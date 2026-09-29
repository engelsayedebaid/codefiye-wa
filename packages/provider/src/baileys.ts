import { EventEmitter } from 'node:events';
import type { Boom } from '@hapi/boom';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  proto,
  type AnyMessageContent,
  type ConnectionState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import pino, { type Logger } from 'pino';
import type { Db } from '@wa/db';
import { jidToPhone, toJid, type MessageStatus, type SessionStatus } from '@wa/shared';
import { usePostgresAuthState, type PostgresAuthState } from './auth-state';
import type { InboundMessage, OutboundContent, OutboundMedia, Provider, ProviderEventName, ProviderEvents, SendResult } from './types';

export type BaileysProviderOptions = {
  sessionId: string;
  db: Db;
  encryptionKey: Buffer;
  logger?: Logger;
  /** Max reconnect attempts before the session is marked `needs_attention`. */
  maxReconnectAttempts?: number;
  maxBackoffMs?: number;
};

const STATUS_MAP: Partial<Record<number, MessageStatus>> = {
  [proto.WebMessageInfo.Status.ERROR]: 'failed',
  [proto.WebMessageInfo.Status.PENDING]: 'pending',
  [proto.WebMessageInfo.Status.SERVER_ACK]: 'sent',
  [proto.WebMessageInfo.Status.DELIVERY_ACK]: 'delivered',
  [proto.WebMessageInfo.Status.READ]: 'read',
  [proto.WebMessageInfo.Status.PLAYED]: 'played',
};

let versionPromise: ReturnType<typeof fetchLatestBaileysVersion> | undefined;
const getVersion = () => (versionPromise ??= fetchLatestBaileysVersion().catch(() => ({ version: undefined, isLatest: false }) as never));

export class BaileysProvider implements Provider {
  readonly sessionId: string;
  private _status: SessionStatus = 'created';
  private sock?: WASocket;
  private auth?: PostgresAuthState;
  private emitter = new EventEmitter();
  private attempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;
  private readonly log: Logger;

  constructor(private readonly opts: BaileysProviderOptions) {
    this.sessionId = opts.sessionId;
    this.log = (opts.logger ?? pino({ level: process.env.LOG_LEVEL ?? 'info' })).child({ sessionId: opts.sessionId });
  }

  get status() {
    return this._status;
  }

  on<E extends ProviderEventName>(event: E, listener: (...args: ProviderEvents[E]) => void) {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return () => void this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  private emit<E extends ProviderEventName>(event: E, ...args: ProviderEvents[E]) {
    this.emitter.emit(event, ...args);
  }

  private setStatus(status: SessionStatus, info: ProviderEvents['status'][1] = {}) {
    if (this._status === status && !info.reason) return;
    this._status = status;
    this.emit('status', status, info);
  }

  async connect() {
    this.stopped = false;
    clearTimeout(this.reconnectTimer);
    if (this.sock) return;
    this.auth ??= await usePostgresAuthState(this.opts.db, this.sessionId, this.opts.encryptionKey);
    const { version } = await getVersion();
    const baileysLogger = this.log.child({ module: 'baileys' }, { level: 'warn' });

    this.setStatus('connecting');
    const sock = makeWASocket({
      version,
      auth: { creds: this.auth.state.creds, keys: makeCacheableSignalKeyStore(this.auth.state.keys, baileysLogger) },
      logger: baileysLogger,
      browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', () => void this.auth!.saveCreds().catch((err) => this.log.error({ err }, 'saveCreds failed')));
    sock.ev.on('connection.update', (u) => void this.onConnectionUpdate(sock, u));
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        const parsed = this.parseInbound(m);
        if (parsed && !parsed.fromMe) this.emit('message', parsed);
      }
    });
    sock.ev.on('messages.update', (updates) => {
      for (const { key, update } of updates) {
        const status = update.status != null ? STATUS_MAP[update.status] : undefined;
        if (status && key.id && key.remoteJid) this.emit('message.status', { waMessageId: key.id, remoteJid: key.remoteJid, status });
      }
    });
  }

  private async onConnectionUpdate(sock: WASocket, u: Partial<ConnectionState>) {
    if (sock !== this.sock) return;
    const { connection, qr, lastDisconnect } = u;

    if (qr) {
      this.setStatus('qr');
      this.emit('qr', qr);
    }

    if (connection === 'open') {
      this.attempts = 0;
      this.setStatus('connected', { phone: sock.user?.id ? jidToPhone(sock.user.id.replace(/:\d+@/, '@')) : null });
      return;
    }

    if (connection !== 'close') return;
    this.sock = undefined;
    const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
    const reason = lastDisconnect?.error?.message;
    this.log.info({ statusCode, reason }, 'connection closed');

    if (this.stopped) return this.setStatus('disconnected', { reason: 'manual', statusCode });

    if (statusCode === DisconnectReason.loggedOut) {
      await this.auth?.clear();
      this.auth = undefined;
      return this.setStatus('logged_out', { reason: 'logged_out', statusCode });
    }
    if (statusCode === DisconnectReason.connectionReplaced)
      return this.setStatus('needs_attention', { reason: 'connection_replaced', statusCode });
    if (statusCode === DisconnectReason.timedOut && !this.auth?.state.creds.registered)
      return this.setStatus('disconnected', { reason: 'qr_timeout', statusCode });

    // 515 after a fresh QR scan: WhatsApp asks us to reconnect immediately.
    if (statusCode === DisconnectReason.restartRequired) return void this.connect();

    const max = this.opts.maxReconnectAttempts ?? 20;
    if (++this.attempts > max) return this.setStatus('needs_attention', { reason: 'max_reconnect_attempts', statusCode });

    const delay = Math.min(1000 * 2 ** (this.attempts - 1), this.opts.maxBackoffMs ?? 60_000);
    this.setStatus('disconnected', { reason: `reconnecting in ${delay}ms (attempt ${this.attempts}/${max})`, statusCode });
    this.reconnectTimer = setTimeout(() => void this.connect().catch((err) => this.log.error({ err }, 'reconnect failed')), delay);
  }

