import { hostname } from 'node:os';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_UNPOOLED: z.string().optional(),
  AUTH_ENCRYPTION_KEY: z.string().min(1),
  WORKER_SECRET: z.string().min(16),
  /** Stable across restarts so a restarted worker reclaims its own sessions immediately. */
  WORKER_ID: z.string().min(1).default(hostname()),
  /** Defaults to 127.0.0.1, or `::` on Railway (its private network is IPv6). */
  WORKER_HOST: z.string().optional(),
  WORKER_PORT: z.coerce.number().int().positive().default(4100),
  /**
   * URL the API uses to reach this worker; defaults to http://127.0.0.1:WORKER_PORT, or the service's
   * private domain on Railway (http://<RAILWAY_PRIVATE_DOMAIN>:WORKER_PORT).
   */
  WORKER_URL: z.string().optional(),
  WORKER_CAPACITY: z.coerce.number().int().positive().default(100),
  /** Postgres connections shared by every session of this worker (signal keys, messages, receipts). */
  /** Conversation sync jobs running at once on this worker; the others wait (queued). */
  SYNC_CONCURRENCY: z.coerce.number().int().positive().default(3),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  SEND_DELAY_MIN_MS: z.coerce.number().int().nonnegative().default(1_000),
  SEND_DELAY_MAX_MS: z.coerce.number().int().nonnegative().default(3_000),
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(64 * 1024 * 1024),
  LOG_LEVEL: z.string().default('info'),
  BAILEYS_LOG_LEVEL: z.string().default('warn'),
  RAILWAY_PRIVATE_DOMAIN: z.string().optional(),
});

export type Config = z.infer<typeof schema> & { WORKER_HOST: string; workerUrl: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  const railway = parsed.RAILWAY_PRIVATE_DOMAIN;
  return {
    ...parsed,
    WORKER_HOST: parsed.WORKER_HOST ?? (railway ? '::' : '127.0.0.1'),
    workerUrl: parsed.WORKER_URL ?? `http://${railway ?? '127.0.0.1'}:${parsed.WORKER_PORT}`,
  };
}
