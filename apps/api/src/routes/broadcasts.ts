import { notify, type SqlFragment } from '@wa/db';
import {
  BROADCAST_LIMITS,
  BROADCAST_PACE_IDS,
  type BroadcastPace,
  CHANNELS,
  getPlan,
  jidToPhone,
  MESSAGE_STATUSES,
  type MessageStatus,
  ok,
  planHasFeature,
  POLL_LIMITS,
  successSchema,
  templateBody,
  type TemplateParts,
  templateVariablesInput,
} from '@wa/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps';
import { audit } from '../lib/audit';
import { requirePat } from '../lib/auth';
import { planRecipients, scheduleBroadcast } from '../lib/broadcast';
import { ApiError, conflict, forbidden, notFound, paymentRequired, unprocessable } from '../lib/errors';
import { getFeatures } from '../lib/features';
import { assertActive } from '../lib/limits';

// Dashboard-only endpoints (used by /ads), hidden from /docs.
const schemaBase = { tags: ['Admin'], hide: true };
/** Statuses in which a session accepts new messages: connected, or briefly reconnecting. */
const SENDABLE = new Set(['connected', 'connecting']);
const httpUrl = z.url({ protocol: /^https?$/, error: 'Must be an http(s) URL' }).max(2048);
const idParams = z.object({ id: z.uuid() });

const createBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    /** In rotation order. */
    sessionIds: z.array(z.uuid()).min(1).max(BROADCAST_LIMITS.sessions),
    rotateEvery: z.number().int().min(1).max(BROADCAST_LIMITS.rotateEvery).default(1),
    pace: z.enum(BROADCAST_PACE_IDS).default('normal'),
    body: templateBody,
    imageUrl: httpUrl.nullable().optional(),
    buttons: z.array(z.string().trim().min(1).max(POLL_LIMITS.option)).max(POLL_LIMITS.maxOptions).nullable().optional(),
    buttonsTitle: z.string().trim().max(POLL_LIMITS.question).nullable().optional(),
    recipients: z
      .array(z.object({ to: z.string().trim().min(1).max(64), variables: templateVariablesInput.optional() }))
      .min(1)
      .max(BROADCAST_LIMITS.recipients),
  })
  .superRefine((b, ctx) => {
    if (new Set(b.sessionIds).size !== b.sessionIds.length) ctx.addIssue({ code: 'custom', path: ['sessionIds'], message: 'Sessions must be different' });
    if (!b.buttons?.length) return;
    if (b.buttons.length < POLL_LIMITS.minOptions) ctx.addIssue({ code: 'custom', path: ['buttons'], message: `Add at least ${POLL_LIMITS.minOptions} buttons` });
    if (new Set(b.buttons).size !== b.buttons.length) ctx.addIssue({ code: 'custom', path: ['buttons'], message: 'Buttons must be different' });
    if (!b.buttonsTitle) ctx.addIssue({ code: 'custom', path: ['buttonsTitle'], message: 'Required with buttons' });
  });

const statsDto = z.object({ queued: z.number(), sending: z.number(), sent: z.number(), delivered: z.number(), read: z.number(), failed: z.number() });

const broadcastDto = z.object({
  id: z.uuid(),
  name: z.string(),
  template: z.object({ body: z.string(), imageUrl: z.string().nullable(), buttons: z.array(z.string()).nullable(), buttonsTitle: z.string().nullable() }),
  sessionIds: z.array(z.uuid()),
  rotateEvery: z.number(),
  pace: z.enum(BROADCAST_PACE_IDS),
  recipients: z.number(),
  state: z.enum(['running', 'done', 'cancelled']),
  /** Per recipient (the buttons poll that follows a card isn't counted twice). */
  stats: statsDto,
  /** When the last scheduled message is due; null for `fast`. */
  finishesAt: z.string().nullable(),
  createdAt: z.string(),
  cancelledAt: z.string().nullable(),
});

