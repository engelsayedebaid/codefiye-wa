import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, markChatRead, runMigrations, setChatName, type Sql } from '../src';

const url = process.env.TEST_DATABASE_URL;
const PHONE = '201012345678@s.whatsapp.net';
const LID = '99887766@lid';

describe.skipIf(!url)('chats (integration)', () => {
  let sql: Sql;
  let workspaceId: string;
  let sessionId: string;

  beforeAll(async () => {
    await runMigrations(url!);
    sql = createDb(url!, { max: 4 }).sql;
    workspaceId = (await sql<{ id: string }[]>`insert into workspaces (name) values ('chats-test') returning id`)[0]!.id;
    sessionId = (await sql<{ id: string }[]>`insert into sessions (workspace_id, name) values (${workspaceId}, 'c') returning id`)[0]!.id;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id = ${workspaceId}`;
    await sql.end();
  });

  const inbound = (jid: string, content: Record<string, unknown>, type = 'text') => sql<{ id: number }[]>`
    insert into messages (workspace_id, session_id, direction, remote_jid, wa_message_id, type, content, status)
    values (${workspaceId}, ${sessionId}, 'in', ${jid}, ${`W${Math.random()}`}, ${type}, ${sql.json(content as never)}, 'received')
    returning id`;
  const outbound = (jid: string, text: string) => sql<{ id: number }[]>`
    insert into messages (workspace_id, session_id, direction, remote_jid, type, content, status)
    values (${workspaceId}, ${sessionId}, 'out', ${jid}, 'text', ${sql.json({ type: 'text', text })}, 'queued')
    returning id`;
  const chat = async (jid: string) => (await sql`select * from chats where session_id = ${sessionId} and jid = ${jid}`)[0];

  it('opens a chat on the first message and keeps its counters', async () => {
    const [out] = await outbound(PHONE, 'hello');
    let row = await chat(PHONE);
    expect(row).toMatchObject({ outbound_count: 1, inbound_count: 0, unread_count: 0, last_message_id: out!.id });

    const [reply] = await inbound(PHONE, { from: PHONE, pushName: 'Ali', text: 'hi' });
    row = await chat(PHONE);
    expect(row).toMatchObject({ outbound_count: 1, inbound_count: 1, unread_count: 1, name: 'Ali', last_message_id: reply!.id });
  });

  it('files a LID-addressed message under the phone number', async () => {
    await inbound(LID, { from: PHONE, pushName: 'Ali K', text: 'from lid' });
    const row = await chat(PHONE);
    expect(row).toMatchObject({ alt_jid: LID, name: 'Ali K', unread_count: 2 });
    expect(await chat(LID)).toBeUndefined();
  });

  it('ignores reactions', async () => {
    const before = await chat(PHONE);
    await inbound(PHONE, { from: PHONE, text: '👍', reactTo: 'X' }, 'reaction');
    expect((await chat(PHONE))!.last_message_id).toBe(before!.last_message_id);
  });

  it('marks read by either address, once', async () => {
    expect(await markChatRead(sql, sessionId, LID)).toBe(PHONE);
    expect((await chat(PHONE))!.unread_count).toBe(0);
    expect(await markChatRead(sql, sessionId, PHONE)).toBeNull();
  });

  it('unarchives on a new inbound message and keeps group subjects', async () => {
    await sql`update chats set archived_at = now() where session_id = ${sessionId} and jid = ${PHONE}`;
    await inbound(PHONE, { from: PHONE, text: 'back' });
    expect((await chat(PHONE))!.archived_at).toBeNull();

    const group = '1203630001@g.us';
    await inbound(group, { from: PHONE, pushName: 'Member', text: 'hey all', isGroup: true });
    expect((await chat(group))!.name).toBeNull();
    await setChatName(sql, sessionId, group, 'Team');
    await inbound(group, { from: PHONE, pushName: 'Member', text: 'again', isGroup: true });
    expect((await chat(group))!.name).toBe('Team');
  });

  it('upserts many chats from one statement (a campaign launch)', async () => {
    const jids = Array.from({ length: 5 }, (_, i) => `2010000000${i}@s.whatsapp.net`);
    await sql`
      insert into messages (workspace_id, session_id, direction, remote_jid, type, content, status)
      select ${workspaceId}, ${sessionId}, 'out', j, 'text', '{"type":"text","text":"x"}'::jsonb, 'queued'
      from unnest(${jids}::text[]) as j, generate_series(1, 2)`;
    const rows = await sql<{ jid: string; outbound_count: number }[]>`select jid, outbound_count from chats where session_id = ${sessionId} and jid = any(${jids})`;
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.outbound_count === 2)).toBe(true);
  });

  it('files synced history by its own time: no unread, no reorder, no rename', async () => {
    const jid = '201077700000@s.whatsapp.net';
    const [live] = await inbound(jid, { from: jid, pushName: 'New Name', text: 'latest' });
    await markChatRead(sql, sessionId, jid);
    await sql`
      insert into messages (workspace_id, session_id, direction, remote_jid, wa_message_id, type, content, status, created_at)
      values (${workspaceId}, ${sessionId}, 'in', ${jid}, 'H1', 'text', ${sql.json({ from: jid, pushName: 'Old Name', text: 'old', history: true })}, 'received', now() - interval '30 days')`;
    const row = await chat(jid);
    expect(row).toMatchObject({ unread_count: 0, last_message_id: live!.id, name: 'New Name', inbound_count: 2 });
    expect(new Date(row!.created_at).getTime()).toBeLessThan(Date.now() - 29 * 86_400_000);
  });
});
