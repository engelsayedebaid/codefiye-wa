import type { MessageStatus, SessionStatus } from '@wa/shared';

export type OutboundContent =
  | { type: 'text'; text: string }
  | { type: 'image' | 'video' | 'sticker'; url: string; caption?: string; mimetype?: string }
  | { type: 'audio'; url: string; mimetype?: string; ptt?: boolean }
  | { type: 'document'; url: string; fileName?: string; mimetype?: string; caption?: string }
  | { type: 'location'; latitude: number; longitude: number; name?: string; address?: string }
  | { type: 'contact'; name: string; phone: string };

export type OutboundMedia = Extract<OutboundContent, { url: string }>;

export type SendResult = { waMessageId: string; remoteJid: string; timestamp: number };

export type InboundMessage = {
  waMessageId: string;
  remoteJid: string;
  from: string;
  fromMe: boolean;
  pushName?: string | null;
  type: string;
  text: string | null;
  timestamp: number;
  raw: unknown;
};

export type StatusInfo = { reason?: string; phone?: string | null; statusCode?: number };

export type ProviderEvents = {
  status: [status: SessionStatus, info: StatusInfo];
  qr: [qr: string];
  message: [message: InboundMessage];
  'message.status': [update: { waMessageId: string; remoteJid: string; status: MessageStatus }];
};

export type ProviderEventName = keyof ProviderEvents;

/**
 * Provider-agnostic WhatsApp transport. Baileys (unofficial, Multi-Device) today;
 * Meta Cloud API can implement the same contract later.
 */
export interface Provider {
  readonly sessionId: string;
  readonly status: SessionStatus;
  connect(): Promise<void>;
  /** Close the socket but keep credentials; `connect()` resumes without a new QR. */
  disconnect(): Promise<void>;
  /** Unlink the device and wipe credentials. */
  logout(): Promise<void>;
  requestPairingCode(phone: string): Promise<string>;
  send(to: string, content: OutboundContent): Promise<SendResult>;
  sendText(to: string, text: string): Promise<SendResult>;
  sendMedia(to: string, media: OutboundMedia): Promise<SendResult>;
  isOnWhatsApp(to: string): Promise<{ exists: boolean; jid: string | null }>;
  setPresence(to: string, presence: 'composing' | 'recording' | 'paused' | 'available'): Promise<void>;
  on<E extends ProviderEventName>(event: E, listener: (...args: ProviderEvents[E]) => void): () => void;
}
