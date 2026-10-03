import type { Sql } from '@wa/db';
import { tooMany } from './errors';

/** A fixed-window limit: at most `limit` hits per `windowSec` for `key`. */
export type Rule = { key: string; limit: number; windowSec: number };

type Row = { key: string; hits: number; ttl: number };

/**
 * Brute-force and abuse limits that hold across API instances and restarts (unlike the per-process
 * request rate limiter): login failures, signups, verification codes. One round trip per call.
 */
export function createThrottle(sql: Sql) {
  return {
    /** Counts one hit against every rule; throws 429 if any of them is now over its limit. */
    async consume(rules: Rule[], message = 'Too many attempts. Try again later.') {
      if (rules.length === 0) return;
      const rows = await sql<Row[]>`
        insert into throttles (key, hits, reset_at)
        select r.key, 1, now() + make_interval(secs => r.window_sec)
        from jsonb_to_recordset(${sql.json(rules.map((r) => ({ key: r.key, window_sec: r.windowSec })))}::jsonb) as r(key text, window_sec int)
        on conflict (key) do update set
          hits = case when throttles.reset_at <= now() then 1 else throttles.hits + 1 end,
          reset_at = case when throttles.reset_at <= now() then excluded.reset_at else throttles.reset_at end
        returning key, hits, greatest(0, extract(epoch from reset_at - now()))::int as ttl`;
      exceeded(rules, rows, message, (hits, limit) => hits > limit);
    },

    /** Throws 429 if any rule is already exhausted, without counting a hit. */
    async check(rules: Rule[], message = 'Too many attempts. Try again later.') {
      if (rules.length === 0) return;
      const rows = await sql<Row[]>`
        select key, hits, greatest(0, extract(epoch from reset_at - now()))::int as ttl
        from throttles where key = any(${rules.map((r) => r.key)}::text[]) and reset_at > now()`;
      exceeded(rules, rows, message, (hits, limit) => hits >= limit);
    },

    async reset(keys: string[]) {
      if (keys.length > 0) await sql`delete from throttles where key = any(${keys}::text[])`;
    },
  };
}

function exceeded(rules: Rule[], rows: Row[], message: string, over: (hits: number, limit: number) => boolean) {
  const blocked = rows.filter((row) => {
    const rule = rules.find((r) => r.key === row.key);
    return rule !== undefined && over(row.hits, rule.limit);
  });
  if (blocked.length > 0) throw tooMany(message, Math.max(...blocked.map((row) => row.ttl)));
}

export type Throttle = ReturnType<typeof createThrottle>;

/**
 * In-process brake on failed authentications per IP, checked before any database lookup, so a flood
 * of random keys can't turn into a flood of queries. Approximate by design (per instance).
 */
export function createFailureGuard({ limit = 30, windowMs = 60_000 } = {}) {
  const hits = new Map<string, { n: number; reset: number }>();
  return {
    check(ip: string) {
      const entry = hits.get(ip);
      if (entry && entry.reset > Date.now() && entry.n >= limit) {
        throw tooMany('Too many failed authentication attempts. Try again shortly.', (entry.reset - Date.now()) / 1000);
      }
    },
    fail(ip: string) {
      const now = Date.now();
      const entry = hits.get(ip);
      if (!entry || entry.reset <= now) {
        if (hits.size > 50_000) hits.clear();
        hits.set(ip, { n: 1, reset: now + windowMs });
      } else entry.n += 1;
    },
  };
}
