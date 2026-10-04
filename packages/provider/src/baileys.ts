import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Boom } from '@hapi/boom';
import type { ChatMedia, MessageExtras, MessageType, OutboundContent, Presence } from '@wa/shared';
import { jidToPhone, PRESENCES } from '@wa/shared';
import makeWASocket, {
  type AnyMessageContent,
  Browsers,
  BufferJSON,
  type CacheStore,
  decryptPollVote,
  DisconnectReason,
  downloadMediaMessage,
  extractMessageContent,
  fetchLatestWaWebVersion,
  getContentType,
  getKeyAuthor,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  isLidUser,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  proto,
  toNumber,
  type WAMessage,
  type WASocket,
  type WAVersion,
} from '@whiskeysockets/baileys';
import pino, { type Logger } from 'pino';
import type { EncryptedAuthState } from './auth-state';
import {
  type CloseReason,
  type ContactProfile,
  type EchoMessage,
  type HistoryAnchor,
  type HistoryMessage,
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

/** Outbound kinds whose sent WAMessage we keep: it holds the keys to download the file again. */
const STORED_MEDIA = new Set<OutboundContent['type']>(['image', 'video', 'audio', 'document', 'sticker']);

/** Embedded previews larger than this are dropped: they're stored with every message. */
const MAX_THUMB_BYTES = 12_000;

type MediaFields = {
  mimetype?: string | null;
  fileLength?: unknown;
  seconds?: number | null;
  width?: number | null;
  height?: number | null;
  fileName?: string | null;
  ptt?: boolean | null;
  gifPlayback?: boolean | null;
  jpegThumbnail?: Uint8Array | null;
  viewOnce?: boolean | null;
  contextInfo?: proto.IContextInfo | null;
};

/** Drops empty fields, so stored content stays small. */
const compact = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')) as T;

function mediaOf(m: MediaFields): ChatMedia {
  const thumb = m.jpegThumbnail?.length && m.jpegThumbnail.length <= MAX_THUMB_BYTES ? Buffer.from(m.jpegThumbnail).toString('base64') : undefined;
  return compact({
    mimetype: m.mimetype ?? undefined,
    size: m.fileLength != null ? toNumber(m.fileLength as number) || undefined : undefined,
    seconds: m.seconds ?? undefined,
    width: m.width ?? undefined,
    height: m.height ?? undefined,
    fileName: m.fileName ?? undefined,
    ptt: m.ptt || undefined,
    gif: m.gifPlayback || undefined,
    thumb,
  });
}

/** Contact cards carry a vCard; WhatsApp puts the number in `waid=`. */
function vcardPhone(vcard: string | null | undefined): string | null {
  const waid = /waid=(\d+)/.exec(vcard ?? '')?.[1];
  if (waid) return `+${waid}`;
  const tel = /TEL[^:\n]*:([+\d][\d\s().-]{5,})/.exec(vcard ?? '')?.[1]?.replace(/[^\d+]/g, '');
  return tel || null;
}

function textOf(content: proto.IMessage): string | null {
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    content.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    content.reactionMessage?.text ??
    null
  );
}

