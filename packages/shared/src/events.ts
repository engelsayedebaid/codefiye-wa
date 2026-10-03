import type { MessageStatus, MessageType, SessionStatus } from './constants';

type Base<T extends string, D> = { type: T; workspaceId: string; sessionId: string; data: D };

/** Events published by workers on `wa_events`. Names follow the webhook event names (README §7). */
export type WaEvent =
  | Base<'session.status', { status: SessionStatus; phone: string | null; lastError: string | null }>
  | Base<'qrcode.updated', { qr: string }>
  | Base<'pairing.updated', { code: string }>
  | Base<'messages.received', { id: number; from: string; type: MessageType; text: string | null }>
  | Base<'messages.update', { id: number; status: MessageStatus; error: string | null }>
  /** A recipient answered a poll we sent; `selected` is their current choice (empty = withdrawn). */
  | Base<'poll.vote', { id: number; voter: string; selected: string[] }>;

export type WaEventType = WaEvent['type'];

/** Messages sent by the API on `wa_control`. */
export type ControlMessage =
  | { type: 'session.changed'; sessionId: string }
  | { type: 'message.queued'; sessionId: string };
