import { randomBytes } from 'node:crypto';
import { memoryAuthStore, useEncryptedAuthState } from '@wa/provider';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  advanceStatus,
  claimNextOutbound,
  createDb,
  failInterrupted,
  markSent,
  pgAuthStore,
  requeue,
  runMigrations,
  type Sql,
} from '../src';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('db (integration)', () => {
  let sql: Sql;
  let workspaceId: string;
  let sessionId: string;

  beforeAll(async () => {
    await runMigrations(url!);
    sql = createDb(url!, { max: 4 }).sql;
    workspaceId = (await sql<{ id: string }[]>`insert into workspaces (name) values ('db-test') returning id`)[0]!.id;
    sessionId = (await sql<{ id: string }[]>`insert into sessions (workspace_id, name) values (${workspaceId}, 's') returning id`)[0]!.id;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id = ${workspaceId}`;
    await sql.end();
  });

  const enqueue = async (text: string) => {
    const [row] = await sql<{ id: number }[]>`
      insert into messages (workspace_id, session_id, direction, remote_jid, type, content, status)
      values (${workspaceId}, ${sessionId}, 'out', '201012345678@s.whatsapp.net', 'text', ${sql.json({ type: 'text', text })}, 'queued')
      returning id`;
    return row!.id;
  };

  describe('pgAuthStore', () => {
    it('round-trips encrypted auth state through Postgres', async () => {
      const key = randomBytes(32);
      const store = pgAuthStore(sql, sessionId);
      const first = await useEncryptedAuthState(store, sessionId, key);
      first.state.creds.me = { id: '201012345678:2@s.whatsapp.net' };
      await first.saveCreds();
      await first.state.keys.set({ 'pre-key': { '1': { public: new Uint8Array([1]), private: new Uint8Array([2]) } }, session: { a: new Uint8Array([9]) } });

      const second = await useEncryptedAuthState(pgAuthStore(sql, sessionId), sessionId, key);
      expect(second.state.creds.me?.id).toBe('201012345678:2@s.whatsapp.net');
      const preKeys = await second.state.keys.get('pre-key', ['1', '2']);
      expect(Buffer.from(preKeys['1']!.private)).toEqual(Buffer.from([2]));
      expect(preKeys['2']).toBeUndefined();

      await second.state.keys.set({ session: { a: null } });
      expect(await second.state.keys.get('session', ['a'])).toEqual({});

      await second.clear();
      const n = (await sql<{ n: number }[]>`select count(*)::int as n from session_auth where session_id = ${sessionId}`)[0]!.n;
      expect(n).toBe(0);
    });

    it('stores nothing readable', async () => {
      const store = pgAuthStore(sql, sessionId);
      const auth = await useEncryptedAuthState(store, sessionId, randomBytes(32));
      auth.state.creds.me = { id: 'plaintext-marker@s.whatsapp.net' };
      await auth.saveCreds();
      const rows = await sql<{ value: Buffer }[]>`select value from session_auth where session_id = ${sessionId}`;
      expect(rows.length).toBe(1);
      expect(rows[0]!.value.toString('latin1')).not.toContain('plaintext-marker');
      await auth.clear();
      // sanity: the memory store has the same contract
      expect((await memoryAuthStore().get('creds', ['creds'])).size).toBe(0);
    });
  });

  describe('outbound queue', () => {
    it('claims in order, one at a time, and skips locked rows', async () => {
      const a = await enqueue('a');
      const b = await enqueue('b');
      const [first, second] = await Promise.all([claimNextOutbound(sql, sessionId), claimNextOutbound(sql, sessionId)]);
      expect(new Set([first?.id, second?.id])).toEqual(new Set([a, b]));
      expect(await claimNextOutbound(sql, sessionId)).toBeNull();
      expect(first?.content).toMatchObject({ type: 'text' });

      await requeue(sql, a);
      expect((await claimNextOutbound(sql, sessionId))?.id).toBe(a);
      expect((await failInterrupted(sql, sessionId)).sort()).toEqual([a, b].sort());
    });

    it('only moves receipts forward', async () => {
      const id = await enqueue('c');
      await claimNextOutbound(sql, sessionId);
      await markSent(sql, id, 'WAID-1');
      expect(await advanceStatus(sql, sessionId, 'WAID-1', 'read')).toMatchObject({ id });
      expect(await advanceStatus(sql, sessionId, 'WAID-1', 'delivered')).toBeNull();
      const [row] = await sql<{ status: string }[]>`select status from messages where id = ${id}`;
      expect(row!.status).toBe('read');
    });
  });
});
