import { setTimeout as sleep } from 'node:timers/promises';
import {
  activeSyncJob,
  addSyncLog,
  finishSyncChat,
  loadSyncJob,
  nextSyncChat,
  oldestAnchor,
  recordSyncAttempt,
  recordSyncPage,
  type SyncChat,
  type SyncJob,
  seedSyncChats,
  setSyncStatus,
  type Sql,
  startSyncChat,
  syncProgress,
} from '@wa/db';
import type { HistoryAnchor } from '@wa/provider';
import { isGroupJid, type SyncLogCode, type SyncLogLevel, type SyncLogParams, type WaEvent } from '@wa/shared';
import type { Logger } from 'pino';

/** Messages asked of the phone per request (WhatsApp answers at most about this many). */
export const SYNC_PAGE = 50;
/** Requests per conversation in one job: a cap on how deep one conversation goes (~5,000 messages). */
const MAX_PAGES = 100;
/** How long to wait for the phone to answer a request, and how often to ask before giving up. */
const PAGE_TIMEOUT_MS = 20_000;
const PAGE_ATTEMPTS = 2;
/** Gap between requests to the phone, so a sync never floods it (nor our database). */
const REQUEST_GAP_MS = 500;
/** Conversations in a row the phone ignored, while it answered none: the job pauses (phone offline). */
const MAX_SILENT_CHATS = 3;
/** How long the address-book refresh may take before the sync goes on without it. */
const CONTACTS_TIMEOUT_MS = 30_000;
/** Progress events at most this often (status changes always go out). */
const PROGRESS_EVERY_MS = 500;

/**
 * Sync jobs running at once on a worker. A job is light (one request in flight, then a batch
 * insert), but a worker may carry 20+ numbers: the rest wait their turn in `queued`.
 */
export class SyncSlots {
  private used = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(readonly max: number) {}

  get free() {
    return this.used < this.max;
  }

  async acquire(): Promise<() => void> {
    if (this.used >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.used += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next(); // the slot passes straight on
      else this.used -= 1;
    };
  }
}

type SyncEvent = Extract<WaEvent, { type: 'sync.progress' | 'sync.log' }>;
type SyncEventInput = SyncEvent extends infer E ? (E extends SyncEvent ? Omit<E, 'workspaceId' | 'sessionId'> : never) : never;

/** What a sync needs from its session runner. */
export type SyncHost = {
  sql: Sql;
  sessionId: string;
  workspaceId: string;
  log: Logger;
  slots: SyncSlots;
  connected: () => boolean;
  /** Asks the phone for older messages; the answer arrives through `SessionSync.onHistory`. */
  requestHistory: (anchor: HistoryAnchor, count: number) => Promise<void>;
  /** Asks WhatsApp for the address-book names again (they arrive as contact events, see runner.onContacts). */
  refreshContacts: () => Promise<void>;
  /** Refreshes a group's subject; resolves to it (or null). */
  nameGroup: (jid: string) => Promise<string | null>;
  publish: (event: SyncEventInput) => Promise<void>;
};

/** Waits of a sync (shortened in tests). */
export type SyncTiming = { pageTimeoutMs: number; requestGapMs: number };

/** Messages of one on-demand answer that belong to the conversation asked about. */
export type PageAnswer = { received: number; added: number };

/**
 * `end`: the phone said there is nothing older (an empty or all-known page) or the per-job cap was hit;
 * `unanswered`: no answer after every attempt — WhatsApp may drop an empty answer, so once the phone has
 * answered in this run that means "nothing older" (re-running a sync is always safe: it asks from the
 * oldest stored message and duplicates are refused); `interrupted`: paused, cancelled, disconnected, stopped.
 */
type Outcome = 'end' | 'unanswered' | 'interrupted';

/**
 * Runs the number's sync job (README: chats sync). The job lives in `sync_jobs`; this only drives
 * it while the number is connected on this worker, so it survives disconnects and restarts: the
 * next run picks up the conversation it was on, from the oldest message stored (requests are
 * idempotent, and stored messages are de-duplicated by WhatsApp id).
 */
export class SessionSync {
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private waiter: { jids: Set<string>; resolve: (answer: PageAnswer | 'aborted' | null) => void } | null = null;
  private lastProgressAt = 0;
  private waitingLogged: SyncLogCode | null = null;

  private readonly timing: SyncTiming;

  constructor(
    private readonly host: SyncHost,
    timing: Partial<SyncTiming> = {},
  ) {
    this.timing = { pageTimeoutMs: PAGE_TIMEOUT_MS, requestGapMs: REQUEST_GAP_MS, ...timing };
  }

