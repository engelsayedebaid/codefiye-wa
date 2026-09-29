/**
 * BullMQ Postgres-backend connection config (Neon). Uses the direct URL because
 * BullMQ relies on LISTEN/NOTIFY. `migrate: true` creates/updates the `bullmq` schema on connect
 * (guarded by an advisory lock, so concurrent processes are safe).
 */
export function queueConnection(url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set');
  // node-postgres already treats `require` as `verify-full`; say so explicitly to keep that behavior in pg v9.
  const connectionString = url.replace(/([?&]sslmode=)(require|prefer|verify-ca)\b/, '$1verify-full');
  return { connectionString, max: 4, keepAlive: true, migrate: true } as const;
}
