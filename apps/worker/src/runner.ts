import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  advanceStatus,
  claimNextOutbound,
  failInterrupted,
  isTransientDbError,
  loadOutboundRaw,
  markChatRead,
  markFailed,
  markSent,
  notify,
  notifyMany,
  pgAuthStore,
  type QueuedMessage,
  recordOptOut,
  recordPollVote,
  replanCampaigns,
  requeue,
  type SessionSettings,
  setChatName,
  type Sql,
  stopCampaigns,
} from '@wa/db';
import {
  BaileysProvider,
  type EchoMessage,
  type EncryptedAuthState,
  type HistoryAnchor,
  type InboundMessage,
  type MediaFetcher,
  ProviderError,
  type ProviderEvents,
  useEncryptedAuthState,
} from '@wa/provider';
import {
  BROADCAST_PACES,
  CHANNELS,
  type DesiredState,
  isGroupJid,
  isUserJid,
  jidToPhone,
  optOutReply,
  type SessionStatus,
  SHIELD_STOPS,
  type ShieldStop,
  type WaEvent,
} from '@wa/shared';
import type { Logger } from 'pino';
import { MediaError } from './media';
import { TimeoutError, withTimeout } from './timeout';

export type RunnerContext = {
  sql: Sql;
  workerId: string;
  encryptionKey: Buffer;
  logger: Logger;
  baileysLogger: Logger;
  sendDelay: { min: number; max: number };
  fetchMedia: MediaFetcher;
  /** Called once the runner has stopped and released (or lost) the session. */
  onStopped: (sessionId: string) => void;
};

type SessionPatch = Partial<{
  status: SessionStatus;
  desired_state: DesiredState;
  worker_id: null;
  qr: string | null;
  pairing_code: string | null;
  last_error: string | null;
  phone: string | null;
  connected_at: Date;
  restricted_at: Date;
}>;

type EventInput = WaEvent extends infer E ? (E extends WaEvent ? Omit<E, 'workspaceId' | 'sessionId'> : never) : never;

/** Quick reconnect attempts before the session shows `needs_attention` (it keeps retrying, slower). */
const MAX_RECONNECTS = 20;
const SLOW_RECONNECT_MS = 5 * 60_000;
/** WhatsApp's close code for an account it refuses (banned): retrying can't help. */
const FORBIDDEN = 403;
/** How long stopping waits for pending credential writes. */
const FLUSH_TIMEOUT_MS = 10_000;
const ON_WHATSAPP_TTL_MS = 24 * 60 * 60_000;
/** History sync: rows per insert, messages asked per chat, and the gap between per-chat requests. */
const HISTORY_CHUNK = 200;
const HISTORY_PAGE = 50;
const HISTORY_REQUEST_GAP_MS = 400;
/** Profile pictures fetched in parallel for the chat list. */
const PICTURE_CONCURRENCY = 4;
/** How long the account stays online after the chats page last asked (it renews every minute). */
const WATCH_LEASE_MS = 75_000;
/** A followed contact's presence subscription is renewed this often. */
const PRESENCE_RENEW_MS = 5 * 60_000;
/** Number lookups: Baileys would wait 60s on a dead socket. */
const LOOKUP_TIMEOUT_MS = 10_000;
/** Sending: generous for media (uploads to WhatsApp's CDN), tight for everything else. */
const SEND_TIMEOUT_MS = { media: 5 * 60_000, other: 45_000 };
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);
/**
 * Waits between attempts of a write that must not be lost (~3 min in all): WhatsApp delivers an
 * inbound message once, and a sent message's id is our only proof it went out.
 */
const PERSIST_RETRY_MS = [500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 60_000];

/**
 * A campaign message due longer ago than this means the number fell behind (offline, restarted):
 * its campaigns are re-planned rather than caught up in a burst.
 */
const REPLAN_AFTER_MS = 60_000;
/** Failed campaign sends in a row before the shield stops the number's campaigns. */
const MAX_CAMPAIGN_FAILURES = 5;
/** WhatsApp's error ack for a number that may not start new chats right now. */
const RESTRICTED = '463';

/** Why WhatsApp rejected a message (the code of its error ack), in words a customer can act on. */
const REJECTIONS: Record<string, string> = {
  [RESTRICTED]:
    'WhatsApp refused: this number may not start new chats right now (a new or restricted number, or the contact has never messaged it). Ask the contact to message this number first — resending makes the restriction worse.',
  '479': 'WhatsApp rejected the message (stale device session). Send it again.',
};
const rejection = (code?: string) => (code ? (REJECTIONS[code] ?? `Rejected by WhatsApp (error ${code})`) : 'Rejected by WhatsApp');

/** How far a receipt goes; a rejection outranks everything. */
const RECEIPT_RANK: Record<ProviderEvents['receipt']['status'], number> = { sent: 1, delivered: 2, read: 3, failed: 4 };
const EARLY_RECEIPT_TTL_MS = 60_000;

/**
 * Owns one WhatsApp session inside a worker: socket lifecycle and reconnects (README §4.2–4.3),
 * the serialized send queue with human-like pacing (§4.4), receipts (§4.5) and inbound messages.
 * Every DB write is fenced on `worker_id`, so a worker that lost the session can't clobber it.
 */
