import { randomBytes } from 'node:crypto';
import { useEncryptedAuthState } from '@wa/provider';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimNextOutbound, createDb, markSent, pgAuthStore, runMigrations, type Sql } from '../src';

const url = process.env.TEST_DATABASE_URL;

/** Sessions running at once on one worker, as in production with 20 numbers. */
const SESSIONS = 20;
/** Contacts per session, and inbound messages per contact (each delivered twice, like a reconnect replay). */
const CONTACTS = 5;
const PER_CONTACT = 10;
/** Outbound messages queued per session. */
const QUEUED = 25;

/**
 * Many sessions hitting the database at the same moment, through one pool the size of the
 * worker's: inbound bursts with duplicate deliveries, send queues drained by competing claimers,
 * and fenced credential writes. Asserts that nothing is lost, doubled or filed under another session.
 */
describe.skipIf(!url)('20 concurrent sessions (integration)', () => {
  let sql: Sql;
  const workspaces: string[] = [];
  const sessions: { id: string; workspaceId: string }[] = [];
  const workerId = `load-${Date.now()}`;

  beforeAll(async () => {
    await runMigrations(url!);
    sql = createDb(url!, { max: 20 }).sql;
    // Two sessions per workspace: isolation is checked across workspaces and within one.
    for (let w = 0; w < SESSIONS / 2; w++) {
      const [ws] = await sql<{ id: string }[]>`insert into workspaces (name) values (${`load-${w}`}) returning id`;
      workspaces.push(ws!.id);
      for (let s = 0; s < 2; s++) {
        const [row] = await sql<{ id: string }[]>`
          insert into sessions (workspace_id, name, worker_id, desired_state) values (${ws!.id}, ${`n${s}`}, ${workerId}, 'running') returning id`;
        sessions.push({ id: row!.id, workspaceId: ws!.id });
      }
    }
    await sql`insert into workers (id, url, capacity, session_count, heartbeat_at) values (${workerId}, 'http://x', 100, 0, now())`;
  }, 120_000);

  afterAll(async () => {
    if (workspaces.length) await sql`delete from workspaces where id = any(${workspaces}::uuid[])`;
    await sql`delete from workers where id = ${workerId}`;
    await sql.end();
  });

  const jid = (c: number) => `2010000000${c}@s.whatsapp.net`;

  it('stores every inbound message exactly once, under its own session and workspace', async () => {
    const insert = (s: { id: string; workspaceId: string }, c: number, n: number) => sql`
      insert into messages (workspace_id, session_id, direction, remote_jid, wa_message_id, type, content, status)
      values (${s.workspaceId}, ${s.id}, 'in', ${jid(c)}, ${`M${c}-${n}`}, 'text', ${sql.json({ text: `hi ${n}` })}, 'received')
      on conflict (session_id, wa_message_id) do nothing`;
    // Every session gets the same WhatsApp ids: unique per session, not globally.
    const jobs = sessions.flatMap((s) => Array.from({ length: CONTACTS * PER_CONTACT }, (_, i) => [s, Math.floor(i / PER_CONTACT), i % PER_CONTACT] as const));
    await Promise.all([...jobs, ...jobs].map(([s, c, n]) => insert(s, c, n)));

    const counts = await sql<{ session_id: string; workspace_id: string; n: number }[]>`
      select session_id, workspace_id, count(*)::int as n from messages
      where session_id = any(${sessions.map((s) => s.id)}::uuid[]) and direction = 'in' group by 1, 2`;
    expect(counts).toHaveLength(SESSIONS);
    for (const row of counts) {
      expect(row.n).toBe(CONTACTS * PER_CONTACT);
      expect(sessions.find((s) => s.id === row.session_id)?.workspaceId).toBe(row.workspace_id);
    }

    // The chats trigger kept up: one chat per session × contact, counters matching the stored rows.
    const chats = await sql<{ session_id: string; workspace_id: string; inbound_count: number; unread_count: number }[]>`
      select session_id, workspace_id, inbound_count, unread_count from chats where session_id = any(${sessions.map((s) => s.id)}::uuid[])`;
    expect(chats).toHaveLength(SESSIONS * CONTACTS);
    for (const chat of chats) {
      expect(chat.inbound_count).toBe(PER_CONTACT);
      expect(chat.unread_count).toBe(PER_CONTACT);
      expect(sessions.find((s) => s.id === chat.session_id)?.workspaceId).toBe(chat.workspace_id);
    }
  }, 120_000);

  it('hands each queued message to exactly one sender, never across sessions', async () => {
    for (const s of sessions) {
      await sql`
        insert into messages (workspace_id, session_id, direction, remote_jid, type, content, status)
        select ${s.workspaceId}, ${s.id}, 'out', ${jid(0)}, 'text', jsonb_build_object('type', 'text', 'text', 'm' || g), 'queued'
        from generate_series(1, ${QUEUED}) g`;
    }
    const claimed = new Map<string, number[]>();
    // Two claimers per session race (a drain plus a stale one after a restart); each sends what it gets.
    const drain = async (sessionId: string) => {
      for (;;) {
        const job = await claimNextOutbound(sql, sessionId);
        if (!job) return;
        expect(job.session_id).toBe(sessionId);
        claimed.set(sessionId, [...(claimed.get(sessionId) ?? []), job.id]);
        await markSent(sql, job.id, `W${job.id}`);
      }
    };
    await Promise.all(sessions.flatMap((s) => [drain(s.id), drain(s.id)]));

    for (const s of sessions) {
      const ids = claimed.get(s.id) ?? [];
      expect(ids).toHaveLength(QUEUED);
      expect(new Set(ids).size).toBe(QUEUED);
    }
    const left = await sql<{ n: number }[]>`
      select count(*)::int as n from messages where session_id = any(${sessions.map((s) => s.id)}::uuid[]) and direction = 'out' and status <> 'sent'`;
    expect(left[0]!.n).toBe(0);
  }, 120_000);

  it('keeps every session’s credentials apart under concurrent fenced writes', async () => {
    const key = randomBytes(32);
    await Promise.all(
      sessions.map(async (s, i) => {
        const auth = await useEncryptedAuthState(pgAuthStore(sql, s.id, { workerId }), s.id, key);
        auth.state.creds.me = { id: `2011111${String(i).padStart(4, '0')}:1@s.whatsapp.net` };
        // Bursts of signal-key writes, as during busy messaging, alongside creds saves.
        await Promise.all([
          ...Array.from({ length: 10 }, (_, k) => auth.state.keys.set({ session: { [`c${k}`]: new Uint8Array([i, k]) } })),
          auth.saveCreds(),
          auth.saveCreds(),
        ]);
        await auth.flush();
      }),
    );
    await Promise.all(
      sessions.map(async (s, i) => {
        const auth = await useEncryptedAuthState(pgAuthStore(sql, s.id), s.id, key);
        expect(auth.state.creds.me?.id).toBe(`2011111${String(i).padStart(4, '0')}:1@s.whatsapp.net`);
        const keys = await auth.state.keys.get('session', ['c0', 'c9']);
        expect(Buffer.from(keys.c9!)).toEqual(Buffer.from([i, 9]));
      }),
    );
  }, 120_000);
});
