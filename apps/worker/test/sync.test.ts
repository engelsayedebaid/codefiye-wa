import { setTimeout as sleep } from 'node:timers/promises';
import { createDb, createSyncJob, loadSyncJob, runMigrations, setSyncStatus, type Sql, type SyncJob } from '@wa/db';
import type { HistoryAnchor } from '@wa/provider';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PageAnswer, SessionSync, SyncSlots } from '../src/sync';

const url = process.env.TEST_DATABASE_URL;
const silent = pino({ level: 'silent' });

type PhoneMessage = { id: string; ts: number; fromMe: boolean; type: string };

/**
 * A phone holding each conversation's full history (oldest first). Answers on-demand requests the
 * way WhatsApp does — up to `count` messages older than the anchor, a moment later — and stores them
 * like the runner's onHistory (de-duplicated by WhatsApp id).
 */
class FakePhone {
  readonly history = new Map<string, PhoneMessage[]>();
  requests = 0;
  /** Not answering at all (offline). */
  silent = false;
  /** Also return this many already-stored messages with each page (overlap). */
  overlap = 0;
  sync!: SessionSync;

  constructor(
    private readonly sql: Sql,
    private readonly workspaceId: string,
    private readonly sessionId: string,
  ) {}

  /** A conversation of `total` messages, of which the newest `stored` are in the database already. */
  async chat(jid: string, total: number, stored: number, { media = false } = {}) {
    const all = Array.from({ length: total }, (_, i) => ({
      id: `${jid.split('@')[0]}-${i}`,
      ts: 1_700_000_000 + i * 60,
      fromMe: i % 4 === 0,
      type: media && i % 5 === 0 ? 'image' : 'text',
    }));
    this.history.set(jid, all);
    await this.store(jid, all.slice(total - stored), false);
  }

  async store(jid: string, messages: PhoneMessage[], history = true) {
    if (messages.length === 0) return [] as { remote_jid: string }[];
    const rows = messages.map((m) => ({
      direction: m.fromMe ? 'out' : 'in',
      wa: m.id,
      type: m.type,
      content: m.fromMe
        ? { text: m.id, timestamp: m.ts, sentFrom: 'phone', history, ...(m.type === 'image' ? { media: { mimetype: 'image/jpeg' } } : {}) }
        : { from: jid, text: m.id, timestamp: m.ts, history, ...(m.type === 'image' ? { media: { mimetype: 'image/jpeg' } } : {}) },
      raw: m.type === 'image' ? { key: { id: m.id }, message: { imageMessage: { mediaKey: 'k' } } } : null,
      status: m.fromMe ? 'sent' : 'received',
      ts: m.ts,
    }));
    return this.sql<{ remote_jid: string }[]>`
      insert into messages (workspace_id, session_id, direction, remote_jid, wa_message_id, type, content, raw, status, created_at)
      select ${this.workspaceId}, ${this.sessionId}, x.direction, ${jid}, x.wa, x.type, x.content, x.raw, x.status, to_timestamp(x.ts)
      from jsonb_to_recordset(${this.sql.json(rows as never)}) as x(direction text, wa text, type text, content jsonb, raw jsonb, status text, ts float8)
      on conflict (session_id, wa_message_id) do nothing
      returning remote_jid`;
  }

  requestHistory = async (anchor: HistoryAnchor, count: number) => {
    this.requests += 1;
    if (this.silent) return;
    const all = this.history.get(anchor.chatJid) ?? [];
    const at = all.findIndex((m) => m.id === anchor.id);
    const page = all.slice(Math.max(0, at - count), at);
    const extra = this.overlap ? all.slice(at, at + this.overlap) : [];
    setTimeout(async () => {
      const inserted = await this.store(anchor.chatJid, [...page, ...extra]);
      const perChat = new Map<string, PageAnswer>([[anchor.chatJid, { received: page.length + extra.length, added: inserted.length }]]);
      this.sync.onHistory([anchor.chatJid], perChat);
    }, 5 + Math.random() * 15);
  };
}