const detailDto = broadcastDto.extend({
  sessions: z.array(
    z.object({ id: z.uuid(), name: z.string(), phone: z.string().nullable(), status: z.string(), total: z.number(), done: z.number(), failed: z.number(), pending: z.number() }),
  ),
  /** Latest status changes, newest first: the live feed. */
  recent: z.array(z.object({ id: z.number(), phone: z.string().nullable(), sessionId: z.uuid(), status: z.enum(MESSAGE_STATUSES), error: z.string().nullable(), updatedAt: z.string() })),
  failures: z.array(z.object({ phone: z.string().nullable(), error: z.string().nullable() })),
});

type BroadcastRow = {
  id: string;
  name: string;
  template: TemplateParts;
  session_ids: string[];
  rotate_every: number;
  pace: BroadcastPace;
  recipients: number;
  created_at: Date;
  cancelled_at: Date | null;
  finishes_at: Date | null;
} & z.infer<typeof statsDto>;

const toBroadcastDto = (r: BroadcastRow): z.infer<typeof broadcastDto> => ({
  id: r.id,
  name: r.name,
  template: { body: r.template.body, imageUrl: r.template.imageUrl ?? null, buttons: r.template.buttons ?? null, buttonsTitle: r.template.buttonsTitle ?? null },
  sessionIds: r.session_ids,
  rotateEvery: r.rotate_every,
  pace: r.pace,
  recipients: r.recipients,
  state: r.cancelled_at ? 'cancelled' : r.queued + r.sending > 0 ? 'running' : 'done',
  stats: { queued: r.queued, sending: r.sending, sent: r.sent, delivered: r.delivered, read: r.read, failed: r.failed },
  finishesAt: r.finishes_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
  cancelledAt: r.cancelled_at?.toISOString() ?? null,
});

/**
 * Bulk "ads" campaigns (dashboard `/ads`): one message per recipient from the workspace's own
 * sessions, rotating between them and paced per session so the numbers don't look automated.
 */
