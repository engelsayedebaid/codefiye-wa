import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { apiKeys, createDb, createListener, type Db, runMigrations, type Sql, users, workspaces } from '@wa/db';
import { listedPriceUsd, planPriceEgp } from '@wa/shared';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { createAuth } from '../src/lib/auth';
import { EventBus } from '../src/lib/events';
import { generateKey } from '../src/lib/keys';
import { otpKey } from '../src/lib/otp';
import { getPaymentSettings } from '../src/lib/payments';
import { getPlanPricing } from '../src/lib/plan-pricing';
import { createThrottle } from '../src/lib/throttle';
import { WorkerClient } from '../src/lib/workers';
import { saveXPaySettings } from '../src/lib/xpay';

const url = process.env.TEST_DATABASE_URL;
const WEBHOOK_SECRET = 'whsec_flowtest';
const WEBHOOK = '/api/payments/xpay/webhook';

type FakeSession = { id: string; object: 'checkout.session'; status: 'open' | 'complete' | 'expired'; paymentStatus: 'paid' | 'unpaid'; amountTotal: number; currency: string; paymentIntentId: string | null; isExpired: boolean };

/**
 * End to end against the test database, with XPay replaced by an in-memory fake behind `fetch`:
 * checkout creation, webhook signatures and replays, duplicate and concurrent deliveries, and plan
 * activation only for a session XPay itself reports as paid.
 */