export class SessionRunner {
  status: SessionStatus = 'connecting';
  private phone: string | null = null;
  private lastError: string | null = null;
  private provider: BaileysProvider | null = null;
  private stopped = false;
  private reconnects = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private draining = false;
  private drainRequested = false;
  private lastSentAt = 0;
  /** Last campaign recipient sent, and campaign sends that failed since (the shield, README §10). */
  private lastCampaignAt = 0;
  private campaignFailures = 0;
  private readonly onWhatsApp = new Map<string, { exists: boolean; at: number }>();
  /**
   * Receipts can beat our own write of the WhatsApp id: an error ack often arrives before the
   * `markSent` round-trip finishes. `storing` holds those in-flight writes, `earlyReceipts` the
   * receipts that came before the send even returned (both keyed by WhatsApp message id).
   */
  private readonly storing = new Map<string, Promise<unknown>>();
  private readonly earlyReceipts = new Map<string, ProviderEvents['receipt']>();
  private readonly log: Logger;
  /** Groups whose subject we already looked up. */
  private readonly groupNames = new Set<string>();
  /** The account shows as online until then: someone is watching a chat on the chats page (see `watchChats`). */
  private onlineUntil = 0;
  private onlineTimer: NodeJS.Timeout | null = null;
  /** Contacts whose presence we follow → when subscribed; valid only for `subscribedOn` (that socket) while online. */
  private readonly subscribed = new Map<string, number>();
  private subscribedOn: object | null = null;
  private auth: EncryptedAuthState | null = null;
  private connecting = false;
  /** Started from `logged_out`: one more 401 confirms the logout (see onLoggedOut). */
  private confirmingLogout = false;

  constructor(
    readonly sessionId: string,
    readonly workspaceId: string,
    public settings: SessionSettings,
    private readonly ctx: RunnerContext,
  ) {
    this.log = ctx.logger.child({ sessionId });
  }

  get connected() {
    return this.provider?.connected ?? false;
  }

  /** `previous`: the session's status when claimed — `logged_out` means this start must confirm a logout. */
  async start(previous?: SessionStatus) {
    this.confirmingLogout = previous === 'logged_out';
    this.connecting = true; // starting counts as connecting (see `stalled`)
    const interrupted = await failInterrupted(this.ctx.sql, this.sessionId);
    for (const id of interrupted) {
      await this.publish({ type: 'messages.update', data: { id, status: 'failed', error: 'Interrupted while sending' } });
    }
    await this.connect();
  }

  /** Auth state store: every write fenced on this worker still owning the session. */
  private authStore() {
    return pgAuthStore(this.ctx.sql, this.sessionId, { workerId: this.ctx.workerId });
  }

  /**
   * Neither connected, connecting nor waiting to reconnect, though not stopped: something threw where
   * it shouldn't have. The supervisor restarts such a runner rather than leave the session dead.
   */
  get stalled() {
    return !this.stopped && !this.provider && !this.reconnectTimer && !this.connecting;
  }

  private async connect() {
    if (this.stopped) return;
    this.reconnectTimer = null;
    this.connecting = true;
    try {
      if (!(await this.write({ status: 'connecting' }))) return this.halt();
      // A failed load (database, key, corrupt row) throws and lands in the retry below: never a wipe.
      const auth = await useEncryptedAuthState(this.authStore(), this.sessionId, this.ctx.encryptionKey);
      if (this.stopped) return;
      this.auth = auth;
      const provider = new BaileysProvider({
        sessionId: this.sessionId,
        auth,
        fetchMedia: this.ctx.fetchMedia,
        loadMessage: (waMessageId) => loadOutboundRaw(this.ctx.sql, this.sessionId, waMessageId),
        logger: this.ctx.baileysLogger,
      });
      this.provider = provider;
      provider.on('qr', ({ qr }) => this.track(this.onQr(qr)));
      provider.on('open', (info) => this.track(this.onOpen(info)));
      provider.on('close', (info) => this.track(this.onClose(info)));
      provider.on('message', (m) => this.track(this.onMessage(m)));
      provider.on('receipt', (r) => this.track(this.onReceipt(r)));
      provider.on('pollVote', (v) => this.track(this.onPollVote(v)));
      provider.on('echo', (m) => this.track(this.onEcho(m)));
      provider.on('presence', (p) => this.track(this.publish({ type: 'presence.update', data: p })));
      provider.on('chatRead', ({ chatJid }) => this.track(this.onChatRead(chatJid)));
      provider.on('history', (h) => this.track(this.onHistory(h)));
      await provider.connect();
    } catch (err) {
      this.log.error({ err }, 'connect failed');
      this.provider = null;
      await this.onClose({ reason: 'error', statusCode: null, message: (err as Error).message });
    } finally {
      this.connecting = false;
    }
  }

  /** Provider events are fire-and-forget; surface failures in logs instead of unhandled rejections. */
  private track(promise: Promise<unknown>) {
    promise.catch((err) => this.log.error({ err }, 'session event handler failed'));
  }

