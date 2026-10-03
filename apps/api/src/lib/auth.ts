import { notify, type Sql, type UserStatus } from '@wa/db';
import { type AuthInvalidation, CHANNELS } from '@wa/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { badRequest, forbidden, notFound, unauthorized } from './errors';
import { hashKey, type KeyKind } from './keys';
import { createFailureGuard } from './throttle';

export type AuthContext = {
  keyId: string;
  kind: KeyKind;
  workspaceId: string;
  /** Set for session keys: the only session the key may act on. */
  keySessionId: string | null;
  planId: string;
  trialEndsAt: Date | null;
  planExpiresAt: Date | null;
  /** The workspace owner; null for a workspace without one. */
  userId: string | null;
  /** The workspace owner has the `admin` role (see /api/admin). */
  isAdmin: boolean;
  userStatus: UserStatus | null;
  suspendedReason: string | null;
  /** The owner confirmed a phone number by code. Required to request a plan (admins are exempt). */
  phoneVerified: boolean;
  /** Dashboard login token (scope `console`): expires and is revoked on logout. */
  console: boolean;
  expiresAt: Date | null;
};

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
    /** How the credential arrived: `cookie` = the dashboard's HttpOnly session cookie. */
    authVia: 'bearer' | 'cookie';
  }
}

/** HttpOnly session cookie of the dashboard; holds a console token, only ever sent to /api. */
export const SESSION_COOKIE = 'wa_session';
/** Console token lifetimes: "remember me" vs this browser session. */
export const CONSOLE_TTL_SEC = { remember: 30 * 86_400, session: 12 * 3600 } as const;

const CACHE_TTL_MS = 30_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF guard for cookie-authenticated writes. The cookie is SameSite=Strict, so other sites can't
 * send it; this also refuses same-site but cross-origin pages (sibling subdomains on a shared host).
 * Browsers send Sec-Fetch-Site; older ones are checked by Origin. Non-browser clients send neither
 * and don't carry ambient cookies.
 */
function assertSameOrigin(req: FastifyRequest) {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string') {
    if (site === 'same-origin' || site === 'none') return;
    throw forbidden('Cross-site request blocked', 'csrf_blocked');
  }
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return;
  let host: string | null = null;
  try {
    host = new URL(origin).host;
  } catch {
    // "null" origin (sandboxed frame, file://)
  }
  if (host !== req.host) throw forbidden('Cross-site request blocked', 'csrf_blocked');
}

export const suspendedError = (reason: string | null) =>
  forbidden('This account has been suspended. Contact support.', 'account_suspended', reason ? { reason } : undefined);

/**
 * Bearer-key or session-cookie authentication. Lookups are cached for 30s per process (including
 * misses, to blunt brute force); `revoke` clears entries on every API instance via NOTIFY.
 */
