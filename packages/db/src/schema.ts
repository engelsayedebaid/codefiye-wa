import type {
  BroadcastPace,
  DesiredState,
  MessageDirection,
  MessageStatus,
  MessageType,
  OutboundContent,
  SendingWindow,
  SessionStatus,
  SyncChatStatus,
  SyncLogCode,
  SyncLogLevel,
  SyncLogParams,
  SyncPauseReason,
  SyncStatus,
  TemplateCategory,
  TemplateParts,
} from '@wa/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

export type UserRole = 'user' | 'admin';
export type UserStatus = 'active' | 'suspended';

export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text(),
    email: text().notNull().unique(),
    /** scrypt, see apps/api/src/lib/passwords.ts. Null for users created by `pnpm bootstrap`. */
    passwordHash: text(),
    /** `admin` = platform operator: sees every account, activates plans, suspends users (`/api/admin`). */
    role: text().$type<UserRole>().notNull().default('user'),
    /** Deprecated, derived from `role` so readers deployed before it keep working; drop in a later migration. */
    isAdmin: boolean().generatedAlwaysAs(sql`role = 'admin'`),
    /** `suspended`: every request of the user's workspaces is refused with 403 until an admin reactivates. */
    status: text().$type<UserStatus>().notNull().default('active'),
    suspendedAt: timestamp({ withTimezone: true }),
    suspendedReason: text(),
    /** E.164 (`+201012345678`). Unique among verified numbers only, so an unverified claim can't block the owner. */
    phone: text(),
    phoneVerifiedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check('users_role_check', sql`${t.role} in ('user', 'admin')`),
    check('users_status_check', sql`${t.status} in ('active', 'suspended')`),
    uniqueIndex('users_verified_phone_idx').on(t.phone).where(sql`${t.phoneVerifiedAt} is not null`),
  ],
);

/** The billing account; owns sessions and API keys. */
export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid().primaryKey().defaultRandom(),
    ownerId: uuid().references(() => users.id, { onDelete: 'set null' }),
    name: text().notNull(),
    planId: text().notNull().default('trial'),
    trialEndsAt: timestamp({ withTimezone: true }),
    /** End of a paid plan set by an admin; null = no expiry. After it, sending stops with 402. */
    planExpiresAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.ownerId)],
);

export type VerificationPurpose = 'register' | 'phone';

/**
 * Pending phone verifications. `register` holds a signup until its code is confirmed (the user,
 * workspace and trial are created only then); `phone` adds or changes the number of an existing
 * user. Only an HMAC of the code is stored (apps/api/src/lib/otp.ts).
 */
export const phoneVerifications = pgTable(
  'phone_verifications',
  {
    id: uuid().primaryKey().defaultRandom(),
    purpose: text().$type<VerificationPurpose>().notNull(),
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    phone: text().notNull(),
    /** Signup details, kept until the code is confirmed (`register` only). */
    email: text(),
    name: text(),
    passwordHash: text(),
    lang: text().notNull().default('ar'),
    codeHash: text().notNull(),
    attempts: integer().notNull().default(0),
    sends: integer().notNull().default(1),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    lastSentAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp({ withTimezone: true }),
    ip: text(),
    createdAt: createdAt(),
  },
  (t) => [
    check('phone_verifications_purpose_check', sql`${t.purpose} in ('register', 'phone')`),
    index().on(t.expiresAt),
    index().on(t.userId),
  ],
);

/** Fixed-window counters for brute-force and abuse limits (login, signup, OTP), shared by every API instance. */
export const throttles = pgTable(
  'throttles',
  {
    key: text().primaryKey(),
    hits: integer().notNull(),
    resetAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index().on(t.resetAt)],
);

/** Append-only record of operator actions (suspend, reactivate, delete, plan changes). No FKs: it outlives its targets. */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    actorId: uuid(),
    actorEmail: text(),
    action: text().notNull(),
    targetType: text().notNull(),
    targetId: text(),
    /** Human-readable target at the time (e.g. the email), since the row may be gone later. */
    targetLabel: text(),
    details: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ip: text(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.createdAt), index().on(t.targetType, t.targetId)],
);

export type PlanRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/**
 * A customer's request to move to a plan. Payment is collected outside the platform for now
 * (bank transfer, wallets); an admin approves the request, which activates the plan.
 */
