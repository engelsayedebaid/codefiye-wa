import { randomInt, randomUUID } from 'node:crypto';
import { notify } from '@wa/db';
import { encrypt, otpDeliveryKey } from '@wa/provider';
import {
  CHANNELS,
  chooseOtpSession,
  decideResend,
  formatOtpMessage,
  maskPhoneNumber,
  normalizePhone,
  ok,
  OTP_DEFAULT_SEND_MS,
  OTP_PURPOSES,
  otpPlanLimits,
  type OtpDeliveryStatus,
  type OtpSenderCandidate,
  type OtpVerifyStatus,
  retryAfterSeconds,
  successSchema,
  toJid,
} from '@wa/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps';
import { audit } from '../lib/audit';
import { assertScope, requireAdmin, requirePat } from '../lib/auth';
import { conflict, forbidden, notFound, tooMany, unavailable, unprocessable } from '../lib/errors';
import { generateKey } from '../lib/keys';
import { assertActive } from '../lib/limits';
import { hashOtp, otpMatches } from '../lib/otp';

const tags = ['OTP gateway'];
const OTP_PRIORITY = 10;

const poolBody = z.object({
  name: z.string().trim().min(1).max(80),
  sessionIds: z.array(z.uuid()).max(100).optional(),
  makeDefault: z.boolean().optional(),
});

const settingsBody = z.object({
  codeLength: z.number().int().min(4).max(8).optional(),
  ttlSeconds: z.number().int().min(60).max(600).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  resendCooldownSec: z.number().int().min(30).max(600).optional(),
  maxSends: z.number().int().min(1).max(5).optional(),
});

type PoolRow = {
  id: string;
  workspace_id: string;
  name: string;
  status: 'active' | 'paused' | 'archived';
  is_default: boolean;
  code_length: number;
  ttl_seconds: number;
  max_attempts: number;
  resend_cooldown_sec: number;
  max_sends: number;
};

function assertManage(req: Parameters<typeof requirePat>[0]) {
  requirePat(req);
  if (req.auth.console || req.auth.scopes.length === 0) return;
  throw forbidden('This key cannot manage sender pools', 'scope_required');
}

function assertWorkspaceKey(req: Parameters<typeof requirePat>[0]) {
  requirePat(req);
}

