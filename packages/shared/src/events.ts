import type { Presence } from './chats';
import type { MessageDirection, MessageStatus, MessageType, SessionStatus } from './constants';
import type { SyncLogEntry, SyncProgress } from './sync';

type Base<T extends string, D> = { type: T; workspaceId: string; sessionId: string; data: D };

/** Events published by workers on `wa_events`. Names follow the webhook event names (README §7). */
export type WaEvent =
  | Base<'session.status', { status: SessionStatus; phone: string | null; lastError: string | null }>
  | Base<'qrcode.updated', { qr: string }>
  | Base<'pairing.updated', { code: string }>
  /** `chatJid`: the chat it belongs to (the sender in 1:1 chats, as WhatsApp addressed it — possibly a LID). */
  | Base<'messages.received', { id: number; from: string; type: MessageType; text: string | null; chatJid?: string; pushName?: string | null }>
  | Base<'messages.update', { id: number; status: MessageStatus; error: string | null }>
  /** A message that didn't arrive through `messages.received`: sent from the phone itself, or queued from the chats page. */
  | Base<'messages.created', { id: number; chatJid: string; direction: MessageDirection; type: MessageType }>
  /** A recipient answered a poll we sent; `selected` is their current choice (empty = withdrawn). */
  | Base<'poll.vote', { id: number; voter: string; selected: string[] }>
  /** What a contact is doing (online, typing…), for chats someone is watching. `lastSeen` in epoch seconds when shared. */
  | Base<'presence.update', { chatJid: string; jid: string; presence: Presence; lastSeen: number | null }>
  /** A chat was read: on the phone, or from another dashboard tab. */
  | Base<'chat.read', { chatJid: string }>
  /** Past messages arrived from the phone (sync): `added` new ones, for one chat or (null) several. */
  | Base<'chats.synced', { chatJid: string | null; added: number }>
  /** A conversation sync job moved (status, counters, the conversation in progress). */
  | Base<'sync.progress', SyncProgress>
  /** One line of a sync job's log. */
  | Base<'sync.log', SyncLogEntry & { jobId: string }>;

export type WaEventType = WaEvent['type'];

/** Messages sent by the API on `wa_control`. */
export type ControlMessage =
  | { type: 'session.changed'; sessionId: string }
  | { type: 'message.queued'; sessionId: string }
  /** A sync job was started, paused, resumed, cancelled or retried. */
  | { type: 'sync.changed'; sessionId: string };
