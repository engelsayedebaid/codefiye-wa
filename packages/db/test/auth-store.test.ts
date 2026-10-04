import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthFenceError, createDb, pgAuthStore, runMigrations, type Sql } from '../src';

const url = process.env.TEST_DATABASE_URL;
const v = (s: string) => Buffer.from(s);

describe.skipIf(!url)('session auth persistence (integration)', () => {
  let sql: Sql;
  let workspaceId: string;
  let ownerId: string;
  let sessionId: string;

  beforeAll(async () => {
    await runMigrations(url!);
    sql = createDb(url!, { max: 6 }).sql;
    ownerId = (await sql<{ id: string }[]>`insert into users (email) values (${`auth-${Date.now()}@test.local`}) returning id`)[0]!.id;
    workspaceId = (await sql<{ id: string }[]>`insert into workspaces (name, owner_id) values ('auth-test', ${ownerId}) returning id`)[0]!.id;
    sessionId = (await sql<{ id: string }[]>`insert into sessions (workspace_id, name, worker_id) values (${workspaceId}, 'a', 'worker-A') returning id`)[0]!.id;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id = ${workspaceId}`;
    await sql`delete from users where id = ${ownerId}`;
    await sql.end();
  });

  const value = async (keyId: string) =>
    (await sql<{ value: Buffer }[]>`select value from session_auth where session_id = ${sessionId} and type = 'session' and key_id = ${keyId}`)[0]?.value.toString();

  it('lets the owning worker write, and refuses everyone else', async () => {
    const a = pgAuthStore(sql, sessionId, { workerId: 'worker-A' });
    const b = pgAuthStore(sql, sessionId, { workerId: 'worker-B' });
    await a.set([{ type: 'session', id: 'k1', value: v('from-A') }]);
    await expect(b.set([{ type: 'session', id: 'k1', value: v('from-B') }])).rejects.toBeInstanceOf(AuthFenceError);
    await expect(b.clear()).rejects.toBeInstanceOf(AuthFenceError);
    expect(await value('k1')).toBe('from-A');
  });

  it('stops a stale worker from overwriting the new owner after a takeover', async () => {
    const a = pgAuthStore(sql, sessionId, { workerId: 'worker-A' });
    const b = pgAuthStore(sql, sessionId, { workerId: 'worker-B' });
    // Worker A stalls; worker B takes the session over and writes fresh keys.
    await sql`update sessions set worker_id = 'worker-B' where id = ${sessionId}`;
    await b.set([{ type: 'session', id: 'k1', value: v('fresh-from-B') }]);
    // A wakes up with its old state and tries to save it.
    await expect(a.set([{ type: 'session', id: 'k1', value: v('stale-from-A') }])).rejects.toBeInstanceOf(AuthFenceError);
    expect(await value('k1')).toBe('fresh-from-B');
  });

  it('serializes a write against a concurrent takeover: the write lands before it, or not at all', async () => {
    const b = pgAuthStore(sql, sessionId, { workerId: 'worker-B' });
    for (let i = 0; i < 10; i++) {
      await sql`update sessions set worker_id = 'worker-B' where id = ${sessionId}`;
      const [write, takeover] = await Promise.allSettled([
        b.set([{ type: 'session', id: 'race', value: v(`B-${i}`) }]),
        sql`update sessions set worker_id = 'worker-C' where id = ${sessionId} returning now() as at`,
      ]);
      expect(takeover.status).toBe('fulfilled');
      if (write.status === 'rejected') expect(write.reason).toBeInstanceOf(AuthFenceError);
      else expect(await value('race')).toBe(`B-${i}`);
      // After the takeover, B can never write again.
      await expect(b.set([{ type: 'session', id: 'race', value: v('late') }])).rejects.toBeInstanceOf(AuthFenceError);
    }
  });

  it('writes all entries of one call or none of them', async () => {
    await sql`update sessions set worker_id = 'worker-A' where id = ${sessionId}`;
    const a = pgAuthStore(sql, sessionId, { workerId: 'worker-A' });
    await expect(
      a.set([
        { type: 'session', id: 'atomic-ok', value: v('x') },
        { type: null as unknown as string, id: 'atomic-bad', value: v('y') },
      ]),
    ).rejects.toThrow();
    expect(await value('atomic-ok')).toBeUndefined();
  });

  it('keeps credentials when unrelated records are deleted', async () => {
    const before = (await sql<{ n: number }[]>`select count(*)::int as n from session_auth where session_id = ${sessionId}`)[0]!.n;
    expect(before).toBeGreaterThan(0);
    await sql`delete from workers where id in ('worker-A', 'worker-B', 'worker-C')`;
    await sql`delete from messages where session_id = ${sessionId}`;
    await sql`delete from chats where session_id = ${sessionId}`;
    // Deleting the owner user keeps the workspace (owner_id set null), so the session and its auth stay.
    await sql`delete from users where id = ${ownerId}`;
    const after = (await sql<{ n: number }[]>`select count(*)::int as n from session_auth where session_id = ${sessionId}`)[0]!.n;
    expect(after).toBe(before);
  });
});
