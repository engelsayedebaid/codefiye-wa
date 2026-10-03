import type { Db, Sql } from '@wa/db';
import type { Auth } from './lib/auth';
import type { EventBus } from './lib/events';
import type { OtpSender } from './lib/otp';
import type { Throttle } from './lib/throttle';
import type { WorkerClient } from './lib/workers';

export type Deps = {
  sql: Sql;
  db: Db;
  auth: Auth;
  events: EventBus;
  workers: WorkerClient;
  throttle: Throttle;
  /** Phone verification: HMAC key for stored codes, and the delivery channel (null = not configured → 503). */
  otp: { key: Buffer; sender: OtpSender | null; dailyLimit: number };
};