  /** Starts (or re-checks) the job; calls while a run is going coalesce into one more pass. */
  request() {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.run();
        } while (this.again && !this.stopped);
      } catch (err) {
        this.host.log.error({ err }, 'sync run failed');
      } finally {
        this.running = null;
      }
    })();
  }

  /** The job changed under us (paused, cancelled, resumed): stop waiting on the phone and re-read it. */
  interrupt() {
    this.waiter?.resolve('aborted');
    this.request();
  }

  /** The runner is stopping: let go (the job stays as it is and resumes wherever the number runs next). */
  stop() {
    this.stopped = true;
    this.waiter?.resolve('aborted');
  }

  /** An on-demand history answer arrived (already stored): wakes the request waiting for it. */
  onHistory(chatJids: string[], perChat: Map<string, PageAnswer>) {
    const waiter = this.waiter;
    if (!waiter) return;
    let hit = chatJids.some((j) => waiter.jids.has(j));
    const answer: PageAnswer = { received: 0, added: 0 };
    for (const [jid, counts] of perChat) {
      if (!waiter.jids.has(jid)) continue;
      hit = true;
      answer.received += counts.received;
      answer.added += counts.added;
    }
    if (hit) waiter.resolve(answer);
  }

  get busy() {
    return this.running !== null;
  }

  private async run() {
    const { sql, sessionId, slots } = this.host;
    let job = await activeSyncJob(sql, sessionId);
    if (!job || job.status === 'paused') return;
    if (!this.host.connected()) return this.waitFor(job, 'waiting_connection');
    if (!slots.free) await this.waitFor(job, 'waiting_slot', false);
    const release = await slots.acquire();
    try {
      job = await loadSyncJob(sql, job.id);
      if (!job || (job.status !== 'queued' && job.status !== 'running') || this.stopped) return;
      const resumed = job.status === 'running' || job.chats_total > 0;
      job = await setSyncStatus(sql, job.id, ['queued', 'running'], 'running');
      if (!job) return;
      this.waitingLogged = null;
      await this.logLine(job.id, 'info', resumed ? 'resumed' : 'started');
      const before = job.chats_total;
      const total = await seedSyncChats(sql, job.id, sessionId);
      if (before === 0) {
        await this.logLine(job.id, 'info', 'found_chats', { total });
        // Names saved on the phone, so conversations show them as they sync. Best effort.
        const refreshed = await Promise.race([this.host.refreshContacts().then(() => true), sleep(CONTACTS_TIMEOUT_MS).then(() => false)]).catch(() => false);
        await this.logLine(job.id, refreshed ? 'info' : 'warning', refreshed ? 'contacts_requested' : 'contacts_failed');
      }
      await this.progress((await loadSyncJob(sql, job.id))!, true);
      await this.work(job.id);
    } finally {
      release();
    }
  }

  /** Conversation after conversation until the job ends, pauses, or the number goes away. */
  private async work(jobId: string) {
    const { sql } = this.host;
    let answered = false;
    let silent = 0;
    for (;;) {
      if (this.stopped) return;
      let job = await loadSyncJob(sql, jobId);
      if (!job || job.status !== 'running') return;
      if (!this.host.connected()) {
        job = await setSyncStatus(sql, jobId, ['running'], 'queued');
        if (job) await this.waitFor(job, 'waiting_connection');
        return;
      }
      const chat = await nextSyncChat(sql, jobId);
      if (!chat) {
        job = await setSyncStatus(sql, jobId, ['running'], 'completed');
        if (job) {
          await this.logLine(jobId, 'success', 'completed', { total: job.chats_done, added: job.messages_added });
          await this.progress(job, true);
        }
        return;
      }
      job = await startSyncChat(sql, jobId, chat);
      if (job) await this.progress(job, true);
      await this.logLine(jobId, 'progress', 'chat_start', { name: label(chat) });

      const outcome = await this.syncChat(jobId, chat, () => (answered = true));
      if (outcome === 'interrupted') continue; // the top of the loop works out why (and says so)
      if (outcome === 'unanswered' && !answered) {
        silent += 1;
        job = await finishSyncChat(sql, jobId, chat.jid, 'failed', 'The phone did not answer');
        await this.logLine(jobId, 'error', 'chat_failed', { name: label(chat), error: 'no_answer' });
        if (job) await this.progress(job, true);
        if (silent >= MAX_SILENT_CHATS) {
          job = await setSyncStatus(sql, jobId, ['running'], 'paused', { pauseReason: 'phone_unresponsive' });
          if (job) {
            await this.logLine(jobId, 'warning', 'phone_unresponsive');
            await this.progress(job, true);
          }
          return;
        }
        continue;
      }
      silent = 0;
      job = await finishSyncChat(sql, jobId, chat.jid, 'done');
      const added = (await this.chatAdded(jobId, chat.jid)) ?? chat.added;
      // `unanswered` while the phone answers other requests: this conversation has nothing older.
      await this.logLine(jobId, 'success', outcome === 'end' ? 'chat_done' : 'chat_end', { name: label(chat), added });
      if (job) await this.progress(job, true);
    }
  }

  /** Pages back through one conversation until its history ends (or the per-job cap). */
  private async syncChat(jobId: string, chat: SyncChat, onAnswer: () => void): Promise<Outcome> {
    const { sql, sessionId } = this.host;
    if (isGroupJid(chat.jid)) {
      const subject = await this.host.nameGroup(chat.jid).catch(() => null);
      if (subject && subject !== chat.name) await this.logLine(jobId, 'info', 'group_named', { name: subject });
    }
    const [row] = await sql<{ jid: string; alt_jid: string | null }[]>`
      select jid, alt_jid from chats where session_id = ${sessionId} and (jid = ${chat.jid} or alt_jid = ${chat.jid})`;
    const jids = [...new Set([chat.jid, ...(row ? [row.jid, ...(row.alt_jid ? [row.alt_jid] : [])] : [])])];

    for (let page = chat.pages; page < MAX_PAGES; ) {
      const job = await loadSyncJob(sql, jobId);
      if (this.stopped || job?.status !== 'running' || !this.host.connected()) return 'interrupted';
      const anchor = await oldestAnchor(sql, sessionId, jids);
      if (!anchor) return 'end'; // nothing to ask from (e.g. only failed sends)
      const answer = await this.ask(anchor, jids);
      if (answer === 'aborted') return 'interrupted';
      if (answer === null) {
        const attempts = await recordSyncAttempt(sql, jobId, chat.jid, 'No answer from the phone');
        if (attempts >= PAGE_ATTEMPTS) return 'unanswered';
        await this.logLine(jobId, 'warning', 'chat_retry', { name: label(chat), attempt: attempts + 1 });
        continue;
      }
      onAnswer();
      if (answer.received === 0) return 'end';
      page += 1;
      const updated = await recordSyncPage(sql, jobId, chat.jid, answer.added);
      if (answer.added > 0) await this.logLine(jobId, 'info', 'chat_page', { name: label(chat), page, added: answer.added });
      if (updated) await this.progress(updated);
      // Everything returned was already stored: we've reached history we have.
      if (answer.added === 0) return 'end';
      await sleep(this.timing.requestGapMs);
    }
    return 'end';
  }

  /** One request to the phone; its answer, null if none came in time, or 'aborted'. */
  private async ask(anchor: HistoryAnchor, jids: string[]): Promise<PageAnswer | 'aborted' | null> {
    let timer: NodeJS.Timeout | undefined;
    const answered = new Promise<PageAnswer | 'aborted' | null>((resolve) => {
      this.waiter = { jids: new Set(jids), resolve };
      timer = setTimeout(() => resolve(null), this.timing.pageTimeoutMs);
    });
    try {
      await this.host.requestHistory(anchor, SYNC_PAGE);
      return await answered;
    } catch (err) {
      this.host.log.warn({ err }, 'history request failed');
      return null;
    } finally {
      clearTimeout(timer);
      this.waiter = null;
    }
  }

  private async chatAdded(jobId: string, jid: string) {
    const [row] = await this.host.sql<{ added: number }[]>`select added from sync_job_chats where job_id = ${jobId} and jid = ${jid}`;
    return row?.added;
  }

  /** Says once (not every pass) why a queued job is waiting. */
  private async waitFor(job: SyncJob, code: 'waiting_connection' | 'waiting_slot', publish = true) {
    if (this.waitingLogged === code) return;
    this.waitingLogged = code;
    await this.logLine(job.id, 'info', code);
    if (publish) await this.progress(job, true);
  }

  private async logLine(jobId: string, level: SyncLogLevel, code: SyncLogCode, params: SyncLogParams = {}) {
    const entry = await addSyncLog(this.host.sql, jobId, level, code, params);
    await this.host.publish({ type: 'sync.log', data: { ...entry, jobId } });
  }

  private async progress(job: SyncJob, force = false) {
    const now = Date.now();
    if (!force && now - this.lastProgressAt < PROGRESS_EVERY_MS) return;
    this.lastProgressAt = now;
    await this.host.publish({ type: 'sync.progress', data: syncProgress(job) });
  }
}

/** How a conversation is named in the log: its name, else its number. */
function label(chat: { jid: string; name: string | null }) {
  if (chat.name) return chat.name;
  const user = chat.jid.split('@')[0] ?? chat.jid;
  return chat.jid.endsWith('@s.whatsapp.net') ? `+${user}` : user;
}
