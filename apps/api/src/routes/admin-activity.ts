import type { SqlFragment, UserEventType } from '@wa/db';
import { ok, successSchema } from '@wa/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps';
import { ONLINE_WINDOW_SEC } from '../lib/activity';
import { requireAdmin } from '../lib/auth';
import { notFound } from '../lib/errors';

// Operator endpoints: not part of the public API, so hidden from /docs.
const schemaBase = { tags: ['Admin'], hide: true };

const isTimeZone = (value: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/** The admin's time zone, so days and hours are counted the way they see them. */
const tz = z.string().max(64).refine(isTimeZone, 'Unknown time zone').default('UTC');
/** The period the numbers cover, ending today. */
const days = z.coerce.number().int().min(1).max(180).default(30);
const pageQuery = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};
const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), total: z.number(), page: z.number(), pageSize: z.number() });

const EVENT_TYPES = ['signup', 'login', 'login_failed', 'logout', 'password_reset', 'page', 'action'] as const satisfies readonly UserEventType[];

/** `%term%` for ILIKE with the user's wildcards escaped. */
const likeTerm = (q: string | undefined) => (q ? `%${q.replace(/[%_\\]/g, '\\$&')}%` : null);
const iso = (d: Date | null) => d?.toISOString() ?? null;

const userRef = z.object({ id: z.uuid(), name: z.string().nullable(), email: z.string() });

const dailyPoint = z.object({ day: z.string(), activeUsers: z.number(), visits: z.number(), activeSeconds: z.number(), logins: z.number(), signups: z.number() });

const summaryDto = z.object({
  since: z.string(),
  users: z.number(),
  onlineNow: z.number(),
  online: z.array(userRef.extend({ lastPath: z.string().nullable(), startedAt: z.string(), lastSeenAt: z.string() })),
  activeToday: z.number(),
  active7d: z.number(),
  activePeriod: z.number(),
  visits: z.number(),
  activeSeconds: z.number(),
  avgVisitSeconds: z.number(),
  loginsToday: z.number(),
  loginsPeriod: z.number(),
  failedLogins24h: z.number(),
  newUsers: z.number(),
  daily: z.array(dailyPoint),
  /** Visits started per weekday (0 = Sunday) and hour, in the admin's time zone. */
  heatmap: z.array(z.object({ dow: z.number(), hour: z.number(), visits: z.number() })),
  topUsers: z.array(userRef.extend({ activeSeconds: z.number(), visits: z.number() })),
  topPages: z.array(z.object({ path: z.string(), views: z.number() })),
});

const activityUserDto = userRef.extend({
  role: z.enum(['user', 'admin']),
  status: z.enum(['active', 'suspended']),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  online: z.boolean(),
  visits: z.number(),
  activeSeconds: z.number(),
  lastLoginAt: z.string().nullable(),
  lastIp: z.string().nullable(),
  lastAgent: z.string().nullable(),
  failedLogins: z.number(),
});

