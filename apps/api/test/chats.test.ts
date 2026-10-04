import { apiKeys, createDb, createListener, type Db, runMigrations, type Sql, users, workspaces } from '@wa/db';
import Fastify from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createAuth } from '../src/lib/auth';
import { EventBus } from '../src/lib/events';
import { generateKey } from '../src/lib/keys';
import { otpKey } from '../src/lib/otp';
import { isInlineSafe, parseRange, sendMedia } from '../src/lib/media-cache';
import { createThrottle } from '../src/lib/throttle';
import { WorkerClient } from '../src/lib/workers';

const url = process.env.TEST_DATABASE_URL;
const PHONE = '201055500011@s.whatsapp.net';

describe('parseRange', () => {
  it('reads single byte ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=200-300', 100)).toBe(false);
    expect(parseRange('items=0-1', 100)).toBeNull();
  });
});

describe('sendMedia', () => {
  // The mimetype of chat media is whatever the sender claimed; only plain media may render in place.
  const serve = async (mimetype: string, query = '') => {
    const app = Fastify();
    app.get('/m', (req, reply) => sendMedia(req, reply, { data: Buffer.from('<script>alert(1)</script>'), mimetype, fileName: 'x' }, query === 'download'));
    const res = await app.inject({ method: 'GET', url: '/m' });
    await app.close();
    return res;
  };

  it('downloads scriptable types instead of rendering them on our origin', async () => {
    for (const type of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/javascript', 'TEXT/HTML; charset=utf-8']) {
      const res = await serve(type);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-disposition']).toMatch(/^attachment;/);
      expect(res.headers['content-security-policy']).toMatch(/^sandbox;/);
    }
  });

  it('shows plain images, video and audio inline, still sandboxed', async () => {
    for (const type of ['image/jpeg', 'image/webp', 'video/mp4', 'audio/ogg; codecs=opus']) {
      const res = await serve(type);
      expect(res.headers['content-type']).toBe(type);
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(res.headers['content-security-policy']).toMatch(/^sandbox;/);
    }
    expect(isInlineSafe('image/svg+xml')).toBe(false);
  });
});

