import { hostname } from 'node:os';
import pino from 'pino';
import { parseKey } from '@wa/provider';

const num = (v: string | undefined, d: number) => (v ? Number(v) : d);

export const config = {
  workerId: process.env.WORKER_ID || hostname(),
  maxSessions: num(process.env.WORKER_MAX_SESSIONS, 100),
  encryptionKey: parseKey(),
  sendMinDelayMs: num(process.env.SEND_MIN_DELAY_MS, 1000),
  sendMaxDelayMs: num(process.env.SEND_MAX_DELAY_MS, 3000),
  heartbeatMs: 10_000,
};

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { svc: 'worker', workerId: config.workerId },
  redact: ['*.phone', '*.to', '*.remoteJid'],
});
