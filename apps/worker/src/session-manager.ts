import { setTimeout as sleep } from 'node:timers/promises';
import { UnrecoverableError, type Job } from 'bullmq';
import { and, eq, messages, sessions, type Db, type EventBus } from '@wa/db';
import { BaileysProvider, SessionNotConnectedError, type OutboundContent, type Provider } from '@wa/provider';
import type { PlatformEvent, SendJob, SessionStatus } from '@wa/shared';
import { config, logger } from './config';

const rand = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

export class SessionManager {
  private providers = new Map<string, Provider>();
  /** Per-session promise chain: one send at a time per session, in pickup order. */
  private chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
  ) {}

  get size() {
    return this.providers.size;
  }

  get(sessionId: string) {
    return this.providers.get(sessionId);
  }

  private publish(event: PlatformEvent) {
    return this.bus.publish(event).catch((err) => logger.warn({ err: (err as Error).message }, 'publish failed'));
  }

  private create(sessionId: string) {
    const provider = new BaileysProvider({ sessionId, db: this.db, encryptionKey: config.encryptionKey, logger });
    this.wire(provider);
    return provider;
  }

  async start(sessionId: string): Promise<Provider> {
    let provider = this.providers.get(sessionId);
    if (!provider) {
      if (this.providers.size >= config.maxSessions) throw new Error(`Worker ${config.workerId} is at capacity`);
      provider = this.create(sessionId);
      this.providers.set(sessionId, provider);
    }
    await provider.connect();
    return provider;
  }

  async stop(sessionId: string, mode: 'disconnect' | 'logout' | 'shutdown') {
    const provider = this.providers.get(sessionId);
    if (mode === 'logout') await (provider ?? this.create(sessionId)).logout();
    else await provider?.disconnect();
    this.providers.delete(sessionId);
  }

  async stopAll() {
    await Promise.allSettled([...this.providers.keys()].map((id) => this.stop(id, 'shutdown')));
  }

  private wire(provider: Provider) {
    const sessionId = provider.sessionId;
    const now = () => Date.now();
    const update = (patch: Partial<typeof sessions.$inferInsert>) =>
      this.db
        .update(sessions)
        .set(patch)
        .where(eq(sessions.id, sessionId))
        .catch((err) => logger.error({ err }, 'session update failed'));

    provider.on('status', (status: SessionStatus, info) => {
      logger.info({ sessionId, status, reason: info.reason }, 'session status');
      const patch: Partial<typeof sessions.$inferInsert> = { status, lastSeenAt: new Date() };
      if (info.phone) patch.phone = info.phone;
      if (status === 'logged_out') patch.autoConnect = false;
      if (status !== 'qr') Object.assign(patch, { qr: null, qrUpdatedAt: null });
      void update(patch);
      void this.publish({ event: 'session.status', sessionId, timestamp: now(), data: { status, phone: info.phone, reason: info.reason } });
    });

    provider.on('qr', (qr) => {
      void update({ qr, qrUpdatedAt: new Date() });
      void this.publish({ event: 'qrcode.updated', sessionId, timestamp: now(), data: { qr } });
    });

    provider.on('message', async (m) => {
      try {
        await this.db.insert(messages).values({
          sessionId,
          direction: 'in',
          remoteJid: m.remoteJid,
          waMessageId: m.waMessageId,
          type: normalizeType(m.type),
          body: { text: m.text, type: m.type, pushName: m.pushName },
          status: 'delivered',
        });
        await this.publish({ event: 'messages.received', sessionId, timestamp: now(), data: { id: m.waMessageId, from: m.from, text: m.text, type: m.type } });
      } catch (err) {
        logger.error({ err, sessionId }, 'failed to store inbound message');
      }
    });

    provider.on('message.status', async (u) => {
      await this.db
        .update(messages)
        .set({ status: u.status })
        .where(and(eq(messages.sessionId, sessionId), eq(messages.waMessageId, u.waMessageId)))
        .catch((err) => logger.error({ err }, 'status update failed'));
      await this.publish({ event: 'messages.update', sessionId, timestamp: now(), data: { id: u.waMessageId, remoteJid: u.remoteJid, status: u.status } });
    });
  }

  /** Entry point for the worker's send queue. Serializes per session. */
  processSend(job: Job<SendJob>) {
    const { sessionId } = job.data;
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.send(job));
    this.chains.set(sessionId, run);
    void run.finally(() => {
      if (this.chains.get(sessionId) === run) this.chains.delete(sessionId);
    }).catch(() => {});
    return run;
  }

  /** Human-like pacing to reduce ban risk. */
  private async send(job: Job<SendJob>) {
    const msg = await this.db.query.messages.findFirst({ where: eq(messages.id, job.data.messageId) });
    if (!msg) throw new UnrecoverableError('message row not found');
    if (msg.status !== 'pending') return { skipped: msg.status };

    const provider = this.providers.get(msg.sessionId);
    const content = msg.body as OutboundContent;
    const setFailed = (error: string) => this.db.update(messages).set({ status: 'failed', error }).where(eq(messages.id, msg.id));

    try {
      if (!provider) throw new SessionNotConnectedError(msg.sessionId);
      const check = await provider.isOnWhatsApp(msg.remoteJid);
      if (!check.exists) {
        await setFailed('Recipient is not on WhatsApp');
        throw new UnrecoverableError('Recipient is not on WhatsApp');
      }
      const jid = check.jid ?? msg.remoteJid;

      if (content.type === 'text') {
        await provider.setPresence(jid, 'composing');
        await sleep(Math.min(800 + content.text.length * 40, 4000));
        await provider.setPresence(jid, 'paused');
      }
      const result = await provider.send(jid, content);
      await this.db
        .update(messages)
        .set({ status: 'sent', waMessageId: result.waMessageId, remoteJid: result.remoteJid, error: null })
        .where(eq(messages.id, msg.id));
      await sleep(rand(config.sendMinDelayMs, config.sendMaxDelayMs));
      return result;
    } catch (err) {
      if (err instanceof UnrecoverableError) throw err;
      const notConnected = err instanceof SessionNotConnectedError;
      const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (final || !notConnected) await setFailed((err as Error).message);
      if (!notConnected) throw new UnrecoverableError((err as Error).message);
      throw err;
    }
  }
}

const TYPES = new Set(['text', 'image', 'video', 'audio', 'document', 'location', 'contact', 'sticker']);
function normalizeType(t: string) {
  if (t === 'conversation' || t === 'extendedText') return 'text' as const;
  if (t === 'contacts' || t === 'contactsArray') return 'contact' as const;
  return (TYPES.has(t) ? t : 'text') as 'text';
}