export const planRequests = pgTable(
  'plan_requests',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    planId: text().notNull(),
    status: text().$type<PlanRequestStatus>().notNull().default('pending'),
    /** From the customer, e.g. a payment reference. */
    note: text(),
    /** From the admin, e.g. why a request was rejected. */
    adminNote: text(),
    decidedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.workspaceId),
    index().on(t.status, t.createdAt),
    // At most one pending request per workspace, even under concurrent submits.
    uniqueIndex('plan_requests_one_pending_idx').on(t.workspaceId).where(sql`${t.status} = 'pending'`),
  ],
);

export type SessionSettings = {
  /** Mark inbound messages as read automatically. */
  autoRead?: boolean;
  /** Reject incoming calls. */
  rejectCalls?: boolean;
};

export const sessions = pgTable(
  'sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** Linked number in E.164, known after the first successful connection. */
    phone: text(),
    status: text().$type<SessionStatus>().notNull().default('created'),
    desiredState: text().$type<DesiredState>().notNull().default('stopped'),
    /** Worker currently holding the socket; null = unassigned. */
    workerId: text(),
    qr: text(),
    pairingCode: text(),
    lastError: text(),
    settings: jsonb().$type<SessionSettings>().notNull().default({}),
    /** Last time WhatsApp refused to let this number start new chats (error 463); campaigns rest a day after. */
    restrictedAt: timestamp({ withTimezone: true }),
    connectedAt: timestamp({ withTimezone: true }),
    lastSeenAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.workspaceId),
    index().on(t.desiredState, t.workerId),
    /** A session's name must be unique per workspace, case-insensitively. */
    uniqueIndex('sessions_workspace_name_unique').on(t.workspaceId, sql`lower(${t.name})`),
  ],
);

/**
 * Baileys auth state, one row per creds blob / signal key. `value` is AES-256-GCM ciphertext
 * (see @wa/provider crypto). Written on nearly every message, so it lives apart from `sessions`.
 */
export const sessionAuth = pgTable(
  'session_auth',
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

/** Session keys (`session_id` set) and workspace personal access tokens (`session_id` null). Only the SHA-256 is stored. */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionId: uuid().references(() => sessions.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    keyHash: text().notNull().unique(),
    /** First characters of the key, shown in the dashboard to tell keys apart. */
    prefix: text().notNull(),
    /** `console` = a dashboard login token: hidden from the keys list, expires, revoked on logout. */
    scopes: text().array().notNull().default(sql`'{}'::text[]`),
    expiresAt: timestamp({ withTimezone: true }),
    lastUsedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.workspaceId), index().on(t.sessionId)],
);

/**
 * A bulk "ads" campaign sent by an admin from `/ads`: one message (plus its buttons poll) per
 * recipient, spread over the chosen sessions in turn. Progress is read from its `messages` rows.
 */
export const broadcasts = pgTable(
  'broadcasts',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    name: text().notNull(),
    /** The message as composed, `{{placeholders}}` unfilled (each recipient's copy is in `messages`). */
    template: jsonb().$type<TemplateParts>().notNull(),
    /** In rotation order. */
    sessionIds: uuid().array().notNull(),
    /** Recipients sent from one session before switching to the next. */
    rotateEvery: integer().notNull().default(1),
    pace: text().$type<BroadcastPace>().notNull().default('normal'),
    /** Local hours the campaign may send in; null = any time. Kept so the worker can re-plan it. */
    sendingWindow: jsonb().$type<SendingWindow>(),
    /** Recipients queued (after dropping invalid numbers and duplicates). */
    recipients: integer().notNull(),
    cancelledAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.workspaceId, t.createdAt)],
);

/**
 * Numbers that replied "stop" to a campaign (see `optOutReply`): later campaigns of the workspace
 * skip them until they reply "start". Phones in E.164.
 */
export const optOuts = pgTable(
  'opt_outs',
  {
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    phone: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.phone] })],
);

