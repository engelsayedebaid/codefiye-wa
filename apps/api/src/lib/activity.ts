import type { Sql, UserEventType } from '@wa/db';
import type { FastifyRequest } from 'fastify';

/** A visit ends after this much silence; the next ping starts a new one. */
export const VISIT_GAP_SEC = 5 * 60;
/** The most one ping adds to a visit's active time (the dashboard pings once a minute while in use). */
const MAX_CREDIT_SEC = 60;
/** Pinged within this = online now. */
export const ONLINE_WINDOW_SEC = 2 * 60;
/** How long events and visits are kept. */
export const EVENTS_RETENTION_DAYS = 180;
export const VISITS_RETENTION_DAYS = 365;

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Dashboard writes that are not worth a line in the user's log: the activity ping itself, and the
 * chat page's per-message traffic (the messages are stored anyway).
 */
const QUIET_ROUTES = new Set([
  '/api/activity',
  '/api/auth/session',
  '/api/chats/uploads',
  '/api/chats/:sessionId/send',
  '/api/chats/:sessionId/resend',
  '/api/chats/:sessionId/read',
  '/api/chats/:sessionId/flags',
  '/api/chats/:sessionId/watch',
  '/api/chats/:sessionId/typing',
  '/api/chats/:sessionId/react',
  '/api/chats/:sessionId/messages/:messageId/edit',
  '/api/chats/:sessionId/messages/:messageId/delete',
]);

const agentOf = (req: FastifyRequest) => req.headers['user-agent']?.slice(0, 400) ?? null;

/** Appends to `user_events`. Never fails the request it belongs to: a lost log line beats a lost login. */
export async function recordEvent(sql: Sql, req: FastifyRequest, event: { userId: string | null; type: UserEventType; details?: Record<string, unknown> }) {
  try {
    await sql`
      insert into user_events (user_id, type, ip, user_agent, details)
      values (${event.userId}, ${event.type}, ${req.ip}, ${agentOf(req)}, ${sql.json((event.details ?? {}) as never)})`;
  } catch (err) {
    req.log.warn({ err, type: event.type }, 'user event not recorded');
  }
}

/** A dashboard write by a signed-in user, as an `action` event (called once the response is sent). */
export async function recordAction(sql: Sql, req: FastifyRequest, status: number) {
  const route = req.routeOptions.url;
  if (!req.auth?.console || !req.auth.userId || !UNSAFE_METHODS.has(req.method) || !route || QUIET_ROUTES.has(route)) return;
  // A login that ended or a missing key isn't something the user did.
  if (status === 401) return;
  await recordEvent(sql, req, { userId: req.auth.userId, type: 'action', details: { method: req.method, route, status } });
}

/**
 * The dashboard is open and in use: extends the user's open visit (crediting the time since its last
 * ping, at most a minute) or starts a new one. `view` = the user just opened `path`.
 */
export async function recordPing(sql: Sql, req: FastifyRequest, { path, view }: { path: string | null; view: boolean }) {
  const userId = req.auth.userId;
  if (!userId) return;
  const views = view ? 1 : 0;
  await sql`
    with open as (
      select id from user_visits
      where user_id = ${userId} and last_seen_at > now() - make_interval(secs => ${VISIT_GAP_SEC})
      order by last_seen_at desc
      limit 1
      for update
    ), extended as (
      update user_visits v set
        active_seconds = v.active_seconds + least(${MAX_CREDIT_SEC}::int, greatest(0, extract(epoch from now() - v.last_seen_at))::int),
        last_seen_at = now(),
        page_views = v.page_views + ${views}::int,
        last_path = coalesce(${path}, v.last_path)
      from open
      where v.id = open.id
      returning v.id
    )
    insert into user_visits (user_id, key_id, ip, user_agent, entry_path, last_path, page_views)
    select ${userId}, ${req.auth.keyId}, ${req.ip}, ${agentOf(req)}, ${path}, ${path}, ${views}::int
    where not exists (select 1 from extended)`;
  if (view && path) await recordEvent(sql, req, { userId, type: 'page', details: { path } });
}

/** Old events and visits are dead weight; called by the API's periodic sweep. */
export async function pruneActivity(sql: Sql) {
  await sql`delete from user_events where created_at < now() - make_interval(days => ${EVENTS_RETENTION_DAYS})`;
  await sql`delete from user_visits where last_seen_at < now() - make_interval(days => ${VISITS_RETENTION_DAYS})`;
}