/** Everything a chat view needs to draw the message besides its text (see `MessageExtras`). */
export function extrasOf(content: proto.IMessage, kind: keyof proto.IMessage, wrapper?: proto.IMessage | null): MessageExtras {
  const extras: MessageExtras = {};
  const inner = content[kind] as MediaFields | null | undefined;
  const media = content.imageMessage ?? content.videoMessage ?? content.ptvMessage ?? content.audioMessage ?? content.documentMessage ?? content.stickerMessage;
  if (media) extras.media = mediaOf({ ...(media as MediaFields), ptt: content.audioMessage?.ptt ?? (content.ptvMessage ? true : null) });
  const location = content.locationMessage ?? content.liveLocationMessage;
  if (location && location.degreesLatitude != null && location.degreesLongitude != null) {
    extras.location = compact({
      latitude: location.degreesLatitude,
      longitude: location.degreesLongitude,
      name: content.locationMessage?.name ?? undefined,
      address: content.locationMessage?.address ?? undefined,
      live: content.liveLocationMessage ? true : undefined,
    });
  }
  const cards = content.contactMessage ? [content.contactMessage] : (content.contactsArrayMessage?.contacts ?? []);
  if (cards.length) extras.contacts = cards.map((c) => ({ name: c.displayName ?? '', phone: vcardPhone(c.vcard) }));
  if (content.reactionMessage?.key?.id) extras.reactTo = content.reactionMessage.key.id;
  const poll = content.pollCreationMessage ?? content.pollCreationMessageV3 ?? content.pollCreationMessageV2;
  if (poll?.name) extras.poll = { name: poll.name, options: (poll.options ?? []).map((o) => o.optionName ?? '') };

  const context = inner && typeof inner === 'object' ? inner.contextInfo : null;
  if (context?.stanzaId && context.quotedMessage) {
    const quoted = normalizeMessageContent(context.quotedMessage);
    const quotedKind = getContentType(quoted);
    if (quoted && quotedKind) {
      extras.quoted = { id: context.stanzaId, type: CONTENT_TYPES[quotedKind] ?? 'unknown', text: textOf(quoted), participant: context.participant ?? null };
    }
  }
  if (context?.isForwarded) extras.forwarded = true;
  if (wrapper?.viewOnceMessage || wrapper?.viewOnceMessageV2 || wrapper?.viewOnceMessageV2Extension || inner?.viewOnce) extras.viewOnce = true;
  return extras;
}

/** What inbound and phone-sent messages have in common; null for anything that isn't a chat message. */
function parse(msg: WAMessage) {
  const { key } = msg;
  const chatJid = key.remoteJid;
  if (!chatJid || !key.id) return null;
  if (isJidStatusBroadcast(chatJid) || isJidNewsletter(chatJid) || isJidBroadcast(chatJid)) return null;
  const content = normalizeMessageContent(msg.message);
  const kind = getContentType(content);
  if (!content || !kind || IGNORED.has(kind)) return null;
  return {
    waMessageId: key.id,
    chatJid,
    isGroup: Boolean(isJidGroup(chatJid)),
    type: CONTENT_TYPES[kind] ?? ('unknown' as MessageType),
    text: textOf(content),
    extras: extrasOf(content, kind, msg.message),
    timestamp: toNumber(msg.messageTimestamp as number) || Math.floor(Date.now() / 1000),
    raw: JSON.parse(JSON.stringify(msg, BufferJSON.replacer)) as unknown,
  };
}

/** The phone-number JID when WhatsApp gives one alongside a LID. */
const pick = (jid?: string | null, alt?: string | null) => (jid && isLidUser(jid) && alt ? alt : jid);

export function toInbound(msg: WAMessage): InboundMessage | null {
  const { key } = msg;
  if (key.fromMe) return null;
  const base = parse(msg);
  if (!base) return null;
  const from = (base.isGroup ? pick(key.participant, key.participantAlt) : pick(base.chatJid, key.remoteJidAlt)) ?? base.chatJid;
  return { ...base, from, participant: base.isGroup ? (key.participant ?? undefined) : undefined, pushName: msg.pushName ?? null };
}

/** A message we sent from the phone (or another linked device). The chat is addressed by phone number when WhatsApp says which. */
export function toEcho(msg: WAMessage): EchoMessage | null {
  const { key } = msg;
  if (!key.fromMe) return null;
  const base = parse(msg);
  if (!base) return null;
  return { ...base, chatJid: (base.isGroup ? base.chatJid : pick(base.chatJid, key.remoteJidAlt)) ?? base.chatJid };
}

/** Statuses of a media download that mean WhatsApp's link expired and the phone must upload the file again. */
const EXPIRED_MEDIA = new Set([403, 404, 410]);

export function isMediaExpired(err: unknown): boolean {
  const status = (err as Boom | undefined)?.output?.statusCode ?? (err as { status?: number } | undefined)?.status;
  return typeof status === 'number' && EXPIRED_MEDIA.has(status);
}

