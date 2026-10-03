import { hostname } from 'node:os';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_UNPOOLED: z.string().optional(),
  AUTH_ENCRYPTION_KEY: z.string().min(1),
  WORKER_SECRET: z.string().min(16),
  /** Stable across restarts so a restarted worker reclaims its own sessions immediately. */
  WORKER_ID: z.string().min(1).default(hostname()),
  WORKER_HOST: z.string().default('127.0.0.1'),
  WORKER_PORT: z.coerce.number().int().positive().default(4100),
  /** URL the API uses to reach this worker; defaults to http://127.0.0.1:WORKER_PORT. */
  WORKER_URL: z.string().optional(),
  WORKER_CAPACITY: z.coerce.number().int().positive().default(100),
  SEND_DELAY_MIN_MS: z.coerce.number().int().nonnegative().default(1_000),
  SEND_DELAY_MAX_MS: z.coerce.number().int().nonnegative().default(3_000),
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(64 * 1024 * 1024),
  LOG_LEVEL: z.string().default('info'),
  BAILEYS_LOG_LEVEL: z.string().default('warn'),
});

export type Config = z.infer<typeof schema> & { workerUrl: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  return { ...parsed, workerUrl: parsed.WORKER_URL ?? `http://127.0.0.1:${parsed.WORKER_PORT}` };
}
