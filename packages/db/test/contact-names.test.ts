import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, recordContactNames, recordLidMappings, runMigrations, type Sql } from '../src';

const url = process.env.TEST_DATABASE_URL;

/**
 * What a chat is called: the name saved in the phone's address book (when WhatsApp syncs it), else a
 * business's verified name, else the contact's own WhatsApp name — on the one chat of that contact,
 * whichever address the name came under. Groups keep their subject.
 */
describe.skipIf(!url)('contact names (integration)', () => {
  let sql: Sql;
  let workspaceId: string;
  let n = 0;

  beforeAll(async () => {
    await runMigrations(url!);
    sql = createDb(url!, { max: 6 }).sql;
    workspaceId = (await sql<{ id: string }[]>`insert into workspaces (name) values ('contact-names-test') returning id`)[0]!.id;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id = ${workspaceId}`;
    await sql.end();
  });

  async function session() {
    const [row] = await sql<{ id: string }[]>`insert into sessions (workspace_id, name) values (${workspaceId}, ${`c${++n}-${Date.now()}`}) returning id`;
    const id = row!.id;
    const message = (jid: string, content: Record<string, unknown>, direction: 'in' | 'out' = 'in') => sql`
      insert into messages (workspace_id, session_id, direction, remote_jid, wa_message_id, type, content, status)
      values (${workspaceId}, ${id}, ${direction}, ${jid}, ${`W${Math.random()}`}, 'text', ${sql.json(content as never)}, 'received')`;
    /** The chats as the API lists them (name resolved like the list and chat routes do). */
    const listed = () => sql<{ jid: string; name: string | null }[]>`
      select jid, chat_display_name(session_id, jid, alt_jid, name) as name from chats where session_id = ${id} order by jid`;
    return { id, message, listed };
  }

  const PN = '201012345678@s.whatsapp.net';
  const LID = '88800011122233@lid';

  it('shows the name saved on the phone (01012345678 → Ahmed), over the contact’s own WhatsApp name', async () => {
    const s = await session();
    await s.message(PN, { from: PN, pushName: 'A.M ✨', text: 'hi' });
    expect(await s.listed()).toEqual([{ jid: PN, name: 'A.M ✨' }]);
    expect(await recordContactNames(sql, s.id, [{ jid: PN, savedName: 'Ahmed' }])).toBe(1);
    expect(await s.listed()).toEqual([{ jid: PN, name: 'Ahmed' }]);
    // Newer messages keep updating their own WhatsApp name underneath, but the saved name wins.
    await s.message(PN, { from: PN, pushName: 'Ahmed M.', text: 'again' });
    expect(await s.listed()).toEqual([{ jid: PN, name: 'Ahmed' }]);
  });

  it('names a chat that had none once the name arrives, without opening another chat', async () => {
    const s = await session();
    await s.message(LID, { from: LID, text: 'no name, no number' });
    await s.message(LID, { text: 'reply', sentFrom: 'phone' }, 'out');
    expect(await s.listed()).toEqual([{ jid: LID, name: null }]);
    // The address book arrives keyed by number, with the LID: pair first (merge), then the name.
    await recordLidMappings(sql, s.id, [{ lid: LID, pn: PN }]);
    await recordContactNames(sql, s.id, [{ jid: PN, savedName: 'Mona' }]);
    expect(await s.listed()).toEqual([{ jid: PN, name: 'Mona' }]);
    // A name filed under the LID reaches the same chat too, and a rename replaces it.
    await recordContactNames(sql, s.id, [{ jid: LID, savedName: 'Mona (LID)' }]);
    expect(await s.listed()).toEqual([{ jid: PN, name: 'Mona' }]); // the chat's own address first
    await recordContactNames(sql, s.id, [{ jid: PN, savedName: 'Mona Ali' }]);
    expect(await s.listed()).toEqual([{ jid: PN, name: 'Mona Ali' }]);
    // A contact entry without a name never erases one.
    expect(await recordContactNames(sql, s.id, [{ jid: PN }])).toBe(0);
    expect(await s.listed()).toEqual([{ jid: PN, name: 'Mona Ali' }]);
  });

  it('uses a business’s verified name when nothing is saved', async () => {
    const s = await session();
    const biz = '201055500000@s.whatsapp.net';
    await s.message(biz, { from: biz, pushName: 'shop', text: 'offer' });
    await recordContactNames(sql, s.id, [{ jid: biz, verifiedName: 'Shop LLC' }]);
    expect(await s.listed()).toEqual([{ jid: biz, name: 'Shop LLC' }]);
    await recordContactNames(sql, s.id, [{ jid: biz, savedName: 'My shop' }]);
    expect(await s.listed()).toEqual([{ jid: biz, name: 'My shop' }]);
  });

  it('never shows a masked number as a name', async () => {
    const s = await session();
    await s.message(PN, { from: PN, text: 'x' });
    await sql`update chats set name = '+20∙∙∙∙∙∙∙∙78' where session_id = ${s.id}`;
    expect(await s.listed()).toEqual([{ jid: PN, name: null }]); // the dashboard falls back to the number
    const [usable] = await sql`select usable_contact_name('+20∙∙∙∙78') as masked, usable_contact_name('+20 101 234') as digits, usable_contact_name('Ahmed') as ok`;
    expect(usable).toEqual({ masked: false, digits: false, ok: true });
  });

  it('keeps group subjects exactly as before', async () => {
    const s = await session();
    const group = '120363000000000077@g.us';
    await s.message(group, { from: PN, pushName: 'Ahmed', text: 'in group' });
    await sql`update chats set name = 'Family' where session_id = ${s.id} and jid = ${group}`;
    await recordContactNames(sql, s.id, [{ jid: PN, savedName: 'Ahmed' }]);
    expect(await s.listed()).toEqual([{ jid: group, name: 'Family' }]);
  });

  it('never creates a chat from a name', async () => {
    const s = await session();
    await recordContactNames(sql, s.id, [
      { jid: PN, savedName: 'Someone' },
      { jid: PN, savedName: 'Someone Else' }, // twice in one batch: the later one wins
    ]);
    expect(await s.listed()).toEqual([]);
    await s.message(PN, { from: PN, text: 'first message' });
    expect(await s.listed()).toEqual([{ jid: PN, name: 'Someone Else' }]);
  });
});