/** Outbound rows double as the per-session send queue (status `queued` → `sending` → …). */
export const messages = pgTable(
  'messages',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionId: uuid()
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    direction: text().$type<MessageDirection>().notNull(),
    remoteJid: text().notNull(),
    waMessageId: text(),
    type: text().$type<MessageType>().notNull(),
    /** Outbound: the OutboundContent to send. Inbound: simplified fields (text, caption, …). */
    content: jsonb().$type<OutboundContent | Record<string, unknown>>().notNull(),
    /** Inbound: the raw WAMessage (BufferJSON-encoded), kept for media decryption. */
    raw: jsonb(),
    status: text().$type<MessageStatus>().notNull(),
    error: text(),
    idempotencyKey: text(),
    attempts: integer().notNull().default(0),
    /** Outbound: not sent before this time (a paced broadcast); null = as soon as possible. */
    notBefore: timestamp({ withTimezone: true }),
    broadcastId: uuid().references(() => broadcasts.id, { onDelete: 'set null' }),
    sentAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('messages_queue_idx').on(t.sessionId, t.id).where(sql`${t.status} = 'queued'`),
    index().on(t.workspaceId, t.createdAt),
    index().on(t.sessionId, t.createdAt),
    index().on(t.broadcastId).where(sql`${t.broadcastId} is not null`),
    /** A number's recent campaign sends, for its daily cap. */
    index('messages_campaign_sent_idx').on(t.sessionId, t.sentAt).where(sql`${t.broadcastId} is not null`),
    /** A conversation's history, newest first (the chats page). */
    index('messages_chat_idx').on(t.sessionId, t.remoteJid, t.id),
    /** …and by time: synced history arrives after newer messages. */
    index('messages_chat_time_idx').on(t.sessionId, t.remoteJid, t.createdAt, t.id),
    uniqueIndex().on(t.sessionId, t.waMessageId),
    uniqueIndex().on(t.sessionId, t.idempotencyKey),
  ],
);

/** Reusable message texts with `{{variable}}` placeholders (OTP codes, order updates, …), per workspace. */
export const messageTemplates = pgTable(
  'message_templates',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** What API callers pass as `template`; unique within the workspace. */
    name: text().notNull(),
    category: text().$type<TemplateCategory>().notNull().default('custom'),
    /** The text; the caption when `imageUrl` is set. */
    body: text().notNull(),
    /** Optional header image: the template is sent as one image-with-caption "card". */
    imageUrl: text(),
    /** Optional tap-to-choose options, sent as a WhatsApp poll titled `buttonsTitle` right after. */
    buttons: text().array(),
    buttonsTitle: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.name)],
);

/** Liveness of worker processes. A worker whose heartbeat is older than 30s loses its sessions. */
/** Platform-wide key/value settings (feature flags like `features.ads`), toggled by admins at runtime. */
export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const workers = pgTable('workers', {
  id: text().primaryKey(),
  /** Internal RPC base URL the API calls for live-socket operations. */
  url: text().notNull(),
  capacity: integer().notNull(),
  sessionCount: integer().notNull().default(0),
  startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  heartbeatAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type PhoneVerification = typeof phoneVerifications.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type PlanRequest = typeof planRequests.$inferSelect;
export type MessageTemplate = typeof messageTemplates.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Broadcast = typeof broadcasts.$inferSelect;
export type OptOut = typeof optOuts.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Worker = typeof workers.$inferSelect;

/**
 * The admin inbox (`/chats`): one row per conversation of a session. A trigger on `messages`
 * (migration 0010) keeps it current, so every way a message is written — the API, campaigns,
 * inbound, the phone itself — counts. A contact WhatsApp addresses by LID is filed under its phone
 * number when known, with the LID in `alt_jid` (history is read under both).
 */
export const chats = pgTable(
  'chats',
  {
    sessionId: uuid()
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    jid: text().notNull(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** The LID this contact's messages arrive under, when the chat is filed under the phone number. */
    altJid: text(),
    /** Group subject, or the contact's WhatsApp name (from their latest message). */
    name: text(),
    lastMessageId: bigint({ mode: 'number' }),
    lastMessageAt: timestamp({ withTimezone: true }).notNull(),
    lastInboundAt: timestamp({ withTimezone: true }),
    lastOutboundAt: timestamp({ withTimezone: true }),
    inboundCount: integer().notNull().default(0),
    outboundCount: integer().notNull().default(0),
    /** Inbound messages since the chat was last read (here or on the phone). */
    unreadCount: integer().notNull().default(0),
    pinnedAt: timestamp({ withTimezone: true }),
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.jid] }),
    index().on(t.sessionId, t.lastMessageAt),
    /** A LID belongs to one conversation: the chat filed under its phone number (see `contactLids`). */
    uniqueIndex().on(t.sessionId, t.altJid).where(sql`${t.altJid} is not null`),
  ],
);

