import type { MessageStatus, SessionStatus } from './contracts';

/** Events published by workers via Postgres NOTIFY; consumed by the API (SSE) and, later, the webhook dispatcher. */
export type PlatformEvent =
  | { event: 'session.status'; sessionId: string; timestamp: number; data: { status: SessionStatus; phone?: string | null; reason?: string } }
  | { event: 'qrcode.updated'; sessionId: string; timestamp: number; data: { qr: string } }
  | { event: 'pairing.updated'; sessionId: string; timestamp: number; data: { code: string } }
  | { event: 'messages.received'; sessionId: string; timestamp: number; data: { id: string; from: string; text: string | null; type: string } }
  | { event: 'messages.update'; sessionId: string; timestamp: number; data: { id: string; remoteJid: string; status: MessageStatus } };

export type PlatformEventName = PlatformEvent['event'];

/** RPC commands the API sends to the worker that owns a session. */
export type WorkerCommand =
  | { op: 'connect'; sessionId: string }
  | { op: 'disconnect'; sessionId: string }
  | { op: 'logout'; sessionId: string }
  | { op: 'pairing-code'; sessionId: string; phone: string }
  | { op: 'on-whatsapp'; sessionId: string; jid: string };

export type SendJob = { messageId: string; sessionId: string };
