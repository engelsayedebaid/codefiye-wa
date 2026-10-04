import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMessageEdit, applyMessageRevoke, createDb, dropStoredEnvelope, runMigrations, type Sql } from '../src';

const url = process.env.TEST_DATABASE_URL;
const PN = '201010984531@s.whatsapp.net';

/** Edits and deletes-for-everyone change the original row; one real message is always one row. */
describe.skipIf(!url)('message edits and deletes (integration)', () => {
  let sql: Sql;
  let workspaceId: string;
  let n = 0;

  beforeAll(async () => {
    await runMigrations(url!);
    sql = createDb(url!, { max: 4 }).sql;
    workspaceId = (await sql<{ id: string }[]>`insert into workspaces (name) values ('edits-test') returning id`)[0]!.id;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id = ${workspaceId}`;
    await sql.end();
  });

  async function session() {
    const [row] = await sql<{ id: string }[]>`insert into sessions (workspace_id, name) values (${workspaceId}, ${`e${++n}-${Date.now()}`}) returning id`;
    const id = row!.id;
    /** What the runner's onMessage stores (de-duplicated by WhatsApp id). */
    const receive = (wa: string, text: string, type = 'text') => sql<{ id: number }[]>`
      insert into messages (workspace_id, session_id, direction, remote_jid, wa_message_id, type, content, status)
      values (${workspaceId}, ${id}, 'in', ${PN}, ${wa}, ${type}, ${sql.json({ from: PN, text })}, 'received')
      on conflict (session_id, wa_message_id) do nothing returning id`;
    const rows = () => sql<{ id: number; wa_message_id: string; type: string; content: Record<string, unknown> }[]>`
      select id, wa_message_id, type, content from messages where session_id = ${id} order by id`;
    const chat = async () => (await sql<{ inbound_count: number; unread_count: number; last_message_id: number | null }[]>`
      select inbound_count, unread_count, last_message_id from chats where session_id = ${id}`)[0];
    return { id, receive, rows, chat };
  }

  it('a normal message is one row', async () => {
    const s = await session();
    await s.receive('W1', 'hello');
    expect(await s.rows()).toMatchObject([{ wa_message_id: 'W1', type: 'text', content: { text: 'hello' } }]);
  });

  it('a duplicate delivery stays one row', async () => {
    const s = await session();
    const [first] = await s.receive('W1', 'hello');
    const again = await s.receive('W1', 'hello');
    expect(first).toBeDefined();
    expect(again).toHaveLength(0);
    expect(await s.rows()).toHaveLength(1);
  });

  it('an edit changes the original row (same id) and marks it edited — one message, one row', async () => {
    const s = await session();
    const [orig] = await s.receive('W1', 'علت اي ه طمني');
    const changed = await applyMessageEdit(sql, s.id, 'W1', 'عملت ايه طمني', 1_700_000_100);
    expect(changed).toEqual({ id: orig!.id, remote_jid: PN });
    expect(await s.rows()).toEqual([
      { id: orig!.id, wa_message_id: 'W1', type: 'text', content: { from: PN, text: 'عملت ايه طمني', edited: true, editedAt: 1_700_000_100 } },
    ]);
    // A repeated or older edit never rolls it back; a newer one wins.
    expect(await applyMessageEdit(sql, s.id, 'W1', 'older', 1_700_000_050)).toBeNull();
    await applyMessageEdit(sql, s.id, 'W1', 'newest', 1_700_000_200);
    expect((await s.rows())[0]!.content.text).toBe('newest');
  });

  it('an edit of a message we don’t hold changes nothing', async () => {
    const s = await session();
    await s.receive('W1', 'hello');
    expect(await applyMessageEdit(sql, s.id, 'NOT-HERE', 'x', 1)).toBeNull();
    expect(await s.rows()).toMatchObject([{ content: { text: 'hello' } }]);
  });

  it('a delete-for-everyone marks the original row (kept, same id), once; later edits don’t revive it', async () => {
    const s = await session();
    const [orig] = await s.receive('W1', 'oops');
    expect(await applyMessageRevoke(sql, s.id, 'W1')).toEqual({ id: orig!.id, remote_jid: PN });
    expect(await applyMessageRevoke(sql, s.id, 'W1')).toBeNull();
    expect(await applyMessageEdit(sql, s.id, 'W1', 'edited after delete', 9_999_999_999)).toBeNull();
    const [row] = await s.rows();
    expect(row).toMatchObject({ id: orig!.id, wa_message_id: 'W1', content: { text: 'oops', revoked: true } });
    expect(await s.rows()).toHaveLength(1);
    expect(await applyMessageRevoke(sql, s.id, 'NOT-HERE')).toBeNull();
  });

  it('removes an old edit envelope and keeps the chat’s counters and last message right', async () => {
    const s = await session();
    const [orig] = await s.receive('W1', 'real');
    const [envelope] = await s.receive('W2', '', 'unknown');
    expect(await s.chat()).toMatchObject({ inbound_count: 2, unread_count: 2, last_message_id: envelope!.id });
    await dropStoredEnvelope(sql, envelope!.id);
    expect(await s.rows()).toHaveLength(1);
    expect(await s.chat()).toMatchObject({ inbound_count: 1, unread_count: 1, last_message_id: orig!.id });
  });
});
