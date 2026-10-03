import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { databaseUrls } from './client';

const MIGRATION_LOCK = 7_262_891;

/**
 * Applies pending migrations over the direct connection. The API and workers both call this on
 * boot; an advisory lock (same single connection) keeps concurrent boots from racing.
 */
export async function runMigrations(url = databaseUrls().direct) {
  const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 10 });
  try {
    // Exempt from the app role's statement_timeout (migration 0005): waiting for another
    // instance's lock or building an index on a large table can legitimately take longer.
    await sql`set statement_timeout = 0`;
    await sql`select pg_advisory_lock(${MIGRATION_LOCK})`;
    await migrate(drizzle({ client: sql }), {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
    await sql`select pg_advisory_unlock(${MIGRATION_LOCK})`;
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runMigrations();
  console.log('migrations applied');
}