export function createAuth(sql: Sql) {
  const cache = new Map<string, { ctx: AuthContext | null; expires: number }>();
  const touched = new Map<string, number>();
  const guard = createFailureGuard();

  async function lookup(hash: string): Promise<AuthContext | null> {
    const hit = cache.get(hash);
    if (hit && hit.expires > Date.now()) return hit.ctx;
    const [row] = await sql<
      {
        id: string;
        workspace_id: string;
        session_id: string | null;
        scopes: string[];
        expires_at: Date | null;
        plan_id: string;
        trial_ends_at: Date | null;
        plan_expires_at: Date | null;
        user_id: string | null;
        role: string | null;
        status: UserStatus | null;
        suspended_reason: string | null;
        phone_verified: boolean | null;
      }[]
    >`
      select k.id, k.workspace_id, k.session_id, k.scopes, k.expires_at, w.plan_id, w.trial_ends_at, w.plan_expires_at,
        u.id as user_id, u.role, u.status, u.suspended_reason, u.phone_verified_at is not null as phone_verified
      from api_keys k
      join workspaces w on w.id = k.workspace_id
      left join users u on u.id = w.owner_id
      where k.key_hash = ${hash} and k.revoked_at is null`;
    const ctx: AuthContext | null = row
      ? {
          keyId: row.id,
          kind: row.session_id ? 'session' : 'pat',
          workspaceId: row.workspace_id,
          keySessionId: row.session_id,
          planId: row.plan_id,
          trialEndsAt: row.trial_ends_at,
          planExpiresAt: row.plan_expires_at,
          userId: row.user_id,
          isAdmin: row.role === 'admin',
          userStatus: row.status,
          suspendedReason: row.suspended_reason,
          phoneVerified: row.phone_verified === true,
          console: row.scopes.includes('console'),
          expiresAt: row.expires_at,
        }
      : null;
    if (cache.size > 10_000) cache.clear();
    cache.set(hash, { ctx, expires: Date.now() + CACHE_TTL_MS });
    return ctx;
  }

  /** Records last use at most once a minute per key. */
  function touch(keyId: string) {
    const last = touched.get(keyId) ?? 0;
    if (Date.now() - last < 60_000) return;
    if (touched.size > 10_000) touched.clear();
    touched.set(keyId, Date.now());
    sql`update api_keys set last_used_at = now() where id = ${keyId}`.catch(() => {});
  }

  function invalidate(match: (ctx: AuthContext) => boolean) {
    for (const [hash, entry] of cache) if (entry.ctx && match(entry.ctx)) cache.delete(hash);
  }

  const matches = (target: AuthInvalidation) => (ctx: AuthContext) =>
    Boolean(target.workspaceIds?.includes(ctx.workspaceId) || target.keyIds?.includes(ctx.keyId));

  return {
    async authenticate(req: FastifyRequest) {
      const header = req.headers.authorization;
      let token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
      let via: 'bearer' | 'cookie' = 'bearer';
      if (!token) {
        token = req.cookies[SESSION_COOKIE] ?? '';
        via = 'cookie';
      }
      if (!token) throw unauthorized();
      if (via === 'cookie' && UNSAFE_METHODS.has(req.method)) assertSameOrigin(req);
      guard.check(req.ip);
      const ctx = await lookup(hashKey(token));
      // A cookie only ever carries a console token; anything else in it is treated as no session.
      if (!ctx || (ctx.expiresAt && ctx.expiresAt.getTime() < Date.now()) || (via === 'cookie' && !ctx.console)) {
        guard.fail(req.ip);
        throw via === 'cookie' ? unauthorized('Your session has ended. Log in again.', 'session_expired') : unauthorized();
      }
      if (ctx.userStatus === 'suspended') throw suspendedError(ctx.suspendedReason);
      req.auth = ctx;
      req.authVia = via;
      touch(ctx.keyId);
    },
    /** Drops cached entries in this process only. */
    invalidate,
    /** Applies an invalidation received from another instance (`wa_auth`). */
    apply(target: AuthInvalidation) {
      invalidate(matches(target));
    },
    /** Drops cached credentials for keys or whole workspaces here and on every other API instance. */
    async revoke(target: AuthInvalidation) {
      invalidate(matches(target));
      await notify(sql, CHANNELS.auth, target).catch(() => {});
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;

export function setSessionCookie(reply: FastifyReply, token: string, { remember, secure }: { remember: boolean; secure: boolean }) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/api',
    httpOnly: true,
    sameSite: 'strict',
    secure,
    ...(remember ? { maxAge: CONSOLE_TTL_SEC.remember } : {}),
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean) {
  reply.clearCookie(SESSION_COOKIE, { path: '/api', httpOnly: true, sameSite: 'strict', secure });
}

export function requirePat(req: FastifyRequest) {
  if (req.auth.kind !== 'pat') throw forbidden('This endpoint needs a workspace access token (wap_…), not a session key', 'pat_required');
}

export function requireAdmin(req: FastifyRequest) {
  requirePat(req);
  if (!req.auth.isAdmin) throw forbidden('Admins only', 'admin_only');
}

export type ScopedSession = {
  id: string;
  workspace_id: string;
  status: string;
  desired_state: string;
  phone: string | null;
};

/** The session a request acts on: the session key's own session, or `X-Session-Id` with a workspace token. */
export async function resolveSession(sql: Sql, req: FastifyRequest): Promise<ScopedSession> {
  let id = req.auth.keySessionId;
  if (!id) {
    const header = req.headers['x-session-id'];
    if (typeof header !== 'string' || !UUID_RE.test(header)) {
      throw badRequest('X-Session-Id header is required when using a workspace access token', 'session_id_required');
    }
    id = header;
  }
  const [session] = await sql<ScopedSession[]>`
    select id, workspace_id, status, desired_state, phone from sessions
    where id = ${id} and workspace_id = ${req.auth.workspaceId}`;
  if (!session) throw notFound('Session not found');
  return session;
}

/** For `/:id` routes that name a session explicitly: it must be in the caller's workspace. */
export async function ownedSession(sql: Sql, req: FastifyRequest, id: string): Promise<ScopedSession> {
  if (req.auth.keySessionId && req.auth.keySessionId !== id) throw notFound('Session not found');
  const [session] = await sql<ScopedSession[]>`
    select id, workspace_id, status, desired_state, phone from sessions
    where id = ${id} and workspace_id = ${req.auth.workspaceId}`;
  if (!session) throw notFound('Session not found');
  return session;
}
