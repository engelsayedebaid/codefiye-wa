import { and, eq, notify, planRequests, type Sql, type SqlFragment, type TxSql, type UserRole, type UserStatus, workspaces, type Db } from '@wa/db';
import { CHANNELS, ok, PLANS, successSchema, TRIAL_DAYS } from '@wa/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps';
import { audit, auditIn } from '../lib/audit';
import { requireAdmin } from '../lib/auth';
import { conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { getFeatures, type RuntimeFeature, setFeature } from '../lib/features';
import { OTP_DEFAULT_TEXTS } from '../lib/otp';
import { getOtpTexts, setOtpTexts } from '../lib/otp-text';
import { planRequestDto, toPlanRequestDto, toWorkspaceDto } from './account';

// Operator endpoints: not part of the public API, so hidden from /docs.
const schemaBase = { tags: ['Admin'], hide: true };
const planIds = Object.keys(PLANS) as [keyof typeof PLANS, ...(keyof typeof PLANS)[]];
/** Months a plan stays active; null = no expiry. */
const months = z.number().int().min(1).max(36).nullable();
const pageQuery = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

type Tx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

function addMonths(from: Date, n: number) {
  const d = new Date(from);
  d.setMonth(d.getMonth() + n);
  return d;
}

/**
 * Moves a workspace to a plan. Renewing the same plan extends from its current expiry, so paying
 * early never loses days; any other change starts counting today.
 */
async function applyPlan(db: Tx, workspaceId: string, planId: string, durationMonths: number | null) {
  const [current] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for('update');
  if (!current) throw notFound('Workspace not found');
  const now = new Date();
  const values =
    planId === 'trial'
      ? { planId, trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * 86_400_000), planExpiresAt: null }
      : {
          planId,
          planExpiresAt:
            durationMonths === null
              ? null
              : addMonths(current.planId === planId && current.planExpiresAt && current.planExpiresAt > now ? current.planExpiresAt : now, durationMonths),
        };
  const [updated] = await db.update(workspaces).set(values).where(eq(workspaces.id, workspaceId)).returning();
  return { before: current, after: updated! };
}

const ownerDto = z.object({ name: z.string().nullable(), email: z.string(), isAdmin: z.boolean(), status: z.enum(['active', 'suspended']) });

const adminWorkspaceDto = z.object({
  id: z.uuid(),
  name: z.string(),
  planId: z.string(),
  trialEndsAt: z.string().nullable(),
  planExpiresAt: z.string().nullable(),
  createdAt: z.string(),
  owner: ownerDto.nullable(),
  sessions: z.number(),
  connected: z.number(),
  messages30d: z.number(),
});

const adminUserDto = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  email: z.string(),
  role: z.enum(['user', 'admin']),
  status: z.enum(['active', 'suspended']),
  suspendedAt: z.string().nullable(),
  suspendedReason: z.string().nullable(),
  phone: z.string().nullable(),
  phoneVerified: z.boolean(),
  createdAt: z.string(),
  /** The user's first workspace: plan changes apply to it. */
  workspace: z.object({ id: z.uuid(), name: z.string(), planId: z.string(), trialEndsAt: z.string().nullable(), planExpiresAt: z.string().nullable() }).nullable(),
  workspaces: z.number(),
  sessions: z.number(),
  connected: z.number(),
  messages30d: z.number(),
});

type AdminUserRow = {
  id: string;
  name: string | null;
  email: string;
  role: UserRole;
  status: UserStatus;
  suspended_at: Date | null;
  suspended_reason: string | null;
  phone: string | null;
  phone_verified_at: Date | null;
  created_at: Date;
  workspace_id: string | null;
  workspace_name: string | null;
  plan_id: string | null;
  trial_ends_at: Date | null;
  plan_expires_at: Date | null;
  workspaces: number;
  sessions: number;
  connected: number;
  messages_30d: number;
};

