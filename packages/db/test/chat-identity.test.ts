import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, recordLidMappings, runMigrations, type Sql } from '../src';

const url = process.env.TEST_DATABASE_URL;

/**
 * One contact = one chat, whichever address (phone number or LID) each message comes with and
 * whenever we learn which number a LID is (regression: the same person used to appear twice).
 */
describe.skipIf(!url)('chat identity (integration)', () => {
  let sql: Sql;
  let workspaceId: string;
  let n = 0;

  beforeAll(async () => {
    await runMigrations(url!);
    sql = createDb(url!, { max: 12 }).sql;
    workspaceId = (await sql<{ id: string }[]>`insert into workspaces (name) values ('chat-identity-test') returning id`)[0]!.id;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id = ${workspaceId}`;
    await sql.end();
  });

  /** A fresh session (own chats), and helpers bound to it. */
  async function session() {
    const [row] = await sql<{ id: string }[]>`insert into sessions (workspace_id, name) values (${workspaceId}, ${`s${++n}-${Date.now()}`}) returning id`;
    const id = row!.id;
    const message = (direction: 'in' | 'out', jid: string, content: Record<string, unknown>) => sql`
      insert into messages (workspace_id, session_id, direction, remote_jid, wa_message_id, type, content, status)
      values (${workspaceId}, ${id}, ${direction}, ${jid}, ${`W${Math.random()}`}, 'text', ${sql.json(content as never)}, ${direction === 'in' ? 'received' : 'sent'})`;
    const chats = () => sql<{ jid: string; alt_jid: string | null; name: string | null; inbound_count: number; outbound_count: number; unread_count: number }[]>`
      select jid, alt_jid, name, inbound_count, outbound_count, unread_count from chats where session_id = ${id} order by jid`;
    const stored = async () => (await sql<{ n: number }[]>`select count(*)::int as n from messages where session_id = ${id}`)[0]!.n;
    return { id, message, chats, stored };
  }

  const PN = '201011112222@s.whatsapp.net';
  const LID = '55500011122233@lid';

  it('keeps one chat when the number is missing at first and known later', async () => {
    const s = await session();
    await s.message('in', LID, { from: LID, pushName: 'Ahmed', text: 'no number yet' });
    await s.message('out', LID, { text: 'reply from the phone', sentFrom: 'phone' });
    expect(await s.chats()).toMatchObject([{ jid: LID, inbound_count: 1, outbound_count: 1 }]);

    // The number becomes known: by Baileys' mapping store (worker) …
    expect(await recordLidMappings(sql, s.id, [{ lid: LID, pn: PN }])).toBe(1);
    expect(await s.chats()).toMatchObject([{ jid: PN, alt_jid: LID, name: 'Ahmed', inbound_count: 1, outbound_count: 1, unread_count: 1 }]);

    // … and every later message, under either address, lands in that chat. (Device JIDs never reach
    // the database: the provider normalizes them, see provider/test/inbound.test.ts.)
    await s.message('in', LID, { from: LID, text: 'still lid' });
    await s.message('in', PN, { from: PN, pushName: 'Ahmed M', text: 'by number' });
    await s.message('out', PN, { type: 'text', text: 'from the API' });
    expect(await s.chats()).toMatchObject([{ jid: PN, alt_jid: LID, inbound_count: 3, outbound_count: 2 }]);
    // Mapping pairs are normalized to the user JID too.
    expect(await recordLidMappings(sql, s.id, [{ lid: '55500011122233:3@lid', pn: '201011112222:3@s.whatsapp.net' }])).toBe(0);
  });

  it('merges an existing LID chat into the number’s chat without losing messages or counts', async () => {
    const s = await session();
    await s.message('in', LID, { from: LID, pushName: 'Sara', text: 'a' });
    await s.message('out', LID, { text: 'b', sentFrom: 'phone' });
    await s.message('out', PN, { type: 'text', text: 'c' });
    await s.message('in', PN, { from: PN, pushName: 'Sara', text: 'd' });
    await sql`update chats set pinned_at = now() where session_id = ${s.id} and jid = ${LID}`;
    expect(await s.chats()).toHaveLength(2);

    // An inbound message that names the number teaches the pair by itself.
    await s.message('in', LID, { from: PN, pushName: 'Sara', text: 'e' });
    const rows = await s.chats();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ jid: PN, alt_jid: LID, inbound_count: 3, outbound_count: 2, unread_count: 3 });
    const [pinned] = await sql`select pinned_at from chats where session_id = ${s.id}`;
    expect(pinned!.pinned_at).not.toBeNull();
    expect(await s.stored()).toBe(5);
  });

  it('never merges two different people', async () => {
    const s = await session();
    const otherLid = '77700088899900@lid';
    await recordLidMappings(sql, s.id, [{ lid: LID, pn: PN }]);
    await s.message('in', PN, { from: PN, text: 'mine' });
    await s.message('in', otherLid, { from: otherLid, text: 'someone else' });
    // A conflicting claim that the other LID is the same number is ignored for the chats.
    await recordLidMappings(sql, s.id, [{ lid: otherLid, pn: PN }]);
    expect(await s.chats()).toMatchObject([
      { jid: PN, alt_jid: LID, inbound_count: 1 },
      { jid: otherLid, alt_jid: null, inbound_count: 1 },
    ]);
    // A group is never touched by contact pairs.
    await s.message('in', '120363000000000000@g.us', { from: PN, text: 'group' });
    expect((await s.chats()).filter((c) => c.jid.endsWith('@g.us'))).toHaveLength(1);
  });

  it('makes one chat under concurrent events for the same new contact', async () => {
    for (let round = 0; round < 5; round++) {
      const s = await session();
      const lid = `4440000000${round}@lid`;
      const pn = `20155500000${round}@s.whatsapp.net`;
      await Promise.all([
        ...Array.from({ length: 6 }, (_, i) => s.message('in', lid, { from: lid, text: `lid ${i}` })),
        ...Array.from({ length: 6 }, (_, i) => s.message('in', pn, { from: pn, text: `pn ${i}` })),
        ...Array.from({ length: 3 }, (_, i) => s.message('out', lid, { text: `echo ${i}`, sentFrom: 'phone' })),
        recordLidMappings(sql, s.id, [{ lid, pn }]),
        s.message('in', lid, { from: pn, text: 'names the number' }),
      ]);
      const rows = await s.chats();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ jid: pn, alt_jid: lid, inbound_count: 13, outbound_count: 3 });
      expect(await s.stored()).toBe(16);
    }
  }, 60_000);

  it('keeps one chat when history sync and live messages arrive together', async () => {
    const s = await session();
    const history = Array.from({ length: 150 }, (_, i) => ({
      direction: i % 3 === 0 ? 'out' : 'in',
      remote_jid: LID,
      wa: `H${i}`,
      content: { text: `old ${i}`, history: true, ...(i % 3 === 0 ? { sentFrom: 'phone' } : { from: LID }) },
      ts: 1_700_000_000 + i,
    }));
    const syncBatch = sql`
      insert into messages (workspace_id, session_id, direction, remote_jid, wa_message_id, type, content, status, created_at)
      select ${workspaceId}, ${s.id}, x.direction, x.remote_jid, x.wa, 'text', x.content, 'received', to_timestamp(x.ts)
      from jsonb_to_recordset(${sql.json(history as never)}) as x(direction text, remote_jid text, wa text, content jsonb, ts float8)`;
    await Promise.all([
      syncBatch,
      ...Array.from({ length: 10 }, (_, i) => s.message('in', PN, { from: PN, pushName: 'Live', text: `live ${i}` })),
      recordLidMappings(sql, s.id, [{ lid: LID, pn: PN }]),
    ]);
    const rows = await s.chats();
    expect(rows).toHaveLength(1);
    // History never counts as unread; the live messages do.
    expect(rows[0]).toMatchObject({ jid: PN, alt_jid: LID, inbound_count: 110, outbound_count: 50, unread_count: 10, name: 'Live' });
  }, 60_000);

  it('enforces one chat per LID in the database', async () => {
    const s = await session();
    await recordLidMappings(sql, s.id, [{ lid: LID, pn: PN }]);
    await s.message('in', PN, { from: PN, text: 'x' });
    await expect(sql`insert into chats (session_id, jid, workspace_id, alt_jid, last_message_at) values (${s.id}, '209999@s.whatsapp.net', ${workspaceId}, ${LID}, now())`).rejects.toThrow(/chats_session_id_alt_jid_index/);
  });
});
