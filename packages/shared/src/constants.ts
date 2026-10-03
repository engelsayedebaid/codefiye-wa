/** Session lifecycle (README §4.2). `needs_attention` = reconnect attempts exhausted. */
export const SESSION_STATUSES = [
  'created',
  'connecting',
  'qr',
  'pairing',
  'connected',
  'disconnected',
  'logged_out',
  'needs_attention',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** What the session should be doing; workers reconcile `status` towards it. */
export const DESIRED_STATES = ['running', 'stopped'] as const;
export type DesiredState = (typeof DESIRED_STATES)[number];

export const MESSAGE_STATUSES = ['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'received'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const MESSAGE_DIRECTIONS = ['in', 'out'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MESSAGE_TYPES = [
  'text',
  'image',
  'video',
  'audio',
  'document',
  'sticker',
  'location',
  'contact',
  'reaction',
  'poll',
  'unknown',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** Postgres NOTIFY channels. */
export const CHANNELS = {
  /** worker → api: session/message events (fanned out to SSE, later webhooks). */
  events: 'wa_events',
  /** api → worker: something changed, reconcile now instead of waiting for the next tick. */
  control: 'wa_control',
  /** api → api: drop cached credentials (revoked keys, suspended or deleted users) on every instance. */
  auth: 'wa_auth',
} as const;

/** Payload of `wa_auth`. */
export type AuthInvalidation = { workspaceIds?: string[]; keyIds?: string[] };
