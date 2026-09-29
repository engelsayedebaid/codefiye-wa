import { defineConfig } from 'drizzle-kit';

// loadEnvFile never overrides already-set vars, so load .env.local (written by `neon link`/`neon deploy`) first.
for (const file of ['../../.env.local', '../../.env']) {
  try {
    process.loadEnvFile(file);
  } catch {}
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  // Migrations must use the direct (non-pooled) connection; PgBouncer transaction mode breaks session state.
  dbCredentials: { url: (process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL)! },
  casing: 'snake_case',
  strict: true,
});
