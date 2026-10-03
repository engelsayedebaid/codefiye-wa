// TEMPORARY test harness (not committed): the real API on :4020 serving the production dashboard
// build, with verification codes written to a local file instead of being sent by SMS/WhatsApp.
import { appendFileSync } from 'node:fs';
import { createDb, createListener, databaseUrls } from '@wa/db';
import pino from 'pino';
import { buildApp } from './src/app';
import { loadConfig } from './src/config';
import { createAuth } from './src/lib/auth';
import { EventBus } from './src/lib/events';
import { otpKey, type OtpSender } from './src/lib/otp';
import { createThrottle } from './src/lib/throttle';
import { WorkerClient } from './src/lib/workers';

const outbox = process.env.E2E_OUTBOX!;
const config = loadConfig();
const logger = pino({ level: 'warn' });
const urls = databaseUrls();
const { sql, db } = createDb(urls.pooled);
const auth = createAuth(sql);
const events = new EventBus({ createListener: () => createListener(urls.direct), sql, logger, onAuth: (t) => auth.apply(t) });
await events.start();
const sender: OtpSender = {
  channel: 'whatsapp',
  async send(phone, text) {
    appendFileSync(outbox, `${JSON.stringify({ phone, code: /\b(\d{6})\b/.exec(text)?.[1] })}\n`);
  },
};
const app = await buildApp(
  {
    sql,
    db,
    auth,
    events,
    workers: new WorkerClient(sql, config.WORKER_SECRET),
    throttle: createThrottle(sql),
    otp: { key: otpKey(config.OTP_SECRET, config.WORKER_SECRET), sender, dailyLimit: 1000 },
  },
  { logger, corsOrigins: [], publicUrl: 'http://localhost:4020', dashboardDist: '../dashboard/dist', trustProxy: false },
);
await app.listen({ host: '127.0.0.1', port: 4020 });
console.log('e2e harness on :4020');
