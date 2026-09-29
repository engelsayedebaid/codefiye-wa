import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { MESSAGE_STATUSES, MESSAGE_TYPES, PAYMENT_REQUEST_STATUSES, SESSION_STATUSES } from '@wa/shared';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

const id = () => uuid().primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const sessionStatus = pgEnum('session_status', SESSION_STATUSES);
export const messageStatus = pgEnum('message_status', MESSAGE_STATUSES);
export const messageType = pgEnum('message_type', MESSAGE_TYPES);
export const messageDirection = pgEnum('message_direction', ['in', 'out']);
export const paymentRequestStatus = pgEnum('payment_request_status', PAYMENT_REQUEST_STATUSES);

export const users = pgTable('users', {
  id: id(),
  email: text().notNull().unique(),
  passwordHash: text(),
  totpSecret: text(),
  createdAt: createdAt(),
});

export const workspaces = pgTable('workspaces', {
  id: id(),
  ownerId: uuid().references(() => users.id, { onDelete: 'set null' }),
  name: text().notNull(),
  planId: text().notNull().default('trial'),
  stripeCustomerId: text(),
  trialEndsAt: timestamp({ withTimezone: true }),
  /** Paid plan validity. Null on trial. Expired → treated as trial limits. */
  planExpiresAt: timestamp({ withTimezone: true }),
  suspendedAt: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
});

/** Subscription plans, editable by the platform admin. Seeded from shared PLANS. */
export const plans = pgTable('plans', {
  key: text().primaryKey(),
  name: text().notNull(),
  /** Monthly price in EGP. */
  egp: integer().notNull().default(0),
  /** Max concurrent WhatsApp sessions. */
  sessions: integer().notNull().default(1),
  /** Max outbound messages per day; null = unlimited. */
  dailyMessages: integer(),
  /** Internal plans (owner's unlimited…) are hidden from clients. */
  internal: boolean().notNull().default(false),
  /** Disabled plans can't be newly purchased but keep working for current subscribers. */
  enabled: boolean().notNull().default(true),
  sortOrder: integer().notNull().default(0),
});

/** Transfer destinations managed by the platform admin (InstaPay number, Vodafone Cash wallet, bank account…). */
export const paymentMethods = pgTable('payment_methods', {
  id: id(),
  label: text().notNull(),
  /** Where the client transfers: wallet number, instapay handle, IBAN… */
  details: text().notNull().default(''),
  instructions: text().notNull().default(''),
  enabled: boolean().notNull().default(true),
  sortOrder: integer().notNull().default(0),
  createdAt: createdAt(),
});

/** Manual payment flow (until a gateway is connected): client submits proof, admin approves → plan activated. */
export const paymentRequests = pgTable(
  'payment_requests',
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    planId: text().notNull(),
    amountEgp: integer().notNull(),
    months: integer().notNull().default(1),
    methodId: uuid().references(() => paymentMethods.id, { onDelete: 'set null' }),
    /** Snapshot of the method label at request time (survives method edits/deletion). */
    method: text().notNull(),
    reference: text(),
    note: text(),
    status: paymentRequestStatus().notNull().default('pending'),
    adminNote: text(),
    reviewedBy: text(),
    reviewedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.workspaceId, t.createdAt), index().on(t.status)],
);

export type SessionSettings = {
  autoDownloadMedia?: boolean;
  autoRead?: boolean;
  rejectCalls?: boolean;
  proxyUrl?: string;
};

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    phone: text(),
    status: sessionStatus().notNull().default('created'),
    workerId: text(),
    /** Desired state: true after `connect`, false after `disconnect`/`logout`. Workers resume these on boot. */
    autoConnect: boolean().notNull().default(false),
    lastSeenAt: timestamp({ withTimezone: true }),
    /** Latest QR payload while linking; valid for QR_TTL_MS after qrUpdatedAt. */
    qr: text(),
    qrUpdatedAt: timestamp({ withTimezone: true }),
    settings: jsonb().$type<SessionSettings>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.workspaceId), index().on(t.workerId)],
);

/** Session worker registry + heartbeat. Alive = lastSeenAt within WORKER_HEARTBEAT_TTL_MS. */
export const workers = pgTable('workers', {
  id: text().primaryKey(),
  sessions: integer().notNull().default(0),
  maxSessions: integer().notNull(),
  lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Baileys `creds`, encrypted (AES-256-GCM). One row per session, rewritten on every creds.update. */
export const sessionAuth = pgTable('session_auth', {
  sessionId: uuid()
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  creds: bytea().notNull(),
  updatedAt: updatedAt(),
});

/**
 * Signal keys (pre-keys, sessions, sender-keys, app-state…), one encrypted row per key.
 * Stored separately from creds so a single key write doesn't rewrite a multi-MB blob.
 */
export const sessionAuthKeys = pgTable(
  'session_auth_keys',
  {
    sessionId: uuid()
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    keyId: text().notNull(),
    value: bytea().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.type, t.keyId] })],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionId: uuid().references(() => sessions.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    keyHash: text().notNull(),
    prefix: text().notNull(),
    scopes: text().array().notNull().default(sql`'{}'::text[]`),
    lastUsedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.keyHash), index().on(t.workspaceId)],
);

/** TODO(phase 2): convert to a monthly-partitioned table via a hand-written migration. */
export const messages = pgTable(
  'messages',
  {
    id: id(),
    sessionId: uuid()
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    direction: messageDirection().notNull(),
    remoteJid: text().notNull(),
    waMessageId: text(),
    type: messageType().notNull(),
    body: jsonb().$type<Record<string, unknown>>().notNull(),
    mediaRef: jsonb().$type<Record<string, unknown>>(),
    status: messageStatus().notNull().default('pending'),
    error: text(),
    idempotencyKey: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.sessionId, t.createdAt),
    index().on(t.sessionId, t.waMessageId),
    uniqueIndex().on(t.sessionId, t.idempotencyKey),
  ],
);

export const webhooks = pgTable(
  'webhooks',
  {
    id: id(),
    sessionId: uuid()
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    url: text().notNull(),
    secret: bytea().notNull(),
    events: text().array().notNull(),
    enabled: boolean().notNull().default(true),
    consecutiveFailures: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.sessionId)],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    webhookId: uuid()
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    event: text().notNull(),
    payload: jsonb().notNull(),
    attempt: integer().notNull().default(0),
    statusCode: integer(),
    responseBody: text(),
    nextRetryAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.webhookId, t.createdAt)],
);

export const usageCounters = pgTable(
  'usage_counters',
  {
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    day: date().notNull(),
    messagesOut: integer().notNull().default(0),
    messagesIn: integer().notNull().default(0),
    mediaBytes: bigint({ mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.day] })],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    workspaceId: uuid().references(() => workspaces.id, { onDelete: 'cascade' }),
    actor: text().notNull(),
    action: text().notNull(),
    entity: text(),
    ip: text(),
    meta: jsonb(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.workspaceId, t.createdAt)],
);
