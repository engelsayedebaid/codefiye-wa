export type ApiSuccess<T> = { success: true; data: T };
export type ApiError = { success: false; message: string; errors?: Record<string, string[]> };
export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export const ok = <T>(data: T): ApiSuccess<T> => ({ success: true, data });
export const fail = (message: string, errors?: Record<string, string[]>): ApiError =>
  errors ? { success: false, message, errors } : { success: false, message };

export const SESSION_STATUSES = [
  'created',
  'qr',
  'pairing',
  'connecting',
  'connected',
  'disconnected',
  'needs_attention',
  'logged_out',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const MESSAGE_STATUSES = ['pending', 'sent', 'delivered', 'read', 'played', 'failed'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const MESSAGE_TYPES = ['text', 'image', 'video', 'audio', 'document', 'location', 'contact', 'sticker'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const API_VERSION = '2026-09-01';

const safe = (id: string) => id.replace(/[^\w-]/g, '_');

/** BullMQ queues (Postgres backend). Sends go to the owning worker's queue; the worker serializes per session. */
export const QUEUES = {
  rpc: (workerId: string) => `wa-rpc-${safe(workerId)}`,
  send: (workerId: string) => `wa-send-${safe(workerId)}`,
} as const;

/** Postgres LISTEN/NOTIFY channel for PlatformEvents (payload limit ~8 KB). */
export const EVENTS_CHANNEL = 'wa_events';

export const WORKER_HEARTBEAT_TTL_MS = 30_000;

/** Fixed EGP list prices (≈50 EGP/USD). `trial` is the default plan for new workspaces. */
export const PLANS = {
  trial: { id: 'trial', name: 'تجريبي', egp: 0, sessions: 1, dailyMessages: 50, internal: false },
  basic: { id: 'basic', name: 'Basic', egp: 300, sessions: 1, dailyMessages: null, internal: false },
  pro: { id: 'pro', name: 'Pro', egp: 750, sessions: 3, dailyMessages: null, internal: false },
  plus: { id: 'plus', name: 'Plus', egp: 1500, sessions: 6, dailyMessages: null, internal: false },
  business: { id: 'business', name: 'Business', egp: 2250, sessions: 10, dailyMessages: null, internal: false },
  /** Internal: platform owner's own workspace. Never shown to clients. */
  unlimited: { id: 'unlimited', name: 'غير محدود', egp: 0, sessions: 9999, dailyMessages: null, internal: true },
} as const;
export type PlanId = keyof typeof PLANS;
export const PLAN_IDS = Object.keys(PLANS) as PlanId[];
/** Plans a client can purchase (paid, public). */
export const PAID_PLAN_IDS = PLAN_IDS.filter((p) => p !== 'trial' && !PLANS[p].internal);
export const PAYMENT_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export const QR_TTL_MS = 60_000;
