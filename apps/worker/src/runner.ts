import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  advanceStatus,
  claimNextOutbound,
  failInterrupted,
  loadOutboundRaw,
  markFailed,
  markSent,
  notify,
  pgAuthStore,
  type QueuedMessage,
  recordPollVote,
  requeue,
  type SessionSettings,
  type Sql,
} from '@wa/db';
import {
  BaileysProvider,
  type InboundMessage,
  type MediaFetcher,
  ProviderError,
  type ProviderEvents,
  useEncryptedAuthState,
} from '@wa/provider';
import { CHANNELS, type DesiredState, isUserJid, jidToPhone, type SessionStatus, type WaEvent } from '@wa/shared';
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
}>;

type EventInput = WaEvent extends infer E ? (E extends WaEvent ? Omit<E, 'workspaceId' | 'sessionId'> : never) : never;

const MAX_RECONNECTS = 20;
const ON_WHATSAPP_TTL_MS = 24 * 60 * 60_000;
/** Number lookups: Baileys would wait 60s on a dead socket. */
const LOOKUP_TIMEOUT_MS = 10_000;
/** Sending: generous for media (uploads to WhatsApp's CDN), tight for everything else. */
const SEND_TIMEOUT_MS = { media: 5 * 60_000, other: 45_000 };
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

