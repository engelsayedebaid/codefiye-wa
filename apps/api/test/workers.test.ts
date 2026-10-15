import { createDb, createListener, notify, runMigrations, type Sql } from '@wa/db';
import { CHANNELS, type ControlMessage, type RpcResult } from '@wa/shared';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/lib/events';
import { WorkerClient } from '../src/lib/workers';

const url = process.env.TEST_DATABASE_URL;

/**
 * Worker RPC relayed through Postgres when the worker's URL can't be reached from the API
 * (apps/api/src/lib/workers.ts ↔ Supervisor.answerRpc). A stand-in worker speaks the protocol here.
 */
describe.skipIf(!url)('worker rpc relay (integration)', () => {
  let sql: Sql;
  let end: () => Promise<unknown>;
  let events: EventBus;
  let listener: Sql;
  let workspaceId: string;
  const sessionId = '0f0f0f0f-0000-4000-8000-000000000001';
  const workerId = `relay-test-${Date.now()}`;
  const seen: ControlMessage[] = [];
  /** What the stand-in worker answers; null = stays silent (as a worker on the old code, or none owning the session). */
  let reply: ((m: Extract<ControlMessage, { type: 'rpc' }>) => Omit<RpcResult, 'requestId'>) | null = null;

  beforeAll(async () => {
    await runMigrations(url!);
    ({ sql, end } = createDb(url!, { max: 3 }));
    events = new EventBus({ createListener: () => createListener(url!), sql, logger: pino({ level: 'silent' }) });
    await events.start();

    const [ws] = await sql<{ id: string }[]>`insert into workspaces (name) values ('relay test') returning id`;
    workspaceId = ws!.id;
    // A live worker at an address nothing listens on (RFC 2606 reserved TLD → DNS fails fast), owning the session.
    await sql`insert into workers (id, url, capacity, session_count) values (${workerId}, 'http://worker.invalid:4100', 10, 1)`;
    await sql`insert into sessions (id, workspace_id, name, status, desired_state, worker_id) values (${sessionId}, ${workspaceId}, 'relay', 'connected', 'running', ${workerId})`;

    listener = createListener(url!);
    await listener.listen(CHANNELS.control, (payload) => {
      const message = JSON.parse(payload) as ControlMessage;
      seen.push(message);
      if (message.type !== 'rpc' || message.sessionId !== sessionId || !reply) return;
      const result: RpcResult = { requestId: message.requestId, ...reply(message) } as RpcResult;
      void notify(sql, CHANNELS.rpc, result);
    });
  }, 120_000);

  afterAll(async () => {
    await listener?.end({ timeout: 1 }).catch(() => {});
    await sql`delete from workspaces where id = ${workspaceId}`;
    await sql`delete from workers where id = ${workerId}`;
    await events?.stop();
    await end?.();
  });

  it('relays a call the worker URL cannot serve and returns the owner’s answer', async () => {
    reply = (m) => ({ ok: true, data: { waMessageId: `sent:${(m.body as { to: string }).to}` } });
    const workers = new WorkerClient(sql, 'x'.repeat(16), events);
    const result = await workers.call<{ waMessageId: string }>(sessionId, 'send-text', { to: '201000000001', text: 'code 123456' }, { timeoutMs: 15_000 });
    expect(result).toEqual({ waMessageId: 'sent:201000000001' });
    const relayed = seen.find((m) => m.type === 'rpc') as Extract<ControlMessage, { type: 'rpc' }>;
    expect(relayed).toMatchObject({ sessionId, action: 'send-text', body: { to: '201000000001' } });

    // The unreachable address is remembered: the next call skips HTTP and goes straight to the relay.
    const before = Date.now();
    await workers.call(sessionId, 'send-text', { to: '201000000002', text: 'code 654321' }, { timeoutMs: 15_000 });
    expect(Date.now() - before).toBeLessThan(5_000);
  }, 60_000);

  it('maps the owner’s failures like HTTP answers', async () => {
    const workers = new WorkerClient(sql, 'x'.repeat(16), events);
    reply = () => ({ ok: false, status: 422, code: 'invalid_input', message: 'This number is not on WhatsApp' });
    await expect(workers.call(sessionId, 'send-text', { to: '201000000003', text: 'x' }, { timeoutMs: 15_000 })).rejects.toMatchObject({ statusCode: 422 });
    reply = () => ({ ok: false, status: 409, code: 'not_connected', message: 'Session is not connected' });
    await expect(workers.call(sessionId, 'send-text', { to: '201000000003', text: 'x' }, { timeoutMs: 15_000 })).rejects.toMatchObject({ code: 'session_not_connected' });
  }, 60_000);

  it('fails as unreachable when nobody answers, and without a relay', async () => {
    reply = null;
    const workers = new WorkerClient(sql, 'x'.repeat(16), events);
    await expect(workers.call(sessionId, 'send-text', { to: '201000000004', text: 'x' }, { timeoutMs: 1_500 })).rejects.toMatchObject({ code: 'worker_unreachable' });
    const plain = new WorkerClient(sql, 'x'.repeat(16));
    await expect(plain.call(sessionId, 'send-text', { to: '201000000004', text: 'x' }, { timeoutMs: 15_000 })).rejects.toMatchObject({ code: 'worker_unreachable' });
    expect(seen.filter((m) => m.type === 'rpc').length).toBeGreaterThan(0);
  }, 60_000);
});