export function broadcastRoutes({ sql }: Deps): FastifyPluginAsyncZod {
  const selectBroadcasts = (where: SqlFragment, limit: number) => sql<BroadcastRow[]>`
    select b.id, b.name, b.template, b.session_ids, b.rotate_every, b.pace, b.recipients, b.created_at, b.cancelled_at,
      s.queued, s.sending, s.sent, s.delivered, s.read, s.failed, s.finishes_at
    from broadcasts b
    cross join lateral (
      select
        count(*) filter (where m.status = 'queued')::int as queued,
        count(*) filter (where m.status = 'sending')::int as sending,
        count(*) filter (where m.status = 'sent')::int as sent,
        count(*) filter (where m.status = 'delivered')::int as delivered,
        count(*) filter (where m.status = 'read')::int as "read",
        count(*) filter (where m.status = 'failed')::int as failed,
        max(m.not_before) as finishes_at
      from messages m where m.broadcast_id = b.id and m.type <> 'poll'
    ) s
    where ${where}
    order by b.created_at desc
    limit ${limit}`;

  const load = async (workspaceId: string, id: string) => {
    const [row] = await selectBroadcasts(sql`b.id = ${id} and b.workspace_id = ${workspaceId}`, 1);
    if (!row) throw notFound('Campaign not found');
    return row;
  };

  return async (app) => {
    // Admins always get in; customers need a plan that bundles `ads` and the flag switched on from /admin.
    app.addHook('preHandler', async (req) => {
      requirePat(req);
      if (req.auth.isAdmin) return;
      if (!planHasFeature(req.auth.planId, 'ads')) {
        throw paymentRequired('Bulk campaigns are not included in your plan. Upgrade to unlock them.', 'feature_not_in_plan');
      }
      if (!(await getFeatures(sql)).ads) throw forbidden('Campaigns are not available yet', 'feature_coming_soon');
    });

    app.post(
      '/',
      {
        schema: {
          ...schemaBase,
          summary: 'Queue a campaign',
          body: createBody,
          response: {
            201: successSchema(
              z.object({
                id: z.uuid(),
                recipients: z.number(),
                skipped: z.array(z.object({ to: z.string(), reason: z.enum(['invalid_number', 'duplicate', 'missing_variables', 'invalid_buttons']) })),
                skippedCount: z.number(),
                finishesAt: z.string().nullable(),
              }),
            ),
          },
        },
      },
      async (req, reply) => {
        assertActive(req.auth);
        const input = req.body;
        const workspaceId = req.auth.workspaceId;

        const found = await sql<{ id: string; name: string; status: string; desired_state: string }[]>`
          select id, name, status, desired_state from sessions
          where workspace_id = ${workspaceId} and id = any(${input.sessionIds}::uuid[])`;
        if (found.length !== input.sessionIds.length) throw notFound('Session not found');
        const offline = found.filter((s) => s.desired_state !== 'running' || !SENDABLE.has(s.status));
        if (offline.length) {
          throw conflict(`Not connected: ${offline.map((s) => s.name).join(', ')}`, 'session_not_connected', {
            sessionIds: offline.map((s) => `${s.name} is ${s.status}`),
          });
        }

        const template: TemplateParts = {
          body: input.body,
          imageUrl: input.imageUrl || null,
          buttons: input.buttons?.length ? input.buttons : null,
          buttonsTitle: input.buttons?.length ? input.buttonsTitle! : null,
        };
        const { planned, skipped } = planRecipients(template, input.recipients);
        if (!planned.length) {
          throw unprocessable('No recipient can receive this campaign', { recipients: ['Every number is invalid, repeated, or missing a variable'] });
        }

        const [clock] = await sql<{ now: Date }[]>`select now() as now`;
        const backlog = await sql<{ session_id: string; last: Date }[]>`
          select session_id, max(not_before) as last from messages
          where session_id = any(${input.sessionIds}::uuid[]) and status = 'queued' and not_before is not null
          group by session_id`;
        const rows = scheduleBroadcast(planned, input.sessionIds, {
          rotateEvery: input.rotateEvery,
          pace: input.pace,
          now: clock!.now.getTime(),
          backlog: new Map(backlog.map((b) => [b.session_id, b.last.getTime()])),
        });

        const plan = getPlan(req.auth.planId);
        if (plan.dailyMessages !== null) {
          const [today] = await sql<{ n: number }[]>`
            select count(*)::int as n from messages
            where workspace_id = ${workspaceId} and direction = 'out' and created_at >= date_trunc('day', now())`;
          const left = Math.max(0, plan.dailyMessages - (today?.n ?? 0));
          if (rows.length > left) {
            throw new ApiError(429, `This campaign needs ${rows.length} messages; ${left} left today on the ${plan.name} plan`, undefined, {
              code: 'daily_limit',
              details: { left },
            });
          }
        }

        const created = await sql.begin(async (tx) => {
          const [broadcast] = await tx<{ id: string }[]>`
            insert into broadcasts (workspace_id, created_by, name, template, session_ids, rotate_every, pace, recipients)
            values (${workspaceId}, ${req.auth.userId}, ${input.name}, ${tx.json(template as never)}, ${input.sessionIds}::uuid[],
                    ${input.rotateEvery}, ${input.pace}, ${planned.length})
            returning id`;
          // One statement for the whole list; ordinality keeps ids (= send order) as scheduled.
          await tx`
            insert into messages (workspace_id, session_id, direction, remote_jid, type, content, status, broadcast_id, not_before)
            select ${workspaceId}, r.session_id, 'out', r.jid, r.type, r.content::jsonb, 'queued', ${broadcast!.id}, nullif(r.not_before, '')::timestamptz
            from unnest(
              ${rows.map((r) => r.sessionId)}::uuid[],
              ${rows.map((r) => r.jid)}::text[],
              ${rows.map((r) => r.content.type)}::text[],
              ${rows.map((r) => JSON.stringify(r.content))}::text[],
              ${rows.map((r) => r.notBefore?.toISOString() ?? '')}::text[]
            ) with ordinality as r(session_id, jid, type, content, not_before, ord)
            order by r.ord`;
          await audit(tx, req, {
            action: 'broadcast.create',
            targetType: 'broadcast',
            targetId: broadcast!.id,
            targetLabel: input.name,
            details: { recipients: planned.length, skipped: skipped.length, sessions: input.sessionIds.length, pace: input.pace, rotateEvery: input.rotateEvery },
          });
          return broadcast!;
        });

        await Promise.all(input.sessionIds.map((sessionId) => notify(sql, CHANNELS.control, { type: 'message.queued', sessionId }).catch(() => {})));
        const last = rows.reduce<Date | null>((max, r) => (r.notBefore && (!max || r.notBefore > max) ? r.notBefore : max), null);
        reply.code(201);
        return ok({ id: created.id, recipients: planned.length, skipped: skipped.slice(0, 200), skippedCount: skipped.length, finishesAt: last?.toISOString() ?? null });
      },
    );

    app.get(
      '/',
      { schema: { ...schemaBase, summary: 'Recent campaigns, newest first', response: { 200: successSchema(z.array(broadcastDto)) } } },
      async (req) => ok((await selectBroadcasts(sql`b.workspace_id = ${req.auth.workspaceId}`, 30)).map(toBroadcastDto)),
    );

    app.get(
      '/:id',
      { schema: { ...schemaBase, summary: 'A campaign with live progress', params: idParams, response: { 200: successSchema(detailDto) } } },
      async (req) => {
        const row = await load(req.auth.workspaceId, req.params.id);
        const [sessions, recent, failures] = await Promise.all([
          sql<{ id: string; name: string; phone: string | null; status: string; total: number; done: number; failed: number; pending: number }[]>`
            select s.id, s.name, s.phone, s.status, count(*)::int as total,
              count(*) filter (where m.status in ('sent', 'delivered', 'read'))::int as done,
              count(*) filter (where m.status = 'failed')::int as failed,
              count(*) filter (where m.status in ('queued', 'sending'))::int as pending
            from messages m join sessions s on s.id = m.session_id
            where m.broadcast_id = ${row.id} and m.type <> 'poll'
            group by s.id`,
          sql<{ id: number; session_id: string; remote_jid: string; status: MessageStatus; error: string | null; updated_at: Date }[]>`
            select id, session_id, remote_jid, status, error, updated_at from messages
            where broadcast_id = ${row.id} and type <> 'poll' and status <> 'queued'
            order by updated_at desc, id desc
            limit 30`,
          sql<{ remote_jid: string; error: string | null }[]>`
            select remote_jid, error from messages
            where broadcast_id = ${row.id} and type <> 'poll' and status = 'failed'
            order by id
            limit 1000`,
        ]);
        const order = new Map(row.session_ids.map((id, i) => [id, i]));
        return ok({
          ...toBroadcastDto(row),
          sessions: sessions.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)),
          recent: recent.map((m) => ({ id: m.id, phone: jidToPhone(m.remote_jid), sessionId: m.session_id, status: m.status, error: m.error, updatedAt: m.updated_at.toISOString() })),
          failures: failures.map((m) => ({ phone: jidToPhone(m.remote_jid), error: m.error })),
        });
      },
    );

    app.post(
      '/:id/cancel',
      {
        schema: {
          ...schemaBase,
          summary: 'Stop a campaign: messages not sent yet are marked failed',
          params: idParams,
          response: { 200: successSchema(broadcastDto.extend({ cancelled: z.number() })) },
        },
      },
      async (req) => {
        const row = await load(req.auth.workspaceId, req.params.id);
        // A message the worker already claimed (`sending`) finishes; everything still queued stops here.
        const cancelled = await sql.begin(async (tx) => {
          const stopped = await tx`
            update messages set status = 'failed', error = 'Cancelled', updated_at = now()
            where broadcast_id = ${row.id} and status = 'queued'
            returning id`;
          await tx`update broadcasts set cancelled_at = coalesce(cancelled_at, now()) where id = ${row.id}`;
          await audit(tx, req, { action: 'broadcast.cancel', targetType: 'broadcast', targetId: row.id, targetLabel: row.name, details: { cancelled: stopped.length } });
          return stopped.length;
        });
        return ok({ ...toBroadcastDto(await load(req.auth.workspaceId, row.id)), cancelled });
      },
    );
  };
}