describe.skipIf(!url)('xpay payments (integration)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sql: Sql;
  let db: Db;
  let end: () => Promise<unknown>;
  let events: EventBus;
  let ws: { id: string; pat: string; userId: string };

  // --- the fake XPay ---------------------------------------------------------------------------
  const sessions = new Map<string, FakeSession>();
  const created: { body: Record<string, unknown>; idempotencyKey: string | null }[] = [];
  let xpayDown = false;
  const realFetch = globalThis.fetch;
  const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith('https://api.xpay.app/')) return realFetch(input, init);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (xpayDown) return json(500, { error: { type: 'api_error', code: 'internal', message: 'boom' } });
    const headers = new Headers(init?.headers);
    if (headers.get('authorization') !== 'Bearer sk_test_flow') return json(401, { error: { code: 'unauthorized', message: 'bad key' } });
    const path = new URL(href).pathname;
    if (init?.method === 'POST' && path === '/checkout/sessions') {
      const body = JSON.parse(String(init.body)) as { lineItems: { priceData: { unitAmount: number; currency: string } }[] };
      created.push({ body: body as never, idempotencyKey: headers.get('idempotency-key') });
      const id = `cs_test_${randomBytes(6).toString('hex')}`;
      const s: FakeSession = { id, object: 'checkout.session', status: 'open', paymentStatus: 'unpaid', amountTotal: body.lineItems[0]!.priceData.unitAmount, currency: 'EGP', paymentIntentId: null, isExpired: false };
      sessions.set(id, s);
      return json(200, { ...s, clientSecret: `${id}_secret_x` });
    }
    const match = /^\/checkout\/sessions\/([^/]+)$/.exec(path);
    if (match && (!init?.method || init.method === 'GET')) {
      const s = sessions.get(decodeURIComponent(match[1]!));
      return s ? json(200, s) : json(404, { error: { code: 'resource_missing', message: 'No such session' } });
    }
    return json(404, { error: { code: 'not_found', message: path } });
  });

  // --- helpers ---------------------------------------------------------------------------------
  const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
    app.inject({ method, url: path, headers: { authorization: `Bearer ${ws.pat}` }, ...(body !== undefined ? { payload: body as object } : {}) });
  const signature = (raw: string, t = Math.floor(Date.now() / 1000), secret = WEBHOOK_SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
  const deliver = (event: { id?: string; type: string; object: Record<string, unknown> }, opts: { t?: number; secret?: string; header?: string } = {}) => {
    const raw = JSON.stringify({ id: event.id ?? `evt_${randomBytes(6).toString('hex')}`, type: event.type, data: { object: event.object } });
    return app.inject({
      method: 'POST',
      url: WEBHOOK,
      headers: { 'content-type': 'application/json', 'xpay-signature': opts.header ?? signature(raw, opts.t, opts.secret) },
      payload: raw,
    });
  };
  const workspace = async () => (await sql<{ plan_id: string; plan_expires_at: Date | null }[]>`select plan_id, plan_expires_at from workspaces where id = ${ws.id}`)[0]!;
  const approvedXPay = async () => (await sql<{ n: number }[]>`select count(*)::int as n from plan_requests where workspace_id = ${ws.id} and status = 'approved' and payment->>'method' = 'xpay'`)[0]!.n;
  const paymentRow = async (id: string) => (await sql<{ status: string; error: string | null; plan_request_id: string | null }[]>`select status, error, plan_request_id from payments where id = ${id}`)[0]!;
  const openCheckout = async (planId = 'basic', months = 1) => {
    const res = await call('POST', '/api/payments/xpay', { planId, months, locale: 'en' });
    expect(res.statusCode, res.body).toBe(201);
    const { payment, clientSecret } = res.json().data as { payment: { id: string; amountCents: number; status: string }; clientSecret: string };
    const [row] = await sql<{ session_id: string }[]>`select session_id from payments where id = ${payment.id}`;
    return { payment, clientSecret, session: sessions.get(row!.session_id)! };
  };
  // An expired Pro plan: Pro's rate limit leaves room for the whole suite (Trial allows 10 calls a
  // minute), and every purchase below shows as a plan change.
  const BASE = 'pro';
  const resetWorkspace = () => sql`update workspaces set plan_id = ${BASE}, plan_expires_at = now() - interval '1 day', trial_ends_at = null where id = ${ws.id}`;

  beforeAll(async () => {
    await runMigrations(url!);
    ({ sql, db, end } = createDb(url!, { max: 5 }));
    const logger = pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' });
    events = new EventBus({ createListener: () => createListener(url!), sql, logger });
    await events.start();
    const encryptionKey = randomBytes(32);
    app = await buildApp(
      {
        sql,
        db,
        auth: createAuth(sql),
        events,
        workers: new WorkerClient(sql, 'x'.repeat(16)),
        throttle: createThrottle(sql),
        otp: { key: otpKey(undefined, 'x'.repeat(16)), sender: null, dailyLimit: 10 },
        encryptionKey,
      },
      { logger, corsOrigins: [], publicUrl: 'http://test' },
    );
    const [user] = await db
      .insert(users)
      .values({ email: `xpay-flow-${randomInt(1e9)}@test.local`, name: 'Pay Er', phone: `+2010${String(randomInt(1e8)).padStart(8, '0')}`, phoneVerifiedAt: new Date() })
      .returning();
    const [w] = await db.insert(workspaces).values({ name: 'xpay-flow', ownerId: user!.id, planId: BASE, planExpiresAt: new Date(Date.now() - 86_400_000) }).returning();
    const key = generateKey('pat');
    await db.insert(apiKeys).values({ workspaceId: w!.id, name: 'test', keyHash: key.hash, prefix: key.prefix });
    ws = { id: w!.id, pat: key.key, userId: user!.id };
    await saveXPaySettings(sql, encryptionKey, { enabled: true, publishableKey: 'pk_test_flow', methods: ['card'], secretKey: 'sk_test_flow', webhookSecret: WEBHOOK_SECRET });
    vi.stubGlobal('fetch', fakeFetch);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (sql) {
      await sql`delete from settings where key = 'xpay'`;
      if (ws) {
        await sql`delete from workspaces where id = ${ws.id}`;
        await sql`delete from users where id = ${ws.userId}`;
      }
    }
    await app?.close();
    await events?.stop();
    await end?.();
  });

  beforeEach(() => {
    xpayDown = false;
  });

  it('opens a checkout priced from the plan, with an idempotency key and our own return link', async () => {
    const config = await call('GET', '/api/payments/xpay');
    expect(config.json().data).toEqual({ enabled: true, publishableKey: 'pk_test_flow' });

    const [settings, pricing] = await Promise.all([getPaymentSettings(sql), getPlanPricing(sql)]);
    const expectedCents = planPriceEgp(listedPriceUsd('basic', pricing), 3, settings.egpPerUsd)! * 100;
    const { payment, clientSecret, session } = await openCheckout('basic', 3);
    expect(payment.status).toBe('pending');
    expect(payment.amountCents).toBe(expectedCents);
    expect(clientSecret).toBe(`${session.id}_secret_x`);
    const sent = created.at(-1)!;
    expect(sent.idempotencyKey).toBe(payment.id);
    expect(sent.body).toMatchObject({
      uiMode: 'custom',
      currency: 'EGP',
      paymentMethodTypes: ['card'],
      metadata: { paymentId: payment.id, workspaceId: ws.id },
      afterCompletion: { type: 'redirect', redirect: { url: `http://test/subscription?payment=${payment.id}` } },
    });
    expect((sent.body.lineItems as { priceData: { unitAmount: number } }[])[0]!.priceData.unitAmount).toBe(expectedCents);
    // Opening a checkout changes nothing yet.
    expect((await workspace()).plan_id).toBe(BASE);
  });

  it('refuses manual transfers for priced plans while XPay is on', async () => {
    const res = await call('POST', '/api/plan-requests', { planId: 'basic', payment: { method: 'vodafone_cash', senderPhone: '01012345678' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('pay_online');
  });

  it('rejects unsigned, wrongly signed, tampered and replayed webhooks', async () => {
    const { session, payment } = await openCheckout();
    session.status = 'complete';
    session.paymentStatus = 'paid';
    const object = { ...session };
    expect((await deliver({ type: 'checkout.session.completed', object }, { header: '' })).statusCode).toBe(400);
    expect((await deliver({ type: 'checkout.session.completed', object }, { header: 'nonsense' })).statusCode).toBe(400);
    expect((await deliver({ type: 'checkout.session.completed', object }, { secret: 'whsec_wrong' })).statusCode).toBe(400);
    expect((await deliver({ type: 'checkout.session.completed', object }, { t: Math.floor(Date.now() / 1000) - 301 })).statusCode).toBe(400);
    expect((await deliver({ type: 'checkout.session.completed', object }, { t: Math.floor(Date.now() / 1000) + 301 })).statusCode).toBe(400);
    // A body changed after signing.
    const raw = JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object } });
    const tampered = await app.inject({ method: 'POST', url: WEBHOOK, headers: { 'content-type': 'application/json', 'xpay-signature': signature(raw) }, payload: raw.replace('"paid"', '"paid" ') });
    expect(tampered.statusCode).toBe(400);
    expect((await paymentRow(payment.id)).status).toBe('pending');
    expect((await workspace()).plan_id).toBe(BASE);
    expect(await approvedXPay()).toBe(0);
    session.status = 'expired';
    session.paymentStatus = 'unpaid';
  });

  it('never activates on the payload alone: the state comes from XPay', async () => {
    const { session, payment } = await openCheckout();
    // Signed event claiming "paid" while XPay still says unpaid.
    const res = await deliver({ type: 'checkout.session.completed', object: { ...session, status: 'complete', paymentStatus: 'paid' } });
    expect(res.statusCode).toBe(200);
    expect((await paymentRow(payment.id)).status).toBe('pending');
    expect((await workspace()).plan_id).toBe(BASE);
    // And while XPay can't be reached, the event is refused so XPay delivers it again.
    session.status = 'complete';
    session.paymentStatus = 'paid';
    xpayDown = true;
    expect((await deliver({ type: 'checkout.session.completed', object: session })).statusCode).toBe(503);
    expect((await paymentRow(payment.id)).status).toBe('pending');
    expect((await workspace()).plan_id).toBe(BASE);
    session.status = 'expired';
    session.paymentStatus = 'unpaid';
    session.isExpired = true;
    xpayDown = false;
    await deliver({ type: 'checkout.session.expired', object: session });
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'failed', error: 'expired' });
  });

  it('activates once for a paid session, however many times and however concurrently it is reported', async () => {
    await resetWorkspace();
    const before = await approvedXPay();
    const { session, payment } = await openCheckout('basic', 1);
    expect((await call('POST', `/api/payments/${payment.id}/check`)).json().data.status).toBe('pending');

    session.status = 'complete';
    session.paymentStatus = 'paid';
    session.paymentIntentId = 'pi_test_1';
    const event = { id: 'evt_dup_1', type: 'checkout.session.completed', object: session };
    const first = await deliver(event);
    expect(first.statusCode).toBe(200);
    const paid = await paymentRow(payment.id);
    expect(paid.status).toBe('paid');
    expect(paid.plan_request_id).not.toBeNull();
    const activated = await workspace();
    expect(activated.plan_id).toBe('basic');
    const days = (activated.plan_expires_at!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);

    // Redeliveries (same event, new event ids, concurrently) and the dashboard's check: no second activation.
    const again = await Promise.all([deliver(event), deliver(event), deliver({ ...event, id: 'evt_dup_2' }), call('POST', `/api/payments/${payment.id}/check`), deliver(event)]);
    for (const res of again) expect(res.statusCode).toBe(200);
    expect(await approvedXPay()).toBe(before + 1);
    expect((await workspace()).plan_expires_at!.getTime()).toBe(activated.plan_expires_at!.getTime());
    const [request] = await sql<{ payment: { method: string; sessionId: string; paymentId: string } }[]>`select payment from plan_requests where id = ${paid.plan_request_id}`;
    expect(request!.payment).toMatchObject({ method: 'xpay', sessionId: session.id, paymentId: 'pi_test_1' });
  });

  it('settles from the dashboard check when the webhook is late', async () => {
    await resetWorkspace();
    const { session, payment } = await openCheckout('plus', 1);
    session.status = 'complete';
    session.paymentStatus = 'paid';
    const res = await call('POST', `/api/payments/${payment.id}/check`);
    expect(res.json().data.status).toBe('paid');
    expect((await workspace()).plan_id).toBe('plus');
  });

  it('a failed or unpaid payment never activates, and a later genuine success still counts', async () => {
    await resetWorkspace();
    const before = await approvedXPay();
    const { session, payment } = await openCheckout('basic', 1);
    // Fawry reference: complete but unpaid.
    session.status = 'complete';
    expect((await deliver({ type: 'checkout.session.completed', object: session })).statusCode).toBe(200);
    expect((await paymentRow(payment.id)).status).toBe('pending');
    // The reference was never paid.
    expect((await deliver({ type: 'checkout.session.async_payment_failed', object: session })).statusCode).toBe(200);
    expect((await paymentRow(payment.id)).status).toBe('failed');
    expect((await workspace()).plan_id).toBe(BASE);
    expect(await approvedXPay()).toBe(before);
    // XPay later reports it paid after all: the money arrived, so the plan turns on.
    session.paymentStatus = 'paid';
    await deliver({ type: 'checkout.session.async_payment_succeeded', object: session });
    expect((await paymentRow(payment.id)).status).toBe('paid');
    expect((await workspace()).plan_id).toBe('basic');
  });

  it('refuses a paid session for less than the price or in another currency', async () => {
    await resetWorkspace();
    const short = await openCheckout('basic', 1);
    Object.assign(short.session, { status: 'complete', paymentStatus: 'paid', amountTotal: short.payment.amountCents - 100 });
    await deliver({ type: 'checkout.session.completed', object: short.session });
    expect(await paymentRow(short.payment.id)).toMatchObject({ status: 'failed', error: 'amount_mismatch' });

    const usd = await openCheckout('basic', 1);
    Object.assign(usd.session, { status: 'complete', paymentStatus: 'paid', currency: 'USD' });
    await deliver({ type: 'checkout.session.completed', object: usd.session });
    expect(await paymentRow(usd.payment.id)).toMatchObject({ status: 'failed', error: 'amount_mismatch' });

    // A customer fee on top is fine.
    const fee = await openCheckout('basic', 1);
    Object.assign(fee.session, { status: 'complete', paymentStatus: 'paid', amountTotal: fee.payment.amountCents + 1_500 });
    await deliver({ type: 'checkout.session.completed', object: fee.session });
    expect((await paymentRow(fee.payment.id)).status).toBe('paid');
    expect((await workspace()).plan_id).toBe('basic');
  });

  it('ignores sessions that are not ours and events that are not checkout sessions', async () => {
    sessions.set('cs_test_foreign', { id: 'cs_test_foreign', object: 'checkout.session', status: 'complete', paymentStatus: 'paid', amountTotal: 1, currency: 'EGP', paymentIntentId: null, isExpired: false });
    expect((await deliver({ type: 'checkout.session.completed', object: { id: 'cs_test_foreign' } })).statusCode).toBe(200);
    expect((await deliver({ type: 'refund.created', object: { id: 're_1' } })).statusCode).toBe(200);
  });

  it('keeps payments private to their workspace', async () => {
    const other = await call('GET', '/api/payments/00000000-0000-4000-8000-000000000000');
    expect(other.statusCode).toBe(404);
  });
});
