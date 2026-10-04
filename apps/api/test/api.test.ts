import { randomInt } from 'node:crypto';
import { apiKeys, claimNextOutbound, createDb, createListener, type Db, eq, notify, runMigrations, type Sql, users, workspaces } from '@wa/db';
import { CHANNELS } from '@wa/shared';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createAuth } from '../src/lib/auth';
import { EventBus } from '../src/lib/events';
import { generateKey } from '../src/lib/keys';
import { OtpDeliveryError, otpKey, type OtpSender } from '../src/lib/otp';
import { createThrottle } from '../src/lib/throttle';
import { WorkerClient } from '../src/lib/workers';

const url = process.env.TEST_DATABASE_URL;

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
/** A bearer key, or a dashboard session cookie. */
type Credential = string | { cookie: string } | undefined;

describe.skipIf(!url)('api (integration)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sql: Sql;
  let end: () => Promise<unknown>;
  let db: Db;
  let events: EventBus;
  const ws: Record<'a' | 'b', { id: string; pat: string }> = {} as never;

  // Verification codes "sent" by the fake channel, newest last; a test can make the next send fail.
  const outbox: { phone: string; text: string }[] = [];
  let failNextSend: OtpDeliveryError | null = null;
  const sender: OtpSender = {
    channel: 'test',
    async send(phone, text) {
      if (failNextSend) {
        const err = failNextSend;
        failNextSend = null;
        throw err;
      }
      outbox.push({ phone, text });
    },
  };
  const codeFor = (phone: string) => /\b(\d{6})\b/.exec(outbox.filter((m) => m.phone === phone).at(-1)?.text ?? '')?.[1] ?? 'missing';

  // Every caller gets its own address so per-IP limits of one test don't spill into another.
  let ipCounter = 1;
  const nextIp = () => `10.77.${ipCounter >> 8}.${ipCounter++ & 255}`;
  const nextPhone = () => `+2010${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;

  const createWorkspace = async (name: string, planId: string, trialEndsAt: Date | null) => {
    const [w] = await db.insert(workspaces).values({ name, planId, trialEndsAt }).returning();
    const key = generateKey('pat');
    await db.insert(apiKeys).values({ workspaceId: w!.id, name: 'test', keyHash: key.hash, prefix: key.prefix });
    return { id: w!.id, pat: key.key };
  };

  const call = (method: Method, path: string, credential?: Credential, body?: unknown, headers: Record<string, string> = {}, ip?: string) =>
    app.inject({
      method,
      url: path,
      headers: { ...(typeof credential === 'string' ? { authorization: `Bearer ${credential}` } : {}), ...headers },
      ...(credential && typeof credential === 'object' ? { cookies: { wa_session: credential.cookie } } : {}),
      ...(ip ? { remoteAddress: ip } : {}),
      ...(body !== undefined ? { payload: body as object } : {}),
    });

  const sessionCookie = (res: Awaited<ReturnType<typeof call>>) => res.cookies.find((c) => c.name === 'wa_session');

  /** Signs up through the real flow (code to the phone) and returns the session cookie. */
  async function register(email: string, { phone = nextPhone(), password = 'correct horse battery', name = 'Owner' } = {}) {
    const ip = nextIp();
    const start = await call('POST', '/api/auth/register', undefined, { name, email, phone, password }, {}, ip);
    expect(start.statusCode, start.body).toBe(202);
    const verify = await call('POST', '/api/auth/register/verify', undefined, { verificationId: start.json().data.verificationId, code: codeFor(phone) }, {}, ip);
    expect(verify.statusCode, verify.body).toBe(201);
    const { user, workspace } = verify.json().data;
    return { cookie: { cookie: sessionCookie(verify)!.value }, user, workspace, phone, password };
  }

  const login = async (email: string, password: string, ip = nextIp()) => {
    const res = await call('POST', '/api/auth/login', undefined, { email, password }, {}, ip);
    return { res, cookie: sessionCookie(res) ? { cookie: sessionCookie(res)!.value } : undefined };
  };

  beforeAll(async () => {
    await runMigrations(url!);
    ({ sql, db, end } = createDb(url!, { max: 5 }));
    const logger = pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' });
    events = new EventBus({ createListener: () => createListener(url!), sql, logger });
    await events.start();
    await sql`delete from workers`;
    await sql`delete from throttles`;
    const auth = createAuth(sql);
    app = await buildApp(
      {
        sql,
        db,
        auth,
        events,
        workers: new WorkerClient(sql, 'x'.repeat(16)),
        throttle: createThrottle(sql),
        otp: { key: otpKey(undefined, 'x'.repeat(16)), sender, dailyLimit: 1000 },
      },
      { logger, corsOrigins: [], publicUrl: 'http://test' },
    );
    ws.a = await createWorkspace('api-test-a', 'pro', null);
    ws.b = await createWorkspace('api-test-b', 'trial', new Date(Date.now() + 86_400_000));
  });

  afterAll(async () => {
    await sql`delete from workspaces where id in (${ws.a.id}, ${ws.b.id})`;
    await app.close();
    await events.stop();
    await end();
  });

  let sessionId: string;
  let sessionKey: string;

  it('rejects missing and unknown keys', async () => {
    expect((await call('GET', '/api/whatsapp-sessions')).statusCode).toBe(401);
    const res = await call('GET', '/api/whatsapp-sessions', 'wap_nope');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ success: false, message: 'Missing or invalid API key', code: 'unauthorized' });
  });

  it('creates a session and returns its key once', async () => {
    const res = await call('POST', '/api/whatsapp-sessions', ws.a.pat, { name: 'Sales' });
    expect(res.statusCode).toBe(201);
    const { data } = res.json();
    expect(data).toMatchObject({ name: 'Sales', status: 'created', desiredState: 'stopped', phoneNumber: null });
    expect(data.apiKey).toMatch(/^was_/);
    sessionId = data.id;
    sessionKey = data.apiKey;

    const list = await call('GET', '/api/whatsapp-sessions', ws.a.pat);
    expect(list.json().data.map((s: { id: string }) => s.id)).toEqual([sessionId]);
    expect(JSON.stringify(list.json())).not.toContain('was_');
  });

  it('validates input with the documented error shape', async () => {
    const res = await call('POST', '/api/whatsapp-sessions', ws.a.pat, { name: '' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ success: false, message: 'Validation failed', code: 'validation_failed', errors: { name: expect.any(Array) } });
  });

  it('keeps session keys out of workspace management', async () => {
    expect((await call('GET', '/api/whatsapp-sessions', sessionKey)).statusCode).toBe(403);
    const status = await call('GET', '/api/status', sessionKey);
    expect(status.json().data).toEqual({ sessionId, status: 'created', phoneNumber: null });
  });

  it('isolates workspaces', async () => {
    expect((await call('GET', `/api/whatsapp-sessions/${sessionId}`, ws.b.pat)).statusCode).toBe(404);
    expect((await call('GET', '/api/status', ws.b.pat, undefined, { 'x-session-id': sessionId })).statusCode).toBe(404);
    expect((await call('POST', `/api/whatsapp-sessions/${sessionId}/connect`, ws.b.pat)).statusCode).toBe(404);
    expect((await call('DELETE', `/api/whatsapp-sessions/${sessionId}`, ws.b.pat)).statusCode).toBe(404);
  });

  it('requires X-Session-Id with a workspace token', async () => {
    const res = await call('GET', '/api/status', ws.a.pat);
    expect(res.statusCode).toBe(400);
    const ok = await call('GET', '/api/status', ws.a.pat, undefined, { 'x-session-id': sessionId });
    expect(ok.json().data.sessionId).toBe(sessionId);
  });

  it('validates send-message bodies', async () => {
    const bad = await call('POST', '/api/send-message', sessionKey, { to: 'nope', text: 'hi' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors.to).toBeDefined();
    expect((await call('POST', '/api/send-message', sessionKey, { to: '+201012345678' })).statusCode).toBe(422);
    const both = await call('POST', '/api/send-message', sessionKey, {
      to: '+201012345678',
      imageUrl: 'https://x.test/a.jpg',
      videoUrl: 'https://x.test/a.mp4',
    });
    expect(both.statusCode).toBe(422);
  });

  it('refuses to queue while the session is not connected', async () => {
    const res = await call('POST', '/api/send-message', sessionKey, { to: '+201012345678', text: 'hi' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'session_not_connected' });
    expect(res.json().message).toContain('not connected');
  });

  it('503s on connect when no worker is alive', async () => {
    expect((await call('POST', `/api/whatsapp-sessions/${sessionId}/connect`, ws.a.pat)).statusCode).toBe(503);
  });

  it('queues messages, honours Idempotency-Key, and exposes status', async () => {
    await sql`update sessions set status = 'connected', desired_state = 'running' where id = ${sessionId}`;
    const send = () =>
      call('POST', '/api/send-message', sessionKey, { to: '+20 101 234 5678', text: 'hello' }, { 'idempotency-key': 'order-42' });
    const first = await send();
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({ jid: '201012345678@s.whatsapp.net', status: 'queued' });
    const msgId = first.json().data.msgId;
    expect((await send()).json().data.msgId).toBe(msgId);

    const message = await call('GET', `/api/messages/${msgId}`, sessionKey);
    expect(message.json().data).toMatchObject({ id: msgId, direction: 'out', type: 'text', status: 'queued', content: { text: 'hello' } });
    expect(message.json().data).not.toHaveProperty('raw');

    const list = await call('GET', '/api/messages?direction=out', sessionKey);
    expect(list.json().data.messages.map((m: { id: number }) => m.id)).toContain(msgId);

    expect((await call('POST', `/api/messages/${msgId}/resend`, sessionKey)).statusCode).toBe(409);
    await sql`update messages set status = 'failed', error = 'boom' where id = ${msgId}`;
    const resent = await call('POST', `/api/messages/${msgId}/resend`, sessionKey);
    expect(resent.json().data).toMatchObject({ status: 'queued', error: null });
  });

  it('manages templates and renders them when sending', async () => {
    // Isolation checks use a throwaway workspace: ws.b is on the trial's 10 rpm, which later tests rely on.
    const other = await createWorkspace('api-test-templates', 'pro', null);
    const created = await call('POST', '/api/templates', ws.a.pat, {
      name: 'order_update',
      category: 'notification',
      body: 'Hi {{name}}, order {{ order }} is {{status}}.',
    });
    expect(created.statusCode).toBe(201);
    const template = created.json().data;
    expect(template.variables).toEqual(['name', 'order', 'status']);
    expect((await call('POST', '/api/templates', ws.a.pat, { name: 'order_update', body: 'x' })).statusCode).toBe(409);
    expect((await call('POST', '/api/templates', ws.a.pat, { name: 'bad name!', body: 'x' })).statusCode).toBe(422);
    expect((await call('GET', '/api/templates', other.pat)).json().data).toEqual([]);

    const missing = await call('POST', '/api/send-message', sessionKey, { to: '+201012345678', template: 'order_update', variables: { name: 'Sara' } });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().errors.variables).toEqual(['Missing "order"', 'Missing "status"']);
    expect((await call('POST', '/api/send-message', sessionKey, { to: '+201012345678', template: 'nope' })).statusCode).toBe(422);
    expect((await call('POST', '/api/send-message', sessionKey, { to: '+201012345678', template: 'order_update', text: 'x' })).statusCode).toBe(422);

    const sent = await call('POST', '/api/send-message', sessionKey, {
      to: '+201012345678',
      template: 'order_update',
      variables: { name: 'Sara', order: 42, status: 'shipped' },
    });
    expect(sent.statusCode).toBe(200);
    const message = await call('GET', `/api/messages/${sent.json().data.msgId}`, sessionKey);
    expect(message.json().data.content).toEqual({ type: 'text', text: 'Hi Sara, order 42 is shipped.' });

    const updated = await call('PUT', `/api/templates/${template.id}`, ws.a.pat, { body: 'Order {{order}}: {{status}}' });
    expect(updated.json().data.variables).toEqual(['order', 'status']);
    expect((await call('DELETE', `/api/templates/${template.id}`, other.pat)).statusCode).toBe(404);
    expect((await call('DELETE', `/api/templates/${template.id}`, ws.a.pat)).statusCode).toBe(200);
    await sql`delete from workspaces where id = ${other.id}`;
  });

  it('sends one-time codes', async () => {
    const generated = await call('POST', '/api/send-otp', sessionKey, { to: '+201012345678', lang: 'en' });
    expect(generated.statusCode).toBe(200);
    const { code, msgId } = generated.json().data;
    expect(code).toMatch(/^\d{6}$/);
    const first = await call('GET', `/api/messages/${msgId}`, sessionKey);
    expect(first.json().data.content.text).toContain(`*${code}*`);
    expect(first.json().data.content.text).toContain('verification code');

    // A workspace template named "otp" replaces the built-in text.
    await call('POST', '/api/templates', ws.a.pat, { name: 'otp', category: 'otp', body: '{{app}} code: {{code}}' });
    expect((await call('POST', '/api/send-otp', sessionKey, { to: '+201012345678', code: '1234' })).statusCode).toBe(422);
    const custom = await call('POST', '/api/send-otp', sessionKey, { to: '+201012345678', code: '1234', variables: { app: 'Shop' } });
    expect(custom.json().data.code).toBe('1234');
    const second = await call('GET', `/api/messages/${custom.json().data.msgId}`, sessionKey);
    expect(second.json().data.content.text).toBe('Shop code: 1234');

    await call('POST', '/api/templates', ws.a.pat, { name: 'no_code', body: 'Hello' });
    expect((await call('POST', '/api/send-otp', sessionKey, { to: '+201012345678', template: 'no_code' })).statusCode).toBe(422);
    expect((await call('POST', '/api/send-otp', sessionKey, { to: '+201012345678', length: 3 })).statusCode).toBe(422);
  });

  it('sends card templates with buttons as an image plus a poll', async () => {
    const bad = (extra: object) => call('POST', '/api/templates', ws.a.pat, { name: 'card_bad', body: 'x', ...extra });
    expect((await bad({ buttons: ['Only'], buttonsTitle: 'T' })).statusCode).toBe(422);
    expect((await bad({ buttons: ['A', 'A'], buttonsTitle: 'T' })).statusCode).toBe(422);
    expect((await bad({ buttons: ['A', 'B'] })).statusCode).toBe(422);
    expect((await bad({ imageUrl: 'ftp://example.com/a.png' })).statusCode).toBe(422);
    expect((await bad({ buttons: Array.from({ length: 13 }, (_, i) => `b${i}`), buttonsTitle: 'T' })).statusCode).toBe(422);

    const created = await call('POST', '/api/templates', ws.a.pat, {
      name: 'product_card',
      category: 'marketing',
      body: 'New: *{{product}}* for {{price}}',
      imageUrl: 'https://example.com/shoe.jpg',
      buttons: ['Order {{product}}', 'Not now'],
      buttonsTitle: 'Interested?',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({
      imageUrl: 'https://example.com/shoe.jpg',
      buttons: ['Order {{product}}', 'Not now'],
      buttonsTitle: 'Interested?',
      variables: ['product', 'price'],
    });

    const vars = { product: 'Runner', price: '$40' };
    const sent = await call('POST', '/api/send-message', sessionKey, { to: '+201012345678', template: 'product_card', variables: vars });
    expect(sent.statusCode).toBe(200);
    const { msgId, pollMsgId } = sent.json().data;
    expect(pollMsgId).toBeGreaterThan(msgId);
    const card = (await call('GET', `/api/messages/${msgId}`, sessionKey)).json().data;
    expect(card).toMatchObject({ type: 'image', content: { type: 'image', url: 'https://example.com/shoe.jpg', caption: 'New: *Runner* for $40' } });
    const poll = (await call('GET', `/api/messages/${pollMsgId}`, sessionKey)).json().data;
    expect(poll).toMatchObject({ type: 'poll', content: { type: 'poll', name: 'Interested?', options: ['Order Runner', 'Not now'], selectableCount: 1 } });

    // Clearing the buttons turns it back into a single card.
    const updated = await call('PUT', `/api/templates/${created.json().data.id}`, ws.a.pat, { buttons: null });
    expect(updated.json().data).toMatchObject({ buttons: null, buttonsTitle: null, imageUrl: 'https://example.com/shoe.jpg' });
    const single = await call('POST', '/api/send-message', sessionKey, { to: '+201012345678', template: 'product_card', variables: vars });
    expect(single.json().data.pollMsgId).toBeUndefined();

    // A poll sent directly, WasenderAPI-style.
    const direct = await call('POST', '/api/send-message', sessionKey, { to: '+201012345678', poll: { question: 'Size?', options: ['S', 'M', 'L'] } });
    expect(direct.statusCode).toBe(200);
    expect((await call('GET', `/api/messages/${direct.json().data.msgId}`, sessionKey)).json().data).toMatchObject({ type: 'poll', content: { name: 'Size?' } });
  });

  it("doesn't let a session key read another session's messages", async () => {
    const other = await call('POST', '/api/whatsapp-sessions', ws.a.pat, { name: 'Support' });
    const otherKey = other.json().data.apiKey;
    const [msg] = await sql<{ id: number }[]>`select id from messages where session_id = ${sessionId} limit 1`;
    expect((await call('GET', `/api/messages/${msg!.id}`, otherKey)).statusCode).toBe(404);
    expect((await call('GET', `/api/messages/${msg!.id}`, ws.b.pat)).statusCode).toBe(404);
  });

  it('serves the QR as text and PNG', async () => {
    expect((await call('GET', `/api/whatsapp-sessions/${sessionId}/qrcode`, sessionKey)).statusCode).toBe(409);
    await sql`update sessions set qr = '2@abc,def,ghi' where id = ${sessionId}`;
    const res = await call('GET', `/api/whatsapp-sessions/${sessionId}/qrcode`, sessionKey);
    expect(res.json().data.qrCode).toBe('2@abc,def,ghi');
    expect(res.json().data.qrImage).toMatch(/^data:image\/png;base64,/);
  });

  it('rotates the session key', async () => {
    const res = await call('POST', `/api/whatsapp-sessions/${sessionId}/regenerate-key`, ws.a.pat);
    const newKey = res.json().data.apiKey;
    expect((await call('GET', '/api/status', sessionKey)).statusCode).toBe(401);
    expect((await call('GET', '/api/status', newKey)).statusCode).toBe(200);
    sessionKey = newKey;
  });

  it('creates and revokes workspace tokens', async () => {
    const created = await call('POST', '/api/api-keys', ws.a.pat, { name: 'CI' });
    expect(created.statusCode).toBe(201);
    const { id, key } = created.json().data;
    expect(key).toMatch(/^wap_/);
    expect((await call('GET', '/api/api-keys', key)).statusCode).toBe(200);
    expect((await call('DELETE', `/api/api-keys/${id}`, ws.a.pat)).statusCode).toBe(200);
    expect((await call('GET', '/api/api-keys', key)).statusCode).toBe(401);
    expect((await call('DELETE', `/api/api-keys/${id}`, ws.b.pat)).statusCode).toBe(404);
  });

  it('enforces the plan session quota with 402', async () => {
    expect((await call('POST', '/api/whatsapp-sessions', ws.b.pat, { name: 'one' })).statusCode).toBe(201);
    const res = await call('POST', '/api/whatsapp-sessions', ws.b.pat, { name: 'two' });
    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe('session_quota');
  });

  it('blocks sending after the trial ends', async () => {
    const [s] = await sql<{ id: string }[]>`select id from sessions where workspace_id = ${ws.b.id}`;
    await sql`update sessions set status = 'connected', desired_state = 'running' where id = ${s!.id}`;
    await sql`update workspaces set trial_ends_at = now() - interval '1 day' where id = ${ws.b.id}`;
    const fresh = await call('POST', '/api/api-keys', ws.b.pat, { name: 'fresh' }); // new key → uncached plan data
    const res = await call('POST', '/api/send-message', fresh.json().data.key, { to: '+201012345678', text: 'x' }, { 'x-session-id': s!.id });
    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe('trial_expired');
  });

  it('rate-limits per workspace, so extra tokens add no quota', async () => {
    const rl = await createWorkspace('api-test-rl', 'trial', new Date(Date.now() + 86_400_000));
    const extra = generateKey('pat');
    await db.insert(apiKeys).values({ workspaceId: rl.id, name: 'second', keyHash: extra.hash, prefix: extra.prefix });
    const keys = [rl.pat, extra.key];
    let last;
    for (let i = 0; i < 11; i++) last = await call('GET', '/api/api-keys', keys[i % 2]); // trial: 10 rpm for the whole workspace
    expect(last!.statusCode).toBe(429);
    expect(last!.headers['retry-after']).toBeDefined();
    expect(last!.json()).toMatchObject({ code: 'rate_limited' });
    expect(last!.json().message).toContain('Rate limit');
    await sql`delete from workspaces where id = ${rl.id}`;
  });

  it('delivers worker events to subscribers', async () => {
    const waiting = events.waitFor(ws.a.id, (e) => e.type === 'qrcode.updated', 5_000);
    await notify(sql, CHANNELS.events, { type: 'qrcode.updated', workspaceId: ws.a.id, sessionId, data: { qr: 'x' } });
    expect(await waiting).toMatchObject({ type: 'qrcode.updated', sessionId });
  });

  it('deletes a session with its keys', async () => {
    expect((await call('DELETE', `/api/whatsapp-sessions/${sessionId}`, ws.a.pat)).statusCode).toBe(200);
    expect((await call('GET', '/api/status', sessionKey)).statusCode).toBe(401);
  });

  describe('responses and protection', () => {
    it('tags every response with a request id and safe headers', async () => {
      const res = await call('GET', '/api/me', ws.a.pat, undefined, { 'x-request-id': 'client-trace-0001' });
      expect(res.headers['x-request-id']).toBe('client-trace-0001');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['cache-control']).toBe('no-store');
      const minted = await call('GET', '/api/me', ws.a.pat, undefined, { 'x-request-id': 'bad id with spaces' });
      expect(minted.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('answers unknown routes and bad JSON with the error contract', async () => {
      const missing = await call('GET', '/api/nope', ws.a.pat);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ success: false, code: 'route_not_found' });
      const broken = await app.inject({ method: 'POST', url: '/api/api-keys', headers: { authorization: `Bearer ${ws.a.pat}`, 'content-type': 'application/json' }, payload: '{nope' });
      expect(broken.statusCode).toBe(400);
      expect(broken.json()).toMatchObject({ success: false, code: 'bad_request' });
    });

    it('slows down floods of invalid keys from one address', async () => {
      const ip = nextIp();
      let last;
      for (let i = 0; i < 31; i++) last = await call('GET', '/api/me', `wap_guess_${i}`, undefined, {}, ip);
      expect(last!.statusCode).toBe(429);
      // Another address is unaffected.
      expect((await call('GET', '/api/me', 'wap_guess', undefined, {}, nextIp())).statusCode).toBe(401);
    });

    it('ignores a forged X-Forwarded-For when counting login failures', async () => {
      const ip = nextIp();
      const statuses: number[] = [];
      for (let i = 0; i < 22; i++) {
        const res = await call('POST', '/api/auth/login', undefined, { email: `ghost-${i}@test.local`, password: 'nope' }, { 'x-forwarded-for': `203.0.113.${i}` }, ip);
        statuses.push(res.statusCode);
      }
      expect(statuses.slice(0, 20).every((s) => s === 422)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
    });
  });

  describe('sign-up with phone verification', () => {
    const stamp = Date.now();
    const email = `owner-${stamp}@test.local`;
    const phone = nextPhone();
    const ip = nextIp();

    afterAll(async () => {
      await sql`delete from workspaces where owner_id in (select id from users where email like ${`%-${stamp}@test.local`})`;
      await sql`delete from users where email like ${`%-${stamp}@test.local`}`;
      await sql`delete from phone_verifications where email like ${`%-${stamp}@test.local`}`;
    });

    it('validates the details before sending anything', async () => {
      const sent = outbox.length;
      const bad = (body: object) => call('POST', '/api/auth/register', undefined, { name: 'X', email, phone, password: 'correct horse battery', ...body }, {}, ip);
      expect((await bad({ phone: '01012345678' })).json().errors.phone).toBeDefined(); // local format: country unknown
      expect((await bad({ password: 'password123' })).json().errors.password).toEqual(['This password is too common']);
      expect((await bad({ password: email })).statusCode).toBe(422);
      expect((await bad({ email: 'not-an-email' })).statusCode).toBe(422);
      expect(outbox.length).toBe(sent);
    });

    it('sends a code and creates nothing until it is confirmed', async () => {
      const res = await call('POST', '/api/auth/register', undefined, { name: 'Owner', email, phone, password: 'correct horse battery', lang: 'en' }, {}, ip);
      expect(res.statusCode).toBe(202);
      const ticket = res.json().data;
      expect(ticket).toMatchObject({ channel: 'test', resendAfter: 60, phone: expect.stringMatching(/^\+20•+\d{3}$/) });
      expect(ticket.phone).not.toContain(phone.slice(3, 9));
      expect(await sql`select 1 from users where email = ${email}`).toHaveLength(0);
      const code = codeFor(phone);
      expect(outbox.at(-1)!.text).toContain(code);
      // Only an HMAC of the code is stored.
      const [row] = await sql<{ code_hash: string }[]>`select code_hash from phone_verifications where id = ${ticket.verificationId}`;
      expect(row!.code_hash).not.toContain(code);
      expect(row!.code_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const wrong = await call('POST', '/api/auth/register/verify', undefined, { verificationId: ticket.verificationId, code: code === '000000' ? '111111' : '000000' }, {}, ip);
      expect(wrong.statusCode).toBe(422);
      expect(wrong.json()).toMatchObject({ code: 'code_invalid', details: { attemptsLeft: 4 } });

      // Arabic-Indic digits are accepted as typed on Arabic keyboards.
      const arabic = code.replace(/\d/g, (d) => String.fromCharCode(0x660 + Number(d)));
      const ok = await call('POST', '/api/auth/register/verify', undefined, { verificationId: ticket.verificationId, code: arabic }, {}, ip);
      expect(ok.statusCode).toBe(201);
      const { user, workspace } = ok.json().data;
      expect(user).toMatchObject({ email, role: 'user', status: 'active', phone, phoneVerified: true, isAdmin: false });
      expect(workspace.planId).toBe('trial');
      expect(new Date(workspace.trialEndsAt).getTime()).toBeGreaterThan(Date.now() + 2 * 86_400_000);
      expect(ok.json().data).not.toHaveProperty('token');

      const cookie = sessionCookie(ok)!;
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api' });
      const me = await call('GET', '/api/me', { cookie: cookie.value });
      expect(me.json().data.user).toMatchObject({ email, phoneVerified: true });

      // Single use.
      expect((await call('POST', '/api/auth/register/verify', undefined, { verificationId: ticket.verificationId, code }, {}, ip)).statusCode).toBe(404);
    });

    it('refuses an email or a phone that is already taken', async () => {
      const again = await call('POST', '/api/auth/register', undefined, { name: 'X', email: email.toUpperCase(), phone: nextPhone(), password: 'another long pass' }, {}, nextIp());
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: 'email_taken' });
      const samePhone = await call('POST', '/api/auth/register', undefined, { name: 'X', email: `other-${stamp}@test.local`, phone, password: 'another long pass' }, {}, nextIp());
      expect(samePhone.json()).toMatchObject({ code: 'phone_taken' });
    });

    it('limits guesses, expires codes and paces resends', async () => {
      const p = nextPhone();
      const callerIp = nextIp();
      const start = await call('POST', '/api/auth/register', undefined, { name: 'G', email: `guess-${stamp}@test.local`, phone: p, password: 'guess me not please' }, {}, callerIp);
      const id = start.json().data.verificationId;
      const firstCode = codeFor(p);
      const wrong = firstCode === '999999' ? '888888' : '999999';
      for (let i = 0; i < 5; i++) await call('POST', '/api/auth/register/verify', undefined, { verificationId: id, code: wrong }, {}, callerIp);
      const blocked = await call('POST', '/api/auth/register/verify', undefined, { verificationId: id, code: firstCode }, {}, callerIp);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().code).toBe('too_many_attempts');

      // Resending is paced…
      const early = await call('POST', '/api/auth/register/resend', undefined, { verificationId: id }, {}, callerIp);
      expect(early.statusCode).toBe(429);
      expect(early.json()).toMatchObject({ code: 'resend_cooldown', details: { retryAfter: expect.any(Number) } });
      // …and once allowed, issues a new code with a fresh budget; the old code stops working.
      await sql`update phone_verifications set last_sent_at = now() - interval '2 minutes' where id = ${id}`;
      expect((await call('POST', '/api/auth/register/resend', undefined, { verificationId: id }, {}, callerIp)).statusCode).toBe(200);
      const newCode = codeFor(p);
      if (newCode !== firstCode) {
        expect((await call('POST', '/api/auth/register/verify', undefined, { verificationId: id, code: firstCode }, {}, callerIp)).json().code).toBe('code_invalid');
      }
      await sql`update phone_verifications set expires_at = now() - interval '1 second' where id = ${id}`;
      const expired = await call('POST', '/api/auth/register/verify', undefined, { verificationId: id, code: newCode }, {}, callerIp);
      expect(expired.json().code).toBe('code_expired');
    });

    it('reports a number that cannot receive codes, and keeps nothing behind', async () => {
      const p = nextPhone();
      failNextSend = new OtpDeliveryError('recipient', 'nope');
      const res = await call('POST', '/api/auth/register', undefined, { name: 'U', email: `unreachable-${stamp}@test.local`, phone: p, password: 'unreachable pass' }, {}, nextIp());
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'phone_unreachable', errors: { phone: expect.any(Array) } });
      expect(await sql`select 1 from phone_verifications where phone = ${p}`).toHaveLength(0);
      failNextSend = new OtpDeliveryError('unavailable', 'down');
      const down = await call('POST', '/api/auth/register', undefined, { name: 'U', email: `unreachable-${stamp}@test.local`, phone: p, password: 'unreachable pass' }, {}, nextIp());
      expect(down.statusCode).toBe(503);
      expect(down.json().code).toBe('otp_unavailable');
    });

    it('caps how many codes one number can receive', async () => {
      const p = nextPhone();
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await call('POST', '/api/auth/register', undefined, { name: 'C', email: `cap-${i}-${stamp}@test.local`, phone: p, password: 'capped password' }, {}, nextIp());
        statuses.push(res.statusCode);
      }
      expect(statuses.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
      expect(statuses[5]).toBe(429);
    });
  });

  describe('login and sessions', () => {
    const stamp = Date.now() + 1;
    const email = `login-${stamp}@test.local`;
    let account: Awaited<ReturnType<typeof register>>;

    beforeAll(async () => {
      account = await register(email);
    });

    afterAll(async () => {
      await sql`delete from workspaces where owner_id in (select id from users where email like ${`%-${stamp}@test.local`})`;
      await sql`delete from users where email like ${`%-${stamp}@test.local`}`;
      await sql`delete from phone_verifications where email like ${`%-${stamp}@test.local`}`;
    });

    it('answers wrong passwords and unknown emails the same way', async () => {
      const wrong = await login(email, 'wrong password');
      const unknown = await login(`nobody-${stamp}@test.local`, 'wrong password');
      expect(wrong.res.statusCode).toBe(422);
      expect(unknown.res.json()).toEqual(wrong.res.json());
      expect(wrong.cookie).toBeUndefined();
      const good = await login(email.toUpperCase(), account.password);
      expect(good.res.statusCode).toBe(200);
      expect(good.res.json().data.workspace.id).toBe(account.workspace.id);
      expect(good.cookie).toBeDefined();
    });

    it('locks an account after repeated failures, from any address', async () => {
      const target = await register(`locked-${stamp}@test.local`);
      for (let i = 0; i < 10; i++) await login(`locked-${stamp}@test.local`, `wrong ${i}`);
      const blocked = await login(`locked-${stamp}@test.local`, target.password);
      expect(blocked.res.statusCode).toBe(429);
      expect(blocked.res.json()).toMatchObject({ code: 'rate_limited' });
      expect(blocked.res.headers['retry-after']).toBeDefined();
    });

    it('only accepts cookie writes from our own pages', async () => {
      const create = (headers: Record<string, string>) => call('POST', '/api/api-keys', account.cookie, { name: 'csrf' }, headers);
      expect((await create({ 'sec-fetch-site': 'cross-site' })).json()).toMatchObject({ code: 'csrf_blocked' });
      expect((await create({ 'sec-fetch-site': 'same-site' })).statusCode).toBe(403);
      expect((await create({ origin: 'https://evil.test' })).statusCode).toBe(403);
      expect((await create({ 'sec-fetch-site': 'same-origin' })).statusCode).toBe(201);
      // Bearer keys aren't ambient, so they need no such check; reads are always fine.
      expect((await call('GET', '/api/api-keys', account.cookie, undefined, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(200);
      // Login from another site is refused too (login CSRF).
      expect((await call('POST', '/api/auth/login', undefined, { email, password: account.password }, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    });

    it('only honours dashboard tokens in the cookie', async () => {
      const pat = (await call('POST', '/api/api-keys', account.cookie, { name: 'not-a-cookie' })).json().data.key;
      expect((await call('GET', '/api/me', { cookie: pat })).statusCode).toBe(401);
      expect((await call('GET', '/api/me', pat)).statusCode).toBe(200);
      // Dashboard tokens stay out of the keys list.
      const keys = (await call('GET', '/api/api-keys', account.cookie)).json().data;
      expect(keys.every((k: { name: string }) => k.name !== 'Dashboard login')).toBe(true);
    });

    it('turns a workspace token into a session cookie, retiring old console tokens', async () => {
      const pat = (await call('POST', '/api/api-keys', account.cookie, { name: 'login-token' })).json().data.key;
      const res = await call('POST', '/api/auth/session', pat, { remember: false });
      expect(res.statusCode).toBe(200);
      const cookie = sessionCookie(res)!;
      expect(cookie.maxAge).toBeUndefined(); // browser-session cookie
      expect((await call('GET', '/api/me', { cookie: cookie.value })).statusCode).toBe(200);
      expect((await call('GET', '/api/me', pat)).statusCode).toBe(200); // the API token itself is untouched

      // A console token kept by an older dashboard is exchanged once, then dead.
      const legacy = generateKey('pat');
      await db.insert(apiKeys).values({ workspaceId: account.workspace.id, name: 'Dashboard login', keyHash: legacy.hash, prefix: legacy.prefix, scopes: ['console'] });
      expect((await call('POST', '/api/auth/session', legacy.key, {})).statusCode).toBe(200);
      expect((await call('GET', '/api/me', legacy.key)).statusCode).toBe(401);
      expect((await call('POST', '/api/auth/session', account.cookie, {})).json().code).toBe('bearer_required');
    });

    it('logs out the session and clears the cookie', async () => {
      const { cookie } = await login(email, account.password);
      const res = await call('POST', '/api/auth/logout', cookie);
      expect(res.statusCode).toBe(200);
      expect(sessionCookie(res)).toMatchObject({ value: '' });
      expect((await call('GET', '/api/me', cookie)).json()).toMatchObject({ code: 'session_expired' });
      // Logging out again (stale cookie) still succeeds.
      expect((await call('POST', '/api/auth/logout', cookie)).statusCode).toBe(200);
    });

    it('ends the other sessions when the password changes', async () => {
      const a = (await login(email, account.password)).cookie!;
      const b = (await login(email, account.password)).cookie!;
      const weak = await call('POST', '/api/auth/password', a, { currentPassword: account.password, newPassword: '12345678' });
      expect(weak.statusCode).toBe(422);
      const wrong = await call('POST', '/api/auth/password', a, { currentPassword: 'nope', newPassword: 'brand new passphrase' });
      expect(wrong.statusCode).toBe(422);
      const changed = await call('POST', '/api/auth/password', a, { currentPassword: account.password, newPassword: 'brand new passphrase' });
      expect(changed.json().data.otherSessionsEnded).toBeGreaterThanOrEqual(2);
      expect((await call('GET', '/api/me', a)).statusCode).toBe(200);
      expect((await call('GET', '/api/me', b)).statusCode).toBe(401);
      expect((await call('GET', '/api/me', account.cookie)).statusCode).toBe(401);
      expect((await login(email, 'brand new passphrase')).res.statusCode).toBe(200);
      account.password = 'brand new passphrase';
    });

    it('upgrades old password hashes on login', async () => {
      const { hashPassword } = await import('../src/lib/passwords');
      const strong = await hashPassword('legacy password');
      // Same derivation, weaker parameters: what older builds stored.
      const { scryptSync, randomBytes } = await import('node:crypto');
      const salt = randomBytes(16);
      const key = scryptSync('legacy password'.normalize('NFKC'), salt, 64, { N: 16_384, r: 8, p: 1 });
      await sql`update users set password_hash = ${['scrypt', 16384, 8, 1, salt.toString('base64'), key.toString('base64')].join('$')} where email = ${email}`;
      expect((await login(email, 'legacy password')).res.statusCode).toBe(200);
      const [row] = await sql<{ password_hash: string }[]>`select password_hash from users where email = ${email}`;
      expect(row!.password_hash.split('$').slice(1, 4)).toEqual(strong.split('$').slice(1, 4));
      account.password = 'legacy password';
    });

    it('returns the account and an overview', async () => {
      const { cookie } = await login(email, account.password);
      const me = await call('GET', '/api/me', cookie);
      expect(me.json().data).toMatchObject({ user: { email }, workspace: { id: account.workspace.id }, plan: { id: 'trial', sessions: 1 }, pendingRequest: null });
      await call('POST', '/api/whatsapp-sessions', cookie, { name: 'Main' });
      const overview = await call('GET', '/api/overview?days=7', cookie);
      expect(overview.statusCode).toBe(200);
      const { data } = overview.json();
      expect(data.sessions).toMatchObject({ total: 1, byStatus: { created: 1, connected: 0 } });
      expect(data.messages.daily).toHaveLength(7);
      expect(data.messages.daily.at(-1).day).toBe(new Date().toISOString().slice(0, 10));
    });

    it('rejects expired dashboard sessions', async () => {
      const { cookie } = await login(email, account.password);
      await sql`update api_keys set expires_at = now() - interval '1 minute' where workspace_id = ${account.workspace.id} and revoked_at is null and 'console' = any(scopes)`;
      expect((await call('GET', '/api/me', cookie)).statusCode).toBe(401);
    });
  });

  describe('plans, admins and user management', () => {
    const stamp = Date.now() + 2;
    const adminEmail = `admin-${stamp}@test.local`;
    let admin: { id: string; pat: string };
    let adminUserId: string;
    let customer: Awaited<ReturnType<typeof register>>;

    beforeAll(async () => {
      customer = await register(`customer-${stamp}@test.local`);
      const [owner] = await db.insert(users).values({ email: adminEmail, role: 'admin' }).returning();
      adminUserId = owner!.id;
      admin = await createWorkspace('admin-ws', 'unlimited', null);
      await db.update(workspaces).set({ ownerId: owner!.id }).where(eq(workspaces.id, admin.id));
    });

    afterAll(async () => {
      await sql`delete from workspaces where owner_id in (select id from users where email like ${`%-${stamp}@test.local`})`;
      await sql`delete from users where email like ${`%-${stamp}@test.local`}`;
      await sql`delete from phone_verifications where email like ${`%-${stamp}@test.local`}`;
    });

    it('keeps admin routes away from customers, whatever they send', async () => {
      expect((await call('GET', '/api/admin/stats', customer.cookie)).json()).toMatchObject({ code: 'admin_only' });
      const pat = (await call('POST', '/api/api-keys', customer.cookie, { name: 'probe' })).json().data.key;
      expect((await call('GET', '/api/admin/users', pat)).statusCode).toBe(403);
      expect((await call('POST', `/api/admin/users/${adminUserId}/suspend`, pat, { reason: 'x' })).statusCode).toBe(403);
      expect((await call('PUT', `/api/admin/workspaces/${customer.workspace.id}/plan`, pat, { planId: 'unlimited', months: null })).statusCode).toBe(403);
      expect((await call('GET', '/api/admin/stats', admin.pat)).statusCode).toBe(200);
    });

    it('records one pending request per workspace and refuses duplicates', async () => {
      expect((await call('POST', '/api/plan-requests', customer.cookie, { planId: 'unlimited' })).statusCode).toBe(422);
      expect((await call('POST', '/api/plan-requests', customer.cookie, { planId: 'basic' })).statusCode).toBe(201);
      const dup = await call('POST', '/api/plan-requests', customer.cookie, { planId: 'basic' });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().code).toBe('duplicate_request');
      // Concurrent submissions for different plans: each replaces the last, and exactly one stays pending.
      const results = await Promise.all(['pro', 'plus', 'business', 'pro'].map((planId) => call('POST', '/api/plan-requests', customer.cookie, { planId, note: 'ref 42' })));
      expect(results.every((r) => r.statusCode === 201 || r.statusCode === 409)).toBe(true);
      const [pending] = await sql<{ n: number }[]>`select count(*)::int as n from plan_requests where workspace_id = ${customer.workspace.id} and status = 'pending'`;
      expect(pending!.n).toBe(1);
      const me = (await call('GET', '/api/me', customer.cookie)).json().data;
      expect(me.pendingRequest).toMatchObject({ note: 'ref 42', status: 'pending' });
      const history = (await call('GET', '/api/plan-requests', customer.cookie)).json().data;
      expect(history.length).toBeGreaterThanOrEqual(4);
    });

    it('activates the plan when an admin approves', async () => {
      const me = (await call('GET', '/api/me', customer.cookie)).json().data;
      const approve = await call('POST', `/api/admin/plan-requests/${me.pendingRequest.id}/approve`, admin.pat, { months: 1 });
      expect(approve.statusCode).toBe(200);
      expect((await call('POST', `/api/admin/plan-requests/${me.pendingRequest.id}/approve`, admin.pat, { months: 1 })).json().code).toBe('not_pending');
      const after = (await call('GET', '/api/me', customer.cookie)).json().data;
      expect(after.workspace.planId).toBe(me.pendingRequest.planId);
      expect(after.pendingRequest).toBeNull();
      const days = (new Date(after.workspace.planExpiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(27);
      expect(days).toBeLessThan(32);
    });

    it('needs a verified phone to request a plan', async () => {
      // An account from before phone verification: no number on file.
      const [legacyUser] = await db.insert(users).values({ email: `legacy-${stamp}@test.local` }).returning();
      const legacy = await createWorkspace('legacy-ws', 'trial', new Date(Date.now() + 86_400_000));
      await db.update(workspaces).set({ ownerId: legacyUser!.id }).where(eq(workspaces.id, legacy.id));
      const refused = await call('POST', '/api/plan-requests', legacy.pat, { planId: 'basic' });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().code).toBe('phone_unverified');

      const phone = nextPhone();
      const ip = nextIp();
      const start = await call('POST', '/api/account/phone', legacy.pat, { phone }, {}, ip);
      expect(start.statusCode).toBe(202);
      const verified = await call('POST', '/api/account/phone/verify', legacy.pat, { verificationId: start.json().data.verificationId, code: codeFor(phone) }, {}, ip);
      expect(verified.json().data.user).toMatchObject({ phone, phoneVerified: true });
      expect((await call('POST', '/api/plan-requests', legacy.pat, { planId: 'basic' })).statusCode).toBe(201);
      // A number verified by one account can't be claimed by another.
      expect((await call('POST', '/api/account/phone', customer.cookie, { phone }, {}, nextIp())).json().code).toBe('phone_taken');
    });

    it('lets an admin set any plan, with or without an end date', async () => {
      const res = await call('PUT', `/api/admin/workspaces/${customer.workspace.id}/plan`, admin.pat, { planId: 'business', months: null });
      expect(res.json().data).toMatchObject({ planId: 'business', planExpiresAt: null });
      const list = (await call('GET', `/api/admin/workspaces?q=${encodeURIComponent(customer.user.email)}`, admin.pat)).json().data;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ planId: 'business', owner: { email: customer.user.email, status: 'active' } });
    });

    it('lists users page by page, with search and status filters', async () => {
      const res = await call('GET', `/api/admin/users?q=${encodeURIComponent(`-${stamp}@test.local`)}&pageSize=1&page=1`, admin.pat);
      const page = res.json().data;
      expect(page.items).toHaveLength(1);
      expect(page.total).toBeGreaterThanOrEqual(3);
      expect(page).toMatchObject({ page: 1, pageSize: 1 });
      const found = (await call('GET', `/api/admin/users?q=${encodeURIComponent(customer.user.email)}`, admin.pat)).json().data.items;
      expect(found[0]).toMatchObject({ email: customer.user.email, status: 'active', phoneVerified: true, workspace: { planId: 'business' } });
      expect((await call('GET', '/api/admin/users?status=suspended&q=nobody-at-all', admin.pat)).json().data.total).toBe(0);
    });

    it('stops connecting once a paid plan expires', async () => {
      await sql`update workspaces set plan_expires_at = now() - interval '1 day' where id = ${customer.workspace.id}`;
      const { cookie } = await login(customer.user.email, customer.password);
      const session = await call('POST', '/api/whatsapp-sessions', cookie, { name: 'Expired' });
      const connect = await call('POST', `/api/whatsapp-sessions/${session.json().data.id}/connect`, cookie);
      expect(connect.statusCode).toBe(402);
      expect(connect.json().code).toBe('plan_expired');
      await sql`update workspaces set plan_expires_at = null where id = ${customer.workspace.id}`;
    });

    it("suspends a user: every credential stops, work stops, and the reason is shown", async () => {
      const victim = await register(`suspend-${stamp}@test.local`);
      const pat = (await call('POST', '/api/api-keys', victim.cookie, { name: 'integration' })).json().data.key;
      const session = (await call('POST', '/api/whatsapp-sessions', victim.cookie, { name: 'Shop' })).json().data;
      await sql`update sessions set status = 'connected', desired_state = 'running' where id = ${session.id}`;
      const queued = await call('POST', '/api/send-message', pat, { to: '+201012345678', text: 'later' }, { 'x-session-id': session.id });
      expect(queued.statusCode).toBe(200);

      expect((await call('POST', `/api/admin/users/${victim.user.id}/suspend`, admin.pat, { reason: '' })).statusCode).toBe(422);
      const res = await call('POST', `/api/admin/users/${victim.user.id}/suspend`, admin.pat, { reason: 'Spam reports' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ status: 'suspended', suspendedReason: 'Spam reports' });
      expect((await call('POST', `/api/admin/users/${victim.user.id}/suspend`, admin.pat, { reason: 'again' })).json().code).toBe('already_suspended');

      const refused = await call('GET', '/api/me', pat);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: 'account_suspended', details: { reason: 'Spam reports' } });
      expect((await call('GET', '/api/me', victim.cookie)).statusCode).toBe(401); // dashboard sessions were ended
      expect((await login(victim.user.email, victim.password)).res.json().code).toBe('account_suspended');
      expect((await login(victim.user.email, 'wrong password')).res.statusCode).toBe(422); // no status leak without the password

      const [s] = await sql<{ desired_state: string }[]>`select desired_state from sessions where id = ${session.id}`;
      expect(s!.desired_state).toBe('stopped');
      const [m] = await sql<{ status: string; error: string }[]>`select status, error from messages where id = ${queued.json().data.msgId}`;
      expect(m).toMatchObject({ status: 'failed', error: 'Account suspended' });

      const back = await call('POST', `/api/admin/users/${victim.user.id}/reactivate`, admin.pat);
      expect(back.json().data).toMatchObject({ status: 'active', suspendedReason: null });
      expect((await call('GET', '/api/me', pat)).statusCode).toBe(200);
      expect((await login(victim.user.email, victim.password)).res.statusCode).toBe(200);
      expect((await call('POST', `/api/admin/users/${victim.user.id}/reactivate`, admin.pat)).json().code).toBe('not_suspended');
    });

    it("protects admins and the operator's own account", async () => {
      expect((await call('POST', `/api/admin/users/${adminUserId}/suspend`, admin.pat, { reason: 'x' })).json().code).toBe('self_action');
      const [other] = await db.insert(users).values({ email: `admin2-${stamp}@test.local`, role: 'admin' }).returning();
      const res = await call('POST', `/api/admin/users/${other!.id}/suspend`, admin.pat, { reason: 'x' });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('target_is_admin');
      expect((await call('DELETE', `/api/admin/users/${other!.id}`, admin.pat, { confirmEmail: other!.email })).statusCode).toBe(403);
    });

    it('deletes a user with everything they own, and records it', async () => {
      const doomed = await register(`delete-${stamp}@test.local`);
      const pat = (await call('POST', '/api/api-keys', doomed.cookie, { name: 'integration' })).json().data.key;
      const session = (await call('POST', '/api/whatsapp-sessions', doomed.cookie, { name: 'Shop' })).json().data;
      await call('POST', '/api/templates', doomed.cookie, { name: 'hello', body: 'Hi' });
      await call('POST', '/api/plan-requests', doomed.cookie, { planId: 'pro' });
      await sql`
        insert into messages (workspace_id, session_id, direction, remote_jid, type, content, status)
        values (${doomed.workspace.id}, ${session.id}, 'in', '201000000000@s.whatsapp.net', 'text', '{"text":"hi"}', 'received')`;

      const mismatch = await call('DELETE', `/api/admin/users/${doomed.user.id}`, admin.pat, { confirmEmail: 'someone@else.test' });
      expect(mismatch.statusCode).toBe(422);
      const res = await call('DELETE', `/api/admin/users/${doomed.user.id}`, admin.pat, { confirmEmail: doomed.user.email.toUpperCase() });
      expect(res.statusCode).toBe(200);

      const [left] = await sql<{ users: number; workspaces: number; sessions: number; keys: number; messages: number; templates: number; requests: number; verifications: number }[]>`
        select (select count(*)::int from users where id = ${doomed.user.id}) as users,
          (select count(*)::int from workspaces where id = ${doomed.workspace.id}) as workspaces,
          (select count(*)::int from sessions where workspace_id = ${doomed.workspace.id}) as sessions,
          (select count(*)::int from api_keys where workspace_id = ${doomed.workspace.id}) as keys,
          (select count(*)::int from messages where workspace_id = ${doomed.workspace.id}) as messages,
          (select count(*)::int from message_templates where workspace_id = ${doomed.workspace.id}) as templates,
          (select count(*)::int from plan_requests where workspace_id = ${doomed.workspace.id}) as requests,
          (select count(*)::int from phone_verifications where user_id = ${doomed.user.id}) as verifications`;
      expect(left).toEqual({ users: 0, workspaces: 0, sessions: 0, keys: 0, messages: 0, templates: 0, requests: 0, verifications: 0 });
      expect((await call('GET', '/api/me', pat)).statusCode).toBe(401);
      expect((await call('DELETE', `/api/admin/users/${doomed.user.id}`, admin.pat, { confirmEmail: doomed.user.email })).statusCode).toBe(404);

      const log = (await call('GET', `/api/admin/audit-logs?targetId=${doomed.user.id}`, admin.pat)).json().data.items;
      expect(log[0]).toMatchObject({ action: 'user.delete', actorEmail: adminEmail, targetLabel: doomed.user.email, details: { sessions: 1, templates: 1, messages: 1 } });
    });

    it('keeps an audit trail of operator actions', async () => {
      const page = (await call('GET', '/api/admin/audit-logs?pageSize=50', admin.pat)).json().data;
      const actions = page.items.filter((e: { actorEmail: string }) => e.actorEmail === adminEmail).map((e: { action: string }) => e.action);
      expect(actions).toEqual(expect.arrayContaining(['user.suspend', 'user.reactivate', 'user.delete', 'workspace.plan', 'plan_request.approve']));
    });

    it('never exceeds the session quota under concurrent creates', async () => {
      const racer = await createWorkspace('race-ws', 'trial', new Date(Date.now() + 86_400_000));
      const results = await Promise.all(Array.from({ length: 5 }, (_, i) => call('POST', '/api/whatsapp-sessions', racer.pat, { name: `s${i}` })));
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 402)).toHaveLength(4);
      await sql`delete from workspaces where id = ${racer.id}`;
    });
  });

  describe('broadcasts (ads)', () => {
    const stamp = Date.now() + 3;
    let admin: { id: string; pat: string };
    let customerPat: string;
    let online: string[];
    let offline: string;

    const addSession = async (workspaceId: string, name: string, status: string) => {
      const [row] = await sql<{ id: string }[]>`
        insert into sessions (workspace_id, name, status, desired_state) values (${workspaceId}, ${name}, ${status}, ${status === 'connected' ? 'running' : 'stopped'})
        returning id`;
      return row!.id;
    };

    beforeAll(async () => {
      const [owner] = await db.insert(users).values({ email: `ads-admin-${stamp}@test.local`, role: 'admin' }).returning();
      admin = await createWorkspace('ads-admin-ws', 'unlimited', null);
      await db.update(workspaces).set({ ownerId: owner!.id }).where(eq(workspaces.id, admin.id));
      online = [await addSession(admin.id, 'Line 1', 'connected'), await addSession(admin.id, 'Line 2', 'connected')];
      offline = await addSession(admin.id, 'Line 3', 'disconnected');
      customerPat = ws.a.pat;
    });

    afterAll(async () => {
      await sql`delete from workspaces where id = ${admin.id}`;
      await sql`delete from users where email = ${`ads-admin-${stamp}@test.local`}`;
    });

    const body = (extra: Record<string, unknown> = {}) => ({
      name: 'Autumn sale',
      sessionIds: online,
      rotateEvery: 1,
      pace: 'normal',
      body: 'Hi {{name}}, *30% off* today',
      recipients: [
        { to: '+201000000001', variables: { name: 'Sara' } },
        { to: '+201000000002', variables: { name: 'Omar' } },
        { to: '201000000001', variables: { name: 'Repeat' } },
        { to: '0100', variables: { name: 'Bad' } },
        { to: '+201000000003', variables: { name: 'Mona' } },
      ],
      ...extra,
    });

    it('is gated by the plan feature and the admin flag', async () => {
      // `pro` doesn't bundle campaigns → upgrade required whatever the flag says.
      expect((await call('GET', '/api/broadcasts', customerPat)).statusCode).toBe(402);
      expect((await call('GET', '/api/broadcasts', customerPat)).json().code).toBe('feature_not_in_plan');
      // An eligible plan sees "coming soon" until the admin flips the flag on.
      const plus = await createWorkspace('ads-plus-ws', 'plus', null);
      expect((await call('GET', '/api/broadcasts', plus.pat)).statusCode).toBe(403);
      expect((await call('GET', '/api/broadcasts', plus.pat)).json().code).toBe('feature_coming_soon');
      expect((await call('PUT', '/api/admin/features', plus.pat, { ads: true })).statusCode).toBe(403);
      expect((await call('PUT', '/api/admin/features', admin.pat, { ads: true })).json().data).toEqual({ ads: true });
      expect((await call('GET', '/api/broadcasts', plus.pat)).statusCode).toBe(200);
      // The /me response advertises the flag to the dashboard.
      expect((await call('GET', '/api/me', plus.pat)).json().data.features).toEqual({ ads: true });
      await call('PUT', '/api/admin/features', admin.pat, { ads: false });
      await sql`delete from workspaces where id = ${plus.id}`;
    });

    it('refuses sessions that are offline or not the admin’s own', async () => {
      const res = await call('POST', '/api/broadcasts', admin.pat, body({ sessionIds: [online[0], offline] }));
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('session_not_connected');
      const foreign = await addSession(ws.a.id, 'Not yours', 'connected');
      expect((await call('POST', '/api/broadcasts', admin.pat, body({ sessionIds: [foreign] }))).statusCode).toBe(404);
      await sql`delete from sessions where id = ${foreign}`;
    });

    it('queues one paced message per recipient, rotating between sessions', async () => {
      const res = await call('POST', '/api/broadcasts', admin.pat, body());
      expect(res.statusCode, res.body).toBe(201);
      const created = res.json().data;
      expect(created).toMatchObject({ recipients: 3, skippedCount: 2 });
      expect(created.skipped.map((s: { reason: string }) => s.reason).sort()).toEqual(['duplicate', 'invalid_number']);

      const rows = await sql<{ session_id: string; remote_jid: string; content: { text: string }; not_before: Date }[]>`
        select session_id, remote_jid, content, not_before from messages where broadcast_id = ${created.id} order by id`;
      expect(rows.map((r) => [r.session_id, r.remote_jid, r.content.text])).toEqual([
        [online[0], '201000000001@s.whatsapp.net', 'Hi Sara, *30% off* today'],
        [online[1], '201000000002@s.whatsapp.net', 'Hi Omar, *30% off* today'],
        [online[0], '201000000003@s.whatsapp.net', 'Hi Mona, *30% off* today'],
      ]);
      // Line 1's second message waits 15–35s after its first (`normal`); the worker's queue holds it until then.
      const gap = rows[2]!.not_before.getTime() - rows[0]!.not_before.getTime();
      expect(gap).toBeGreaterThanOrEqual(15_000);
      expect(gap).toBeLessThanOrEqual(35_000);
      expect((await claimNextOutbound(sql, online[0]!))?.remote_jid).toBe('201000000001@s.whatsapp.net');
      expect(await claimNextOutbound(sql, online[0]!)).toBeNull();

      const detail = (await call('GET', `/api/broadcasts/${created.id}`, admin.pat)).json().data;
      expect(detail).toMatchObject({ name: 'Autumn sale', state: 'running', recipients: 3, stats: { queued: 2, sending: 1 } });
      expect(detail.sessions.map((s: { id: string; total: number }) => [s.id, s.total])).toEqual([
        [online[0], 2],
        [online[1], 1],
      ]);
      expect(detail.recent[0]).toMatchObject({ phone: '+201000000001', status: 'sending' });

      const cancelled = (await call('POST', `/api/broadcasts/${created.id}/cancel`, admin.pat)).json().data;
      expect(cancelled).toMatchObject({ cancelled: 2, state: 'cancelled', stats: { queued: 0, failed: 2, sending: 1 } });
      const list = (await call('GET', '/api/broadcasts', admin.pat)).json().data;
      expect(list[0]).toMatchObject({ id: created.id, state: 'cancelled' });
    });

    it('sends a card with its buttons poll, counted once per recipient', async () => {
      const res = await call(
        'POST',
        '/api/broadcasts',
        admin.pat,
        body({ pace: 'fast', imageUrl: 'https://x.test/a.jpg', buttons: ['Yes', 'No'], buttonsTitle: 'Interested?', recipients: [{ to: '+201000000009', variables: { name: 'Ali' } }] }),
      );
      expect(res.statusCode, res.body).toBe(201);
      const rows = await sql<{ type: string; not_before: Date | null }[]>`select type, not_before from messages where broadcast_id = ${res.json().data.id} order by id`;
      expect(rows.map((r) => r.type)).toEqual(['image', 'poll']);
      // Even `fast` is scheduled, and the poll goes out with its card.
      expect(rows[0]!.not_before).not.toBeNull();
      expect(rows[1]!.not_before).toEqual(rows[0]!.not_before);
      const detail = (await call('GET', `/api/broadcasts/${res.json().data.id}`, admin.pat)).json().data;
      expect(detail.stats.queued).toBe(1);
      await call('POST', `/api/broadcasts/${res.json().data.id}/cancel`, admin.pat);
    });

    it('keeps to the sending hours and reports the schedule', async () => {
      const window = { from: 9, to: 21, timeZone: 'Asia/Riyadh' };
      const res = await call('POST', '/api/broadcasts', admin.pat, body({ window }));
      expect(res.statusCode, res.body).toBe(201);
      const rows = await sql<{ local: number }[]>`
        select extract(hour from not_before at time zone 'Asia/Riyadh')::int as local from messages where broadcast_id = ${res.json().data.id}`;
      expect(rows.every((r) => r.local >= 9 && r.local < 21)).toBe(true);
      const detail = (await call('GET', `/api/broadcasts/${res.json().data.id}`, admin.pat)).json().data;
      expect(detail).toMatchObject({ window, finishesAt: res.json().data.finishesAt });
      expect(detail.nextAt).not.toBeNull();
      expect(detail.sessions.every((s: { shield: unknown; restingUntil: unknown }) => s.shield === null && s.restingUntil === null)).toBe(true);
      await call('POST', `/api/broadcasts/${res.json().data.id}/cancel`, admin.pat);

      const bad = await call('POST', '/api/broadcasts', admin.pat, body({ window: { from: 21, to: 9, timeZone: 'Mars/Olympus' } }));
      expect(bad.statusCode).toBe(422);
    });

    it('skips recipients who replied stop', async () => {
      await sql`insert into opt_outs (workspace_id, phone) values (${admin.id}, '+201000000002')`;
      const res = await call('POST', '/api/broadcasts', admin.pat, body());
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().data).toMatchObject({ recipients: 2, skippedCount: 3 });
      expect(res.json().data.skipped).toContainEqual({ to: '+201000000002', reason: 'opted_out' });
      await call('POST', `/api/broadcasts/${res.json().data.id}/cancel`, admin.pat);
      await sql`delete from opt_outs where workspace_id = ${admin.id}`;
    });

    it('rests a number for a day after WhatsApp restricted it', async () => {
      await sql`update sessions set restricted_at = now() - interval '2 hours' where id = ${online[1]!}`;
      const res = await call('POST', '/api/broadcasts', admin.pat, body());
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('number_resting');
      const numbers = (await call('GET', '/api/broadcasts/numbers', admin.pat)).json().data as { id: string; restingUntil: string | null }[];
      expect(numbers.find((n) => n.id === online[1])!.restingUntil).not.toBeNull();
      expect(numbers.find((n) => n.id === online[0])!.restingUntil).toBeNull();
      // A day later it may send again.
      await sql`update sessions set restricted_at = now() - interval '25 hours' where id = ${online[1]!}`;
      const ok = await call('POST', '/api/broadcasts', admin.pat, body());
      expect(ok.statusCode, ok.body).toBe(201);
      await call('POST', `/api/broadcasts/${ok.json().data.id}/cancel`, admin.pat);
    });

    it('reports each number’s campaign load for the planner', async () => {
      const res = await call('POST', '/api/broadcasts', admin.pat, body());
      const numbers = (await call('GET', '/api/broadcasts/numbers', admin.pat)).json().data as { id: string; queued: number; sent24h: number; history: number[] }[];
      const line1 = numbers.find((n) => n.id === online[0])!;
      expect(line1).toMatchObject({ queued: 2, sent24h: 0 });
      expect(line1.history).toHaveLength(2);
      await call('POST', `/api/broadcasts/${res.json().data.id}/cancel`, admin.pat);
    });
  });

  it('publishes an OpenAPI document', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().paths)).toEqual(expect.arrayContaining(['/api/send-message', '/api/whatsapp-sessions/{id}/connect', '/api/auth/register/verify']));
  });
});
