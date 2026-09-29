import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export * from './schema';
export * from './events';
export * from './queue';
export { schema };
export { and, eq, desc, asc, sql, inArray, isNull, gt, lt } from 'drizzle-orm';

export function createDb(url = process.env.DATABASE_URL, opts: { max?: number } = {}) {
  if (!url) throw new Error('DATABASE_URL is not set');
  const client = postgres(url, { max: opts.max ?? 10, prepare: false });
  const db = drizzle(client, { schema, casing: 'snake_case' });
  return Object.assign(db, { close: () => client.end({ timeout: 5 }) });
}

export type Db = ReturnType<typeof createDb>;