  async disconnect() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    const sock = this.sock;
    this.sock = undefined;
    sock?.end(undefined);
    this.setStatus('disconnected', { reason: 'manual' });
  }

  async logout() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    const sock = this.sock;
    this.sock = undefined;
    await sock?.logout().catch((err) => this.log.warn({ err }, 'logout request failed'));
    sock?.end(undefined);
    const auth = this.auth ?? (await usePostgresAuthState(this.opts.db, this.sessionId, this.opts.encryptionKey));
    await auth.clear();
    this.auth = undefined;
    this.setStatus('logged_out', { reason: 'manual' });
  }

  async requestPairingCode(phone: string) {
    if (this.auth?.state.creds.registered) throw new Error('Session is already linked');
    if (!this.sock) {
      const ready = new Promise<void>((resolve) => {
        const off = this.on('qr', () => (off(), resolve()));
      });
      await this.connect();
      await ready;
    }
    return this.requireSocket().requestPairingCode(phone.replace(/\D/g, ''));
  }

  private requireSocket() {
    if (!this.sock) throw new SessionNotConnectedError(this.sessionId);
    return this.sock;
  }

  private requireConnected() {
    if (this._status !== 'connected' || !this.sock) throw new SessionNotConnectedError(this.sessionId);
    return this.sock;
  }

  async send(to: string, content: OutboundContent): Promise<SendResult> {
    const sock = this.requireConnected();
    const jid = toJid(to);
    const msg = await sock.sendMessage(jid, toBaileysContent(content));
    if (!msg?.key.id) throw new Error('WhatsApp did not return a message id');
    return { waMessageId: msg.key.id, remoteJid: msg.key.remoteJid ?? jid, timestamp: Number(msg.messageTimestamp ?? Date.now() / 1000) };
  }

  sendText(to: string, text: string) {
    return this.send(to, { type: 'text', text });
  }

  sendMedia(to: string, media: OutboundMedia) {
    return this.send(to, media);
  }

  async isOnWhatsApp(to: string) {
    const jid = toJid(to);
    if (!jid.endsWith('@s.whatsapp.net')) return { exists: true, jid };
    const [result] = (await this.requireConnected().onWhatsApp(jid.split('@')[0]!)) ?? [];
    return { exists: !!result?.exists, jid: result?.exists ? result.jid : null };
  }

  async setPresence(to: string, presence: 'composing' | 'recording' | 'paused' | 'available') {
    await this.requireConnected().sendPresenceUpdate(presence, toJid(to));
  }

  private parseInbound(m: WAMessage): InboundMessage | null {
    if (!m.key.id || !m.key.remoteJid || !m.message) return null;
    const content = normalizeMessageContent(m.message);
    const type = (content && getContentType(content)) ?? 'unknown';
    if (type === 'protocolMessage' || type === 'senderKeyDistributionMessage') return null;
    const text =
      content?.conversation ??
      content?.extendedTextMessage?.text ??
      content?.imageMessage?.caption ??
      content?.videoMessage?.caption ??
      content?.documentMessage?.caption ??
      null;
    return {
      waMessageId: m.key.id,
      remoteJid: m.key.remoteJid,
      from: m.key.participant ?? m.key.remoteJid,
      fromMe: !!m.key.fromMe,
      pushName: m.pushName,
      type: type.replace(/Message$/, ''),
      text,
      timestamp: Number(m.messageTimestamp ?? 0),
      raw: m,
    };
  }
}

export class SessionNotConnectedError extends Error {
  readonly code = 'SESSION_NOT_CONNECTED';
  constructor(sessionId: string) {
    super(`Session ${sessionId} is not connected`);
  }
}

function toBaileysContent(c: OutboundContent): AnyMessageContent {
  switch (c.type) {
    case 'text':
      return { text: c.text };
    case 'image':
      return { image: { url: c.url }, caption: c.caption, mimetype: c.mimetype };
    case 'video':
      return { video: { url: c.url }, caption: c.caption, mimetype: c.mimetype };
    case 'sticker':
      return { sticker: { url: c.url } };
    case 'audio':
      return { audio: { url: c.url }, mimetype: c.mimetype ?? 'audio/mp4', ptt: c.ptt };
    case 'document':
      return { document: { url: c.url }, fileName: c.fileName ?? 'file', mimetype: c.mimetype ?? 'application/octet-stream', caption: c.caption };
    case 'location':
      return { location: { degreesLatitude: c.latitude, degreesLongitude: c.longitude, name: c.name, address: c.address } };
    case 'contact': {
      const digits = c.phone.replace(/\D/g, '');
      const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${c.name}\nTEL;type=CELL;type=VOICE;waid=${digits}:+${digits}\nEND:VCARD`;
      return { contacts: { displayName: c.name, contacts: [{ vcard }] } };
    }
  }
}
