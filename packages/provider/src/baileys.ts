import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Boom } from '@hapi/boom';
import type { MessageType, OutboundContent } from '@wa/shared';
import { jidToPhone } from '@wa/shared';
import makeWASocket, {
  type AnyMessageContent,
  Browsers,
  BufferJSON,
  type CacheStore,
  decryptPollVote,
  DisconnectReason,
  fetchLatestWaWebVersion,
  getContentType,
  getKeyAuthor,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  isLidUser,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  proto,
  type WAMessage,
  type WASocket,
  type WAVersion,
} from '@whiskeysockets/baileys';
import pino, { type Logger } from 'pino';
import type { EncryptedAuthState } from './auth-state';
import {
  type CloseReason,
  type InboundMessage,
  type MediaFetcher,
  type OnWhatsAppResult,
  type Provider,
  ProviderError,
  type ProviderEvents,
  type ReceiptStatus,
} from './types';

export type BaileysProviderOptions = {
  sessionId: string;
  auth: EncryptedAuthState;
  fetchMedia: MediaFetcher;
  logger?: Logger;
  /**
   * Loads a stored outbound WAMessage (BufferJSON) by id. Baileys asks for the original poll to
   * decrypt each vote; the in-memory cache doesn't survive restarts.
   */
  loadMessage?: (waMessageId: string) => Promise<unknown>;
};

/** Small TTL cache satisfying Baileys' CacheStore (used for message retry counters). */
class TtlCache implements CacheStore {
  private readonly map = new Map<string, { value: unknown; expires: number }>();
  constructor(private readonly ttlMs: number) {}
  get<T>(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value as T;
  }
  set<T>(key: string, value: T) {
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
  }
  del(key: string) {
    this.map.delete(key);
  }
  flushAll() {
    this.map.clear();
  }
}

