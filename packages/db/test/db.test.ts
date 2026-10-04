import { randomBytes } from 'node:crypto';
import { memoryAuthStore, useEncryptedAuthState } from '@wa/provider';
import { type BroadcastPace, SHIELD_STOPS } from '@wa/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  advanceStatus,
  campaignHistory,
  claimNextOutbound,
  createDb,
  failInterrupted,
  markSent,
  pgAuthStore,
  recordOptOut,
  replanCampaigns,
  requeue,
  runMigrations,
  type Sql,
  stopCampaigns,
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

  describe('campaigns', () => {
    const newSession = async () =>
      (await sql<{ id: string }[]>`insert into sessions (workspace_id, name) values (${workspaceId}, ${`c-${randomBytes(4).toString('hex')}`}) returning id`)[0]!.id;
    const newCampaign = async (session: string, pace: BroadcastPace) =>
      (
        await sql<{ id: string }[]>`
          insert into broadcasts (workspace_id, name, template, session_ids, pace, recipients)
          values (${workspaceId}, 'c', ${sql.json({ body: 'x' })}, ${[session]}::uuid[], ${pace}, 1)
          returning id`
      )[0]!.id;
    /** `at`: when it's due, relative to now (e.g. '-2 hours'). */
    const queue = async (session: string, broadcast: string, to: string, at: string, type: 'text' | 'poll' = 'text') =>
      (
        await sql<{ id: number }[]>`
          insert into messages (workspace_id, session_id, direction, remote_jid, type, content, status, broadcast_id, not_before)
          values (${workspaceId}, ${session}, 'out', ${`${to}@s.whatsapp.net`}, ${type}, ${sql.json({ type, text: 'x' })}, 'queued', ${broadcast}, now() + ${at}::interval)
          returning id`
      )[0]!.id;
    const due = async (ids: number[]) =>
      (await sql<{ id: number; at: Date; status: string; error: string | null }[]>`select id, not_before as at, status, error from messages where id = any(${ids}::bigint[]) order by id`);

    it('claims a campaign message with its pace and how late it is', async () => {
      const session = await newSession();
      const id = await queue(session, await newCampaign(session, 'safe'), '201000000001', '-5 minutes');
      const job = await claimNextOutbound(sql, session);
      expect(job).toMatchObject({ id, pace: 'safe' });
      expect(job!.broadcast_id).not.toBeNull();
      expect(job!.late_ms).toBeGreaterThan(295_000);
      expect(job!.late_ms).toBeLessThan(400_000);
    });

    it('re-plans an overdue backlog from now at the campaign’s pace, a card and its poll together', async () => {
      const session = await newSession();
      const broadcast = await newCampaign(session, 'normal');
      const ids = [
        await queue(session, broadcast, '201000000001', '-2 hours'),
        await queue(session, broadcast, '201000000001', '-2 hours', 'poll'),
        await queue(session, broadcast, '201000000002', '-119 minutes'),
        await queue(session, broadcast, '201000000003', '-118 minutes'),
      ];
      const [clock] = await sql<{ now: Date }[]>`select now() as now`;
      expect(await replanCampaigns(sql, session, (min) => min)).toBe(3);
      const rows = await due(ids);
      const at = rows.map((r) => r.at.getTime() - rows[0]!.at.getTime());
      // normal: 15 s apart at the least.
      expect(at).toEqual([0, 0, 15_000, 30_000]);
      expect(rows[0]!.at.getTime()).toBeGreaterThanOrEqual(clock!.now.getTime() - 1_000);
    });

    it('counts recent sends and the schedule, not polls', async () => {
      const session = await newSession();
      const broadcast = await newCampaign(session, 'normal');
      const [sent] = await sql<{ id: number; at: Date }[]>`
        insert into messages (workspace_id, session_id, direction, remote_jid, type, content, status, broadcast_id, sent_at)
        values (${workspaceId}, ${session}, 'out', '201000000009@s.whatsapp.net', 'text', ${sql.json({ type: 'text', text: 'x' })}, 'delivered', ${broadcast}, now() - interval '1 hour')
        returning id, sent_at as at`;
      const later = await queue(session, broadcast, '201000000010', '1 hour');
      await queue(session, broadcast, '201000000010', '1 hour', 'poll');
      const [scheduled] = await due([later]);
      expect((await campaignHistory(sql, [session])).get(session)).toEqual([sent!.at.getTime(), scheduled!.at.getTime()]);
      expect((await campaignHistory(sql, [session], { queued: false })).get(session)).toEqual([sent!.at.getTime()]);
    });

    it('stops a number’s queued campaign messages, saying why', async () => {
      const session = await newSession();
      const id = await queue(session, await newCampaign(session, 'safe'), '201000000001', '1 hour');
      expect(await stopCampaigns(sql, session, 'restricted')).toEqual([id]);
      expect(await due([id])).toMatchObject([{ status: 'failed', error: SHIELD_STOPS.restricted }]);
    });

    it('drops a recipient who replied stop, until they reply start', async () => {
      const session = await newSession();
      const id = await queue(session, await newCampaign(session, 'safe'), '201099999999', '1 hour');
      expect(await recordOptOut(sql, workspaceId, '+201099999999', 'out')).toEqual([id]);
      expect(await due([id])).toMatchObject([{ status: 'failed', error: SHIELD_STOPS.optedOut }]);
      const listed = async () => (await sql`select 1 from opt_outs where workspace_id = ${workspaceId} and phone = '+201099999999'`).length;
      expect(await listed()).toBe(1);
      await recordOptOut(sql, workspaceId, '+201099999999', 'in');
      expect(await listed()).toBe(0);
    });
  });
});
