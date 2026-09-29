import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import QRCode from 'qrcode';
import { z } from 'zod';
import { and, apiKeys, desc, eq, sessions, sql, workspaces, type Db } from '@wa/db';
import { QR_TTL_MS, createSessionSchema, ok, pairingCodeSchema } from '@wa/shared';
import { requireActive, requirePat, resolveSession } from '../plugins/auth';
import { generateApiKey } from '../lib/keys';
import { forbidden, notFound } from '../lib/errors';
import { effectivePlan } from '../lib/plans';
import type { WorkerBus } from '../lib/workers';
import type { EventHub } from '../lib/events';
import { config } from '../config';

const idParams = z.object({ id: z.uuid() });

const publicSession = (s: typeof sessions.$inferSelect) => ({
  id: s.id,
  name: s.name,
  phone: s.phone,
  status: s.status,
  lastSeenAt: s.lastSeenAt,
  createdAt: s.createdAt,
});

const currentQr = (s: typeof sessions.$inferSelect) =>
  s.status === 'qr' && s.qr && s.qrUpdatedAt && Date.now() - s.qrUpdatedAt.getTime() < QR_TTL_MS ? s.qr : null;

export function sessionRoutes(app: FastifyInstance, deps: { db: Db; bus: WorkerBus; hub: EventHub }) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, bus, hub } = deps;
  const tags = ['Sessions'];

  /** Ensures the session is owned by a live worker, (re)assigning if needed. */
  async function ownerOf(session: typeof sessions.$inferSelect) {
    if (session.workerId && (await bus.isAlive(session.workerId))) return session.workerId;
    const workerId = await bus.pickWorker();
    await db.update(sessions).set({ workerId }).where(eq(sessions.id, session.id));
    return workerId;
  }

  r.get('/api/whatsapp-sessions', { schema: { tags, summary: 'List sessions' } }, async (req) => {
    requirePat(req);
    const rows = await db.query.sessions.findMany({
      where: eq(sessions.workspaceId, req.auth.workspaceId),
      orderBy: desc(sessions.createdAt),
    });
    return ok(rows.map(publicSession));
  });

  r.post('/api/whatsapp-sessions', { schema: { tags, summary: 'Create a session', body: createSessionSchema } }, async (req, reply) => {
    requirePat(req);
    requireActive(req);
    const [ws, [count]] = await Promise.all([
      db.query.workspaces.findFirst({ where: eq(workspaces.id, req.auth.workspaceId), columns: { planId: true, planExpiresAt: true } }),
      db.select({ count: sql<number>`count(*)::int` }).from(sessions).where(eq(sessions.workspaceId, req.auth.workspaceId)),
    ]);
    const limit = effectivePlan(ws ?? { planId: 'trial', planExpiresAt: null }).sessions;
    if ((count?.count ?? 0) >= limit) throw forbidden(`وصلت لحد الباقة: ${limit} جلسة. رقّي باقتك من صفحة الاشتراك.`);
    const [session] = await db
      .insert(sessions)
      .values({ workspaceId: req.auth.workspaceId, name: req.body.name, phone: req.body.phone })
      .returning();
    const { key, keyHash, prefix } = generateApiKey('session');
    await db.insert(apiKeys).values({ workspaceId: req.auth.workspaceId, sessionId: session!.id, name: `${req.body.name} key`, keyHash, prefix });
    reply.code(201);
    return ok({ ...publicSession(session!), apiKey: key });
  });

  r.get('/api/whatsapp-sessions/:id', { schema: { tags, summary: 'Get a session', params: idParams } }, async (req) => {
    return ok(publicSession(await resolveSession(app, req, req.params.id)));
  });

  r.delete('/api/whatsapp-sessions/:id', { schema: { tags, summary: 'Delete a session (logs out first)', params: idParams } }, async (req) => {
    requirePat(req);
    const session = await resolveSession(app, req, req.params.id);
    if (session.workerId && (await bus.isAlive(session.workerId)))
      await bus.rpc(session.workerId, { op: 'logout', sessionId: session.id }).catch(() => {});
    await db.delete(sessions).where(and(eq(sessions.id, session.id), eq(sessions.workspaceId, req.auth.workspaceId)));
    return ok({ id: session.id, deleted: true });
  });

  r.post('/api/whatsapp-sessions/:id/connect', { schema: { tags, summary: 'Connect (starts QR flow if not linked)', params: idParams } }, async (req) => {
    const session = await resolveSession(app, req, req.params.id);
    const workerId = await ownerOf(session);
    await db.update(sessions).set({ autoConnect: true }).where(eq(sessions.id, session.id));
    const result = await bus.rpc<{ status: string }>(workerId, { op: 'connect', sessionId: session.id });
    return ok({ id: session.id, status: result.status });
  });

  r.post('/api/whatsapp-sessions/:id/disconnect', { schema: { tags, summary: 'Disconnect (keeps link)', params: idParams } }, async (req) => {
    const session = await resolveSession(app, req, req.params.id);
    await db.update(sessions).set({ autoConnect: false }).where(eq(sessions.id, session.id));
    if (session.workerId) await bus.rpc(session.workerId, { op: 'disconnect', sessionId: session.id });
    return ok({ id: session.id, status: 'disconnected' });
  });

  r.post('/api/whatsapp-sessions/:id/logout', { schema: { tags, summary: 'Unlink the device and wipe credentials', params: idParams } }, async (req) => {
    const session = await resolveSession(app, req, req.params.id);
    await db.update(sessions).set({ autoConnect: false }).where(eq(sessions.id, session.id));
    await bus.rpc(await ownerOf(session), { op: 'logout', sessionId: session.id });
    return ok({ id: session.id, status: 'logged_out' });
  });

  r.get('/api/whatsapp-sessions/:id/qrcode', { schema: { tags, summary: 'Current QR code', params: idParams } }, async (req) => {
    const session = await resolveSession(app, req, req.params.id);
    const qr = currentQr(session);
    if (!qr) throw notFound('No QR code available. Call /connect first, or the session is already linked.');
    return ok({ qr, dataUrl: await QRCode.toDataURL(qr, { margin: 1, width: 320 }) });
  });

  r.post(
    '/api/whatsapp-sessions/:id/pairing-code',
    { schema: { tags, summary: 'Link with a pairing code instead of QR', params: idParams, body: pairingCodeSchema } },
    async (req) => {
      const session = await resolveSession(app, req, req.params.id);
      const workerId = await ownerOf(session);
      await db.update(sessions).set({ autoConnect: true }).where(eq(sessions.id, session.id));
      const { code } = await bus.rpc<{ code: string }>(workerId, { op: 'pairing-code', sessionId: session.id, phone: req.body.phone }, 30_000);
      return ok({ code });
    },
  );

  /** SSE: session.status / qrcode.updated / messages.* for the dashboard. */
  r.get('/api/whatsapp-sessions/:id/events', { schema: { tags, summary: 'Live session events (SSE)', params: idParams } }, async (req, reply) => {
    const session = await resolveSession(app, req, req.params.id);
    reply.hijack();
    const res = reply.raw;
    const origin = req.headers.origin;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(origin && config.corsOrigins.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('session.status', { status: session.status, phone: session.phone });
    const qr = currentQr(session);
    if (qr) send('qrcode.updated', { qr });

    const off = hub.subscribe(session.id, (e) => send(e.event, e.data));
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => (off(), clearInterval(ping)));
  });
}