const eventDto = z.object({
  id: z.number(),
  type: z.enum(EVENT_TYPES),
  createdAt: z.string(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  user: userRef.nullable(),
});

const visitDto = z.object({
  id: z.uuid(),
  startedAt: z.string(),
  lastSeenAt: z.string(),
  activeSeconds: z.number(),
  pageViews: z.number(),
  entryPath: z.string().nullable(),
  lastPath: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  online: z.boolean(),
  user: userRef,
});

const userDetailDto = z.object({
  user: userRef.extend({
    phone: z.string().nullable(),
    role: z.enum(['user', 'admin']),
    status: z.enum(['active', 'suspended']),
    createdAt: z.string(),
    planId: z.string().nullable(),
    twoFactor: z.boolean(),
  }),
  online: z.boolean(),
  lastSeenAt: z.string().nullable(),
  firstSeenAt: z.string().nullable(),
  stats: z.object({
    visits: z.number(),
    activeSeconds: z.number(),
    avgVisitSeconds: z.number(),
    longestVisitSeconds: z.number(),
    pageViews: z.number(),
    activeDays: z.number(),
    logins: z.number(),
    failedLogins: z.number(),
    actions: z.number(),
  }),
  daily: z.array(z.object({ day: z.string(), activeSeconds: z.number(), visits: z.number() })),
  /** Visits started per hour of the day (0–23), in the admin's time zone. */
  hours: z.array(z.number()),
  devices: z.array(z.object({ userAgent: z.string().nullable(), ip: z.string().nullable(), lastAt: z.string(), visits: z.number() })),
  /** Dashboard logins (console tokens), newest first. */
  logins: z.array(z.object({ id: z.uuid(), createdAt: z.string(), lastUsedAt: z.string().nullable(), expiresAt: z.string().nullable(), revokedAt: z.string().nullable() })),
});

type UserRefRow = { user_id: string; name: string | null; email: string };
const toUserRef = (r: UserRefRow) => ({ id: r.user_id, name: r.name, email: r.email });

/**
 * Who uses the dashboard, when and for how long: online now, daily activity, visits (came in / left /
 * time spent) and a log of logins, failures, page views and actions (see lib/activity.ts).
 */
export function adminActivityRoutes({ sql }: Deps): FastifyPluginAsyncZod {
  /** Start of the period (`days` days ending today) and of today, in the admin's time zone. */
  async function bounds(zone: string, n: number) {
    const [row] = await sql<{ since: Date; today: Date }[]>`
      select ((now() at time zone ${zone})::date - ${n - 1}::int)::timestamp at time zone ${zone} as since,
        date_trunc('day', now() at time zone ${zone}) at time zone ${zone} as today`;
    return row!;
  }

  const online = () => sql`now() - make_interval(secs => ${ONLINE_WINDOW_SEC})`;

  return async (app) => {
    app.addHook('preHandler', async (req) => requireAdmin(req));

    app.get(
      '/summary',
      {
        schema: { ...schemaBase, summary: 'Platform activity: online now, daily use, peak hours', querystring: z.object({ days, tz }), response: { 200: successSchema(summaryDto) } },
      },
      async (req) => {
        const { days: n, tz: zone } = req.query;
        const { since, today } = await bounds(zone, n);
        const [[totals], onlineRows, daily, heatmap, topUsers, topPages] = await Promise.all([
          sql<
            {
              users: number;
              online_now: number;
              active_today: number;
              active_7d: number;
              active_period: number;
              visits: number;
              active_seconds: number;
              avg_visit: number;
              logins_today: number;
              logins_period: number;
              failed_24h: number;
              new_users: number;
            }[]
          >`
            select
              (select count(*)::int from users) as users,
              (select count(distinct user_id)::int from user_visits where last_seen_at > ${online()}) as online_now,
              (select count(distinct user_id)::int from user_visits where last_seen_at >= ${today}) as active_today,
              (select count(distinct user_id)::int from user_visits where last_seen_at >= now() - interval '7 days') as active_7d,
              (select count(distinct user_id)::int from user_visits where last_seen_at >= ${since}) as active_period,
              (select count(*)::int from user_visits where started_at >= ${since}) as visits,
              (select coalesce(sum(active_seconds), 0)::int from user_visits where started_at >= ${since}) as active_seconds,
              (select coalesce(avg(active_seconds), 0)::int from user_visits where started_at >= ${since}) as avg_visit,
              (select count(*)::int from user_events where type = 'login' and created_at >= ${today}) as logins_today,
              (select count(*)::int from user_events where type = 'login' and created_at >= ${since}) as logins_period,
              (select count(*)::int from user_events where type = 'login_failed' and created_at >= now() - interval '24 hours') as failed_24h,
              (select count(*)::int from users where created_at >= ${since}) as new_users`,
          sql<(UserRefRow & { last_path: string | null; started_at: Date; last_seen_at: Date })[]>`
            select * from (
              select distinct on (v.user_id) v.user_id, u.name, u.email, v.last_path, v.started_at, v.last_seen_at
              from user_visits v join users u on u.id = v.user_id
              where v.last_seen_at > ${online()}
              order by v.user_id, v.last_seen_at desc
            ) x order by started_at limit 50`,
          sql<{ day: string; active_users: number; visits: number; active_seconds: number; logins: number; signups: number }[]>`
            with days as (
              select d::date as day
              from generate_series((now() at time zone ${zone})::date - ${n - 1}::int, (now() at time zone ${zone})::date, interval '1 day') d
            ), v as (
              select (started_at at time zone ${zone})::date as day, count(distinct user_id)::int as active_users, count(*)::int as visits,
                coalesce(sum(active_seconds), 0)::int as active_seconds
              from user_visits where started_at >= ${since} group by 1
            ), e as (
              select (created_at at time zone ${zone})::date as day,
                count(*) filter (where type = 'login')::int as logins, count(*) filter (where type = 'signup')::int as signups
              from user_events where created_at >= ${since} and type in ('login', 'signup') group by 1
            )
            select to_char(days.day, 'YYYY-MM-DD') as day, coalesce(v.active_users, 0) as active_users, coalesce(v.visits, 0) as visits,
              coalesce(v.active_seconds, 0) as active_seconds, coalesce(e.logins, 0) as logins, coalesce(e.signups, 0) as signups
            from days left join v using (day) left join e using (day)
            order by days.day`,
          sql<{ dow: number; hour: number; visits: number }[]>`
            select extract(dow from started_at at time zone ${zone})::int as dow, extract(hour from started_at at time zone ${zone})::int as hour, count(*)::int as visits
            from user_visits where started_at >= ${since} group by 1, 2`,
          sql<(UserRefRow & { active_seconds: number; visits: number })[]>`
            select v.user_id, u.name, u.email, sum(v.active_seconds)::int as active_seconds, count(*)::int as visits
            from user_visits v join users u on u.id = v.user_id
            where v.started_at >= ${since}
            group by v.user_id, u.name, u.email
            order by 4 desc, 5 desc limit 8`,
          sql<{ path: string; views: number }[]>`
            select details->>'path' as path, count(*)::int as views
            from user_events where type = 'page' and created_at >= ${since} and details ? 'path'
            group by 1 order by 2 desc limit 8`,
        ]);
        const t = totals!;
        return ok({
          since: since.toISOString(),
          users: t.users,
          onlineNow: t.online_now,
          online: onlineRows.map((r) => ({ ...toUserRef(r), lastPath: r.last_path, startedAt: r.started_at.toISOString(), lastSeenAt: r.last_seen_at.toISOString() })),
          activeToday: t.active_today,
          active7d: t.active_7d,
          activePeriod: t.active_period,
          visits: t.visits,
          activeSeconds: t.active_seconds,
          avgVisitSeconds: t.avg_visit,
          loginsToday: t.logins_today,
          loginsPeriod: t.logins_period,
          failedLogins24h: t.failed_24h,
          newUsers: t.new_users,
          daily: daily.map((d) => ({ day: d.day, activeUsers: d.active_users, visits: d.visits, activeSeconds: d.active_seconds, logins: d.logins, signups: d.signups })),
          heatmap,
          topUsers: topUsers.map((r) => ({ ...toUserRef(r), activeSeconds: r.active_seconds, visits: r.visits })),
          topPages,
        });
      },
    );

    const SORTS = {
      recent: 'last_seen_at desc nulls last, created_at desc',
      time: 'active_seconds desc, last_seen_at desc nulls last',
      visits: 'visits desc, last_seen_at desc nulls last',
      newest: 'created_at desc',
      failed: 'failed_logins desc, last_seen_at desc nulls last',
    } as const;
    const FILTERS = {
      all: 'true',
      online: 'online',
      active: 'visits > 0',
      inactive: 'visits = 0',
    } as const;

    app.get(
      '/users',
      {
        schema: {
          ...schemaBase,
          summary: 'Every user with their last visit, time spent and logins in the period',
          querystring: z.object({
            q: z.string().trim().max(200).optional(),
            sort: z.enum(Object.keys(SORTS) as [keyof typeof SORTS, ...(keyof typeof SORTS)[]]).default('recent'),
            filter: z.enum(Object.keys(FILTERS) as [keyof typeof FILTERS, ...(keyof typeof FILTERS)[]]).default('all'),
            days,
            tz,
            ...pageQuery,
          }),
          response: { 200: successSchema(page(activityUserDto)) },
        },
      },
      async (req) => {
        const { q, sort, filter, days: n, tz: zone, page: pageNo, pageSize } = req.query;
        const { since } = await bounds(zone, n);
        const term = likeTerm(q);
        // Before activity tracking existed, a login is still known from its dashboard token.
        const rows = (): SqlFragment => sql`
          select u.id as user_id, u.name, u.email, u.role, u.status, u.created_at,
            greatest(a.last_seen_at, k.last_used_at) as last_seen_at,
            coalesce(a.last_seen_at > ${online()}, false) as online,
            coalesce(a.visits, 0) as visits, coalesce(a.active_seconds, 0) as active_seconds,
            k.last_login_at, coalesce(lv.ip, ll.ip) as last_ip, coalesce(lv.user_agent, ll.user_agent) as last_agent,
            coalesce(f.failed, 0) as failed_logins
          from users u
          left join lateral (
            select max(v.last_seen_at) as last_seen_at, count(*) filter (where v.started_at >= ${since})::int as visits,
              coalesce(sum(v.active_seconds) filter (where v.started_at >= ${since}), 0)::int as active_seconds
            from user_visits v where v.user_id = u.id
          ) a on true
          left join lateral (
            select max(k.last_used_at) as last_used_at, max(k.created_at) as last_login_at
            from api_keys k join workspaces w on w.id = k.workspace_id
            where w.owner_id = u.id and 'console' = any(k.scopes)
          ) k on true
          left join lateral (select v.ip, v.user_agent from user_visits v where v.user_id = u.id order by v.last_seen_at desc limit 1) lv on true
          left join lateral (
            select e.ip, e.user_agent from user_events e where e.user_id = u.id and e.type in ('login', 'signup') order by e.created_at desc limit 1
          ) ll on true
          left join lateral (
            select count(*)::int as failed from user_events e where e.user_id = u.id and e.type = 'login_failed' and e.created_at >= ${since}
          ) f on true
          ${term ? sql`where u.email ilike ${term} or u.name ilike ${term} or u.phone ilike ${term}` : sql``}`;
        const [items, [count]] = await Promise.all([
          sql<
            (UserRefRow & {
              role: 'user' | 'admin';
              status: 'active' | 'suspended';
              created_at: Date;
              last_seen_at: Date | null;
              online: boolean;
              visits: number;
              active_seconds: number;
              last_login_at: Date | null;
              last_ip: string | null;
              last_agent: string | null;
              failed_logins: number;
            })[]
          >`
            select * from (${rows()}) x where ${sql.unsafe(FILTERS[filter])}
            order by ${sql.unsafe(SORTS[sort])}
            limit ${pageSize} offset ${(pageNo - 1) * pageSize}`,
          sql<{ total: number }[]>`select count(*)::int as total from (${rows()}) x where ${sql.unsafe(FILTERS[filter])}`,
        ]);
        return ok({
          items: items.map((r) => ({
            ...toUserRef(r),
            role: r.role,
            status: r.status,
            createdAt: r.created_at.toISOString(),
            lastSeenAt: iso(r.last_seen_at),
            online: r.online,
            visits: r.visits,
            activeSeconds: r.active_seconds,
            lastLoginAt: iso(r.last_login_at),
            lastIp: r.last_ip,
            lastAgent: r.last_agent,
            failedLogins: r.failed_logins,
          })),
          total: count?.total ?? 0,
          page: pageNo,
          pageSize,
        });
      },
    );

    app.get(
      '/users/:id',
      {
        schema: {
          ...schemaBase,
          summary: "One user's activity: stats, daily time, usual hours, devices and logins",
          params: z.object({ id: z.uuid() }),
          querystring: z.object({ days, tz }),
          response: { 200: successSchema(userDetailDto) },
        },
      },
      async (req) => {
        const { days: n, tz: zone } = req.query;
        const id = req.params.id;
        const [[user], { since }] = await Promise.all([
          sql<
            {
              id: string;
              name: string | null;
              email: string;
              phone: string | null;
              role: 'user' | 'admin';
              status: 'active' | 'suspended';
              created_at: Date;
              plan_id: string | null;
              two_factor: boolean;
            }[]
          >`
            select u.id, u.name, u.email, u.phone, u.role, u.status, u.created_at, u.totp_enabled_at is not null as two_factor,
              (select w.plan_id from workspaces w where w.owner_id = u.id order by w.created_at limit 1) as plan_id
            from users u where u.id = ${id}`,
          bounds(zone, n),
        ]);
        if (!user) throw notFound('User not found');

        const [[stats], daily, hours, devices, logins] = await Promise.all([
          sql<
            {
              last_seen_at: Date | null;
              first_seen_at: Date | null;
              online: boolean;
              visits: number;
              active_seconds: number;
              avg_visit: number;
              longest_visit: number;
              page_views: number;
              active_days: number;
              logins: number;
              failed: number;
              actions: number;
              key_last_used: Date | null;
            }[]
          >`
            select
              (select max(last_seen_at) from user_visits where user_id = ${id}) as last_seen_at,
              (select min(started_at) from user_visits where user_id = ${id}) as first_seen_at,
              coalesce((select max(last_seen_at) > ${online()} from user_visits where user_id = ${id}), false) as online,
              (select count(*)::int from user_visits where user_id = ${id} and started_at >= ${since}) as visits,
              (select coalesce(sum(active_seconds), 0)::int from user_visits where user_id = ${id} and started_at >= ${since}) as active_seconds,
              (select coalesce(avg(active_seconds), 0)::int from user_visits where user_id = ${id} and started_at >= ${since}) as avg_visit,
              (select coalesce(max(active_seconds), 0)::int from user_visits where user_id = ${id} and started_at >= ${since}) as longest_visit,
              (select coalesce(sum(page_views), 0)::int from user_visits where user_id = ${id} and started_at >= ${since}) as page_views,
              (select count(distinct (started_at at time zone ${zone})::date)::int from user_visits where user_id = ${id} and started_at >= ${since}) as active_days,
              (select count(*)::int from user_events where user_id = ${id} and type = 'login' and created_at >= ${since}) as logins,
              (select count(*)::int from user_events where user_id = ${id} and type = 'login_failed' and created_at >= ${since}) as failed,
              (select count(*)::int from user_events where user_id = ${id} and type = 'action' and created_at >= ${since}) as actions,
              (select max(k.last_used_at) from api_keys k join workspaces w on w.id = k.workspace_id
                where w.owner_id = ${id} and 'console' = any(k.scopes)) as key_last_used`,
          sql<{ day: string; active_seconds: number; visits: number }[]>`
            with days as (
              select d::date as day
              from generate_series((now() at time zone ${zone})::date - ${n - 1}::int, (now() at time zone ${zone})::date, interval '1 day') d
            ), v as (
              select (started_at at time zone ${zone})::date as day, count(*)::int as visits, coalesce(sum(active_seconds), 0)::int as active_seconds
              from user_visits where user_id = ${id} and started_at >= ${since} group by 1
            )
            select to_char(days.day, 'YYYY-MM-DD') as day, coalesce(v.active_seconds, 0) as active_seconds, coalesce(v.visits, 0) as visits
            from days left join v using (day) order by days.day`,
          sql<{ hour: number; visits: number }[]>`
            select extract(hour from started_at at time zone ${zone})::int as hour, count(*)::int as visits
            from user_visits where user_id = ${id} and started_at >= ${since} group by 1`,
          sql<{ user_agent: string | null; ip: string | null; last_at: Date; visits: number }[]>`
            select user_agent, ip, max(last_seen_at) as last_at, count(*)::int as visits
            from user_visits where user_id = ${id}
            group by user_agent, ip order by last_at desc limit 8`,
          sql<{ id: string; created_at: Date; last_used_at: Date | null; expires_at: Date | null; revoked_at: Date | null }[]>`
            select k.id, k.created_at, k.last_used_at, k.expires_at, k.revoked_at
            from api_keys k join workspaces w on w.id = k.workspace_id
            where w.owner_id = ${id} and 'console' = any(k.scopes)
            order by k.created_at desc limit 20`,
        ]);
        const s = stats!;
        const byHour = Array.from({ length: 24 }, () => 0);
        for (const h of hours) byHour[h.hour] = h.visits;
        const lastSeen = [s.last_seen_at, s.key_last_used].filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
        return ok({
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            phone: user.phone,
            role: user.role,
            status: user.status,
            createdAt: user.created_at.toISOString(),
            planId: user.plan_id,
            twoFactor: user.two_factor,
          },
          online: s.online,
          lastSeenAt: iso(lastSeen),
          firstSeenAt: iso(s.first_seen_at),
          stats: {
            visits: s.visits,
            activeSeconds: s.active_seconds,
            avgVisitSeconds: s.avg_visit,
            longestVisitSeconds: s.longest_visit,
            pageViews: s.page_views,
            activeDays: s.active_days,
            logins: s.logins,
            failedLogins: s.failed,
            actions: s.actions,
          },
          daily: daily.map((d) => ({ day: d.day, activeSeconds: d.active_seconds, visits: d.visits })),
          hours: byHour,
          devices: devices.map((d) => ({ userAgent: d.user_agent, ip: d.ip, lastAt: d.last_at.toISOString(), visits: d.visits })),
          logins: logins.map((k) => ({ id: k.id, createdAt: k.created_at.toISOString(), lastUsedAt: iso(k.last_used_at), expiresAt: iso(k.expires_at), revokedAt: iso(k.revoked_at) })),
        });
      },
    );

    app.get(
      '/visits',
      {
        schema: {
          ...schemaBase,
          summary: 'Visits (came in, left, time spent), newest first',
          querystring: z.object({ userId: z.uuid().optional(), ...pageQuery }),
          response: { 200: successSchema(page(visitDto)) },
        },
      },
      async (req) => {
        const { userId, page: pageNo, pageSize } = req.query;
        const where = () => (userId ? sql`v.user_id = ${userId}` : sql`true`);
        const [rows, [count]] = await Promise.all([
          sql<
            (UserRefRow & {
              id: string;
              started_at: Date;
              last_seen_at: Date;
              active_seconds: number;
              page_views: number;
              entry_path: string | null;
              last_path: string | null;
              ip: string | null;
              user_agent: string | null;
              online: boolean;
            })[]
          >`
            select v.id, v.user_id, u.name, u.email, v.started_at, v.last_seen_at, v.active_seconds, v.page_views, v.entry_path, v.last_path,
              v.ip, v.user_agent, v.last_seen_at > ${online()} as online
            from user_visits v join users u on u.id = v.user_id
            where ${where()}
            order by v.started_at desc
            limit ${pageSize} offset ${(pageNo - 1) * pageSize}`,
          sql<{ total: number }[]>`select count(*)::int as total from user_visits v where ${where()}`,
        ]);
        return ok({
          items: rows.map((r) => ({
            id: r.id,
            startedAt: r.started_at.toISOString(),
            lastSeenAt: r.last_seen_at.toISOString(),
            activeSeconds: r.active_seconds,
            pageViews: r.page_views,
            entryPath: r.entry_path,
            lastPath: r.last_path,
            ip: r.ip,
            userAgent: r.user_agent,
            online: r.online,
            user: toUserRef(r),
          })),
          total: count?.total ?? 0,
          page: pageNo,
          pageSize,
        });
      },
    );

    app.get(
      '/events',
      {
        schema: {
          ...schemaBase,
          summary: 'Logins, failures, logouts, page views and actions, newest first',
          description: 'Without `type`, page views are left out (they are the bulk of the log).',
          querystring: z.object({ userId: z.uuid().optional(), type: z.enum(EVENT_TYPES).optional(), q: z.string().trim().max(200).optional(), ...pageQuery }),
          response: { 200: successSchema(page(eventDto)) },
        },
      },
      async (req) => {
        const { userId, type, q, page: pageNo, pageSize } = req.query;
        const term = likeTerm(q);
        const where = () => sql`${type ? sql`e.type = ${type}` : sql`e.type <> 'page'`}
          ${userId ? sql`and e.user_id = ${userId}` : sql``}
          ${term ? sql`and (u.email ilike ${term} or u.name ilike ${term} or e.ip ilike ${term} or e.details->>'identifier' ilike ${term})` : sql``}`;
        const [rows, [count]] = await Promise.all([
          sql<
            {
              id: string;
              type: UserEventType;
              created_at: Date;
              ip: string | null;
              user_agent: string | null;
              details: Record<string, unknown>;
              user_id: string | null;
              name: string | null;
              email: string | null;
            }[]
          >`
            select e.id, e.type, e.created_at, e.ip, e.user_agent, e.details, e.user_id, u.name, u.email
            from user_events e left join users u on u.id = e.user_id
            where ${where()}
            order by e.id desc
            limit ${pageSize} offset ${(pageNo - 1) * pageSize}`,
          sql<{ total: number }[]>`select count(*)::int as total from user_events e left join users u on u.id = e.user_id where ${where()}`,
        ]);
        return ok({
          items: rows.map((r) => ({
            // bigint identity: postgres.js hands it over as a string.
            id: Number(r.id),
            type: r.type,
            createdAt: r.created_at.toISOString(),
            ip: r.ip,
            userAgent: r.user_agent,
            details: r.details,
            user: r.user_id && r.email ? { id: r.user_id, name: r.name, email: r.email } : null,
          })),
          total: count?.total ?? 0,
          page: pageNo,
          pageSize,
        });
      },
    );
  };
}