const toAdminUserDto = (r: AdminUserRow): z.infer<typeof adminUserDto> => ({
  id: r.id,
  name: r.name,
  email: r.email,
  role: r.role,
  status: r.status,
  suspendedAt: r.suspended_at?.toISOString() ?? null,
  suspendedReason: r.suspended_reason,
  phone: r.phone,
  phoneVerified: r.phone_verified_at !== null,
  createdAt: r.created_at.toISOString(),
  workspace: r.workspace_id
    ? {
        id: r.workspace_id,
        name: r.workspace_name ?? '',
        planId: r.plan_id ?? 'trial',
        trialEndsAt: r.trial_ends_at?.toISOString() ?? null,
        planExpiresAt: r.plan_expires_at?.toISOString() ?? null,
      }
    : null,
  workspaces: r.workspaces,
  sessions: r.sessions,
  connected: r.connected,
  messages30d: r.messages_30d,
});

const adminRequestDto = planRequestDto.extend({
  workspace: z.object({ id: z.uuid(), name: z.string(), planId: z.string(), ownerEmail: z.string().nullable() }),
});

const auditDto = z.object({
  id: z.number(),
  actorEmail: z.string().nullable(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  targetLabel: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), total: z.number(), page: z.number(), pageSize: z.number() });

/** `%term%` for ILIKE with the user's wildcards escaped. */
const likeTerm = (q: string | undefined) => (q ? `%${q.replace(/[%_\\]/g, '\\$&')}%` : null);

