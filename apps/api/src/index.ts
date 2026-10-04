import { createDb, createListener, databaseUrls, runMigrations } from '@wa/db';
import pino from 'pino';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createAuth } from './lib/auth';
import { EventBus } from './lib/events';
import { scrubUrl } from './lib/log';
import { otpKey, type OtpSender, twilioSender, whatsappSender } from './lib/otp';
import { createThrottle } from './lib/throttle';
import { WorkerClient } from './lib/workers';

const config = loadConfig();
const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'api' },
  // Credentials, cookies and anything that could hold a password or code never reach the logs.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-worker-secret"]',
      'res.headers["set-cookie"]',
      '*.password',
      '*.currentPassword',
      '*.newPassword',
      '*.code',
      '*.token',
    ],
    censor: '[redacted]',
  },
  serializers: {
    req: (req: { method?: string; url?: string; ip?: string }) => ({ method: req.method, url: scrubUrl(req.url ?? ''), ip: req.ip }),
    res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    err: pino.stdSerializers.err,
  },
  transport: process.stdout.isTTY ? { target: 'pino-pretty' } : undefined,
});

const urls = databaseUrls();
await runMigrations(urls.direct);
const { sql, db, end } = createDb(urls.pooled);
const auth = createAuth(sql);
const events = new EventBus({ createListener: () => createListener(urls.direct), sql, logger, onAuth: (target) => auth.apply(target) });
await events.start();
const workers = new WorkerClient(sql, config.WORKER_SECRET);

function otpSender(): OtpSender | null {
  if (config.OTP_CHANNEL === 'sms') {
    const { TWILIO_ACCOUNT_SID: accountSid, TWILIO_AUTH_TOKEN: authToken, TWILIO_FROM: from } = config;
    if (accountSid && authToken && from) return twilioSender({ accountSid, authToken, from, logger: logger.child({ module: 'otp' }) });
    logger.warn('OTP_CHANNEL=sms but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM are incomplete');
  } else if (config.OTP_CHANNEL === 'whatsapp') {
    if (config.OTP_WHATSAPP_SESSION_ID) return whatsappSender(workers, config.OTP_WHATSAPP_SESSION_ID, logger.child({ module: 'otp' }));
    logger.warn('OTP_CHANNEL=whatsapp but OTP_WHATSAPP_SESSION_ID is not set');
  }
  logger.warn('phone verification is not configured (OTP_CHANNEL); sign-ups will be refused with 503');
  return null;
}

const app = await buildApp(
  {
    sql,
    db,
    auth,
    events,
    workers,
    throttle: createThrottle(sql),
    otp: { key: otpKey(config.OTP_SECRET, config.WORKER_SECRET), sender: otpSender(), dailyLimit: config.OTP_DAILY_LIMIT },
  },
  {
    logger,
    corsOrigins: config.corsOrigins,
    publicUrl: config.PUBLIC_URL,
    dashboardDist: config.DASHBOARD_DIST,
    trustProxy: config.trustProxy,
    cookieSecure: config.COOKIE_SECURE,
  },
);
await app.listen({ host: config.API_HOST, port: config.port });

// Expired throttle windows and verifications are dead weight; sweep them now and then.
const sweep = setInterval(() => {
  sql`delete from throttles where reset_at < now()`.catch(() => {});
  sql`delete from phone_verifications where expires_at < now() - interval '1 day'`.catch(() => {});
}, 15 * 60_000);
sweep.unref();

let shuttingDown = false;
async function shutdown(signal: string, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  setTimeout(() => process.exit(1), 10_000).unref();
  clearInterval(sweep);
  await app.close().catch(() => {});
  await events.stop().catch(() => {});
  await end().catch(() => {});
  process.exit(code);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// A stray rejection is a bug to fix, not a reason to drop every open request: log it and keep serving.
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled promise rejection'));
// After an uncaught exception the process state is unknown: log, close cleanly, let the platform restart us.
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  void shutdown('uncaughtException', 1);
});