describe.skipIf(!url)('chats api (integration)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sql: Sql;
  let db: Db;
  let end: () => Promise<unknown>;
  let events: EventBus;
  const stamp = Date.now();
  let admin: { id: string; pat: string; userId: string };
  let customer: { id: string; pat: string };
  let business: { id: string; pat: string };
  let sessionId: string;

  const workspace = async (name: string, planId: string, role?: 'admin') => {
    let ownerId: string | null = null;
    if (role) ownerId = (await db.insert(users).values({ email: `${name}-${stamp}@test.local`, role }).returning())[0]!.id;
    const [w] = await db.insert(workspaces).values({ name, planId, ownerId }).returning();
    const key = generateKey('pat');
    await db.insert(apiKeys).values({ workspaceId: w!.id, name: 'test', keyHash: key.hash, prefix: key.prefix });
    return { id: w!.id, pat: key.key, userId: ownerId ?? '' };
  };

  const call = (method: 'GET' | 'POST', path: string, pat: string, body?: unknown) =>
    app.inject({ method, url: path, headers: { authorization: `Bearer ${pat}` }, ...(body !== undefined ? { payload: body as object } : {}) });

  beforeAll(async () => {
    await runMigrations(url!);
    ({ sql, db, end } = createDb(url!, { max: 4 }));
    const logger = pino({ level: 'silent' });
    events = new EventBus({ createListener: () => createListener(url!), sql, logger });
    await events.start();
    app = await buildApp(
      { sql, db, auth: createAuth(sql), events, workers: new WorkerClient(sql, 'x'.repeat(16)), throttle: createThrottle(sql), otp: { key: otpKey(undefined, 'x'.repeat(16)), sender: null, dailyLimit: 10 } },
      { logger, corsOrigins: [], publicUrl: 'http://test' },
    );
    admin = await workspace('chats-admin', 'unlimited', 'admin');
    customer = await workspace('chats-customer', 'pro');
    business = await workspace('chats-business', 'business');
    sessionId = (await sql<{ id: string }[]>`
      insert into sessions (workspace_id, name, status, desired_state, phone) values (${admin.id}, 'Main', 'disconnected', 'stopped', '+201000000000') returning id`)[0]!.id;
    const msg = (direction: 'in' | 'out', type: string, content: object, extra: { wa?: string } = {}) => sql`
      insert into messages (workspace_id, session_id, direction, remote_jid, wa_message_id, type, content, status)
      values (${admin.id}, ${sessionId}, ${direction}, ${PHONE}, ${extra.wa ?? null}, ${type}, ${sql.json(content as never)}, ${direction === 'in' ? 'received' : 'sent'})`;
    await msg('out', 'text', { type: 'text', text: 'Welcome!' });
    await msg('in', 'text', { from: PHONE, pushName: 'Mona', text: 'Hello there' }, { wa: 'IN1' });
    await msg('in', 'image', { from: PHONE, pushName: 'Mona', text: 'my order', media: { mimetype: 'image/jpeg' } }, { wa: 'IN2' });
    await msg('in', 'reaction', { from: PHONE, text: '❤️', reactTo: 'IN1' }, { wa: 'IN3' });
  });

  afterAll(async () => {
    await sql`delete from workspaces where id in (${admin.id}, ${customer.id}, ${business.id})`;
    await sql`delete from users where id = ${admin.userId}`;
    await app.close();
    await events.stop();
    await end();
  });

  it('is locked below Business, with an upgrade code', async () => {
    const res = await call('GET', '/api/chats/numbers', customer.pat);
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ code: 'feature_not_in_plan' });
    expect((await call('GET', `/api/chats/${sessionId}/list`, customer.pat)).statusCode).toBe(402);
  });

  it('opens on Business, showing only the workspace’s own numbers', async () => {
    const res = await call('GET', '/api/chats/numbers', business.pat);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual([]);
    // Another workspace's number stays out of reach.
    expect((await call('GET', `/api/chats/${sessionId}/list`, business.pat)).statusCode).toBe(404);
    expect((await call('GET', `/api/chats/${sessionId}/insights`, business.pat)).statusCode).toBe(404);
  });

  it('lists the numbers with their unread chats', async () => {
    const res = await call('GET', '/api/chats/numbers', admin.pat);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual([expect.objectContaining({ id: sessionId, name: 'Main', chats: 1, unreadChats: 1, unread: 2 })]);
  });

  it('lists conversations with their last message, counts and filters', async () => {
    const res = await call('GET', `/api/chats/${sessionId}/list`, admin.pat);
    expect(res.statusCode, res.body).toBe(200);
    const { chats, counts, next } = res.json().data;
    expect(next).toBeNull();
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ jid: PHONE, name: 'Mona', phone: '+201055500011', unread: 2, inbound: 2, outbound: 1, last: { type: 'image', text: 'my order', direction: 'in' } });
    expect(counts).toMatchObject({ all: 1, unread: 1, replied: 1, noReply: 0, groups: 0 });
    expect((await call('GET', `/api/chats/${sessionId}/list?filter=groups`, admin.pat)).json().data.chats).toHaveLength(0);
    expect((await call('GET', `/api/chats/${sessionId}/list?q=mon`, admin.pat)).json().data.chats).toHaveLength(1);
    expect((await call('GET', `/api/chats/${sessionId}/list?q=55500011`, admin.pat)).json().data.chats).toHaveLength(1);
    expect((await call('GET', `/api/chats/${sessionId}/list?q=nobody`, admin.pat)).json().data.chats).toHaveLength(0);
  });

  it('pages through a conversation and searches it', async () => {
    const res = await call('GET', `/api/chats/${sessionId}/messages?jid=${PHONE}&limit=2`, admin.pat);
    expect(res.statusCode, res.body).toBe(200);
    const { messages, nextBefore } = res.json().data;
    expect(messages.map((m: { type: string }) => m.type)).toEqual(['reaction', 'image']);
    expect(nextBefore).toBe(messages[1].id);
    const older = (await call('GET', `/api/chats/${sessionId}/messages?jid=${PHONE}&before=${nextBefore}`, admin.pat)).json().data.messages;
    expect(older).toHaveLength(2);
    const found = (await call('GET', `/api/chats/${sessionId}/messages?jid=${PHONE}&q=hello`, admin.pat)).json().data.messages;
    expect(found.map((m: { content: { text: string } }) => m.content.text)).toEqual(['Hello there']);
    const newer = (await call('GET', `/api/chats/${sessionId}/messages?jid=${PHONE}&after=${older[0].id}`, admin.pat)).json().data.messages;
    expect(newer).toHaveLength(2);
  });

  it('reads, pins and archives a chat', async () => {
    const read = await call('POST', `/api/chats/${sessionId}/read`, admin.pat, { jid: PHONE, receipts: false });
    expect(read.json().data).toEqual({ read: 2 });
    expect((await call('POST', `/api/chats/${sessionId}/read`, admin.pat, { jid: PHONE })).json().data).toEqual({ read: 0 });
    await call('POST', `/api/chats/${sessionId}/flags`, admin.pat, { jid: PHONE, pinned: true });
    let counts = (await call('GET', `/api/chats/${sessionId}/list`, admin.pat)).json().data.counts;
    expect(counts).toMatchObject({ unread: 0, pinned: 1 });
    await call('POST', `/api/chats/${sessionId}/flags`, admin.pat, { jid: PHONE, archived: true, unread: true });
    counts = (await call('GET', `/api/chats/${sessionId}/list`, admin.pat)).json().data.counts;
    expect(counts).toMatchObject({ all: 0, archived: 1 });
  });

  it('describes a chat for the contact panel', async () => {
    const res = await call('GET', `/api/chats/${sessionId}/chat?jid=${PHONE}`, admin.pat);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ chat: { jid: PHONE, pinned: true, archived: true }, stats: { total: 3, media: 1, outbound: 1 }, optedOut: false });
  });

  it('refuses to send from a disconnected number', async () => {
    const res = await call('POST', `/api/chats/${sessionId}/send`, admin.pat, { jid: PHONE, text: 'hi' });
    expect(res.json()).toMatchObject({ code: 'session_not_connected' });
  });

  it('queues a reply with its quote when connected', async () => {
    await sql`update sessions set status = 'connected', desired_state = 'running' where id = ${sessionId}`;
    const res = await call('POST', `/api/chats/${sessionId}/send`, admin.pat, { jid: PHONE, text: 'On its way!', quoteId: 'IN2' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ direction: 'out', status: 'queued', content: { type: 'text', text: 'On its way!', quote: { id: 'IN2', fromMe: false, text: 'my order' } } });
  });

  it('treats a retry with the same Idempotency-Key as the same message', async () => {
    const send = () =>
      app.inject({
        method: 'POST',
        url: `/api/chats/${sessionId}/send`,
        headers: { authorization: `Bearer ${admin.pat}`, 'idempotency-key': 'page-retry-1' },
        payload: { jid: PHONE, text: 'Only once' },
      });
    const [a, b] = await Promise.all([send(), send()]);
    const c = await send();
    expect(a.statusCode, a.body).toBe(200);
    expect(b.json().data.id).toBe(a.json().data.id);
    expect(c.json().data.id).toBe(a.json().data.id);
    expect(a.json().data.content).toMatchObject({ type: 'text', text: 'Only once', sentFrom: 'chats', reachable: true });
    const [counted] = await sql<{ n: number }[]>`select count(*)::int as n from messages where session_id = ${sessionId} and content->>'text' = 'Only once'`;
    expect(counted?.n).toBe(1);
  });

  it('sends a recorded voice note with its length', async () => {
    const up = await app.inject({
      method: 'POST',
      url: '/api/chats/uploads',
      headers: { authorization: `Bearer ${admin.pat}`, 'content-type': 'application/octet-stream', 'x-mime-type': 'audio/ogg', 'x-file-name': 'voice.ogg' },
      payload: Buffer.from('OggS test'),
    });
    expect(up.json().data).toMatchObject({ kind: 'audio' });
    const sent = await call('POST', `/api/chats/${sessionId}/send`, admin.pat, { jid: PHONE, uploadId: up.json().data.id, ptt: true, seconds: 7 });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json().data).toMatchObject({ type: 'audio', status: 'queued', content: { type: 'audio', ptt: true, seconds: 7 } });
  });

  it('stores uploads and sends them as the right kind', async () => {
    const up = await app.inject({
      method: 'POST',
      url: '/api/chats/uploads',
      headers: { authorization: `Bearer ${admin.pat}`, 'content-type': 'application/octet-stream', 'x-mime-type': 'application/pdf', 'x-file-name': encodeURIComponent('فاتورة.pdf') },
      payload: Buffer.from('%PDF-1.4 test'),
    });
    expect(up.statusCode, up.body).toBe(200);
    expect(up.json().data).toMatchObject({ kind: 'document', size: 13 });
    const sent = await call('POST', `/api/chats/${sessionId}/send`, admin.pat, { jid: PHONE, uploadId: up.json().data.id, text: 'invoice' });
    expect(sent.json().data).toMatchObject({ type: 'document', hasMedia: true, content: { type: 'document', fileName: 'فاتورة.pdf', mimetype: 'application/pdf', caption: 'invoice' } });

    const file = await app.inject({ method: 'GET', url: `/api/chats/media/${sent.json().data.id}`, headers: { authorization: `Bearer ${admin.pat}`, range: 'bytes=0-3' } });
    expect(file.statusCode).toBe(206);
    expect(file.body).toBe('%PDF');
    expect(file.headers['cache-control']).toContain('immutable');
    expect((await call('GET', `/api/chats/media/${sent.json().data.id}`, business.pat)).statusCode).toBe(404);
  });

  it('reports insights for a number', async () => {
    const res = await call('GET', `/api/chats/${sessionId}/insights?days=7&tz=Africa/Cairo`, admin.pat);
    expect(res.statusCode, res.body).toBe(200);
    const { totals, types, top, daily } = res.json().data;
    expect(totals).toMatchObject({ inbound: 2, activeChats: 1, contacted: 1, replied: 1 });
    expect(types.find((x: { type: string }) => x.type === 'reaction')).toBeUndefined();
    expect(top[0]).toMatchObject({ jid: PHONE, name: 'Mona', inbound: 2 });
    expect(daily.length).toBeGreaterThan(0);
  });

  it('pages a conversation by time, so synced history lands in place', async () => {
    await sql`
      insert into messages (workspace_id, session_id, direction, remote_jid, wa_message_id, type, content, status, created_at)
      values (${admin.id}, ${sessionId}, 'in', ${PHONE}, 'OLD1', 'text', ${sql.json({ from: PHONE, text: 'from last year', history: true })}, 'received', now() - interval '365 days')`;
    const all = (await call('GET', `/api/chats/${sessionId}/messages?jid=${PHONE}&limit=100`, admin.pat)).json().data.messages;
    expect(all.at(-1).content.text).toBe('from last year');
    const list = (await call('GET', `/api/chats/${sessionId}/list?filter=archived`, admin.pat)).json().data.chats;
    expect(list[0].last.text).not.toBe('from last year');
  });

  it('answers list pictures without asking a disconnected number, ignoring junk', async () => {
    await sql`update sessions set status = 'disconnected' where id = ${sessionId}`;
    const res = await call('GET', `/api/chats/${sessionId}/pictures?jids=${PHONE},not-a-jid`, admin.pat);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({});
    expect((await call('GET', `/api/chats/${sessionId}/pictures?jids=${PHONE}`, business.pat)).statusCode).toBe(404);
  });

  it('syncs only connected numbers', async () => {
    await sql`update sessions set status = 'disconnected' where id = ${sessionId}`;
    expect((await call('POST', `/api/chats/${sessionId}/sync`, admin.pat, {})).json()).toMatchObject({ code: 'session_not_connected' });
    expect((await call('POST', `/api/chats/${sessionId}/sync`, business.pat, {})).statusCode).toBe(404);
  });
});
