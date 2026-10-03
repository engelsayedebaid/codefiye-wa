import type { MessageType, OutboundContent } from '@wa/shared';

export type InboundMessage = {
  waMessageId: string;
  /** Chat the message belongs to (user, group or LID JID). */
  chatJid: string;
  /** Sender — phone-number JID when WhatsApp gives us one, otherwise the LID. */
  from: string;
  /** Group sender as addressed by WhatsApp (needed for read receipts); undefined in 1:1 chats. */
  participant?: string;
  pushName: string | null;
  isGroup: boolean;
  type: MessageType;
  /** Text body, caption, or reaction emoji. */
  text: string | null;
  timestamp: number;
  /** Full WAMessage, JSON-safe (BufferJSON), kept for media download/decrypt later. */
  raw: unknown;
};

export type CloseReason = 'logged_out' | 'restart_required' | 'connection_replaced' | 'qr_timeout' | 'error';

export type ReceiptStatus = 'sent' | 'delivered' | 'read' | 'failed';

export type ProviderEvents = {
  qr: { qr: string };
  open: { jid: string; phone: string | null; name: string | null };
  close: { reason: CloseReason; statusCode: number | null; message: string };
  message: InboundMessage;
  /** `error`: WhatsApp's code when it rejected the message (e.g. '463': may not start new chats). */
  receipt: { waMessageId: string; chatJid: string; status: ReceiptStatus; error?: string };
  /** Someone answered one of our polls. `selected` is their whole current choice (empty = withdrawn). */
  pollVote: { waMessageId: string; chatJid: string; voter: string; voterPhone: string | null; selected: string[] };
};

export type OnWhatsAppResult = { input: string; exists: boolean; jid: string | null };

/** Outbound media kinds; the fetcher checks that a download really is one (not, say, a web page). */
export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

/** Fetches outbound media. Injected so the caller controls SSRF protection and size limits. */
export type MediaFetcher = (url: string, kind: MediaKind) => Promise<{ data: Buffer; mimetype: string | null }>;

/**
 * README §1: the platform talks to WhatsApp only through this interface — Baileys today,
 * Meta Cloud API as a second implementation later.
 */
export interface Provider {
  /** True once a device is linked (creds survive restarts; no QR needed). */
  readonly linked: boolean;
  readonly connected: boolean;
  connect(): Promise<void>;
  /** Closes the socket but keeps the device linked. */
  close(): Promise<void>;
  /** Unlinks the device from the phone. Caller is responsible for wiping auth state. */
  logout(): Promise<void>;
  requestPairingCode(phone: string): Promise<string>;
  /** `raw` is set for polls: the sent message, which must be kept to decrypt the votes later. */
  send(jid: string, content: OutboundContent): Promise<{ waMessageId: string; raw?: unknown }>;
  setTyping(jid: string, typing: boolean): Promise<void>;
  isOnWhatsApp(phones: string[]): Promise<OnWhatsAppResult[]>;
  markRead(messages: Pick<InboundMessage, 'chatJid' | 'waMessageId' | 'participant'>[]): Promise<void>;
  on<E extends keyof ProviderEvents>(event: E, handler: (payload: ProviderEvents[E]) => void): () => void;
}

export class ProviderError extends Error {
  constructor(
    readonly code: 'not_connected' | 'already_linked' | 'invalid_input' | 'send_failed',
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