export function adminRoutes({ sql, db, auth, workers }: Deps): FastifyPluginAsyncZod {
  /** Users with their primary workspace and usage. `where` filters `u`. */
  const selectUsers = (where: SqlFragment, limit: number, offset: number) => sql<AdminUserRow[]>`
    select u.id, u.name, u.email, u.role, u.status, u.suspended_at, u.suspended_reason, u.phone, u.phone_verified_at, u.created_at,
      w.id as workspace_id, w.name as workspace_name, w.plan_id, w.trial_ends_at, w.plan_expires_at,
      (select count(*)::int from workspaces x where x.owner_id = u.id) as workspaces,
      coalesce(s.sessions, 0) as sessions, coalesce(s.connected, 0) as connected,
      (select count(*)::int from messages m join workspaces x on x.id = m.workspace_id
        where x.owner_id = u.id and m.created_at >= now() - interval '30 days') as messages_30d
    from users u
    left join lateral (select * from workspaces x where x.owner_id = u.id order by x.created_at limit 1) w on true
    left join lateral (
      select count(*)::int as sessions, count(*) filter (where s.status = 'connected')::int as connected
      from sessions s join workspaces x on x.id = s.workspace_id where x.owner_id = u.id
    ) s on true
    where ${where}
    order by u.created_at desc
    limit ${limit} offset ${offset}`;

  const loadUser = async (id: string) => {
    const [row] = await selectUsers(sql`u.id = ${id}`, 1, 0);
    if (!row) throw notFound('User not found');
    return row;
  };

  /** Admins can't act on themselves or on other admins (no lock-out, no operator takeover). */
  const assertManageable = (req: FastifyRequest, target: AdminUserRow) => {
    if (target.id === req.auth.userId) throw conflict("You can't do this to your own account", 'self_action');
    if (target.role === 'admin') throw forbidden("Admins can't be suspended or deleted here", 'target_is_admin');
  };

  const ownedWorkspaceIds = async (tx: Sql | TxSql, userId: string) =>
    (await tx<{ id: string }[]>`select id from workspaces where owner_id = ${userId}`).map((r) => r.id);

  /** Workers reconcile changed sessions right away instead of at their next tick. */
  const nudgeSessions = (ids: string[]) =>
    Promise.all(ids.map((sessionId) => notify(sql, CHANNELS.control, { type: 'session.changed', sessionId }).catch(() => {})));

  return async (app) => {
    app.addHook('preHandler', async (req) => requireAdmin(req));

    app.get(
      '/stats',
      {
        schema: {
          ...schemaBase,
          summary: 'Platform totals',
          response: {
            200: successSchema(
              z.object({
                users: z.number(),
                suspended: z.number(),
                workspaces: z.number(),
                activePaid: z.number(),
                sessions: z.number(),
                connected: z.number(),
                pendingRequests: z.number(),
                messagesToday: z.number(),
                byPlan: z.record(z.string(), z.number()),
              }),
            ),
          },
        },
      },
      async () => {
        const [[totals], byPlan] = await Promise.all([
          sql<{ users: number; suspended: number; workspaces: number; active_paid: number; sessions: number; connected: number; pending: number; messages_today: number }[]>`
            select
              (select count(*)::int from users) as users,
              (select count(*)::int from users where status = 'suspended') as suspended,
              (select count(*)::int from workspaces) as workspaces,
              (select count(*)::int from workspaces where plan_id not in ('trial', 'unlimited') and (plan_expires_at is null or plan_expires_at > now())) as active_paid,
              (select count(*)::int from sessions) as sessions,
              (select count(*)::int from sessions where status = 'connected') as connected,
              (select count(*)::int from plan_requests where status = 'pending') as pending,
              (select count(*)::int from messages where created_at >= date_trunc('day', now())) as messages_today`,
          sql<{ plan_id: string; n: number }[]>`select plan_id, count(*)::int as n from workspaces group by plan_id`,
        ]);
        return ok({
          users: totals!.users,
          suspended: totals!.suspended,
          workspaces: totals!.workspaces,
          activePaid: totals!.active_paid,
          sessions: totals!.sessions,
          connected: totals!.connected,
          pendingRequests: totals!.pending,
          messagesToday: totals!.messages_today,
          byPlan: Object.fromEntries(byPlan.map((r) => [r.plan_id, r.n])),
        });
      },
    );

    app.get(
      '/users',
      {
        schema: {
          ...schemaBase,
          summary: 'Users with their workspace and usage, newest first',
          querystring: z.object({ q: z.string().trim().max(200).optional(), status: z.enum(['active', 'suspended']).optional(), ...pageQuery }),
          response: { 200: successSchema(page(adminUserDto)) },
        },
      },
      async (req) => {
        const { q, status, page: n, pageSize } = req.query;
        const term = likeTerm(q);
        const where = sql`true
          ${term ? sql`and (u.email ilike ${term} or u.name ilike ${term} or u.phone ilike ${term})` : sql``}
          ${status ? sql`and u.status = ${status}` : sql``}`;
        const [rows, [count]] = await Promise.all([
          selectUsers(where, pageSize, (n - 1) * pageSize),
          sql<{ total: number }[]>`select count(*)::int as total from users u where ${where}`,
        ]);
        return ok({ items: rows.map(toAdminUserDto), total: count?.total ?? 0, page: n, pageSize });
      },
    );

    app.post(
      '/users/:id/suspend',
      {
        schema: {
          ...schemaBase,
          summary: 'Suspend a user',
          description: 'Ends their dashboard sessions, stops their WhatsApp sessions (devices stay linked), fails queued messages, and refuses their API keys until reactivated.',
          params: z.object({ id: z.uuid() }),
          body: z.object({ reason: z.string().trim().min(1).max(500) }),
          response: { 200: successSchema(adminUserDto) },
        },
      },
      async (req) => {
        const target = await loadUser(req.params.id);
        assertManageable(req, target);
        const { workspaceIds, stopped } = await sql.begin(async (tx) => {
          const [updated] = await tx`
            update users set status = 'suspended', suspended_at = now(), suspended_reason = ${req.body.reason}
            where id = ${target.id} and status = 'active' and role <> 'admin' returning id`;
          if (!updated) throw conflict('This user is already suspended', 'already_suspended');
          const workspaceIds = await ownedWorkspaceIds(tx, target.id);
          const ended = await tx`
            update api_keys set revoked_at = now()
            where workspace_id = any(${workspaceIds}::uuid[]) and 'console' = any(scopes) and revoked_at is null returning id`;
          const stopped = await tx<{ id: string }[]>`
            update sessions set desired_state = 'stopped', updated_at = now()
            where workspace_id = any(${workspaceIds}::uuid[]) and desired_state = 'running' returning id`;
          const failed = await tx`
            update messages set status = 'failed', error = 'Account suspended', updated_at = now()
            where workspace_id = any(${workspaceIds}::uuid[]) and direction = 'out' and status = 'queued' returning id`;
          await audit(tx, req, {
            action: 'user.suspend',
            targetType: 'user',
            targetId: target.id,
            targetLabel: target.email,
            details: { reason: req.body.reason, dashboardSessionsEnded: ended.length, sessionsStopped: stopped.length, messagesFailed: failed.length },
          });
          return { workspaceIds, stopped: stopped.map((s) => s.id) };
        });
        await auth.revoke({ workspaceIds });
        await nudgeSessions(stopped);
        return ok(toAdminUserDto(await loadUser(target.id)));
      },
    );

    app.post(
      '/users/:id/reactivate',
      {
        schema: { ...schemaBase, summary: 'Reactivate a suspended user', params: z.object({ id: z.uuid() }), response: { 200: successSchema(adminUserDto) } },
      },
      async (req) => {
        const target = await loadUser(req.params.id);
        assertManageable(req, target);
        const workspaceIds = await sql.begin(async (tx) => {
          const [updated] = await tx`
            update users set status = 'active', suspended_at = null, suspended_reason = null
            where id = ${target.id} and status = 'suspended' returning id`;
          if (!updated) throw conflict('This user is not suspended', 'not_suspended');
          await audit(tx, req, { action: 'user.reactivate', targetType: 'user', targetId: target.id, targetLabel: target.email });
          return ownedWorkspaceIds(tx, target.id);
        });
        await auth.revoke({ workspaceIds });
        return ok(toAdminUserDto(await loadUser(target.id)));
      },
    );

    app.delete(
      '/users/:id',
      {
        schema: {
          ...schemaBase,
          summary: 'Delete a user and everything they own',
          description: 'Unlinks their WhatsApp devices (best effort), then deletes their workspaces, sessions, keys, messages, templates and plan requests in one transaction.',
          params: z.object({ id: z.uuid() }),
          body: z.object({ confirmEmail: z.string().trim().max(254).describe("The user's email, typed again to confirm") }),
          response: { 200: successSchema(z.object({ deleted: z.literal(true) })) },
        },
      },
      async (req) => {
        const target = await loadUser(req.params.id);
        assertManageable(req, target);
        if (req.body.confirmEmail.toLowerCase() !== target.email.toLowerCase()) {
          throw unprocessable('Validation failed', { confirmEmail: ["Doesn't match the user's email"] });
        }
        const running = await sql<{ id: string }[]>`
          select s.id from sessions s join workspaces w on w.id = s.workspace_id
          where w.owner_id = ${target.id} and s.worker_id is not null`;
        // Unlink devices first so phones don't keep a dead "linked device"; never let this block the delete.
        await Promise.allSettled(running.map((s) => workers.call(s.id, 'logout', {}, { timeoutMs: 5_000 })));

        const { workspaceIds, sessionIds } = await sql.begin(async (tx) => {
          const [locked] = await tx`select id from users where id = ${target.id} and role <> 'admin' for update`;
          if (!locked) throw notFound('User not found');
          const workspaceIds = await ownedWorkspaceIds(tx, target.id);
          const sessionIds = (await tx<{ id: string }[]>`select id from sessions where workspace_id = any(${workspaceIds}::uuid[])`).map((s) => s.id);
          const [counts] = await tx<{ messages: number; keys: number; templates: number }[]>`
            select (select count(*)::int from messages where workspace_id = any(${workspaceIds}::uuid[])) as messages,
              (select count(*)::int from api_keys where workspace_id = any(${workspaceIds}::uuid[])) as keys,
              (select count(*)::int from message_templates where workspace_id = any(${workspaceIds}::uuid[])) as templates`;
          // Workspaces cascade to sessions (and their auth state), keys, messages, templates and plan requests.
          await tx`delete from workspaces where id = any(${workspaceIds}::uuid[])`;
          await tx`delete from users where id = ${target.id}`;
          await audit(tx, req, {
            action: 'user.delete',
            targetType: 'user',
            targetId: target.id,
            targetLabel: target.email,
            details: { name: target.name, workspaces: workspaceIds.length, sessions: sessionIds.length, ...counts },
          });
          return { workspaceIds, sessionIds };
        });
        await auth.revoke({ workspaceIds });
        await nudgeSessions(sessionIds);
        return ok({ deleted: true as const });
      },
    );

    app.get(
      '/audit-logs',
      {
        schema: {
          ...schemaBase,
          summary: 'Operator actions, newest first',
          querystring: z.object({ targetId: z.string().max(64).optional(), ...pageQuery }),
          response: { 200: successSchema(page(auditDto)) },
        },
      },
      async (req) => {
        const { targetId, page: n, pageSize } = req.query;
        const where = targetId ? sql`target_id = ${targetId}` : sql`true`;
        const [rows, [count]] = await Promise.all([
          sql<{ id: number; actor_email: string | null; action: string; target_type: string; target_id: string | null; target_label: string | null; details: Record<string, unknown>; created_at: Date }[]>`
            select id, actor_email, action, target_type, target_id, target_label, details, created_at from audit_logs
            where ${where} order by id desc limit ${pageSize} offset ${(n - 1) * pageSize}`,
          sql<{ total: number }[]>`select count(*)::int as total from audit_logs where ${where}`,
        ]);
        return ok({
          items: rows.map((r) => ({
            id: r.id,
            actorEmail: r.actor_email,
            action: r.action,
            targetType: r.target_type,
            targetId: r.target_id,
            targetLabel: r.target_label,
            details: r.details,
            createdAt: r.created_at.toISOString(),
          })),
          total: count?.total ?? 0,
          page: n,
          pageSize,
        });
      },
    );

    app.get(
      '/workspaces',
      {
        schema: {
          ...schemaBase,
          summary: 'Workspaces with owner and usage',
          querystring: z.object({ q: z.string().trim().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).default(200), offset: z.coerce.number().int().min(0).default(0) }),
          response: { 200: successSchema(z.array(adminWorkspaceDto)) },
        },
      },
      async (req) => {
        const q = likeTerm(req.query.q);
        const rows = await sql<
          {
            id: string;
            name: string;
            plan_id: string;
            trial_ends_at: Date | null;
            plan_expires_at: Date | null;
            created_at: Date;
            owner_name: string | null;
            owner_email: string | null;
            owner_role: UserRole | null;
            owner_status: UserStatus | null;
            sessions: number;
            connected: number;
            messages_30d: number;
          }[]
        >`
          select w.id, w.name, w.plan_id, w.trial_ends_at, w.plan_expires_at, w.created_at,
            u.name as owner_name, u.email as owner_email, u.role as owner_role, u.status as owner_status,
            (select count(*)::int from sessions s where s.workspace_id = w.id) as sessions,
            (select count(*)::int from sessions s where s.workspace_id = w.id and s.status = 'connected') as connected,
            (select count(*)::int from messages m where m.workspace_id = w.id and m.created_at >= now() - interval '30 days') as messages_30d
          from workspaces w
          left join users u on u.id = w.owner_id
          ${q ? sql`where u.email ilike ${q} or u.name ilike ${q} or w.name ilike ${q}` : sql``}
          order by w.created_at desc
          limit ${req.query.limit} offset ${req.query.offset}`;
        return ok(
          rows.map((r) => ({
            id: r.id,
            name: r.name,
            planId: r.plan_id,
            trialEndsAt: r.trial_ends_at?.toISOString() ?? null,
            planExpiresAt: r.plan_expires_at?.toISOString() ?? null,
            createdAt: r.created_at.toISOString(),
            owner: r.owner_email ? { name: r.owner_name, email: r.owner_email, isAdmin: r.owner_role === 'admin', status: r.owner_status ?? 'active' } : null,
            sessions: r.sessions,
            connected: r.connected,
            messages30d: r.messages_30d,
          })),
        );
      },
    );

    app.put(
      '/workspaces/:id/plan',
      {
        schema: {
          ...schemaBase,
          summary: "Set a workspace's plan",
          params: z.object({ id: z.uuid() }),
          body: z.object({ planId: z.enum(planIds), months }),
          response: { 200: successSchema(z.object({ id: z.uuid(), name: z.string(), planId: z.string(), trialEndsAt: z.string().nullable(), planExpiresAt: z.string().nullable() })) },
        },
      },
      async (req) => {
        const { after } = await db.transaction(async (tx) => {
          const result = await applyPlan(tx, req.params.id, req.body.planId, req.body.months);
          await auditIn(tx, req, {
            action: 'workspace.plan',
            targetType: 'workspace',
            targetId: result.after.id,
            targetLabel: result.after.name,
            details: { from: result.before.planId, to: result.after.planId, months: req.body.months, expiresAt: result.after.planExpiresAt?.toISOString() ?? null },
          });
          return result;
        });
        await auth.revoke({ workspaceIds: [after.id] });
        return ok(toWorkspaceDto(after));
      },
    );

    const featuresDto = z.object({ ads: z.boolean() });

    app.get(
      '/features',
      {
        schema: { ...schemaBase, summary: 'Runtime feature flags', response: { 200: successSchema(featuresDto) } },
      },
      async () => ok(await getFeatures(sql)),
    );

    app.put(
      '/features',
      {
        schema: {
          ...schemaBase,
          summary: 'Toggle a feature flag (e.g. `ads` for eligible plans)',
          body: featuresDto.partial().refine((b) => Object.keys(b).length > 0, 'Nothing to change'),
          response: { 200: successSchema(featuresDto) },
        },
      },
      async (req) => {
        for (const [feature, enabled] of Object.entries(req.body) as [RuntimeFeature, boolean][]) {
          await setFeature(sql, feature, enabled);
          await audit(sql, req, { action: 'feature.update', targetType: 'feature', targetId: feature, details: { enabled } });
        }
        return ok(await getFeatures(sql));
      },
    );

    const otpTextValue = z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .nullable()
      .refine((v) => v === null || /\{\{\s*code\s*\}\}/.test(v), 'The text must include {{code}}');
    const otpTextDto = z.object({ ar: otpTextValue, en: otpTextValue });
    const otpTextsDto = z.object({ texts: otpTextDto, defaults: z.object({ ar: z.string(), en: z.string() }) });
    const toOtpTexts = (texts: { ar: string | null; en: string | null }) => ({ texts, defaults: OTP_DEFAULT_TEXTS });

    app.get(
      '/otp-text',
      { schema: { ...schemaBase, summary: 'Custom verification-code message per language (null = built-in)', response: { 200: successSchema(otpTextsDto) } } },
      async () => ok(toOtpTexts(await getOtpTexts(sql))),
    );

    app.put(
      '/otp-text',
      { schema: { ...schemaBase, summary: 'Set or clear (null) the verification-code message per language', body: otpTextDto, response: { 200: successSchema(otpTextsDto) } } },
      async (req) => {
        const texts = await setOtpTexts(sql, req.body);
        await audit(sql, req, { action: 'otp_text.update', targetType: 'feature', targetId: 'otp_text', details: { custom: Boolean(texts.ar || texts.en) } });
        return ok(toOtpTexts(texts));
      },
    );

    app.get(
      '/plan-requests',
      {
        schema: {
          ...schemaBase,
          summary: 'Plan requests, newest first',
          querystring: z.object({ status: z.enum(['pending', 'all']).default('pending') }),
          response: { 200: successSchema(z.array(adminRequestDto)) },
        },
      },
      async (req) => {
        const rows = await sql<
          {
            id: string;
            plan_id: string;
            status: 'pending' | 'approved' | 'rejected' | 'cancelled';
            note: string | null;
            admin_note: string | null;
            created_at: Date;
            decided_at: Date | null;
            workspace_id: string;
            workspace_name: string;
            workspace_plan_id: string;
            owner_email: string | null;
          }[]
        >`
          select r.id, r.plan_id, r.status, r.note, r.admin_note, r.created_at, r.decided_at,
            w.id as workspace_id, w.name as workspace_name, w.plan_id as workspace_plan_id, u.email as owner_email
          from plan_requests r
          join workspaces w on w.id = r.workspace_id
          left join users u on u.id = w.owner_id
          ${req.query.status === 'pending' ? sql`where r.status = 'pending'` : sql``}
          order by r.created_at desc
          limit 200`;
        return ok(
          rows.map((r) => ({
            id: r.id,
            planId: r.plan_id,
            status: r.status,
            note: r.note,
            adminNote: r.admin_note,
            createdAt: r.created_at.toISOString(),
            decidedAt: r.decided_at?.toISOString() ?? null,
            workspace: { id: r.workspace_id, name: r.workspace_name, planId: r.workspace_plan_id, ownerEmail: r.owner_email },
          })),
        );
      },
    );

    const decide = async (tx: Tx, id: string, decidedBy: string | null, status: 'approved' | 'rejected', adminNote: string | null) => {
      const [row] = await tx
        .update(planRequests)
        .set({ status, adminNote, decidedAt: new Date(), decidedBy })
        .where(and(eq(planRequests.id, id), eq(planRequests.status, 'pending')))
        .returning();
      if (!row) throw conflict('This request is no longer pending', 'not_pending');
      return row;
    };

    app.post(
      '/plan-requests/:id/approve',
      {
        schema: {
          ...schemaBase,
          summary: 'Approve a request and activate its plan',
          params: z.object({ id: z.uuid() }),
          body: z.object({ months: months.default(1), note: z.string().trim().max(500).optional() }),
          response: { 200: successSchema(planRequestDto) },
        },
      },
      async (req) => {
        const row = await db.transaction(async (tx) => {
          const approved = await decide(tx, req.params.id, req.auth.userId, 'approved', req.body.note || null);
          const { after } = await applyPlan(tx, approved.workspaceId, approved.planId, req.body.months);
          await auditIn(tx, req, {
            action: 'plan_request.approve',
            targetType: 'plan_request',
            targetId: approved.id,
            targetLabel: after.name,
            details: { planId: approved.planId, months: req.body.months, expiresAt: after.planExpiresAt?.toISOString() ?? null },
          });
          return approved;
        });
        await auth.revoke({ workspaceIds: [row.workspaceId] });
        return ok(toPlanRequestDto(row));
      },
    );

    app.post(
      '/plan-requests/:id/reject',
      {
        schema: {
          ...schemaBase,
          summary: 'Reject a request',
          params: z.object({ id: z.uuid() }),
          body: z.object({ note: z.string().trim().max(500).optional() }),
          response: { 200: successSchema(planRequestDto) },
        },
      },
      async (req) => {
        const row = await db.transaction(async (tx) => {
          const rejected = await decide(tx, req.params.id, req.auth.userId, 'rejected', req.body.note || null);
          await auditIn(tx, req, { action: 'plan_request.reject', targetType: 'plan_request', targetId: rejected.id, details: { planId: rejected.planId, note: req.body.note ?? null } });
          return rejected;
        });
        return ok(toPlanRequestDto(row));
      },
    );
  };
}