describe.skipIf(!url)('conversation sync (integration)', () => {
  let sql: Sql;
  let workspaceId: string;
  let otherWorkspace: string;
  let n = 0;

  beforeAll(async () => {
    await runMigrations(url!);
    sql = createDb(url!, { max: 20 }).sql;
    workspaceId = (await sql<{ id: string }[]>`insert into workspaces (name) values ('sync-test') returning id`)[0]!.id;
    otherWorkspace = (await sql<{ id: string }[]>`insert into workspaces (name) values ('sync-test-other') returning id`)[0]!.id;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id in (${workspaceId}, ${otherWorkspace})`;
    await sql.end();
  });

  /** A number with a fake phone and its sync engine (as a runner would build it). */
  /** Long enough for an answer stored in a remote test database; short enough to test a silent phone. */
  const answerTimeout = 5_000;

  async function number({ slots = new SyncSlots(3), workspace = workspaceId, refreshContacts = async () => {} } = {}) {
    const [row] = await sql<{ id: string }[]>`
      insert into sessions (workspace_id, name, status, desired_state) values (${workspace}, ${`n${++n}-${Date.now()}`}, 'connected', 'running') returning id`;
    const sessionId = row!.id;
    const phone = new FakePhone(sql, workspace, sessionId);
    const events: { type: string; data: unknown; workspaceId: string; sessionId: string }[] = [];
    let online = true;
    const make = () => {
      const sync = new SessionSync(
        {
          sql,
          sessionId,
          workspaceId: workspace,
          log: silent,
          slots,
          connected: () => online,
          requestHistory: phone.requestHistory,
          nameGroup: async () => null,
          refreshContacts,
          publish: async (event) => void events.push({ ...event, workspaceId: workspace, sessionId }),
        },
        { pageTimeoutMs: answerTimeout, requestGapMs: 5 },
      );
      phone.sync = sync;
      return sync;
    };
    const stored = async () => (await sql<{ n: number }[]>`select count(*)::int as n from messages where session_id = ${sessionId}`)[0]!.n;
    const unique = async () => (await sql<{ n: number }[]>`select count(distinct wa_message_id)::int as n from messages where session_id = ${sessionId}`)[0]!.n;
    return { sessionId, phone, events, make, stored, unique, setOnline: (v: boolean) => (online = v) };
  }

  const start = async (sessionId: string, workspace = workspaceId) => (await createSyncJob(sql, workspace, sessionId)).job;

  /** Waits until `check` holds. */
  async function eventually(check: () => boolean | Promise<boolean>, ms = 30_000) {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error('condition not met in time');
      await sleep(50);
    }
  }
  const progressed = (jobId: string) => eventually(async () => ((await loadSyncJob(sql, jobId))?.messages_added ?? 0) > 0);
  const logged = (events: { type: string; data: unknown }[], code: string) => events.some((e) => e.type === 'sync.log' && (e.data as { code: string }).code === code);

  /** Waits until the job reaches one of `states`. */
  async function until(jobId: string, states: SyncJob['status'][], ms = 30_000): Promise<SyncJob> {
    const end = Date.now() + ms;
    for (;;) {
      const job = await loadSyncJob(sql, jobId);
      if (job && states.includes(job.status)) return job;
      if (Date.now() > end) throw new Error(`sync stuck in ${job?.status}`);
      await sleep(50);
    }
  }

  it('syncs a small history completely and reports progress and log lines', async () => {
    const num = await number();
    await num.phone.chat('201000000001@s.whatsapp.net', 30, 5);
    await num.phone.chat('201000000002@s.whatsapp.net', 12, 2);
    await num.phone.chat('120363000000000001@g.us', 8, 8); // nothing older to fetch
    const job = await start(num.sessionId);
    const sync = num.make();
    sync.request();
    const done = await until(job.id, ['completed']);
    expect(done).toMatchObject({ chats_total: 3, chats_done: 3, chats_failed: 0, messages_added: 25 + 10 });
    expect(await num.stored()).toBe(30 + 12 + 8);
    const types = num.events.map((e) => e.type);
    expect(types).toContain('sync.progress');
    expect(num.events.filter((e) => e.type === 'sync.log').map((e) => (e.data as { code: string }).code)).toEqual(
      expect.arrayContaining(['started', 'found_chats', 'contacts_requested', 'chat_start', 'chat_done', 'completed']),
    );
    // Every event belongs to this number's workspace (what the SSE route filters on).
    expect(num.events.every((e) => e.workspaceId === workspaceId && e.sessionId === num.sessionId)).toBe(true);
  }, 60_000);

  it('pages through a large history (and keeps media messages downloadable)', async () => {
    const num = await number();
    await num.phone.chat('201000000010@s.whatsapp.net', 1_500, 20, { media: true });
    const job = await start(num.sessionId);
    num.make().request();
    const done = await until(job.id, ['completed'], 120_000);
    expect(done.messages_added).toBe(1_480);
    expect(await num.stored()).toBe(1_500);
    const [media] = await sql<{ n: number; with_raw: number }[]>`
      select count(*)::int as n, count(raw)::int as with_raw from messages where session_id = ${num.sessionId} and type = 'image'`;
    expect(media!.n).toBe(300);
    expect(media!.with_raw).toBe(300); // the keys to download each file are kept
    const [chat] = await sql`select pages, added, status from sync_job_chats where job_id = ${job.id}`;
    expect(chat).toMatchObject({ pages: 30, added: 1_480, status: 'done' });
  }, 180_000);

  it('never stores a message twice, even when the phone repeats some', async () => {
    const num = await number();
    await num.phone.chat('201000000020@s.whatsapp.net', 200, 10);
    num.phone.overlap = 7;
    const job = await start(num.sessionId);
    num.make().request();
    const done = await until(job.id, ['completed']);
    expect(done.messages_added).toBe(190);
    expect(await num.stored()).toBe(200);
    expect(await num.unique()).toBe(200);
  }, 60_000);

  it('waits out a disconnection and carries on where it stopped', async () => {
    const num = await number();
    await num.phone.chat('201000000030@s.whatsapp.net', 400, 5);
    await num.phone.chat('201000000031@s.whatsapp.net', 100, 5);
    const job = await start(num.sessionId);
    const sync = num.make();
    sync.request();
    await progressed(job.id);
    num.setOnline(false); // WhatsApp dropped
    const waiting = await until(job.id, ['queued']);
    expect(waiting.messages_added).toBeLessThan(490);
    await eventually(() => logged(num.events, 'waiting_connection'));
    num.setOnline(true); // reconnected: the runner calls request() on open
    sync.request();
    const done = await until(job.id, ['completed']);
    expect(done.messages_added).toBe(490);
    expect(await num.unique()).toBe(500);
  }, 60_000);

  it('resumes after a worker restart without losing or doubling anything', async () => {
    const num = await number();
    await num.phone.chat('201000000040@s.whatsapp.net', 300, 5);
    await num.phone.chat('201000000041@s.whatsapp.net', 300, 5);
    const job = await start(num.sessionId);
    const first = num.make();
    first.request();
    await progressed(job.id);
    first.stop(); // the worker went down mid-conversation: the job stays `running` in the database
    await sleep(100);
    const mid = (await loadSyncJob(sql, job.id))!;
    expect(mid.status).toBe('running');
    expect(mid.messages_added).toBeLessThan(590);
    const second = num.make(); // the next worker's runner for this number
    second.request();
    const done = await until(job.id, ['completed']);
    expect(done.messages_added).toBe(590);
    expect(await num.unique()).toBe(600);
    expect(await num.stored()).toBe(600);
    expect(logged(num.events, 'resumed')).toBe(true);
  }, 60_000);

  it('runs many numbers at once within the worker’s sync slots', async () => {
    const slots = new SyncSlots(3);
    let peak = 0;
    const numbers = await Promise.all(Array.from({ length: 6 }, () => number({ slots })));
    const jobs: string[] = [];
    for (const num of numbers) {
      await num.phone.chat(`2010000005${numbers.indexOf(num)}@s.whatsapp.net`, 150, 5);
      await num.phone.chat(`2010000006${numbers.indexOf(num)}@s.whatsapp.net`, 60, 5);
      jobs.push((await start(num.sessionId)).id);
    }
    const watch = setInterval(async () => {
      const [r] = await sql<{ n: number }[]>`select count(*)::int as n from sync_jobs where id = any(${jobs}::uuid[]) and status = 'running'`;
      peak = Math.max(peak, r!.n);
    }, 20);
    for (const num of numbers) num.make().request();
    const done = await Promise.all(jobs.map((id) => until(id, ['completed'], 120_000)));
    clearInterval(watch);
    expect(done.every((j) => j.messages_added === 145 + 55)).toBe(true);
    expect(peak).toBeLessThanOrEqual(3);
    // Each number's messages stayed its own.
    for (const num of numbers) expect(await num.unique()).toBe(210);
  }, 180_000);

  it('asks for the address-book names at the start, and carries on if WhatsApp refuses', async () => {
    let asked = 0;
    const num = await number({
      refreshContacts: async () => {
        asked += 1;
        throw new Error('not connected');
      },
    });
    await num.phone.chat('201000000075@s.whatsapp.net', 30, 5);
    const job = await start(num.sessionId);
    num.make().request();
    const done = await until(job.id, ['completed']);
    expect(done.messages_added).toBe(25);
    expect(asked).toBe(1);
    expect(logged(num.events, 'contacts_failed')).toBe(true);
  }, 60_000);

  it('keeps one job per number, even when started twice at once', async () => {
    const num = await number();
    await num.phone.chat('201000000070@s.whatsapp.net', 20, 5);
    const results = await Promise.all(Array.from({ length: 5 }, () => createSyncJob(sql, workspaceId, num.sessionId)));
    expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it('pauses, resumes and cancels', async () => {
    const num = await number();
    await num.phone.chat('201000000080@s.whatsapp.net', 600, 5);
    const job = await start(num.sessionId);
    const sync = num.make();
    sync.request();
    await progressed(job.id);
    await setSyncStatus(sql, job.id, ['running', 'queued'], 'paused');
    sync.interrupt(); // what the supervisor does on `sync.changed`
    await sleep(200);
    const requests = num.phone.requests;
    const paused = (await loadSyncJob(sql, job.id))!;
    expect(paused.status).toBe('paused');
    await sleep(200);
    expect(num.phone.requests).toBe(requests); // a paused job asks the phone nothing

    await setSyncStatus(sql, job.id, ['paused'], 'queued');
    sync.interrupt();
    await sleep(150);
    await setSyncStatus(sql, job.id, ['running', 'queued', 'paused'], 'cancelled');
    sync.interrupt();
    await sleep(200);
    const cancelled = (await loadSyncJob(sql, job.id))!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.finished_at).not.toBeNull();
    const after = num.phone.requests;
    await sleep(200);
    expect(num.phone.requests).toBe(after);
    // A new job can start once this one is over.
    expect((await createSyncJob(sql, workspaceId, num.sessionId)).created).toBe(true);
  }, 60_000);

  it('pauses when the phone stops answering, and retries the failed conversations later', async () => {
    const num = await number();
    for (let i = 0; i < 4; i++) await num.phone.chat(`20100000009${i}@s.whatsapp.net`, 40, 5);
    num.phone.silent = true;
    const job = await start(num.sessionId);
    const sync = num.make();
    sync.request();
    const paused = await until(job.id, ['paused'], 90_000); // 3 conversations × 2 attempts × the answer timeout
    expect(paused).toMatchObject({ pause_reason: 'phone_unresponsive', chats_failed: 3, chats_done: 0 });

    // Phone back: resume finishes the rest, then "retry failed" redoes the three.
    num.phone.silent = false;
    await setSyncStatus(sql, job.id, ['paused'], 'queued');
    sync.request();
    const completed = await until(job.id, ['completed']);
    expect(completed).toMatchObject({ chats_done: 1, chats_failed: 3 });
    const { retryFailedSyncChats } = await import('@wa/db');
    expect(await retryFailedSyncChats(sql, job.id)).toMatchObject({ status: 'queued', chats_failed: 0 });
    sync.request();
    const retried = await until(job.id, ['completed']);
    expect(retried).toMatchObject({ chats_done: 4, chats_failed: 0, messages_added: 4 * 35 });
    expect(await num.unique()).toBe(160);
  }, 180_000);

  it('keeps live messages flowing while a sync runs', async () => {
    const num = await number();
    const jid = '201000000099@s.whatsapp.net';
    await num.phone.chat(jid, 800, 5);
    const job = await start(num.sessionId);
    num.make().request();
    // Live messages arrive (and are stored) in the middle of the sync, as the runner's onMessage does.
    const live = Array.from({ length: 20 }, (_, i) => ({ id: `live-${i}`, ts: 1_800_000_000 + i, fromMe: false, type: 'text' }));
    const started = Date.now();
    await Promise.all(live.map((m) => num.phone.store(jid, [m], false)));
    const liveMs = Date.now() - started;
    const done = await until(job.id, ['completed'], 60_000);
    expect(done.messages_added).toBe(795);
    expect(await num.unique()).toBe(820);
    const [chat] = await sql<{ inbound_count: number; outbound_count: number }[]>`select inbound_count, outbound_count from chats where session_id = ${num.sessionId}`;
    expect(chat!.inbound_count + chat!.outbound_count).toBe(820);
    expect(liveMs).toBeLessThan(10_000);
  }, 120_000);
});