/** Bounded insertion-ordered map: recent outbound messages, so Baileys can re-encrypt on retry receipts. */
class RecentMessages {
  private readonly map = new Map<string, proto.IMessage>();
  constructor(private readonly max: number) {}
  get(id: string) {
    return this.map.get(id);
  }
  set(id: string, message: proto.IMessage) {
    this.map.set(id, message);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

let latestVersion: Promise<WAVersion | undefined> | undefined;

/** Baileys' bundled WA Web version goes stale; ask for the current one once per process. */
function resolveVersion(logger: Logger): Promise<WAVersion | undefined> {
  latestVersion ??= fetchLatestWaWebVersion({ signal: AbortSignal.timeout(5_000) })
    .then((r) => {
      if (r.error) logger.warn({ err: r.error }, 'could not fetch latest WA Web version; using bundled default');
      return r.error ? undefined : r.version;
    })
    .catch(() => undefined);
  return latestVersion;
}

const RECEIPTS: Partial<Record<number, ReceiptStatus>> = {
  [proto.WebMessageInfo.Status.ERROR]: 'failed',
  [proto.WebMessageInfo.Status.SERVER_ACK]: 'sent',
  [proto.WebMessageInfo.Status.DELIVERY_ACK]: 'delivered',
  [proto.WebMessageInfo.Status.READ]: 'read',
  [proto.WebMessageInfo.Status.PLAYED]: 'read',
};

const CONTENT_TYPES: Partial<Record<keyof proto.IMessage, MessageType>> = {
  conversation: 'text',
  extendedTextMessage: 'text',
  imageMessage: 'image',
  videoMessage: 'video',
  ptvMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  documentWithCaptionMessage: 'document',
  stickerMessage: 'sticker',
  locationMessage: 'location',
  liveLocationMessage: 'location',
  contactMessage: 'contact',
  contactsArrayMessage: 'contact',
  reactionMessage: 'reaction',
  pollCreationMessage: 'poll',
  pollCreationMessageV2: 'poll',
  pollCreationMessageV3: 'poll',
};

/** Message kinds that are protocol plumbing, not something a user sent. */
const IGNORED = new Set<keyof proto.IMessage>(['protocolMessage', 'pollUpdateMessage', 'keepInChatMessage']);

export function toInbound(msg: WAMessage): InboundMessage | null {
  const { key } = msg;
  const chatJid = key.remoteJid;
  if (!chatJid || !key.id || key.fromMe) return null;
  if (isJidStatusBroadcast(chatJid) || isJidNewsletter(chatJid)) return null;

  const content = normalizeMessageContent(msg.message);
  const kind = getContentType(content);
  if (!content || !kind || IGNORED.has(kind)) return null;

  const isGroup = Boolean(isJidGroup(chatJid));
  const pick = (jid?: string | null, alt?: string | null) => (jid && isLidUser(jid) && alt ? alt : jid);
  const from = (isGroup ? pick(key.participant, key.participantAlt) : pick(chatJid, key.remoteJidAlt)) ?? chatJid;
  const text =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    content.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    content.reactionMessage?.text ??
    null;

  return {
    waMessageId: key.id,
    chatJid,
    from,
    participant: isGroup ? (key.participant ?? undefined) : undefined,
    pushName: msg.pushName ?? null,
    isGroup,
    type: CONTENT_TYPES[kind] ?? 'unknown',
    text,
    timestamp: Number(msg.messageTimestamp ?? Math.floor(Date.now() / 1000)),
    raw: JSON.parse(JSON.stringify(msg, BufferJSON.replacer)),
  };
}

const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex');
const jids = (list: (string | null | undefined)[]) => [...new Set(list.filter((j): j is string => Boolean(j)).map(jidNormalizedUser))];

/**
 * Reads a vote on one of our polls; `poll` is the poll as we sent it, `mine` our own JIDs.
 *
 * Baileys 7 no longer decrypts votes (that code is commented out in its process-message), so they
 * arrive as plain `pollUpdateMessage`s. The vote key is derived from the poll's messageSecret plus the
 * creator's and the voter's JIDs as the voter's phone addressed them — phone number or LID, which we
 * can't tell, so every pairing is tried (AES-GCM rejects the wrong ones).
 */
export function readPollVote(msg: WAMessage, poll: proto.IMessage, mine: (string | null | undefined)[]): ProviderEvents['pollVote'] | null {
  const update = normalizeMessageContent(msg.message)?.pollUpdateMessage;
  const pollMsgId = update?.pollCreationMessageKey?.id;
  const pollEncKey = poll.messageContextInfo?.messageSecret;
  const { key } = msg;
  if (!update?.vote || !pollMsgId || !pollEncKey || !key.remoteJid) return null;

  const own = jids(mine);
  const voters = key.fromMe ? own : jids(isJidGroup(key.remoteJid) ? [key.participant, key.participantAlt] : [key.remoteJid, key.remoteJidAlt]);
  let vote: proto.Message.PollVoteMessage | null = null;
  for (const pollCreatorJid of own) {
    for (const voterJid of voters) {
      try {
        vote ??= decryptPollVote(update.vote, { pollEncKey, pollCreatorJid, pollMsgId, voterJid });
      } catch {
        // wrong pairing
      }
    }
  }
  if (!vote) return null;

  // Votes carry SHA-256 hashes of the chosen option names.
  const options = (poll.pollCreationMessage ?? poll.pollCreationMessageV3 ?? poll.pollCreationMessageV2)?.options ?? [];
  const names = new Map(options.map((o) => [sha256Hex(o.optionName ?? ''), o.optionName ?? '']));
  const selected = (vote.selectedOptions ?? []).flatMap((hash) => names.get(Buffer.from(hash).toString('hex')) ?? []);
  // getKeyAuthor prefers the phone-number alternate of a LID.
  const voter = jidNormalizedUser(getKeyAuthor(key, own[0]));
  return { waMessageId: pollMsgId, chatJid: key.remoteJid, voter, voterPhone: isLidUser(voter) ? null : jidToPhone(voter), selected };
}

function closeReason(statusCode: number | null, message: string, linked: boolean): CloseReason {
  if (statusCode === DisconnectReason.loggedOut) return 'logged_out';
  if (statusCode === DisconnectReason.restartRequired) return 'restart_required';
  if (statusCode === DisconnectReason.connectionReplaced) return 'connection_replaced';
  if (!linked && (message.includes('QR refs') || statusCode === DisconnectReason.timedOut)) return 'qr_timeout';
  return 'error';
}

function vcard(name: string, phone: string) {
  const digits = phone.replace(/\D/g, '');
  const safeName = name.replace(/[\r\n;]/g, ' ');
  return `BEGIN:VCARD\nVERSION:3.0\nFN:${safeName}\nTEL;type=CELL;type=VOICE;waid=${digits}:+${digits}\nEND:VCARD`;
}

function fileNameFromUrl(url: string) {
  const last = new URL(url).pathname.split('/').filter(Boolean).at(-1);
  return last ? decodeURIComponent(last) : 'file';
}

export class BaileysProvider implements Provider {
  private sock: WASocket | null = null;
  private open = false;
  private readonly emitter = new EventEmitter();
  private readonly recent = new RecentMessages(1_000);
  private readonly retryCounter = new TtlCache(10 * 60_000);
  private readonly logger: Logger;

  constructor(private readonly options: BaileysProviderOptions) {
    this.logger = (options.logger ?? pino({ level: 'warn' })).child({ sessionId: options.sessionId });
  }

  get linked() {
    const { creds } = this.options.auth.state;
    return Boolean(creds.me && creds.account);
  }

  get connected() {
    return this.open;
  }

  on<E extends keyof ProviderEvents>(event: E, handler: (payload: ProviderEvents[E]) => void) {
    this.emitter.on(event, handler);
    return () => void this.emitter.off(event, handler);
  }

  private emit<E extends keyof ProviderEvents>(event: E, payload: ProviderEvents[E]) {
    this.emitter.emit(event, payload);
  }

  async connect(): Promise<void> {
    if (this.sock) await this.close();
    const { state, saveCreds } = this.options.auth;
    const version = await resolveVersion(this.logger);

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, this.logger) },
      logger: this.logger,
      browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: false,
      // Don't override shouldSyncHistoryMessage: Baileys needs the initial sync for LID mappings.
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      msgRetryCounterCache: this.retryCounter,
      getMessage: async (key) => (key.id ? this.findMessage(key.id) : undefined),
    });
    this.sock = sock;
    // Events from a socket we've since replaced or closed are dropped.
    const current = () => this.sock === sock;

    sock.ev.on('creds.update', () => {
      saveCreds().catch((err) => this.logger.error({ err }, 'failed to persist creds'));
    });

    sock.ev.on('connection.update', (update) => {
      if (!current()) return;
      if (update.qr) this.emit('qr', { qr: update.qr });
      if (update.connection === 'open') {
        this.open = true;
        const me = sock.user;
        this.emit('open', { jid: me?.id ?? '', phone: jidToPhone(me?.id), name: me?.name ?? me?.notify ?? null });
      }
      if (update.connection === 'close') {
        this.open = false;
        this.sock = null;
        const error = update.lastDisconnect?.error as Boom | Error | undefined;
        const statusCode = (error as Boom | undefined)?.output?.statusCode ?? null;
        const message = error?.message ?? 'connection closed';
        this.emit('close', { reason: closeReason(statusCode, message, this.linked), statusCode, message });
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (!current()) return;
      for (const msg of messages) {
        // Votes cast while we were offline arrive as 'append'; replaying one only re-sets that voter's choice.
        if (normalizeMessageContent(msg.message)?.pollUpdateMessage) {
          this.onPollVote(msg).catch((err) => this.logger.warn({ err }, 'could not read poll vote'));
          continue;
        }
        if (type !== 'notify') continue;
        const inbound = toInbound(msg);
        if (inbound) this.emit('message', inbound);
      }
    });

    sock.ev.on('messages.update', (updates) => {
      if (!current()) return;
      for (const { key, update } of updates) {
        const status = update.status != null ? RECEIPTS[update.status] : undefined;
        if (!key.fromMe || !key.id || !key.remoteJid || !status) continue;
        // A rejected message (error ack) carries WhatsApp's code first in messageStubParameters.
        const error = status === 'failed' ? (update.messageStubParameters?.[0] ?? undefined) : undefined;
        this.emit('receipt', { waMessageId: key.id, chatJid: key.remoteJid, status, ...(error ? { error } : {}) });
      }
    });
  }

  /** A recently sent message from memory, else from storage (e.g. a poll sent before a restart). */
  private async findMessage(id: string): Promise<proto.IMessage | undefined> {
    const cached = this.recent.get(id);
    if (cached || !this.options.loadMessage) return cached;
    const raw = await this.options.loadMessage(id).catch(() => undefined);
    if (!raw) return undefined;
    const stored = JSON.parse(JSON.stringify(raw), BufferJSON.reviver) as WAMessage;
    if (stored.message) this.recent.set(id, stored.message);
    return stored.message ?? undefined;
  }

  private async onPollVote(msg: WAMessage) {
    const pollId = normalizeMessageContent(msg.message)?.pollUpdateMessage?.pollCreationMessageKey?.id;
    const poll = pollId ? await this.findMessage(pollId) : undefined;
    if (!poll) return; // someone else's poll, e.g. in a group
    const { me } = this.options.auth.state.creds;
    const vote = readPollVote(msg, poll, [me?.id, me?.lid]);
    if (!vote) return this.logger.warn({ pollId }, 'could not decrypt poll vote');
    this.emit('pollVote', vote);
  }

  async close(): Promise<void> {
    const sock = this.sock;
    this.sock = null;
    this.open = false;
    if (sock) await sock.end(undefined).catch(() => {});
  }

  async logout(): Promise<void> {
    const sock = this.sock;
    this.sock = null;
    this.open = false;
    if (sock) await sock.logout().catch((err) => this.logger.warn({ err }, 'logout request failed'));
  }

  async requestPairingCode(phone: string): Promise<string> {
    const sock = this.sock;
    if (!sock) throw new ProviderError('not_connected', 'Socket is not running; call connect first');
    if (this.linked) throw new ProviderError('already_linked', 'Session is already linked to a device');
    const digits = phone.replace(/\D/g, '');
    if (!/^[1-9]\d{6,14}$/.test(digits)) throw new ProviderError('invalid_input', 'Invalid phone number');
    const code = await sock.requestPairingCode(digits);
    return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
  }

  private requireOpen(): WASocket {
    if (!this.sock || !this.open) throw new ProviderError('not_connected', 'Session is not connected');
    return this.sock;
  }

  private async toBaileys(content: OutboundContent): Promise<AnyMessageContent> {
    switch (content.type) {
      case 'text':
        return { text: content.text };
      case 'location':
        return {
          location: {
            degreesLatitude: content.latitude,
            degreesLongitude: content.longitude,
            name: content.name,
            address: content.address,
          },
        };
      case 'contact':
        return {
          contacts: { displayName: content.name, contacts: [{ displayName: content.name, vcard: vcard(content.name, content.phone) }] },
        };
      case 'poll':
        return { poll: { name: content.name, values: content.options, selectableCount: content.selectableCount } };
    }
    const { data, mimetype } = await this.options.fetchMedia(content.url, content.type);
    switch (content.type) {
      case 'image':
        return { image: data, caption: content.caption };
      case 'video':
        return { video: data, caption: content.caption };
      case 'audio':
        return { audio: data, ptt: content.ptt, mimetype: mimetype ?? 'audio/mp4' };
      case 'sticker':
        return { sticker: data };
      case 'document':
        return {
          document: data,
          mimetype: content.mimetype ?? mimetype ?? 'application/octet-stream',
          fileName: content.fileName ?? fileNameFromUrl(content.url),
          caption: content.caption,
        };
    }
  }

  async send(jid: string, content: OutboundContent): Promise<{ waMessageId: string; raw?: unknown }> {
    const payload = await this.toBaileys(content);
    const sock = this.requireOpen();
    const msg = await sock.sendMessage(jid, payload);
    if (!msg?.key.id) throw new ProviderError('send_failed', 'WhatsApp returned no message id');
    if (msg.message) this.recent.set(msg.key.id, msg.message);
    // Polls carry the secret that votes are encrypted with; the caller persists it.
    const raw = content.type === 'poll' ? JSON.parse(JSON.stringify(msg, BufferJSON.replacer)) : undefined;
    return { waMessageId: msg.key.id, raw };
  }

  async setTyping(jid: string, typing: boolean): Promise<void> {
    await this.requireOpen().sendPresenceUpdate(typing ? 'composing' : 'paused', jid);
  }

  async isOnWhatsApp(phones: string[]): Promise<OnWhatsAppResult[]> {
    const sock = this.requireOpen();
    const digits = phones.map((p) => p.replace(/\D/g, ''));
    const found = ((await sock.onWhatsApp(...digits)) ?? []).filter((r) => r.exists);
    return phones.map((input, i) => {
      // Results carry the server's JID, which isn't guaranteed to echo the phone number (it can be a
      // LID). Match by number when possible; a single-number lookup needs no matching.
      const hit = found.find((r) => r.jid.split('@')[0]?.split(':')[0] === digits[i]) ?? (phones.length === 1 ? found[0] : undefined);
      return { input, exists: Boolean(hit), jid: hit?.jid ?? null };
    });
  }

  async markRead(messages: Pick<InboundMessage, 'chatJid' | 'waMessageId' | 'participant'>[]): Promise<void> {
    if (messages.length === 0) return;
    await this.requireOpen().readMessages(
      messages.map((m) => ({ remoteJid: m.chatJid, id: m.waMessageId, participant: m.participant, fromMe: false })),
    );
  }
}