/**
 * Which phone number a LID (WhatsApp's privacy id, `…@lid`) stands for, per session — learnt from
 * Baileys' own mapping store and from messages that carry both. One contact = one chat: the chats
 * trigger files LID-addressed messages under the phone number, and a newly learnt pair merges the
 * LID's chat into the phone number's (migration 0013). Written only under the session's chat lock.
 */
export const contactLids = pgTable(
  'contact_lids',
  {
    sessionId: uuid()
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    lid: text().notNull(),
    pn: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.lid] }), index().on(t.sessionId, t.pn)],
);

/**
 * Files attached on the chats page, kept until sent: outbound content points at them as
 * `upload:<id>` and the worker reads them from here instead of downloading a URL. Pruned after a few days.
 */
export const mediaUploads = pgTable(
  'media_uploads',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    fileName: text(),
    mimetype: text().notNull(),
    size: integer().notNull(),
    data: bytea().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.createdAt)],
);

/**
 * Names WhatsApp gives a session for its contacts, by address (phone-number JID or LID): the name saved
 * in the phone's address book (synced to linked devices as a contact action, or as a conversation's
 * display name in history) and a business's verified name. A contact's own WhatsApp name (pushName)
 * stays on `chats.name`. Kept apart from chats so a name never creates a conversation; chats read it
 * under both their addresses (`chat_display_name`, migration 0015). Groups don't use it.
 */
export const contactNames = pgTable(
  'contact_names',
  {
    sessionId: uuid()
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    jid: text().notNull(),
    savedName: text(),
    verifiedName: text(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.jid] })],
);

/**
 * Conversation sync jobs (dashboard `/chats`): one active job per number (`queued`, `running`,
 * `paused`), run by the worker that owns the number. Progress lives here so a job resumes after a
 * disconnect or a worker restart; see apps/worker/src/sync.ts.
 */
export const syncJobs = pgTable(
  'sync_jobs',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionId: uuid()
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    status: text().$type<SyncStatus>().notNull().default('queued'),
    pauseReason: text().$type<SyncPauseReason>(),
    chatsTotal: integer().notNull().default(0),
    chatsDone: integer().notNull().default(0),
    chatsFailed: integer().notNull().default(0),
    messagesAdded: integer().notNull().default(0),
    currentJid: text(),
    currentName: text(),
    error: text(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: updatedAt(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('sync_jobs_active_idx').on(t.sessionId).where(sql`${t.status} in ('queued', 'running', 'paused')`),
    index().on(t.sessionId, t.startedAt),
  ],
);

/** The conversations of a sync job, in the order they are synced (newest first), each with its own progress. */
export const syncJobChats = pgTable(
  'sync_job_chats',
  {
    jobId: uuid()
      .notNull()
      .references(() => syncJobs.id, { onDelete: 'cascade' }),
    jid: text().notNull(),
    name: text(),
    position: integer().notNull(),
    status: text().$type<SyncChatStatus>().notNull().default('pending'),
    pages: integer().notNull().default(0),
    added: integer().notNull().default(0),
    attempts: integer().notNull().default(0),
    error: text(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.jid] }), index().on(t.jobId, t.status, t.position)],
);

/** A sync job's log (the live panel), trimmed to its latest lines by the worker. */
export const syncJobLogs = pgTable(
  'sync_job_logs',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    jobId: uuid()
      .notNull()
      .references(() => syncJobs.id, { onDelete: 'cascade' }),
    level: text().$type<SyncLogLevel>().notNull(),
    code: text().$type<SyncLogCode>().notNull(),
    params: jsonb().$type<SyncLogParams>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.jobId, t.id)],
);

export type Chat = typeof chats.$inferSelect;
export type MediaUpload = typeof mediaUploads.$inferSelect;