export function otpGatewayRoutes({ sql, otp, throttle, encryptionKey }: Deps): FastifyPluginAsyncZod {
  const seal = (challengeId: string, text: string) => {
    if (!encryptionKey) throw unavailable('OTP delivery encryption is not configured', 'otp_unavailable');
    return encrypt(otpDeliveryKey(encryptionKey), Buffer.from(text, 'utf8'), `otp:${challengeId}`);
  };

  async function ownedPool(workspaceId: string, poolId: string, lock = false): Promise<PoolRow> {
    const [row] = await sql<PoolRow[]>`
      select id, workspace_id, name, status, is_default, code_length, ttl_seconds, max_attempts, resend_cooldown_sec, max_sends
      from otp_sender_pools where id = ${poolId} and workspace_id = ${workspaceId} and status <> 'archived'
      ${lock ? sql`for update` : sql``}`;
    if (!row) throw notFound('Sender pool not found', 'pool_not_found');
    return row;
  }

  async function candidates(poolId: string): Promise<OtpSenderCandidate[]> {
    const rows = await sql<
      {
        session_id: string;
        enabled: boolean;
        membership: 'active' | 'draining';
        status: string;
        desired_state: string;
        restricted: boolean;
        queued: number;
        inflight: number;
        last_assigned: Date | null;
      }[]
    >`
      select m.session_id, m.enabled, m.membership, s.status, s.desired_state,
        (s.restricted_at is not null and s.restricted_at > now() - interval '1 day') as restricted,
        (select count(*)::int from messages q where q.session_id = s.id and q.otp_challenge_id is not null and q.status = 'queued') as queued,
        (select count(*)::int from messages q where q.session_id = s.id and q.otp_challenge_id is not null and q.status = 'sending') as inflight,
        (select max(c.created_at) from otp_challenges c where c.session_id = s.id and c.pool_id = m.pool_id) as last_assigned
      from otp_sender_pool_members m
      join sessions s on s.id = m.session_id
      where m.pool_id = ${poolId}`;
    return rows.map((r) => ({
      sessionId: r.session_id,
      enabled: r.enabled,
      membership: r.membership,
      connected: r.desired_state === 'running' && r.status === 'connected',
      restricted: r.restricted,
      queued: r.queued,
      inFlight: r.inflight,
      avgSendMs: OTP_DEFAULT_SEND_MS,
      lastAssignedAt: r.last_assigned ? new Date(r.last_assigned).getTime() : null,
    }));
  }

  async function assertSessionRoom(tx: Parameters<Parameters<typeof sql.begin>[0]>[0], sessionId: string, maxQueue: number) {
    await tx`select id from sessions where id = ${sessionId} for update`;
    const [depth] = await tx<{ n: number }[]>`
      select count(*)::int as n from messages
      where session_id = ${sessionId} and otp_challenge_id is not null and status in ('queued', 'sending')`;
    if ((depth?.n ?? 0) >= maxQueue) throw tooMany('No sender can deliver this code before it expires', retryAfterSeconds(OTP_DEFAULT_SEND_MS), 'otp_capacity');
  }

  async function admitDaily(tx: Parameters<Parameters<typeof sql.begin>[0]>[0], workspaceId: string, limit: number | null) {
    if (limit === null) return;
    const [row] = await tx<{ admitted: number }[]>`
      insert into otp_usage_daily (workspace_id, day, admitted)
      values (${workspaceId}, current_date, 1)
      on conflict (workspace_id, day) do update
        set admitted = otp_usage_daily.admitted + 1
        where otp_usage_daily.admitted < ${limit}
      returning admitted`;
    if (!row) throw tooMany('Daily OTP limit reached for this workspace', 3600, 'otp_daily_limit');
  }

  async function enqueue(tx: Parameters<Parameters<typeof sql.begin>[0]>[0], input: {
    workspaceId: string;
    challengeId: string;
    sessionId: string;
    jid: string;
    expiresAt: Date;
  }) {
    const content = { type: 'text', text: '••••••' };
    const [message] = await tx<{ id: number }[]>`
      insert into messages (workspace_id, session_id, direction, remote_jid, type, content, status, priority, expires_at, otp_challenge_id)
      values (${input.workspaceId}, ${input.sessionId}, 'out', ${input.jid}, 'text', ${tx.json(content)}, 'queued', ${OTP_PRIORITY}, ${input.expiresAt}, ${input.challengeId})
      returning id`;
    await tx`update otp_challenges set message_id = ${message!.id}, session_id = ${input.sessionId}, delivery_status = 'queued', updated_at = now() where id = ${input.challengeId}`;
    return message!.id;
  }

  return async (app) => {
    app.get('/v1/otp/overview', { schema: { tags, summary: 'OTP pool overview for this workspace' } }, async (req) => {
      assertManage(req);
      const limits = otpPlanLimits(req.auth.planId);
      const [counts] = await sql<
        { pools: number; queued: number; sent: number; delivered: number; failed: number; expired: number; uncertain: number; verified: number }[]
      >`
        select
          (select count(*)::int from otp_sender_pools where workspace_id = ${req.auth.workspaceId} and status <> 'archived') as pools,
          count(*) filter (where delivery_status = 'queued')::int as queued,
          count(*) filter (where delivery_status = 'sent')::int as sent,
          count(*) filter (where delivery_status = 'delivered')::int as delivered,
          count(*) filter (where delivery_status = 'failed')::int as failed,
          count(*) filter (where delivery_status = 'expired' or verify_status = 'expired')::int as expired,
          count(*) filter (where delivery_status = 'uncertain')::int as uncertain,
          count(*) filter (where verify_status = 'verified')::int as verified
        from otp_challenges where workspace_id = ${req.auth.workspaceId} and created_at > now() - interval '1 day'`;
      const [usage] = await sql<{ admitted: number }[]>`
        select admitted from otp_usage_daily where workspace_id = ${req.auth.workspaceId} and day = current_date`;
      return ok({ counts: counts ?? { pools: 0, queued: 0, sent: 0, delivered: 0, failed: 0, expired: 0, uncertain: 0, verified: 0 }, usageToday: usage?.admitted ?? 0, limits });
    });

    app.get('/v1/otp/pools', { schema: { tags, summary: 'List OTP sender pools' } }, async (req) => {
      assertManage(req);
      const pools = await sql<PoolRow[]>`
        select id, workspace_id, name, status, is_default, code_length, ttl_seconds, max_attempts, resend_cooldown_sec, max_sends
        from otp_sender_pools where workspace_id = ${req.auth.workspaceId} and status <> 'archived' order by created_at`;
      const members = pools.length
        ? await sql<{ pool_id: string; session_id: string; name: string; status: string; phone: string | null; enabled: boolean; membership: string; queued: number }[]>`
            select m.pool_id, m.session_id, s.name, s.status, s.phone, m.enabled, m.membership,
              (select count(*)::int from messages q where q.session_id = s.id and q.otp_challenge_id is not null and q.status = 'queued') as queued
            from otp_sender_pool_members m join sessions s on s.id = m.session_id
            where m.pool_id = any(${pools.map((p) => p.id)}::uuid[])`
        : [];
      return ok({
        limits: otpPlanLimits(req.auth.planId),
        pools: pools.map((p) => ({ ...p, members: members.filter((m) => m.pool_id === p.id) })),
      });
    });

    app.post('/v1/otp/pools', { schema: { tags, summary: 'Create an OTP sender pool', body: poolBody } }, async (req, reply) => {
      assertManage(req);
      assertActive(req.auth);
      const limits = otpPlanLimits(req.auth.planId);
      const sessionIds = [...new Set(req.body.sessionIds ?? [])];
      if (sessionIds.length > limits.sessionsPerPool) throw conflict(`This plan allows ${limits.sessionsPerPool} session(s) per pool`, 'pool_session_limit');
      const id = await sql.begin(async (tx) => {
        await tx`select id from workspaces where id = ${req.auth.workspaceId} for update`;
        const [n] = await tx<{ n: number }[]>`select count(*)::int as n from otp_sender_pools where workspace_id = ${req.auth.workspaceId} and status <> 'archived'`;
        if ((n?.n ?? 0) >= limits.pools) throw conflict(`This plan allows ${limits.pools} OTP pool(s)`, 'pool_limit');
        if (sessionIds.length) {
          const owned = await tx<{ id: string }[]>`select id from sessions where workspace_id = ${req.auth.workspaceId} and id = any(${sessionIds}::uuid[])`;
          if (owned.length !== sessionIds.length) throw notFound('Session not found', 'session_not_found');
        }
        const [countDefault] = await tx<{ n: number }[]>`select count(*)::int as n from otp_sender_pools where workspace_id = ${req.auth.workspaceId} and is_default and status <> 'archived'`;
        const makeDefault = req.body.makeDefault === true || (countDefault?.n ?? 0) === 0;
        if (makeDefault) await tx`update otp_sender_pools set is_default = false, updated_at = now() where workspace_id = ${req.auth.workspaceId} and is_default`;
        const [pool] = await tx<{ id: string }[]>`
          insert into otp_sender_pools (workspace_id, name, is_default) values (${req.auth.workspaceId}, ${req.body.name}, ${makeDefault}) returning id`;
        for (const sessionId of sessionIds) {
          await tx`insert into otp_sender_pool_members (pool_id, session_id) values (${pool!.id}, ${sessionId})`;
        }
        await audit(tx, req, { action: 'otp_pool.create', targetType: 'otp_pool', targetId: pool!.id, targetLabel: req.body.name });
        return pool!.id;
      });
      reply.code(201);
      return ok({ id });
    });

    app.patch('/v1/otp/pools/:id', {
      schema: { tags, summary: 'Rename a pool or change OTP settings', params: z.object({ id: z.uuid() }), body: settingsBody.extend({ name: z.string().trim().min(1).max(80).optional(), status: z.enum(['active', 'paused']).optional() }) },
    }, async (req) => {
      assertManage(req);
      await ownedPool(req.auth.workspaceId, req.params.id);
      const b = req.body;
      await sql`
        update otp_sender_pools set
          name = coalesce(${b.name ?? null}, name),
          status = coalesce(${b.status ?? null}, status),
          code_length = coalesce(${b.codeLength ?? null}, code_length),
          ttl_seconds = coalesce(${b.ttlSeconds ?? null}, ttl_seconds),
          max_attempts = coalesce(${b.maxAttempts ?? null}, max_attempts),
          resend_cooldown_sec = coalesce(${b.resendCooldownSec ?? null}, resend_cooldown_sec),
          max_sends = coalesce(${b.maxSends ?? null}, max_sends),
          updated_at = now()
        where id = ${req.params.id} and workspace_id = ${req.auth.workspaceId}`;
      return ok({ id: req.params.id });
    });

    app.post('/v1/otp/pools/:id/default', { schema: { tags, params: z.object({ id: z.uuid() }) } }, async (req) => {
      assertManage(req);
      await sql.begin(async (tx) => {
        const pool = await tx<PoolRow[]>`select id from otp_sender_pools where id = ${req.params.id} and workspace_id = ${req.auth.workspaceId} and status <> 'archived'`;
        if (!pool.length) throw notFound('Sender pool not found', 'pool_not_found');
        await tx`update otp_sender_pools set is_default = false, updated_at = now() where workspace_id = ${req.auth.workspaceId} and is_default`;
        await tx`update otp_sender_pools set is_default = true, updated_at = now() where id = ${req.params.id}`;
      });
      return ok({ id: req.params.id, isDefault: true });
    });

    app.delete('/v1/otp/pools/:id', { schema: { tags, params: z.object({ id: z.uuid() }) } }, async (req) => {
      assertManage(req);
      await sql.begin(async (tx) => {
        const [busy] = await tx<{ n: number }[]>`
          select count(*)::int as n from otp_challenges
          where pool_id = ${req.params.id} and workspace_id = ${req.auth.workspaceId} and delivery_status in ('queued', 'processing', 'uncertain')`;
        if ((busy?.n ?? 0) > 0) throw conflict('This pool still has OTP jobs in progress', 'pool_busy');
        await tx`update otp_challenges set pool_id = null where pool_id = ${req.params.id}`;
        const [gone] = await tx<{ id: string }[]>`delete from otp_sender_pools where id = ${req.params.id} and workspace_id = ${req.auth.workspaceId} returning id`;
        if (!gone) throw notFound('Sender pool not found', 'pool_not_found');
        await audit(tx, req, { action: 'otp_pool.delete', targetType: 'otp_pool', targetId: req.params.id });
      });
      return ok({ deleted: true });
    });

    app.post('/v1/otp/pools/:id/members', {
      schema: { tags, params: z.object({ id: z.uuid() }), body: z.object({ sessionId: z.uuid() }) },
    }, async (req) => {
      assertManage(req);
      const limits = otpPlanLimits(req.auth.planId);
      await sql.begin(async (tx) => {
        const [pool] = await tx`select id from otp_sender_pools where id = ${req.params.id} and workspace_id = ${req.auth.workspaceId} and status <> 'archived' for update`;
        if (!pool) throw notFound('Sender pool not found', 'pool_not_found');
        const [session] = await tx`select id from sessions where id = ${req.body.sessionId} and workspace_id = ${req.auth.workspaceId}`;
        if (!session) throw notFound('Session not found', 'session_not_found');
        const [n] = await tx<{ n: number }[]>`select count(*)::int as n from otp_sender_pool_members where pool_id = ${req.params.id}`;
        if ((n?.n ?? 0) >= limits.sessionsPerPool) throw conflict(`This plan allows ${limits.sessionsPerPool} session(s) per pool`, 'pool_session_limit');
        await tx`
          insert into otp_sender_pool_members (pool_id, session_id) values (${req.params.id}, ${req.body.sessionId})
          on conflict (pool_id, session_id) do update set membership = 'active', enabled = true`;
      });
      return ok({ sessionId: req.body.sessionId });
    });

    app.patch('/v1/otp/pools/:id/members/:sessionId', {
      schema: { tags, params: z.object({ id: z.uuid(), sessionId: z.uuid() }), body: z.object({ enabled: z.boolean() }) },
    }, async (req) => {
      assertManage(req);
      const [row] = await sql<{ session_id: string }[]>`
        update otp_sender_pool_members set enabled = ${req.body.enabled},
          membership = case when ${req.body.enabled} then 'active' else membership end
        where pool_id = ${req.params.id} and session_id = ${req.params.sessionId}
          and pool_id in (select id from otp_sender_pools where workspace_id = ${req.auth.workspaceId})
        returning session_id`;
      if (!row) throw notFound('Session is not in this pool', 'member_not_found');
      return ok({ sessionId: row.session_id, enabled: req.body.enabled });
    });

    app.delete('/v1/otp/pools/:id/members/:sessionId', {
      schema: { tags, params: z.object({ id: z.uuid(), sessionId: z.uuid() }) },
    }, async (req) => {
      assertManage(req);
      const result = await sql.begin(async (tx) => {
        const [open] = await tx<{ n: number }[]>`
          select count(*)::int as n from otp_challenges
          where pool_id = ${req.params.id} and session_id = ${req.params.sessionId} and delivery_status in ('queued', 'processing')`;
        if ((open?.n ?? 0) > 0) {
          const [row] = await tx<{ session_id: string }[]>`
            update otp_sender_pool_members set membership = 'draining', enabled = false
            where pool_id = ${req.params.id} and session_id = ${req.params.sessionId}
            returning session_id`;
          if (!row) throw notFound('Session is not in this pool', 'member_not_found');
          return { draining: true as const };
        }
        const [row] = await tx<{ session_id: string }[]>`
          delete from otp_sender_pool_members where pool_id = ${req.params.id} and session_id = ${req.params.sessionId}
            and pool_id in (select id from otp_sender_pools where workspace_id = ${req.auth.workspaceId})
          returning session_id`;
        if (!row) throw notFound('Session is not in this pool', 'member_not_found');
        return { draining: false as const };
      });
      return ok(result);
    });

    app.post('/v1/otp/keys', {
      schema: {
        tags,
        summary: 'Create a key that can only call the OTP gateway',
        body: z.object({ name: z.string().trim().min(1).max(80), poolId: z.uuid().optional(), expiresInDays: z.number().int().min(1).max(365).optional() }),
      },
    }, async (req, reply) => {
      assertManage(req);
      if (req.body.poolId) await ownedPool(req.auth.workspaceId, req.body.poolId);
      const key = generateKey('pat');
      const expires = req.body.expiresInDays ? new Date(Date.now() + req.body.expiresInDays * 86_400_000) : null;
      await sql.begin(async (tx) => {
        await tx`select id from workspaces where id = ${req.auth.workspaceId} for update`;
        const [keys] = await tx<{ n: number }[]>`
          select count(*)::int as n from api_keys where workspace_id = ${req.auth.workspaceId} and revoked_at is null and not ('console' = any(scopes))`;
        const [numbers] = await tx<{ n: number }[]>`select count(*)::int as n from sessions where workspace_id = ${req.auth.workspaceId}`;
        if ((keys?.n ?? 0) >= 20 + (numbers?.n ?? 0)) throw conflict('Key limit reached', 'key_limit');
        await tx`
          insert into api_keys (workspace_id, name, key_hash, prefix, scopes, otp_pool_id, expires_at)
          values (${req.auth.workspaceId}, ${req.body.name}, ${key.hash}, ${key.prefix}, ${['otp:send', 'otp:verify']}::text[], ${req.body.poolId ?? null}, ${expires})`;
      });
      reply.code(201);
      return ok({ key: key.key, prefix: key.prefix, poolId: req.body.poolId ?? null, expiresAt: expires?.toISOString() ?? null });
    });

    app.get('/v1/otp/keys', { schema: { tags, summary: 'List OTP keys for this workspace. The secret is never returned.' } }, async (req) => {
      assertManage(req);
      const rows = await sql<
        { id: string; name: string; prefix: string; pool_id: string | null; pool_name: string | null; last_used_at: Date | string | null; created_at: Date | string; expires_at: Date | string | null }[]
      >`
        select k.id, k.name, k.prefix, k.otp_pool_id as pool_id, p.name as pool_name, k.last_used_at, k.created_at, k.expires_at
        from api_keys k
        left join otp_sender_pools p on p.id = k.otp_pool_id and p.workspace_id = k.workspace_id
        where k.workspace_id = ${req.auth.workspaceId} and k.revoked_at is null and 'otp:send' = any(k.scopes)
        order by k.created_at desc`;
      const iso = (value: Date | string | null) => (value == null ? null : new Date(value).toISOString());
      return ok({
        keys: rows.map((r) => ({
          id: r.id,
          name: r.name,
          prefix: r.prefix,
          poolId: r.pool_id,
          poolName: r.pool_name,
          lastUsedAt: iso(r.last_used_at),
          createdAt: iso(r.created_at),
          expiresAt: iso(r.expires_at),
        })),
      });
    });

    app.get('/v1/otp/logs', { schema: { tags, querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }) } }, async (req) => {
      assertManage(req);
      const rows = await sql<
        { id: string; pool_id: string | null; session_id: string | null; phone: string; purpose: string; delivery_status: OtpDeliveryStatus; verify_status: OtpVerifyStatus; failure: string | null; expires_at: Date; created_at: Date }[]
      >`
        select id, pool_id, session_id, phone, purpose, delivery_status, verify_status, failure, expires_at, created_at
        from otp_challenges where workspace_id = ${req.auth.workspaceId}
        order by created_at desc limit ${req.query.limit}`;
      return ok({
        logs: rows.map((r) => ({
          requestId: r.id,
          poolId: r.pool_id,
          sessionId: r.session_id,
          to: maskPhoneNumber(r.phone),
          purpose: r.purpose,
          deliveryStatus: r.delivery_status,
          verifyStatus: r.verify_status,
          failure: r.failure,
          expiresAt: r.expires_at,
          createdAt: r.created_at,
        })),
      });
    });

    const sendBody = z.object({
      senderPoolId: z.uuid().optional(),
      to: z.string().min(3).max(32),
      purpose: z.enum(OTP_PURPOSES).default('login'),
      ttlSeconds: z.number().int().min(60).max(600).optional(),
      lang: z.enum(['ar', 'en']).default('ar'),
    });

    const queued = z.object({ requestId: z.string().uuid(), status: z.literal('queued'), expiresIn: z.number().int() });

    app.post('/v1/otp/send', {
      schema: {
        tags,
        summary: 'Queue an OTP through a sender pool. The code is not returned.',
        headers: z.object({ 'idempotency-key': z.string().min(8).max(200) }),
        body: sendBody,
        response: { 200: successSchema(queued) },
      },
    }, async (req) => {
      assertWorkspaceKey(req);
      assertScope(req, 'otp:send');
      assertActive(req.auth);
      const phone = normalizePhone(req.body.to);
      if (!phone) throw unprocessable('Invalid recipient', { to: ['Use an E.164 number like +201012345678'] });
      const idempotencyKey = req.headers['idempotency-key'];

      const created = await sql.begin(async (tx) => {
        const [existing] = await tx<{ id: string; phone: string; expires_at: Date; delivery_status: string }[]>`
          select id, phone, expires_at, delivery_status from otp_challenges
          where workspace_id = ${req.auth.workspaceId} and idempotency_key = ${idempotencyKey}`;
        if (existing) {
          if (existing.phone !== phone) throw conflict('Idempotency key was used for a different recipient', 'idempotency_conflict');
          return { requestId: existing.id, status: 'queued' as const, expiresIn: Math.max(0, Math.ceil((new Date(existing.expires_at).getTime() - Date.now()) / 1000)), sessionId: null as string | null, replay: true };
        }
        await throttle.consume(
          [
            { key: `otp-gw:${req.auth.workspaceId}:${phone}`, limit: 5, windowSec: 3600 },
            { key: `otp-gw-day:${req.auth.workspaceId}:${phone}`, limit: 10, windowSec: 86_400 },
          ],
          'Too many codes for this number. Try again later.',
        );
        let poolId = req.body.senderPoolId ?? req.auth.otpPoolId;
        if (req.auth.otpPoolId && req.body.senderPoolId && req.body.senderPoolId !== req.auth.otpPoolId) {
          throw forbidden('This key is limited to its sender pool', 'pool_forbidden');
        }
        if (!poolId) {
          const [def] = await tx<{ id: string }[]>`select id from otp_sender_pools where workspace_id = ${req.auth.workspaceId} and is_default and status = 'active'`;
          poolId = def?.id ?? null;
        }
        if (!poolId) throw notFound('No default sender pool', 'pool_not_found');
        const [pool] = await tx<PoolRow[]>`
          select id, workspace_id, name, status, is_default, code_length, ttl_seconds, max_attempts, resend_cooldown_sec, max_sends
          from otp_sender_pools where id = ${poolId} and workspace_id = ${req.auth.workspaceId} and status <> 'archived' for update`;
        if (!pool) throw notFound('Sender pool not found', 'pool_not_found');
        if (pool.status !== 'active') throw conflict('This sender pool is paused', 'pool_paused');
        const ttl = Math.min(pool.ttl_seconds, req.body.ttlSeconds ?? pool.ttl_seconds);
        const limits = otpPlanLimits(req.auth.planId);
        const options = await candidates(pool.id);
        const choice = chooseOtpSession(options, { ttlRemainingMs: ttl * 1000, maxQueue: limits.queuePerSession });
        if (!choice) throw tooMany('No sender can deliver this code before it expires', retryAfterSeconds(OTP_DEFAULT_SEND_MS), 'otp_capacity');
        const id = randomUUID();
        const code = String(randomInt(0, 10 ** pool.code_length)).padStart(pool.code_length, '0');
        const text = formatOtpMessage(code, req.body.lang, ttl);
        const blob = seal(id, text);
        const expiresAt = new Date(Date.now() + ttl * 1000);
        const jid = toJid(phone);
        if (!jid) throw unprocessable('Invalid recipient', { to: ['Use an E.164 number'] });
        await tx`savepoint otp_idem`;
        await assertSessionRoom(tx, choice.sessionId, limits.queuePerSession);
        try {
          await tx`
            insert into otp_challenges (id, workspace_id, pool_id, session_id, phone, purpose, lang, code_hash, delivery_ciphertext, expires_at, max_attempts, max_sends, resend_cooldown_sec, idempotency_key)
            values (${id}, ${req.auth.workspaceId}, ${pool.id}, ${choice.sessionId}, ${phone}, ${req.body.purpose}, ${req.body.lang}, ${hashOtp(otp.key, id, code)}, ${blob}, ${expiresAt}, ${pool.max_attempts}, ${pool.max_sends}, ${pool.resend_cooldown_sec}, ${idempotencyKey})`;
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code !== '23505') throw err;
          await tx`rollback to savepoint otp_idem`;
          const [again] = await tx<{ id: string; phone: string; expires_at: Date }[]>`
            select id, phone, expires_at from otp_challenges where workspace_id = ${req.auth.workspaceId} and idempotency_key = ${idempotencyKey}`;
          if (!again || again.phone !== phone) throw conflict('Idempotency key was used for a different recipient', 'idempotency_conflict');
          return { requestId: again.id, status: 'queued' as const, expiresIn: Math.max(0, Math.ceil((new Date(again.expires_at).getTime() - Date.now()) / 1000)), sessionId: null, replay: true };
        }
        await admitDaily(tx, req.auth.workspaceId, limits.daily);
        await enqueue(tx, { workspaceId: req.auth.workspaceId, challengeId: id, sessionId: choice.sessionId, jid, expiresAt });
        return { requestId: id, status: 'queued' as const, expiresIn: ttl, sessionId: choice.sessionId, replay: false };
      });
      if (!created.replay && created.sessionId) await notify(sql, CHANNELS.control, { type: 'message.queued', sessionId: created.sessionId }).catch(() => {});
      return ok({ requestId: created.requestId, status: created.status, expiresIn: created.expiresIn });
    });

    app.post('/v1/otp/verify', {
      schema: { tags, body: z.object({ requestId: z.uuid(), code: z.string().min(4).max(12) }) },
    }, async (req) => {
      assertWorkspaceKey(req);
      assertScope(req, 'otp:verify');
      const code = req.body.code.replace(/\D/g, '');
      const [row] = await sql<{ id: string; code_hash: string; attempts: number; max_attempts: number; expired: boolean; verify_status: string }[]>`
        update otp_challenges set attempts = attempts + 1, updated_at = now()
        where id = ${req.body.requestId} and workspace_id = ${req.auth.workspaceId} and consumed_at is null and verify_status = 'open' and attempts < max_attempts
        returning id, code_hash, attempts, max_attempts, expires_at <= now() as expired, verify_status`;
      if (!row) {
        const [spent] = await sql`select 1 from otp_challenges where id = ${req.body.requestId} and workspace_id = ${req.auth.workspaceId} and verify_status = 'open' and attempts >= max_attempts`;
        if (spent) {
          await sql`update otp_challenges set verify_status = 'locked', updated_at = now() where id = ${req.body.requestId} and verify_status = 'open'`;
          throw tooMany('Too many incorrect codes', 60, 'too_many_attempts');
        }
        throw notFound('This code has expired or was already used', 'challenge_not_found');
      }
      if (row.expired) {
        await sql`update otp_challenges set verify_status = 'expired', delivery_ciphertext = null, updated_at = now() where id = ${row.id} and verify_status = 'open'`;
        throw unprocessable('This code has expired', { code: ['Expired'] }, { code: 'code_expired' });
      }
      if (!otpMatches(otp.key, row.id, code, row.code_hash)) {
        throw unprocessable('The code is incorrect', { code: ['Incorrect code'] }, { code: 'code_invalid', details: { attemptsLeft: row.max_attempts - row.attempts } });
      }
      const [consumed] = await sql`update otp_challenges set consumed_at = now(), verify_status = 'verified', delivery_ciphertext = null, updated_at = now() where id = ${row.id} and consumed_at is null returning id`;
      if (!consumed) throw notFound('This code has expired or was already used', 'challenge_not_found');
      return ok({ verified: true, requestId: row.id });
    });

    app.get('/v1/otp/:requestId', { schema: { tags, params: z.object({ requestId: z.uuid() }) } }, async (req) => {
      assertWorkspaceKey(req);
      assertScope(req, 'otp:send');
      const [row] = await sql<{
        id: string; delivery_status: OtpDeliveryStatus; verify_status: OtpVerifyStatus; expires_at: Date; failure: string | null;
        send_started: boolean; sends: number; max_sends: number; last_sent_at: Date; resend_cooldown_sec: number; session_id: string | null;
      }[]>`
        select id, delivery_status, verify_status, expires_at, failure, send_started, sends, max_sends, last_sent_at, resend_cooldown_sec, session_id
        from otp_challenges where id = ${req.params.requestId} and workspace_id = ${req.auth.workspaceId}`;
      if (!row) throw notFound('This code has expired or was already used', 'challenge_not_found');
      const decision = decideResend({
        verifyStatus: row.verify_status,
        deliveryStatus: row.delivery_status,
        sendStarted: row.send_started,
        sends: row.sends,
        maxSends: row.max_sends,
        lastSentAtMs: new Date(row.last_sent_at).getTime(),
        cooldownSec: row.resend_cooldown_sec,
        expiresAtMs: new Date(row.expires_at).getTime(),
        nowMs: Date.now(),
        sessionRestricted: false,
        sessionId: row.session_id,
      });
      return ok({
        requestId: row.id,
        status: row.delivery_status,
        verification: row.verify_status,
        expiresAt: row.expires_at,
        failure: row.failure,
        retryable: decision.action !== 'reject',
      });
    });

    app.post('/v1/otp/resend', {
      schema: { tags, body: z.object({ requestId: z.uuid() }) },
    }, async (req) => {
      assertWorkspaceKey(req);
      assertScope(req, 'otp:send');
      assertActive(req.auth);
      const outcome = await sql.begin(async (tx) => {
        const [row] = await tx<{
          id: string; pool_id: string | null; session_id: string | null; phone: string; lang: string; verify_status: OtpVerifyStatus;
          delivery_status: OtpDeliveryStatus; send_started: boolean; sends: number; max_sends: number; last_sent_at: Date;
          resend_cooldown_sec: number; expires_at: Date; code_length: number; restricted: boolean;
        }[]>`
          select c.id, c.pool_id, c.session_id, c.phone, c.lang, c.verify_status, c.delivery_status, c.send_started, c.sends, c.max_sends,
            c.last_sent_at, c.resend_cooldown_sec, c.expires_at, p.code_length,
            coalesce(s.restricted_at > now() - interval '1 day', false) as restricted
          from otp_challenges c
          left join otp_sender_pools p on p.id = c.pool_id
          left join sessions s on s.id = c.session_id
          where c.id = ${req.body.requestId} and c.workspace_id = ${req.auth.workspaceId}
          for update of c`;
        if (!row || !row.pool_id) throw notFound('This code has expired or was already used', 'challenge_not_found');
        const decision = decideResend({
          verifyStatus: row.verify_status,
          deliveryStatus: row.delivery_status,
          sendStarted: row.send_started,
          sends: row.sends,
          maxSends: row.max_sends,
          lastSentAtMs: new Date(row.last_sent_at).getTime(),
          cooldownSec: row.resend_cooldown_sec,
          expiresAtMs: new Date(row.expires_at).getTime(),
          nowMs: Date.now(),
          sessionRestricted: row.restricted,
          sessionId: row.session_id,
        });
        if (decision.action === 'reject') {
          const status = decision.code === 'cooldown' || decision.code === 'too_many_sends' ? 429 : 409;
          throw status === 429 ? tooMany(decision.code, row.resend_cooldown_sec, decision.code) : conflict(decision.code, decision.code);
        }
        const remainingMs = new Date(row.expires_at).getTime() - Date.now();
        const limits = otpPlanLimits(req.auth.planId);
        let sessionId = decision.action === 'replay' ? decision.sessionId : null;
        if (!sessionId) {
          const options = await candidates(row.pool_id);
          const choice = chooseOtpSession(options, { ttlRemainingMs: remainingMs, maxQueue: limits.queuePerSession });
          if (!choice) throw tooMany('No sender can deliver this code before it expires', retryAfterSeconds(OTP_DEFAULT_SEND_MS), 'otp_capacity');
          sessionId = choice.sessionId;
        }
        const length = row.code_length || 6;
        const code = String(randomInt(0, 10 ** length)).padStart(length, '0');
        const text = formatOtpMessage(code, row.lang, Math.max(1, Math.round(remainingMs / 1000)));
        const blob = seal(row.id, text);
        const jid = toJid(row.phone);
        if (!jid) throw unprocessable('Invalid recipient', { to: ['Invalid phone'] });
        await assertSessionRoom(tx, sessionId, limits.queuePerSession);
        await tx`
          update otp_challenges set code_hash = ${hashOtp(otp.key, row.id, code)}, delivery_ciphertext = ${blob}, attempts = 0,
            sends = sends + 1, last_sent_at = now(), send_started = false, delivery_status = 'queued', failure = null, updated_at = now()
          where id = ${row.id}`;
        await enqueue(tx, { workspaceId: req.auth.workspaceId, challengeId: row.id, sessionId, jid, expiresAt: new Date(row.expires_at) });
        return { requestId: row.id, sessionId, expiresIn: Math.max(0, Math.ceil(remainingMs / 1000)) };
      });
      await notify(sql, CHANNELS.control, { type: 'message.queued', sessionId: outcome.sessionId }).catch(() => {});
      return ok({ requestId: outcome.requestId, status: 'queued' as const, expiresIn: outcome.expiresIn });
    });

    app.post('/v1/otp/admin/pools/:id/pause', { schema: { tags, params: z.object({ id: z.uuid() }) } }, async (req) => {
      requireAdmin(req);
      const [row] = await sql<{ id: string; workspace_id: string }[]>`
        update otp_sender_pools set status = 'paused', updated_at = now() where id = ${req.params.id} and status = 'active' returning id, workspace_id`;
      if (!row) throw notFound('Sender pool not found', 'pool_not_found');
      await audit(sql, req, { action: 'otp_pool.pause', targetType: 'otp_pool', targetId: row.id, details: { workspaceId: row.workspace_id } });
      return ok({ id: row.id, status: 'paused' });
    });
  };
}