/** Why WhatsApp rejected a message (the code of its error ack), in words a customer can act on. */
const REJECTIONS: Record<string, string> = {
  '463':
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
  private readonly onWhatsApp = new Map<string, { exists: boolean; at: number }>();
  /**
   * Receipts can beat our own write of the WhatsApp id: an error ack often arrives before the
   * `markSent` round-trip finishes. `storing` holds those in-flight writes, `earlyReceipts` the
   * receipts that came before the send even returned (both keyed by WhatsApp message id).
   */
  private readonly storing = new Map<string, Promise<unknown>>();
  private readonly earlyReceipts = new Map<string, ProviderEvents['receipt']>();
  private readonly log: Logger;

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

  async start() {
    const interrupted = await failInterrupted(this.ctx.sql, this.sessionId);
    for (const id of interrupted) {
      await this.publish({ type: 'messages.update', data: { id, status: 'failed', error: 'Interrupted while sending' } });
    }
    await this.connect();
  }

  private async connect() {
    if (this.stopped) return;
    try {
      if (!(await this.write({ status: 'connecting' }))) return this.halt();
      const auth = await useEncryptedAuthState(pgAuthStore(this.ctx.sql, this.sessionId), this.sessionId, this.ctx.encryptionKey);
      if (this.stopped) return;
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
      await provider.connect();
    } catch (err) {
      this.log.error({ err }, 'connect failed');
      await this.onClose({ reason: 'error', statusCode: null, message: (err as Error).message });
    }
  }

  /** Provider events are fire-and-forget; surface failures in logs instead of unhandled rejections. */
  private track(promise: Promise<unknown>) {
    promise.catch((err) => this.log.error({ err }, 'session event handler failed'));
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
        await pgAuthStore(this.ctx.sql, this.sessionId).clear();
        return this.finish('logged_out', 'The device was logged out from the phone');
      case 'qr_timeout':
        return this.finish('disconnected', 'QR code expired before it was scanned');
    }
    this.reconnects += 1;
    if (this.reconnects > MAX_RECONNECTS) {
      return this.finish('needs_attention', `Gave up after ${MAX_RECONNECTS} reconnect attempts: ${message}`);
    }
    const delay = Math.min(60_000, 1_000 * 2 ** (this.reconnects - 1));
    if (!(await this.write({ status: 'connecting', last_error: message }))) return this.halt();
    this.reconnectTimer = setTimeout(() => this.track(this.connect()), delay);
  }

  private async onMessage(m: InboundMessage) {
    const { sql } = this.ctx;
    const content = { from: m.from, fromPhone: jidToPhone(m.from), pushName: m.pushName, text: m.text, isGroup: m.isGroup, timestamp: m.timestamp };
    const [row] = await sql<{ id: number }[]>`
      insert into messages (workspace_id, session_id, direction, remote_jid, wa_message_id, type, content, raw, status)
      values (${this.workspaceId}, ${this.sessionId}, 'in', ${m.chatJid}, ${m.waMessageId}, ${m.type},
              ${sql.json(content)}, ${sql.json(m.raw as never)}, 'received')
      on conflict (session_id, wa_message_id) do nothing
      returning id`;
    if (!row) return; // duplicate delivery
    await this.publish({ type: 'messages.received', data: { id: row.id, from: m.from, type: m.type, text: m.text } });
    if (this.settings.autoRead) await this.provider?.markRead([m]).catch((err) => this.log.warn({ err }, 'markRead failed'));
  }

  private async onReceipt(receipt: ProviderEvents['receipt']) {
    const { waMessageId } = receipt;
    const pending = this.storing.get(waMessageId);
    if (pending) await pending.catch(() => {});
    if (await this.applyReceipt(receipt)) return;
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
    try {
      if (isUserJid(jid) && !(await this.recipientExists(provider, jid))) {
        return await this.fail(job.id, 'Recipient is not on WhatsApp');
      }
      await this.pace(provider, jid, job.content.type === 'text');
      const media = MEDIA_TYPES.has(job.content.type);
      const { waMessageId, raw } = await withTimeout(
        provider.send(jid, job.content),
        media ? SEND_TIMEOUT_MS.media : SEND_TIMEOUT_MS.other,
        'WhatsApp did not confirm this message in time. It may still be delivered — check before resending.',
      );
      // Receipts that arrive during this write wait for it (see onReceipt).
      const stored = markSent(sql, job.id, waMessageId, raw);
      this.storing.set(waMessageId, stored);
      setTimeout(() => this.storing.delete(waMessageId), EARLY_RECEIPT_TTL_MS).unref();
      await stored;
      await this.publish({ type: 'messages.update', data: { id: job.id, status: 'sent', error: null } });
      const early = this.earlyReceipts.get(waMessageId);
      if (early) {
        this.earlyReceipts.delete(waMessageId);
        await this.applyReceipt(early);
      }
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'not_connected') return requeue(sql, job.id);
      if (err instanceof TimeoutError) {
        // Failed, not requeued: it may have gone out, and a resend must stay the client's call (no duplicates).
        this.log.warn({ messageId: job.id }, 'send timed out');
        await this.fail(job.id, err.message);
        // A plain message that hangs means the socket is gone; reconnect instead of stalling the queue.
        if (!MEDIA_TYPES.has(job.content.type)) await this.restartSocket('Send timed out; reconnecting');
        return;
      }
      const message = err instanceof MediaError || err instanceof ProviderError ? err.message : `Send failed: ${(err as Error).message}`;
      this.log.warn({ err, messageId: job.id }, 'send failed');
      await this.fail(job.id, message);
    } finally {
      this.lastSentAt = Date.now();
    }
  }

  /**
   * Anti-ban pacing (README §4.4/§10): consecutive messages are spaced by a random gap, and text
   * shows "typing…" for at least SEND_DELAY_MIN_MS. A lone message isn't delayed beyond that.
   */
  private async pace(provider: BaileysProvider, jid: string, isText: boolean) {
    const { min, max } = this.ctx.sendDelay;
    const gap = max > min ? randomInt(min, max + 1) : min;
    const wait = Math.max(this.lastSentAt + gap - Date.now(), isText ? min : 0);
    if (wait <= 0) return;
    if (isText) await provider.setTyping(jid, true).catch(() => {});
    await sleep(wait);
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

  // --- operations called over RPC ---------------------------------------------------------------

  async requestPairingCode(phone: string): Promise<string> {
    if (!this.provider) throw new ProviderError('not_connected', 'Session socket is not running yet');
    const code = await withTimeout(this.provider.requestPairingCode(phone), 20_000, 'WhatsApp did not return a pairing code in time');
    await this.write({ status: 'pairing', pairing_code: code });
    await this.publish({ type: 'pairing.updated', data: { code } });
    return code;
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
    await pgAuthStore(this.ctx.sql, this.sessionId).clear();
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