/**
 * Downloads and decrypts the media of a stored WAMessage (`messages.raw`, BufferJSON). Needs no
 * socket; once WhatsApp's link has expired it throws an error `isMediaExpired` recognises, and
 * `BaileysProvider.reuploadMedia` asks the phone for a fresh link.
 */
export async function downloadMedia(raw: unknown): Promise<{ data: Buffer; mimetype: string | null }> {
  const msg = JSON.parse(JSON.stringify(raw), BufferJSON.reviver) as WAMessage;
  const content = extractMessageContent(msg.message);
  const kind = getContentType(content ?? undefined);
  const media = kind ? (content?.[kind] as MediaFields | undefined) : undefined;
  const data = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer;
  return { data, mimetype: media?.mimetype ?? null };
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
        if (inbound) {
          this.emit('message', inbound);
          continue;
        }
        // Sent from the phone. Our own sends arrive as 'append', and are remembered in `recent` besides.
        const echo = msg.key.id && !this.recent.get(msg.key.id) ? toEcho(msg) : null;
        if (echo) this.emit('echo', echo);
      }
    });

    // History the phone shares: a batch right after linking, and what `fetchHistory` asks for.
    sock.ev.on('messaging-history.set', ({ messages, contacts, chats, syncType }) => {
      if (!current()) return;
      const items = messages.flatMap((m): HistoryMessage[] => {
        const inbound = toInbound(m);
        if (inbound) return [{ ...inbound, fromMe: false }];
        const echo = toEcho(m);
        return echo ? [{ ...echo, fromMe: true }] : [];
      });
      const names = [
        ...contacts.map((c) => ({ jid: c.id, name: c.name ?? c.notify ?? c.verifiedName ?? '' })),
        ...chats.map((c) => ({ jid: c.id, name: c.name ?? '' })),
      ].filter((n): n is { jid: string; name: string } => Boolean(n.jid && n.name));
      if (items.length || names.length) this.emit('history', { messages: items, names, onDemand: syncType === proto.HistorySync.HistorySyncType.ON_DEMAND });
    });

    sock.ev.on('presence.update', ({ id, presences }) => {
      if (!current()) return;
      for (const [jid, p] of Object.entries(presences)) {
        if (!PRESENCES.includes(p.lastKnownPresence as Presence)) continue;
        this.track(
          Promise.all([this.phoneJid(id), this.phoneJid(jid)]).then(([chatJid, who]) =>
            this.emit('presence', { chatJid, jid: who, presence: p.lastKnownPresence as Presence, lastSeen: p.lastSeen ?? null }),
          ),
        );
      }
    });

    // Read on the phone: WhatsApp syncs "mark as read" to linked devices.
    sock.ev.on('chats.update', (updates) => {
      if (!current()) return;
      for (const chat of updates) {
        if (chat.id && chat.unreadCount === 0) this.track(this.phoneJid(chat.id).then((chatJid) => this.emit('chatRead', { chatJid })));
      }
    });

    sock.ev.on('messages.update', (updates) => {
      if (!current()) return;
      for (const { key, update } of updates) {
        // Another device of ours read (or played) a message we received.
        if (!key.fromMe && key.remoteJid && update.status != null && update.status >= proto.WebMessageInfo.Status.READ) {
          const remote = key.remoteJid;
          this.track(this.phoneJid(remote).then((chatJid) => this.emit('chatRead', { chatJid })));
          continue;
        }
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

  private track(promise: Promise<unknown>) {
    promise.catch((err) => this.logger.warn({ err }, 'event handler failed'));
  }

  /** The phone-number JID of a LID when Baileys knows it; anything else unchanged. */
  private async phoneJid(jid: string): Promise<string> {
    if (!isLidUser(jid) || !this.sock) return jid;
    const pn = await this.sock.signalRepository.lidMapping.getPNForLID(jid).catch(() => null);
    return pn ? jidNormalizedUser(pn) : jid;
  }

  // --- chats (the admin inbox) -------------------------------------------------------------------

  /** Asks WhatsApp for this contact's presence updates (online, typing…); lasts while we're online. */
  async subscribePresence(jid: string): Promise<void> {
    await this.requireOpen().presenceSubscribe(jid);
  }

  /**
   * Shows the account as online (or not). WhatsApp only delivers presence to online clients, but an
   * online linked device silences notifications on the phone, so callers keep this short-lived.
   */
  async setOnline(online: boolean): Promise<void> {
    await this.requireOpen().sendPresenceUpdate(online ? 'available' : 'unavailable');
  }

  /** "typing…" / "recording audio…" in the contact's chat, or stop showing it. */
  async sendChatState(jid: string, state: 'composing' | 'recording' | 'paused'): Promise<void> {
    await this.requireOpen().sendPresenceUpdate(state, jid);
  }

  /** Profile picture (a temporary URL) and "about" text, as far as the contact's privacy allows. */
  async profile(jid: string): Promise<ContactProfile> {
    const sock = this.requireOpen();
    const [picture, status, group] = await Promise.allSettled([
      sock.profilePictureUrl(jid, 'image', 10_000),
      isJidGroup(jid) ? Promise.resolve(undefined) : sock.fetchStatus(jid),
      isJidGroup(jid) ? sock.groupMetadata(jid) : Promise.resolve(undefined),
    ]);
    const about = status.status === 'fulfilled' ? (status.value?.[0] as { status?: { status?: string } } | undefined)?.status?.status : undefined;
    return {
      pictureUrl: picture.status === 'fulfilled' ? (picture.value ?? null) : null,
      about: about || (group.status === 'fulfilled' ? (group.value?.desc ?? null) : null),
      name: group.status === 'fulfilled' ? (group.value?.subject ?? null) : null,
    };
  }

  /**
   * Asks the phone for up to `count` messages of a chat older than `oldest`. They arrive later as a
   * `history` event (the phone must be online).
   */
  async fetchHistory(oldest: HistoryAnchor, count = 50): Promise<void> {
    await this.requireOpen().fetchMessageHistory(count, { remoteJid: oldest.chatJid, id: oldest.id, fromMe: oldest.fromMe }, oldest.timestampMs);
  }

  /** A contact's or group's picture (a temporary URL; `preview` = small), or null when hidden or unset. */
  async pictureUrl(jid: string, type: 'preview' | 'image' = 'preview'): Promise<string | null> {
    return (await this.requireOpen().profilePictureUrl(jid, type, 8_000).catch(() => undefined)) ?? null;
  }

  /** A group's name. */
  async groupSubject(jid: string): Promise<string | null> {
    return (await this.requireOpen().groupMetadata(jid)).subject || null;
  }

  /**
   * WhatsApp keeps media for a limited time; after that the phone has to upload it again. Returns the
   * stored WAMessage with a fresh link (BufferJSON), to save and download with `downloadMedia`.
   */
  async reuploadMedia(raw: unknown): Promise<unknown> {
    const msg = JSON.parse(JSON.stringify(raw), BufferJSON.reviver) as WAMessage;
    const updated = await this.requireOpen().updateMediaMessage(msg);
    return JSON.parse(JSON.stringify(updated, BufferJSON.replacer));
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
    const msg = await sock.sendMessage(jid, payload, content.quote ? { quoted: this.quoted(jid, content.quote) } : undefined);
    if (!msg?.key.id) throw new ProviderError('send_failed', 'WhatsApp returned no message id');
    if (msg.message) this.recent.set(msg.key.id, msg.message);
    // Polls carry the secret that votes are encrypted with, media the keys to download it again (the
    // chats page shows it); the caller persists them.
    const raw = content.type === 'poll' || STORED_MEDIA.has(content.type) ? JSON.parse(JSON.stringify(msg, BufferJSON.replacer)) : undefined;
    return { waMessageId: msg.key.id, raw };
  }

  /** The replied-to message as Baileys wants it; the quote shows its text (media quotes show their caption). */
  private quoted(jid: string, quote: NonNullable<OutboundContent['quote']>): WAMessage {
    const message = this.recent.get(quote.id) ?? { conversation: quote.text ?? '' };
    return { key: { remoteJid: jid, id: quote.id, fromMe: quote.fromMe, participant: quote.participant }, message };
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
