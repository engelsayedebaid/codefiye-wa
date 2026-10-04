import { createDb, createListener, databaseUrls, runMigrations } from '@wa/db';
import { parseKey } from '@wa/provider';
import { UPLOAD_SCHEME } from '@wa/shared';
import pino from 'pino';
import { loadConfig } from './config';
import { fetchMedia, fetchUpload } from './media';
import { buildRpcServer } from './rpc';
import { Supervisor } from './supervisor';
import { SyncSlots } from './sync';

const config = loadConfig();
const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'worker', workerId: config.WORKER_ID },
  transport: process.stdout.isTTY ? { target: 'pino-pretty' } : undefined,
});

const urls = databaseUrls();
await runMigrations(urls.direct);
const { sql } = createDb(urls.pooled, { max: config.DB_POOL_MAX });
const listener = createListener(urls.direct);

const supervisor = new Supervisor({
  sql,
  listener,
  workerId: config.WORKER_ID,
  url: config.workerUrl,
  capacity: config.WORKER_CAPACITY,
  encryptionKey: parseKey(config.AUTH_ENCRYPTION_KEY),
  logger,
  baileysLogger: logger.child({ module: 'baileys' }, { level: config.BAILEYS_LOG_LEVEL }),
  syncSlots: new SyncSlots(config.SYNC_CONCURRENCY),
  sendDelay: { min: config.SEND_DELAY_MIN_MS, max: Math.max(config.SEND_DELAY_MIN_MS, config.SEND_DELAY_MAX_MS) },
  // Files attached on the chats page come from the database, not a URL.
  fetchMedia: (url, kind) => (url.startsWith(UPLOAD_SCHEME) ? fetchUpload(sql, url.slice(UPLOAD_SCHEME.length)) : fetchMedia(url, { maxBytes: config.MEDIA_MAX_BYTES, kind })),
});

const rpc = buildRpcServer(supervisor, config.WORKER_SECRET, logger);
await rpc.listen({ host: config.WORKER_HOST, port: config.WORKER_PORT });
await supervisor.start();
logger.info({ url: config.workerUrl, capacity: config.WORKER_CAPACITY }, 'worker started');

let shuttingDown = false;
async function shutdown(signal: string, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  try {
    await supervisor.shutdown();
    await rpc.close();
    await listener.end();
    await sql.end();
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
  }
  process.exit(code);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// Baileys occasionally leaves a rejection unhandled; dropping every WhatsApp socket over it would be worse.
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled promise rejection'));
// After an uncaught exception the state is unknown: release the sessions cleanly and let the platform restart us.
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  void shutdown('uncaughtException', 1);
});
