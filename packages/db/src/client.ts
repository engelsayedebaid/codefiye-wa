import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Sql = postgres.Sql;
/** The client a raw-SQL transaction callback receives (`sql.begin(async (tx) => …)`). */
export type TxSql = postgres.TransactionSql;
/** A composable piece of a raw query, e.g. a WHERE condition built with `sql` and interpolated into another query. */
export type SqlFragment = postgres.PendingQuery<postgres.Row[]>;

/** int8 → number. Our bigint ids (messages.id) stay far below 2^53. */
const int8 = { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) };

/**
 * Bounded waits: a connect that never completes fails after 10s, and connections idle for 5 min
 * are closed (TCP keepalive, on by default, keeps the rest from being dropped silently by NATs).
 * Query time is bounded server-side by `statement_timeout` (migration 0005).
 */
const CONNECTION = { onnotice: () => {}, connect_timeout: 10, idle_timeout: 300, max_lifetime: 30 * 60 } as const;

type Scoped = { unsafe: (...args: unknown[]) => unknown; begin?: (...args: unknown[]) => unknown; savepoint?: (...args: unknown[]) => unknown };

/**
 * drizzle sends every query through `client.unsafe(text, params)`, which postgres.js runs
 * unprepared: with parameters that costs a Describe round trip before each execution. Asking for
 * named prepared statements (cached per connection, as our tagged-template queries already are)
 * makes repeat queries a single round trip. Transactions and savepoints hand drizzle a scoped
 * client, so those are patched the same way.
 */
function withPreparedStatements<T>(client: T): T {
  const target = client as unknown as Scoped;
  const unsafe = target.unsafe;
  target.unsafe = (query, args, options) => unsafe.call(target, query, args, { prepare: true, ...(options as object | undefined) });
  for (const method of ['begin', 'savepoint'] as const) {
    const original = target[method];
    if (!original) continue;
    target[method] = (...args: unknown[]) => {
      const callback = args.pop() as (scoped: unknown) => unknown;
      return original.call(target, ...args, (scoped: unknown) => callback(withPreparedStatements(scoped)));
    };
  }
  return client;
}

/**
 * Two clients on purpose: drizzle rewrites the type parsers of the client it's given (timestamps
 * come back as strings, `sql.json` stops serializing), which would break raw queries sharing it.
 * postgres.js connects lazily, so the unused one costs nothing.
 */
export function createDb(url: string, options: { max?: number } = {}) {
  const max = options.max ?? 10;
  const sql = postgres(url, { ...CONNECTION, max, types: { int8 } });
  const db = drizzle({ client: withPreparedStatements(postgres(url, { ...CONNECTION, max })), schema, casing: 'snake_case' });
  return { sql, db, end: () => Promise.all([sql.end(), db.$client.end()]) };
}

export type Db = ReturnType<typeof createDb>['db'];

/**
 * A single-connection client for LISTEN. Must use the direct (unpooled) URL — PgBouncer in
 * transaction mode drops LISTEN registrations. Never idles out: it holds the subscriptions.
 */
export function createListener(url: string) {
  return postgres(url, { ...CONNECTION, idle_timeout: 0, max: 1 });
}

export async function notify(sql: Sql, channel: string, payload: unknown) {
  await sql`select pg_notify(${channel}, ${JSON.stringify(payload)})`;
}

/** Several notifications in one round trip (e.g. a status change on many messages at once). */
export async function notifyMany(sql: Sql, channel: string, payloads: unknown[]) {
  if (!payloads.length) return;
  await sql`select pg_notify(${channel}, p) from unnest(${payloads.map((p) => JSON.stringify(p))}::text[]) as p`;
}

export function databaseUrls(env: NodeJS.ProcessEnv = process.env) {
  const pooled = env.DATABASE_URL;
  if (!pooled) throw new Error('DATABASE_URL is not set');
  return { pooled, direct: env.DATABASE_URL_UNPOOLED || pooled };
}

/** Postgres error codes the API maps to client-facing statuses (see apps/api/src/app.ts). */
export const PG_ERRORS = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  queryCanceled: '57014',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
} as const;

/** The Postgres error behind `err` — thrown by postgres.js directly, or wrapped (as `cause`) by drizzle. */
export function pgError(err: unknown): { code: string; constraint: string | null } | null {
  const pg = err instanceof postgres.PostgresError ? err : (err as { cause?: unknown } | null)?.cause;
  return pg instanceof postgres.PostgresError ? { code: pg.code, constraint: pg.constraint_name ?? null } : null;
}

/** Errors from postgres.js when the database can't be reached or dropped the connection. */
export const CONNECTION_ERRORS = new Set(['CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']);

/** A failure that may pass if the same statement is simply tried again (outage, timeout, deadlock). */
export function isTransientDbError(err: unknown): boolean {
  if (CONNECTION_ERRORS.has((err as { code?: string } | null)?.code ?? '')) return true;
  const code = pgErrorCode(err);
  return code === PG_ERRORS.queryCanceled || code === PG_ERRORS.serializationFailure || code === PG_ERRORS.deadlockDetected;
}

/** The SQLSTATE of a Postgres error (see `pgError`), if it is one. */
export const pgErrorCode = (err: unknown): string | null => pgError(err)?.code ?? null;