  /**
   * Runs a write that has no second chance, retrying while the database is unreachable or busy.
   * Keeps going after the runner stops: the data came from WhatsApp and exists nowhere else.
   */
  private async persist<T>(what: string, write: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await write();
      } catch (err) {
        const delay = PERSIST_RETRY_MS[attempt];
        if (delay === undefined || !isTransientDbError(err)) throw err;
        this.log.warn({ err, attempt: attempt + 1 }, `${what}: database unavailable, retrying`);
        await sleep(delay);
      }
    }
  }

  private async onQr(qr: string) {
    const status = this.status === 'pairing' ? 'pairing' : 'qr';
    if (await this.write({ status, qr })) await this.publish({ type: 'qrcode.updated', data: { qr } });
  }

  private async onOpen({ phone }: ProviderEvents['open']) {
    this.reconnects = 0;
    this.log.info('connected');
    await this.write({ status: 'connected', phone, qr: null, pairing_code: null, last_error: null, connected_at: new Date() });
    this.requestDrain();
  }

  private async onClose({ reason, statusCode, message }: ProviderEvents['close']) {
    if (this.stopped) return;
    this.provider = null;
    this.log.info({ reason, statusCode, message }, 'connection closed');
    switch (reason) {
      case 'restart_required': // expected right after a QR scan / pairing
        return this.connect();
      case 'logged_out':
        return this.onLoggedOut(message);
      case 'qr_timeout':
        return this.finish('disconnected', 'QR code expired before it was scanned');
    }
    if (statusCode === FORBIDDEN) {
      // WhatsApp refuses this account (usually a ban): retrying can't help. Credentials stay.
      return this.finish('needs_attention', `WhatsApp refused the connection (${FORBIDDEN}): the number may be banned. ${message}`);
    }
    // Transient (network, WhatsApp, our database): keep trying, never stop by ourselves. After
    // MAX_RECONNECTS quick attempts the session shows `needs_attention` but retries every few minutes.
    this.reconnects += 1;
    const struggling = this.reconnects > MAX_RECONNECTS;
    const delay = struggling ? SLOW_RECONNECT_MS : Math.min(60_000, 1_000 * 2 ** (this.reconnects - 1));
    try {
      if (!(await this.write({ status: struggling ? 'needs_attention' : 'connecting', last_error: message }))) return this.halt();
    } catch (err) {
      // The database is unreachable, so ownership can't be checked; giving up here would strand the
      // session until a restart. Retry: the fenced writes stop this runner if another worker took over.
      this.log.warn({ err }, 'could not record the disconnect; retrying anyway');
    }
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => this.track(this.connect()), delay);
  }

  /**
   * WhatsApp reported the device logged out (401). Wiping credentials can't be undone, so it takes a
   * confirmation: the first 401 keeps them and stops the session; when someone reconnects it, the
   * stored credentials are tried once more and only a second 401 wipes them (then a QR is shown).
   */
  private async onLoggedOut(message: string) {
    // Unlinked from the phone, or banned: either way its campaigns must not resume on a relink.
    await this.shieldStop('loggedOut').catch((err) => this.log.warn({ err }, 'could not stop campaigns after logout'));
    if (!this.confirmingLogout) return this.finish('logged_out', `The device was logged out from the phone: ${message}`);
    this.confirmingLogout = false;
    try {
      await this.auth?.flush();
      await this.authStore().clear();
    } catch (err) {
      this.log.error({ err }, 'could not wipe credentials after a confirmed logout');
      return this.finish('logged_out', 'The device was logged out from the phone');
    }
    this.auth = null;
    this.log.warn('logout confirmed by WhatsApp twice; credentials wiped, a new QR scan is needed');
    return this.connect();
  }

  private async onMessage(m: InboundMessage) {
    const { sql } = this.ctx;
    const content = {
      from: m.from,
      fromPhone: jidToPhone(m.from),
      pushName: m.pushName,
      text: m.text,
      isGroup: m.isGroup,
      timestamp: m.timestamp,
      ...m.extras,
    };
    const [row] = await this.persist(
      'store inbound message',
      () => sql<{ id: number }[]>`
        insert into messages (workspace_id, session_id, direction, remote_jid, wa_message_id, type, content, raw, status)
        values (${this.workspaceId}, ${this.sessionId}, 'in', ${m.chatJid}, ${m.waMessageId}, ${m.type},
                ${sql.json(content as never)}, ${sql.json(m.raw as never)}, 'received')
        on conflict (session_id, wa_message_id) do nothing
        returning id`,
    );
    if (!row) return; // duplicate delivery
    await this.publish({ type: 'messages.received', data: { id: row.id, from: m.from, type: m.type, text: m.text, chatJid: m.chatJid, pushName: m.pushName } });
    if (this.settings.autoRead) {
      await this.provider?.markRead([m]).catch((err) => this.log.warn({ err }, 'markRead failed'));
      await markChatRead(sql, this.sessionId, m.chatJid);
    }
    if (m.isGroup) await this.nameGroup(m.chatJid);
    await this.onOptOutReply(m);
  }

  /**
   * A message sent from the phone or another linked device. Stored as a sent outbound message so the
   * chats page shows both sides; never treated as an opt-out reply or counted against a plan.
   * Answering from the phone means the chat was read there.
   */
  private async onEcho(m: EchoMessage) {
    const { sql } = this.ctx;
    const content = { text: m.text, isGroup: m.isGroup, timestamp: m.timestamp, sentFrom: 'phone', ...m.extras };
    const [row] = await this.persist(
      'store message sent from the phone',
      () => sql<{ id: number }[]>`
        insert into messages (workspace_id, session_id, direction, remote_jid, wa_message_id, type, content, raw, status, sent_at)
        values (${this.workspaceId}, ${this.sessionId}, 'out', ${m.chatJid}, ${m.waMessageId}, ${m.type},
                ${sql.json(content as never)}, ${sql.json(m.raw as never)}, 'sent', to_timestamp(${m.timestamp}))
        on conflict (session_id, wa_message_id) do nothing
        returning id`,
    );
    if (!row) return;
    await this.publish({ type: 'messages.created', data: { id: row.id, chatJid: m.chatJid, direction: 'out', type: m.type } });
    if (m.type !== 'reaction') await this.onChatRead(m.chatJid);
    if (m.isGroup) await this.nameGroup(m.chatJid);
  }

  /**
   * Past messages from the phone (a sync), stored with their real time and marked `history`: they never
   * count as unread, trigger replies or opt-outs. Only media keeps the raw WAMessage (to download it).
   */
  private async onHistory({ messages, names }: ProviderEvents['history']) {
    const { sql } = this.ctx;
    let added = 0;
    const chatJids = new Set<string>();
    for (let i = 0; i < messages.length; i += HISTORY_CHUNK) {
      const rows = messages.slice(i, i + HISTORY_CHUNK).map((m) => ({
        direction: m.fromMe ? 'out' : 'in',
        remote_jid: m.chatJid,
        wa: m.waMessageId,
        type: m.type,
        content: m.fromMe
          ? { text: m.text, isGroup: m.isGroup, timestamp: m.timestamp, sentFrom: 'phone', history: true, ...m.extras }
          : { from: m.from, fromPhone: jidToPhone(m.from), pushName: m.pushName, text: m.text, isGroup: m.isGroup, timestamp: m.timestamp, history: true, ...m.extras },
        raw: MEDIA_TYPES.has(m.type) ? m.raw : null,
        status: m.fromMe ? 'sent' : 'received',
        ts: m.timestamp,
      }));
      const inserted = await this.persist(
        'store history',
        () => sql<{ remote_jid: string }[]>`
          insert into messages (workspace_id, session_id, direction, remote_jid, wa_message_id, type, content, raw, status, created_at, sent_at)
          select ${this.workspaceId}, ${this.sessionId}, x.direction, x.remote_jid, x.wa, x.type, x.content, x.raw, x.status,
            to_timestamp(x.ts), case when x.direction = 'out' then to_timestamp(x.ts) end
          from jsonb_to_recordset(${sql.json(rows as never)}) as x(direction text, remote_jid text, wa text, type text, content jsonb, raw jsonb, status text, ts float8)
          on conflict (session_id, wa_message_id) do nothing
          returning remote_jid`,
      );
      added += inserted.length;
      for (const r of inserted) chatJids.add(r.remote_jid);
    }
    if (names.length) {
      // Contact names only fill gaps (a WhatsApp name from their own messages wins); groups take their subject.
      await sql`
        update chats c set name = n.name
        from jsonb_to_recordset(${sql.json(names as never)}) as n(jid text, name text)
        where c.session_id = ${this.sessionId} and (c.jid = n.jid or c.alt_jid = n.jid)
          and (c.name is null or c.jid like '%@g.us') and c.name is distinct from n.name`;
    }
    this.log.info({ messages: messages.length, added, names: names.length }, 'history sync');
    const [only] = chatJids;
    await this.publish({ type: 'chats.synced', data: { chatJid: chatJids.size === 1 ? only! : null, added } });
  }

  /** Asks the phone for older messages of each chat, a little apart. Results arrive as history events. */
  fetchHistory(anchors: HistoryAnchor[]) {
    const provider = this.live();
    this.track(
      (async () => {
        for (const [i, anchor] of anchors.entries()) {
          if (i > 0) await sleep(HISTORY_REQUEST_GAP_MS);
          if (!provider.connected) return;
          await provider.fetchHistory(anchor, HISTORY_PAGE).catch((err) => this.log.warn({ err }, 'history request failed'));
        }
      })(),
    );
  }

  private async onChatRead(chatJid: string) {
    const jid = await markChatRead(this.ctx.sql, this.sessionId, chatJid);
    if (jid) await this.publish({ type: 'chat.read', data: { chatJid: jid } });
  }

  /** Groups are listed by their subject, asked of WhatsApp once per group while this runner lives. */
  private async nameGroup(jid: string) {
    if (!isGroupJid(jid) || this.groupNames.has(jid) || !this.provider) return;
    this.groupNames.add(jid);
    const subject = await withTimeout(this.provider.groupSubject(jid), LOOKUP_TIMEOUT_MS, 'group lookup timed out').catch(() => null);
    if (subject) await setChatName(this.ctx.sql, this.sessionId, jid, subject);
  }

  /** "Stop" drops the sender from this workspace's campaigns (queued ones included), "start" brings them back. */
  private async onOptOutReply(m: InboundMessage) {
    const intent = m.isGroup ? null : optOutReply(m.text);
    const phone = intent && jidToPhone(m.from);
    if (!intent || !phone) return;
    const dropped = await recordOptOut(this.ctx.sql, this.workspaceId, phone, intent);
    this.log.info({ intent, dropped: dropped.length }, 'campaign opt-out reply');
    await this.publishFailed(dropped, SHIELD_STOPS.optedOut);
  }

  private async onReceipt(receipt: ProviderEvents['receipt']) {
    // Whichever message drew it (even one sent from the phone), the number is restricted now.
    if (receipt.status === 'failed' && receipt.error === RESTRICTED) await this.onRestricted();
    const { waMessageId } = receipt;
    const pending = this.storing.get(waMessageId);
    if (pending) await pending.catch(() => {});
    if (await this.persist('apply receipt', () => this.applyReceipt(receipt))) return;
    // No row matched. If our send stored its id while we were querying, retry once; if the send
    // hasn't even returned yet, hold the receipt for sendOne. Otherwise it's not ours, or stale.
    const late = this.storing.get(waMessageId);
    if (late && late !== pending) {
      await late.catch(() => {});
      await this.applyReceipt(receipt);
    } else if (!late) {
      this.holdReceipt(receipt);
    }
  }

  /** True when a message row changed. */
  private async applyReceipt({ waMessageId, status, error }: ProviderEvents['receipt']): Promise<boolean> {
    const { sql } = this.ctx;
    if (status === 'failed') {
      const reason = rejection(error);
      const [row] = await sql<{ id: number }[]>`
        update messages set status = 'failed', error = ${reason}, updated_at = now()
        where session_id = ${this.sessionId} and wa_message_id = ${waMessageId} and direction = 'out' and status = 'sent'
        returning id`;
      if (row) await this.publish({ type: 'messages.update', data: { id: row.id, status, error: reason } });
      return Boolean(row);
    }
    const row = await advanceStatus(sql, this.sessionId, waMessageId, status);
    if (row) await this.publish({ type: 'messages.update', data: { id: row.id, status, error: null } });
    return Boolean(row);
  }

  /** Keeps the furthest receipt for a message we haven't stored yet; bounded, and forgotten after a minute. */
  private holdReceipt(receipt: ProviderEvents['receipt']) {
    const prev = this.earlyReceipts.get(receipt.waMessageId);
    if (prev && RECEIPT_RANK[prev.status] >= RECEIPT_RANK[receipt.status]) return;
    // Receipts for messages sent from the phone itself land here too; don't let them pile up.
    if (!prev && this.earlyReceipts.size >= 500) return;
    this.earlyReceipts.set(receipt.waMessageId, receipt);
    setTimeout(() => {
      if (this.earlyReceipts.get(receipt.waMessageId) === receipt) this.earlyReceipts.delete(receipt.waMessageId);
    }, EARLY_RECEIPT_TTL_MS).unref();
  }

  /**
   * WhatsApp refused to let this number start new chats: more campaign messages would only deepen the
   * restriction, so its queued ones stop and new campaigns wait a day (the API reads `restricted_at`).
   */
  private async onRestricted() {
    await this.write({ restricted_at: new Date() });
    await this.shieldStop('restricted');
  }

  /** Fails the number's queued campaign messages, saying why. */
  private async shieldStop(reason: ShieldStop) {
    const stopped = await stopCampaigns(this.ctx.sql, this.sessionId, reason);
    if (stopped.length) this.log.warn({ reason, stopped: stopped.length }, 'shield stopped campaign messages');
    await this.publishFailed(stopped, SHIELD_STOPS[reason]);
  }

  /** Keeps each voter's current choice on the poll row (keyed by phone when known). */
  private async onPollVote({ waMessageId, voter, voterPhone, selected }: ProviderEvents['pollVote']) {
    const who = voterPhone ?? voter;
    const row = await recordPollVote(this.ctx.sql, this.sessionId, waMessageId, who, selected);
    if (row) await this.publish({ type: 'poll.vote', data: { id: row.id, voter: who, selected } });
  }

  /** Sends queued messages one at a time. Safe to call repeatedly; concurrent calls coalesce. */
  requestDrain() {
    if (this.draining) {
      this.drainRequested = true;
      return;
    }
    this.draining = true;
    this.track(
      (async () => {
        try {
          do {
            this.drainRequested = false;
            while (!this.stopped && this.connected) {
              const job = await claimNextOutbound(this.ctx.sql, this.sessionId);
              if (!job) break;
              if (job.broadcast_id && job.late_ms > REPLAN_AFTER_MS) {
                await requeue(this.ctx.sql, job.id);
                const replanned = await replanCampaigns(this.ctx.sql, this.sessionId);
                this.log.info({ lateMs: Math.round(job.late_ms), replanned }, 'campaign fell behind; re-planned instead of catching up');
                if (!replanned) break;
                continue;
              }
              await this.sendOne(job);
            }
          } while (this.drainRequested && !this.stopped);
        } finally {
          this.draining = false;
        }
      })(),
    );
  }

  private async sendOne(job: QueuedMessage) {
    const { sql } = this.ctx;
    const provider = this.provider;
    if (!provider) return requeue(sql, job.id);
    const jid = job.remote_jid;
    // A campaign's buttons poll follows its card at once; recipients are what the campaign paces.
    const recipient = job.pace !== null && job.content.type !== 'poll';
    /** WhatsApp took the message: from here on, an error is ours to record, not a failed send. */
    let accepted = false;
    try {
      if (isUserJid(jid) && !(await this.recipientExists(provider, jid))) {
        return await this.fail(job.id, 'Recipient is not on WhatsApp');
      }
      await this.pace(provider, job, recipient);
      const media = MEDIA_TYPES.has(job.content.type);
      const { waMessageId, raw } = await withTimeout(
        provider.send(jid, job.content),
        media ? SEND_TIMEOUT_MS.media : SEND_TIMEOUT_MS.other,
        'WhatsApp did not confirm this message in time. It may still be delivered — check before resending.',
      );
      accepted = true;
      // Receipts that arrive during this write wait for it (see onReceipt).
      const stored = this.persist('mark message sent', () => markSent(sql, job.id, waMessageId, raw));
      this.storing.set(waMessageId, stored);
      setTimeout(() => this.storing.delete(waMessageId), EARLY_RECEIPT_TTL_MS).unref();
      await stored;
      if (recipient) {
        this.lastCampaignAt = Date.now();
        this.campaignFailures = 0;
      }
      await this.publish({ type: 'messages.update', data: { id: job.id, status: 'sent', error: null } });
      const early = this.earlyReceipts.get(waMessageId);
      if (early) {
        this.earlyReceipts.delete(waMessageId);
        await this.applyReceipt(early);
      }
    } catch (err) {
      if (accepted) {
        // Sent, but recording it failed even after retries. Marking it failed would invite a duplicate
        // resend; the row stays `sending` and is flagged "interrupted, resend if needed" on the next start.
        this.log.error({ err, messageId: job.id }, 'message was sent but its status could not be saved');
        return;
      }
      if (err instanceof ProviderError && err.code === 'not_connected') return requeue(sql, job.id);
      if (err instanceof TimeoutError) {
        // Failed, not requeued: it may have gone out, and a resend must stay the client's call (no duplicates).
        this.log.warn({ messageId: job.id }, 'send timed out');
        await this.fail(job.id, err.message);
        if (job.pace) await this.onCampaignFailure();
        // A plain message that hangs means the socket is gone; reconnect instead of stalling the queue.
        if (!MEDIA_TYPES.has(job.content.type)) await this.restartSocket('Send timed out; reconnecting');
        return;
      }
      const message = err instanceof MediaError || err instanceof ProviderError ? err.message : `Send failed: ${(err as Error).message}`;
      this.log.warn({ err, messageId: job.id }, 'send failed');
      await this.fail(job.id, message);
      if (job.pace) await this.onCampaignFailure();
    } finally {
      this.lastSentAt = Date.now();
    }
  }

  /** Failures in a row mean something is wrong with the number or the campaign: stop rather than push on. */
  private async onCampaignFailure() {
    this.campaignFailures += 1;
    if (this.campaignFailures < MAX_CAMPAIGN_FAILURES) return;
    this.campaignFailures = 0;
    await this.shieldStop('failures');
  }

  /**
   * Anti-ban pacing (README §4.4/§10): consecutive messages are spaced by a random gap, and text
   * shows "typing…" for at least SEND_DELAY_MIN_MS. A lone message isn't delayed beyond that.
   * Campaign recipients are scheduled by their campaign's pace; this also keeps them at least its
   * shortest gap apart when they run late, so catching up never turns into a burst.
   */
  private async pace(provider: BaileysProvider, job: QueuedMessage, recipient: boolean) {
    const { min, max } = this.ctx.sendDelay;
    const gap = max > min ? randomInt(min, max + 1) : min;
    const isText = job.content.type === 'text';
    let wait = Math.max(this.lastSentAt + gap - Date.now(), isText ? min : 0);
    if (recipient && job.pace) wait = Math.max(wait, this.lastCampaignAt + BROADCAST_PACES[job.pace].gap.min * 1000 - Date.now());
    if (wait <= 0) return;
    // "typing…" only for the last stretch of a long wait.
    const typing = isText ? Math.min(wait, Math.max(min, gap)) : 0;
    if (wait > typing) await sleep(wait - typing);
    if (typing > 0) {
      await provider.setTyping(job.remote_jid, true).catch(() => {});
      await sleep(typing);
    }
  }

  private async recipientExists(provider: BaileysProvider, jid: string): Promise<boolean> {
    const hit = this.onWhatsApp.get(jid);
    if (hit && Date.now() - hit.at < ON_WHATSAPP_TTL_MS) return hit.exists;
    try {
      const [result] = await withTimeout(provider.isOnWhatsApp([jid.split('@')[0]!]), LOOKUP_TIMEOUT_MS, 'WhatsApp number lookup timed out');
      const exists = result?.exists ?? true;
      if (this.onWhatsApp.size > 10_000) this.onWhatsApp.clear();
      this.onWhatsApp.set(jid, { exists, at: Date.now() });
      return exists;
    } catch (err) {
      this.log.warn({ err }, 'onWhatsApp lookup failed; sending anyway');
      return true;
    }
  }

  private async fail(id: number, error: string) {
    await markFailed(this.ctx.sql, id, error);
    await this.publish({ type: 'messages.update', data: { id, status: 'failed', error } });
  }

  /** One `messages.update` per message, in a single round trip. */
  private async publishFailed(ids: number[], error: string) {
    await notifyMany(
      this.ctx.sql,
      CHANNELS.events,
      ids.map((id): WaEvent => ({ type: 'messages.update', data: { id, status: 'failed', error }, workspaceId: this.workspaceId, sessionId: this.sessionId })),
    );
  }

  // --- operations called over RPC ---------------------------------------------------------------

  async requestPairingCode(phone: string): Promise<string> {
    if (!this.provider) throw new ProviderError('not_connected', 'Session socket is not running yet');
    const code = await withTimeout(this.provider.requestPairingCode(phone), 20_000, 'WhatsApp did not return a pairing code in time');
    await this.write({ status: 'pairing', pairing_code: code });
    await this.publish({ type: 'pairing.updated', data: { code } });
    return code;
  }

  private live(): BaileysProvider {
    if (!this.provider?.connected) throw new ProviderError('not_connected', 'Session is not connected');
    return this.provider;
  }

  /**
   * The chats page is open: follow the presence of the chats it shows (the open one plus the top of
   * the list), so "typing…" appears in the list without opening each chat first. WhatsApp only
   * delivers presence to online clients, so the account shows online while the page watches (it
   * renews this every minute) and goes back offline shortly after, letting the phone notify again.
   * Each contact is subscribed once per socket and online stretch, renewed every few minutes.
   */
  async watchChats(jids: string[]) {
    const provider = this.live();
    const wasOnline = this.onlineUntil > Date.now();
    this.onlineUntil = Date.now() + WATCH_LEASE_MS;
    if (!wasOnline || this.subscribedOn !== provider) {
      this.subscribed.clear();
      this.subscribedOn = provider;
    }
    if (!wasOnline) await withTimeout(provider.setOnline(true), LOOKUP_TIMEOUT_MS, 'presence update timed out');
    const now = Date.now();
    const due = [...new Set(jids)].filter((j) => now - (this.subscribed.get(j) ?? 0) > PRESENCE_RENEW_MS);
    const failed: string[] = [];
    for (const j of due) {
      try {
        await withTimeout(provider.subscribePresence(j), LOOKUP_TIMEOUT_MS, 'presence subscribe timed out');
        this.subscribed.set(j, Date.now());
      } catch {
        failed.push(j);
      }
    }
    this.scheduleOffline();
    // One chat asked for and it failed: say so, as before.
    if (failed.length > 0 && failed.length === due.length && jids.length === 1) throw new Error('presence subscribe failed');
  }

  private scheduleOffline() {
    if (this.onlineTimer) clearTimeout(this.onlineTimer);
    this.onlineTimer = setTimeout(() => {
      this.onlineTimer = null;
      if (Date.now() < this.onlineUntil) return this.scheduleOffline();
      this.onlineUntil = 0;
      if (this.provider?.connected) this.track(this.provider.setOnline(false));
    }, Math.max(1_000, this.onlineUntil - Date.now()));
    this.onlineTimer.unref();
  }

  /** "typing…" / "recording…" shown to the contact while the chats page composes. */
  async chatState(jid: string, state: 'composing' | 'recording' | 'paused') {
    await withTimeout(this.live().sendChatState(jid, state), LOOKUP_TIMEOUT_MS, 'presence update timed out');
  }

  /** Blue ticks for messages read on the chats page. */
  async readMessages(messages: { chatJid: string; waMessageId: string; participant?: string }[]) {
    await withTimeout(this.live().markRead(messages), LOOKUP_TIMEOUT_MS, 'read receipt timed out');
  }

  /** Small profile pictures for the chat list, a few lookups at a time. */
  async pictures(jids: string[]): Promise<Record<string, string | null>> {
    const provider = this.live();
    const result: Record<string, string | null> = {};
    const queue = [...jids];
    const next = async (): Promise<void> => {
      const jid = queue.shift();
      if (!jid) return;
      result[jid] = await withTimeout(provider.pictureUrl(jid), LOOKUP_TIMEOUT_MS, 'picture lookup timed out').catch(() => null);
      return next();
    };
    await Promise.all(Array.from({ length: Math.min(PICTURE_CONCURRENCY, jids.length) }, next));
    return result;
  }

  profile(jid: string) {
    return withTimeout(this.live().profile(jid), LOOKUP_TIMEOUT_MS + 5_000, 'profile lookup timed out');
  }

  /** Asks the phone to upload expired media again; returns the stored WAMessage with a fresh link. */
  reuploadMedia(raw: unknown) {
    return withTimeout(this.live().reuploadMedia(raw), 30_000, 'The phone did not re-upload the media in time');
  }

  isOnWhatsAppLookup(phones: string[]) {
    if (!this.provider) throw new ProviderError('not_connected', 'Session is not connected');
    return withTimeout(this.provider.isOnWhatsApp(phones), LOOKUP_TIMEOUT_MS + 5_000, 'WhatsApp number lookup timed out');
  }

  /**
   * Sends one text right away, outside the queue and never stored — used for the platform's own
   * verification codes, so a code exists only in memory and on the recipient's phone.
   */
  async sendDirect(digits: string, text: string): Promise<{ waMessageId: string }> {
    const provider = this.provider;
    if (!provider?.connected) throw new ProviderError('not_connected', 'Session is not connected');
    const [found] = await withTimeout(provider.isOnWhatsApp([digits]), LOOKUP_TIMEOUT_MS, 'WhatsApp number lookup timed out');
    if (found && !found.exists) throw new ProviderError('invalid_input', 'This number is not on WhatsApp');
    const { waMessageId } = await withTimeout(provider.send(`${digits}@s.whatsapp.net`, { type: 'text', text }), 20_000, 'WhatsApp did not confirm the message in time');
    return { waMessageId };
  }

  /** Unlinks the device from the phone and wipes auth state. */
  async logout() {
    const provider = this.provider;
    this.provider = null;
    this.stopped = true;
    // The unlink request is best effort; the local credentials are wiped regardless.
    await withTimeout(provider?.logout() ?? Promise.resolve(), 10_000, 'logout timed out').catch((err) => this.log.warn({ err }, 'logout request failed'));
    await this.auth?.flush();
    await this.authStore().clear();
    await this.terminate({ status: 'logged_out', desired_state: 'stopped', worker_id: null, qr: null, pairing_code: null, last_error: null });
  }

  // --- stopping ---------------------------------------------------------------------------------

  /** Drops a socket that stopped responding and reconnects through the normal backoff. */
  private async restartSocket(reason: string) {
    const provider = this.provider;
    if (!provider || this.stopped) return;
    this.provider = null;
    await provider.close().catch(() => {});
    await this.onClose({ reason: 'error', statusCode: null, message: reason });
  }

  /** Supervisor-initiated: close the socket (device stays linked) and release the session. */
  async stop() {
    if (this.stopped) return;
    await this.terminate({ status: 'disconnected', worker_id: null, qr: null, pairing_code: null });
  }

  /** Terminal state reached by the runner itself; don't auto-restart until the user reconnects. */
  private finish(status: SessionStatus, lastError: string) {
    return this.terminate({ status, last_error: lastError, desired_state: 'stopped', worker_id: null, qr: null, pairing_code: null });
  }

  /** We no longer own the session (another worker took it over): stop without touching the row. */
  private halt() {
    return this.terminate(null);
  }

  /**
   * Closes the socket, writes the final state, then tells the supervisor. The order matters: the
   * supervisor must not see the session as reclaimable before `worker_id` is released.
   */
  private async terminate(patch: SessionPatch | null) {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.onlineTimer) clearTimeout(this.onlineTimer);
    this.onlineTimer = null;
    // Credentials asked to be saved must reach the database before the socket (and maybe the process) goes.
    await withTimeout(this.auth?.flush() ?? Promise.resolve(), FLUSH_TIMEOUT_MS, 'creds flush timed out').catch((err) => this.log.error({ err }, 'pending credentials were not saved'));
    const provider = this.provider;
    this.provider = null;
    await provider?.close();
    if (patch) await this.write(patch).catch((err) => this.log.error({ err }, 'failed to write final session state'));
    this.ctx.onStopped(this.sessionId);
  }

  // --- persistence ------------------------------------------------------------------------------

  /** Fenced update: applies only while this worker still owns the session. Returns ownership. */
  private async write(patch: SessionPatch): Promise<boolean> {
    const { sql, workerId } = this.ctx;
    const rows = await sql`
      update sessions set ${sql(patch)}, updated_at = now()
      where id = ${this.sessionId} and worker_id = ${workerId}
      returning id`;
    if (rows.length === 0) return false;

    const changed =
      (patch.status !== undefined && patch.status !== this.status) ||
      (patch.last_error !== undefined && patch.last_error !== this.lastError) ||
      (patch.phone !== undefined && patch.phone !== this.phone);
    if (patch.status !== undefined) this.status = patch.status;
    if (patch.last_error !== undefined) this.lastError = patch.last_error;
    if (patch.phone !== undefined) this.phone = patch.phone;
    if (changed) {
      await this.publish({ type: 'session.status', data: { status: this.status, phone: this.phone, lastError: this.lastError } });
    }
    return true;
  }

  private async publish(event: EventInput) {
    await notify(this.ctx.sql, CHANNELS.events, { ...event, workspaceId: this.workspaceId, sessionId: this.sessionId });
  }
}
