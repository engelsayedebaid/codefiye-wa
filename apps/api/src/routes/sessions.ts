import { and, apiKeys, eq, isNull, notify, pgError, PG_ERRORS, sessions } from '@wa/db';
import { CHANNELS, type ControlMessage, ok, SESSION_STATUSES, successSchema, suggestNames } from '@wa/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { Deps } from '../deps';
import { ownedSession, requirePat } from '../lib/auth';
import { toSessionDto, sessionDto, sessionSettingsSchema } from '../lib/dto';
import { ApiError, conflict, notFound, unavailable } from '../lib/errors';
import { generateKey } from '../lib/keys';
import { assertActive, assertSessionQuota } from '../lib/limits';

const tags = ['Sessions'];
const idParams = z.object({ id: z.uuid() });

/** README §6: session management, WasenderAPI-compatible paths. */
export function sessionRoutes({ sql, db, auth, events, workers }: Deps): FastifyPluginAsyncZod {
  const load = async (workspaceId: string, id: string) => {
    const [session] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.workspaceId, workspaceId)));
    if (!session) throw notFound('Session not found');
    return session;
  };

  const control = (message: ControlMessage) => notify(sql, CHANNELS.control, message);

  /** Session names are unique per workspace (case-insensitive index); a conflict carries free lookalikes. */
  const nameTaken = (name: string, names: string[]) =>
    new ApiError(409, 'A session with this name already exists', { name: ['Already used by another session'] }, {
      code: 'name_taken',
      details: { suggestions: suggestNames(name, names) },
    });

  /** Throws `name_taken` when another session of the workspace already has `name` (`excludeId`: the session being renamed). */
  const assertNameFree = async (workspaceId: string, name: string, excludeId?: string) => {
    const rows = await db.select({ id: sessions.id, name: sessions.name }).from(sessions).where(eq(sessions.workspaceId, workspaceId));
    const others = rows.filter((r) => r.id !== excludeId);
    if (others.some((r) => r.name.toLowerCase() === name.toLowerCase())) throw nameTaken(name, others.map((r) => r.name));
  };

  /** The unique index firing on a concurrent create/rename; the aborted tx can't answer, so names are re-read. */
  const nameTakenFromDb = async (workspaceId: string, name: string, excludeId?: string) => {
    const rows = await db.select({ id: sessions.id, name: sessions.name }).from(sessions).where(eq(sessions.workspaceId, workspaceId));
    return nameTaken(name, rows.filter((r) => r.id !== excludeId).map((r) => r.name));
  };

  const isNameConflict = (err: unknown) => {
    const pg = pgError(err);
    return pg?.code === PG_ERRORS.uniqueViolation && pg.constraint === 'sessions_workspace_name_unique';
  };

  const setDesired = async (id: string, desiredState: 'running' | 'stopped') => {
    await db.update(sessions).set({ desiredState, updatedAt: new Date() }).where(eq(sessions.id, id));
    await control({ type: 'session.changed', sessionId: id });
  };

  return async (app) => {
    app.get(
      '/whatsapp-sessions',
      { schema: { tags, summary: 'List sessions', response: { 200: successSchema(z.array(sessionDto)) } } },
      async (req) => {
        requirePat(req);
        const rows = await db.select().from(sessions).where(eq(sessions.workspaceId, req.auth.workspaceId)).orderBy(sessions.createdAt);
        return ok(rows.map(toSessionDto));
      },
    );

    app.post(
      '/whatsapp-sessions',
      {
        schema: {
          tags,
          summary: 'Create a session',
          description: 'Returns the session API key once — store it, only its hash is kept.',
          body: z.object({ name: z.string().trim().min(1).max(100), settings: sessionSettingsSchema.optional() }),
          response: { 201: successSchema(sessionDto.extend({ apiKey: z.string() })) },
        },
      },
      async (req, reply) => {
        requirePat(req);
        const key = generateKey('session');
        await assertNameFree(req.auth.workspaceId, req.body.name);
        let session;
        try {
          session = await db.transaction(async (tx) => {
            await assertSessionQuota(tx, req.auth);
            const [created] = await tx
              .insert(sessions)
              .values({ workspaceId: req.auth.workspaceId, name: req.body.name, settings: req.body.settings ?? {} })
              .returning();
            await tx.insert(apiKeys).values({
              workspaceId: req.auth.workspaceId,
              sessionId: created!.id,
              name: 'Default',
              keyHash: key.hash,
              prefix: key.prefix,
            });
            return created!;
          });
        } catch (err) {
          if (isNameConflict(err)) throw await nameTakenFromDb(req.auth.workspaceId, req.body.name);
          throw err;
        }
        reply.code(201);
        return ok({ ...toSessionDto(session), apiKey: key.key });
      },
    );

    app.get(
      '/whatsapp-sessions/:id',
      { schema: { tags, summary: 'Get a session', params: idParams, response: { 200: successSchema(sessionDto) } } },
      async (req) => {
        await ownedSession(sql, req, req.params.id);
        return ok(toSessionDto(await load(req.auth.workspaceId, req.params.id)));
      },
    );

    app.put(
      '/whatsapp-sessions/:id',
      {
        schema: {
          tags,
          summary: 'Update a session',
          params: idParams,
          body: z.object({ name: z.string().trim().min(1).max(100).optional(), settings: sessionSettingsSchema.optional() }),
          response: { 200: successSchema(sessionDto) },
        },
      },
      async (req) => {
        requirePat(req);
        const current = await load(req.auth.workspaceId, req.params.id);
        if (req.body.name) await assertNameFree(req.auth.workspaceId, req.body.name, current.id);
        let updated;
        try {
          [updated] = await db
            .update(sessions)
            .set({
              name: req.body.name ?? current.name,
              settings: req.body.settings ? { ...current.settings, ...req.body.settings } : current.settings,
              updatedAt: new Date(),
            })
            .where(eq(sessions.id, current.id))
            .returning();
        } catch (err) {
          if (isNameConflict(err)) throw await nameTakenFromDb(req.auth.workspaceId, req.body.name ?? current.name, current.id);
          throw err;
        }
        await control({ type: 'session.changed', sessionId: current.id });
        return ok(toSessionDto(updated!));
      },
    );

    app.delete(
      '/whatsapp-sessions/:id',
      {
        schema: {
          tags,
          summary: 'Delete a session',
          description: 'Unlinks the device if the session is running, then deletes the session, its keys and messages.',
          params: idParams,
          response: { 200: successSchema(z.object({ deleted: z.literal(true) })) },
        },
      },
      async (req) => {
        requirePat(req);
        const session = await load(req.auth.workspaceId, req.params.id);
        await workers.call(session.id, 'logout').catch(() => {});
        await db.delete(sessions).where(eq(sessions.id, session.id));
        await control({ type: 'session.changed', sessionId: session.id });
        auth.invalidate((ctx) => ctx.keySessionId === session.id);
        return ok({ deleted: true as const });
      },
    );

    app.post(
      '/whatsapp-sessions/:id/connect',
      {
        schema: {
          tags,
          summary: 'Connect a session',
          description: 'Starts the socket. Waits up to 15s for a QR code (new device) or the connection (linked device).',
          params: idParams,
          response: { 200: successSchema(z.object({ status: z.enum(SESSION_STATUSES), qrCode: z.string().nullable() })) },
        },
      },
      async (req) => {
        const session = await ownedSession(sql, req, req.params.id);
        assertActive(req.auth);
        if (session.status === 'connected' && session.desired_state === 'running') return ok({ status: 'connected' as const, qrCode: null });
        if ((await workers.liveWorkers()) === 0) throw unavailable('No session worker is running. Try again shortly.');

        const settled = new Set(['connected', 'logged_out', 'needs_attention', 'disconnected']);
        const waiting = events.waitFor(
          req.auth.workspaceId,
          (e) => e.sessionId === session.id && (e.type === 'qrcode.updated' || (e.type === 'session.status' && settled.has(e.data.status))),
          15_000,
        );
        await db.update(sessions).set({ lastError: null }).where(eq(sessions.id, session.id));
        await setDesired(session.id, 'running');
        await waiting;
        const fresh = await load(req.auth.workspaceId, session.id);
        return ok({ status: fresh.status, qrCode: fresh.qr });
      },
    );

    app.get(
      '/whatsapp-sessions/:id/qrcode',
      {
        schema: {
          tags,
          summary: 'Get the current QR code',
          description: 'QR codes rotate about every 20 seconds; `qrImage` is a PNG data URL of the same code.',
          params: idParams,
          response: { 200: successSchema(z.object({ qrCode: z.string(), qrImage: z.string() })) },
        },
      },
      async (req) => {
        await ownedSession(sql, req, req.params.id);
        const session = await load(req.auth.workspaceId, req.params.id);
        if (!session.qr) throw conflict(`No QR code available (session status: ${session.status})`);
        return ok({ qrCode: session.qr, qrImage: await QRCode.toDataURL(session.qr, { margin: 1, width: 320 }) });
      },
    );

    app.post(
      '/whatsapp-sessions/:id/pairing-code',
      {
        schema: {
          tags,
          summary: 'Link with a pairing code instead of a QR',
          description: 'Call after `connect` while the session shows a QR. Enter the code on the phone under Linked devices → Link with phone number.',
          params: idParams,
          body: z.object({ phoneNumber: z.string().min(7).max(20) }),
          response: { 200: successSchema(z.object({ pairingCode: z.string() })) },
        },
      },
      async (req) => {
        await ownedSession(sql, req, req.params.id);
        assertActive(req.auth);
        const { code } = await workers.call<{ code: string }>(req.params.id, 'pairing-code', { phone: req.body.phoneNumber });
        return ok({ pairingCode: code });
      },
    );

    app.post(
      '/whatsapp-sessions/:id/disconnect',
      {
        schema: {
          tags,
          summary: 'Disconnect a session',
          description: 'Closes the socket; the device stays linked, so `connect` resumes without a QR.',
          params: idParams,
          response: { 200: successSchema(sessionDto) },
        },
      },
      async (req) => {
        const session = await ownedSession(sql, req, req.params.id);
        const waiting = events.waitFor(
          req.auth.workspaceId,
          (e) => e.sessionId === session.id && e.type === 'session.status' && e.data.status !== 'connected',
          5_000,
        );
        await setDesired(session.id, 'stopped');
        if (session.status !== 'created' && session.status !== 'disconnected') await waiting;
        return ok(toSessionDto(await load(req.auth.workspaceId, session.id)));
      },
    );

    app.post(
      '/whatsapp-sessions/:id/logout',
      {
        schema: {
          tags,
          summary: 'Log out (unlink the device)',
          description: 'Removes the linked device from the phone and wipes stored credentials. A new QR scan is needed afterwards.',
          params: idParams,
          response: { 200: successSchema(sessionDto) },
        },
      },
      async (req) => {
        const session = await ownedSession(sql, req, req.params.id);
        try {
          await workers.call(session.id, 'logout');
        } catch (err) {
          if (!(err instanceof ApiError && err.statusCode === 409)) throw err;
          // Not running anywhere: wipe credentials directly. The phone keeps a stale linked-device entry until it expires.
          await sql.begin(async (tx) => {
            await tx`delete from session_auth where session_id = ${session.id}`;
            await tx`
              update sessions set status = 'logged_out', desired_state = 'stopped', worker_id = null, qr = null,
                pairing_code = null, updated_at = now()
              where id = ${session.id}`;
          });
          await control({ type: 'session.changed', sessionId: session.id });
        }
        return ok(toSessionDto(await load(req.auth.workspaceId, session.id)));
      },
    );

    app.post(
      '/whatsapp-sessions/:id/regenerate-key',
      {
        schema: {
          tags,
          summary: 'Regenerate the session API key',
          description: 'Revokes every existing key of this session and returns a new one (shown once).',
          params: idParams,
          response: { 200: successSchema(z.object({ apiKey: z.string() })) },
        },
      },
      async (req) => {
        requirePat(req);
        const session = await load(req.auth.workspaceId, req.params.id);
        const key = generateKey('session');
        await db.transaction(async (tx) => {
          await tx
            .update(apiKeys)
            .set({ revokedAt: new Date() })
            .where(and(eq(apiKeys.sessionId, session.id), isNull(apiKeys.revokedAt)));
          await tx.insert(apiKeys).values({
            workspaceId: req.auth.workspaceId,
            sessionId: session.id,
            name: 'Default',
            keyHash: key.hash,
            prefix: key.prefix,
          });
        });
        auth.invalidate((ctx) => ctx.keySessionId === session.id);
        return ok({ apiKey: key.key });
      },
    );
  };
}
