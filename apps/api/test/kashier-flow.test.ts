import { randomBytes, randomInt } from 'node:crypto';
import { apiKeys, createDb, createListener, type Db, runMigrations, type Sql, users, workspaces } from '@wa/db';
import { type KashierMode, listedPriceUsd, planPriceEgp } from '@wa/shared';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { createAuth } from '../src/lib/auth';
import { EventBus } from '../src/lib/events';
import { kashierSignature, saveKashierSettings } from '../src/lib/kashier';
import { generateKey } from '../src/lib/keys';
import { otpKey } from '../src/lib/otp';
import { getEgpQuote } from '../src/lib/currency';
import { getPlanPricing } from '../src/lib/plan-pricing';
import { createThrottle } from '../src/lib/throttle';
import { WorkerClient } from '../src/lib/workers';

const url = process.env.TEST_DATABASE_URL;
const CREDS = {
  test: { merchantId: 'MID-TEST-1', secretKey: 'secret-test-flow-key', apiKey: 'api-test-flow-key' },
  live: { merchantId: 'MID-LIVE-1', secretKey: 'secret-live-flow-key', apiKey: 'api-live-flow-key' },
} as const;
const HOSTS = { test: 'https://test-api.kashier.io', live: 'https://api.kashier.io' } as const;
const hook = (mode: KashierMode) => `/api/payments/kashier/webhook/${mode}`;

type FakeSession = { id: string; mode: KashierMode; merchantId: string; order: string; amount: string; currency: string; status: string; method: string | null };

/**
 * End to end against the isolated test database, with Kashier replaced by an in-memory fake behind
 * `fetch` (no real Kashier call is made: Sandbox behaviour still needs checking with real test keys).
 */
describe.skipIf(!url)('kashier payments (integration)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sql: Sql;
  let db: Db;
  let end: () => Promise<unknown>;
  let events: EventBus;
  let encryptionKey: Buffer;
  let customer: { id: string; pat: string; userId: string };
  let admin: { id: string; pat: string; userId: string };

  // --- the fake Kashier ------------------------------------------------------------------------
  const sessions = new Map<string, FakeSession>();
  const created: { mode: KashierMode; body: Record<string, unknown>; headers: Headers }[] = [];
  // `GET /v2/merchants/{mid}/paymentMethods` as Kashier really answers it (its test API, 2026-11-01), not the docs' `{ card: true }` example.
  const accountShape = (methods: string[], bnpl: string[] = []) => ({ acceptedPaymentMethods: methods, acceptedBNPLMethods: bnpl, acceptedCardProviders: ['mpgs'], acceptedWalletProviders: ['upg', 'vodafoneCash'], acceptedCardWalletProviders: [], operations: {} });
  const LIVE_FULL = () => accountShape(['card', 'wallet', 'installments', 'instapay', 'basata'], ['valu', 'octo', 'souhoola', 'aman', 'contact', 'tru']);
  const accountMethods: Record<KashierMode, unknown> = { test: accountShape(['card', 'wallet', 'installments', 'instapay', 'basata'], ['valu', 'souhoola']), live: LIVE_FULL() };
  let outage: 'none' | 'http500' | 'network' = 'none';
  const realFetch = globalThis.fetch;
  const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const mode = (Object.keys(HOSTS) as KashierMode[]).find((m) => href.startsWith(`${HOSTS[m]}/`));
    if (!mode) return realFetch(input, init);
    if (outage === 'network') throw new TypeError('fetch failed');
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (outage === 'http500') return json(500, { status: 'FAILURE', messages: { en: 'boom' } });
    const headers = new Headers(init?.headers);
    const path = new URL(href).pathname;
    const methodsMatch = /^\/v2\/merchants\/([^/]+)\/paymentMethods$/.exec(path);
    if (methodsMatch) return decodeURIComponent(methodsMatch[1]!) === CREDS[mode].merchantId ? json(200, accountMethods[mode]) : json(400, { message: 'Merchant not found' });
    // Everything else needs this host's own Secret Key (a test key on the live host is refused).
    if (headers.get('authorization') !== CREDS[mode].secretKey) return json(401, { status: 'FAILURE', messages: { en: 'Unauthorized' } });
    if (path === '/v2/merchants/validate-credentials') return json(200, { status: 'SUCCESS' });
    if (init?.method === 'POST' && path === '/v3/payment/sessions') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      created.push({ mode, body, headers });
      const id = randomBytes(12).toString('hex');
      const s: FakeSession = { id, mode, merchantId: String(body.merchantId), order: String(body.order), amount: String(body.amount), currency: String(body.currency), status: 'CREATED', method: null };
      sessions.set(id, s);
      return json(200, { _id: id, status: 'CREATED', merchantId: s.merchantId, paymentParams: { amount: s.amount, currency: s.currency, order: s.order }, sessionUrl: `https://payments.kashier.io/session/${id}?mode=${mode}` });
    }
    const result = /^\/v3\/payment\/sessions\/([^/]+)\/payment$/.exec(path);
    if (result) {
      const s = sessions.get(decodeURIComponent(result[1]!));
      if (!s || s.mode !== mode) return json(404, { status: 'FAILURE', messages: { en: 'Payment session not found' } });
      return json(200, { message: 'success', data: { sessionId: s.id, status: s.status, merchantId: s.merchantId, merchantOrderId: s.order, amount: s.amount, currency: s.currency, method: s.method ?? 'card', orderId: s.status === 'CREATED' ? 'NA' : `KO-${s.id.slice(0, 6)}` } });
    }
    return json(404, { status: 'FAILURE', messages: { en: path } });
  });

  // --- helpers ---------------------------------------------------------------------------------
  const call = (who: { pat: string }, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) =>
    app.inject({ method, url: path, headers: { authorization: `Bearer ${who.pat}` }, ...(body !== undefined ? { payload: body as object } : {}) });
  /** A Kashier webhook for an order, signed with `apiKey` (that mode's by default). */
  const deliver = (mode: KashierMode, data: { order: string; status: string; transactionId?: string; amount?: number }, opts: { event?: string; apiKey?: string; signature?: string } = {}) => {
    const payload = {
      amount: data.amount ?? 1,
      channel: 'online | e-commerce',
      currency: 'EGP',
      kashierOrderId: randomBytes(4).toString('hex'),
      merchantOrderId: data.order,
      method: 'card',
      orderReference: `TEST-ORD-${randomInt(1e6)}`,
      status: data.status,
      transactionId: data.transactionId ?? `TX-${randomInt(1e9)}`,
      transactionResponseCode: '00',
    };
    const signed = { ...payload, signatureKeys: Object.keys(payload) };
    return app.inject({
      method: 'POST',
      url: hook(mode),
      headers: { 'content-type': 'application/json', 'x-kashier-signature': opts.signature ?? kashierSignature(signed, opts.apiKey ?? CREDS[mode].apiKey)! },
      payload: { event: opts.event ?? 'pay', data: signed },
    });
  };
  const planOf = async (ws: { id: string }) => (await sql<{ plan_id: string; plan_expires_at: Date | null }[]>`select plan_id, plan_expires_at from workspaces where id = ${ws.id}`)[0]!;
  const approvedKashier = async (ws: { id: string }) =>
    (await sql<{ n: number }[]>`select count(*)::int as n from plan_requests where workspace_id = ${ws.id} and status = 'approved' and payment->>'method' = 'kashier'`)[0]!.n;
  const paymentRow = async (id: string) =>
    (await sql<{ status: string; error: string | null; plan_request_id: string | null; mode: string; provider: string; session_id: string }[]>`select status, error, plan_request_id, mode, provider, session_id from payments where id = ${id}`)[0]!;
  const openCheckout = async (who = customer, planId = 'basic', months = 1, extra: Record<string, unknown> = {}) => {
    const res = await call(who, 'POST', '/api/payments/kashier', { planId, months, locale: 'ar', ...extra });
    expect(res.statusCode, res.body).toBe(201);
    const { payment, sessionUrl } = res.json().data as { payment: { id: string; amountCents: number; status: string; mode: KashierMode; provider: string }; sessionUrl: string };
    const row = await paymentRow(payment.id);
    return { payment, sessionUrl, session: sessions.get(row.session_id)! };
  };
  // An expired Pro plan: Pro's rate limit leaves room for the suite, and every purchase shows as a plan change.
  const BASE = 'pro';
  const resetPlan = (ws: { id: string }) => sql`update workspaces set plan_id = ${BASE}, plan_expires_at = now() - interval '1 day', trial_ends_at = null where id = ${ws.id}`;
  /** Live mode on with complete live credentials (test ones stored too), and the methods the live account has. */
  const configure = async (over: Partial<Parameters<typeof saveKashierSettings>[2]> = {}) => {
    await saveKashierSettings(sql, encryptionKey, { enabled: true, mode: 'live', methods: ['card', 'wallet', 'valu'], test: { ...CREDS.test }, live: { ...CREDS.live }, ...over });
  };
  const makeAccount = async (name: string, role: 'user' | 'admin') => {
    const [user] = await db
      .insert(users)
      .values({ email: `kashier-flow-${name}-${randomInt(1e9)}@test.local`, name: 'Pay Er', role, phone: `+2010${String(randomInt(1e8)).padStart(8, '0')}`, phoneVerifiedAt: new Date() })
      .returning();
    const [w] = await db.insert(workspaces).values({ name: `kashier-flow-${name}`, ownerId: user!.id, planId: BASE, planExpiresAt: new Date(Date.now() - 86_400_000) }).returning();
    const key = generateKey('pat');
    await db.insert(apiKeys).values({ workspaceId: w!.id, name: 'test', keyHash: key.hash, prefix: key.prefix });
    return { id: w!.id, pat: key.key, userId: user!.id };
  };

  beforeAll(async () => {
    await runMigrations(url!);
    ({ sql, db, end } = createDb(url!, { max: 5 }));
    const logger = pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' });
    events = new EventBus({ createListener: () => createListener(url!), sql, logger });
    await events.start();
    encryptionKey = randomBytes(32);
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
      { logger, corsOrigins: [], publicUrl: 'https://wa.codefiye.com' },
    );
    customer = await makeAccount('customer', 'user');
    admin = await makeAccount('admin', 'admin');
    await configure();
    vi.stubGlobal('fetch', fakeFetch);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (sql) {
      await sql`delete from settings where key = 'kashier'`;
      await sql`delete from payment_events where provider = 'kashier' and object_id in (select id::text from payments where workspace_id in (${customer?.id ?? null}, ${admin?.id ?? null}))`;
      for (const a of [customer, admin]) {
        if (!a) continue;
        await sql`delete from audit_logs where actor_id = ${a.userId} or target_id in (select id::text from payments where workspace_id = ${a.id})`;
        await sql`delete from workspaces where id = ${a.id}`;
        await sql`delete from users where id = ${a.userId}`;
      }
    }
    await app?.close();
    await events?.stop();
    await end?.();
  });

  // Every test starts from live mode with complete credentials, so one test failing half-way never leaks into the next.
  beforeEach(async () => {
    outage = 'none';
    accountMethods.live = LIVE_FULL();
    await configure();
  });

  // --- checkout ----------------------------------------------------------------------------------

  it('opens a live session priced on the server, for our order, with our webhook and return link', async () => {
    expect((await call(customer, 'GET', '/api/payments/kashier')).json().data).toEqual({ enabled: true, mode: 'live', methods: ['card', 'wallet', 'valu'] });
    const [quote, pricing] = await Promise.all([getEgpQuote(sql), getPlanPricing(sql)]);
    const expectedCents = planPriceEgp(listedPriceUsd('basic', pricing), 3, quote.effective)! * 100;
    // A price or discount sent by the browser is ignored.
    const { payment, sessionUrl, session } = await openCheckout(customer, 'basic', 3, { amount: 1, amountCents: 100, discount: 99 });
    expect(payment).toMatchObject({ status: 'pending', mode: 'live', provider: 'kashier', amountCents: expectedCents });
    expect(sessionUrl).toBe(`https://payments.kashier.io/session/${session.id}?mode=live`);
    const sent = created.at(-1)!;
    expect(sent.mode).toBe('live');
    expect(sent.headers.get('authorization')).toBe(CREDS.live.secretKey);
    expect(sent.headers.get('api-key')).toBe(CREDS.live.apiKey);
    expect(sent.body).toMatchObject({
      amount: (expectedCents / 100).toFixed(2),
      currency: 'EGP',
      order: payment.id,
      merchantId: CREDS.live.merchantId,
      merchantRedirect: `https://wa.codefiye.com/subscription?payment=${payment.id}`,
      serverWebhook: 'https://wa.codefiye.com/api/payments/kashier/webhook/live',
      display: 'ar',
      allowedMethods: 'card,wallet,bnpl[valu]',
      metaData: { paymentId: payment.id, workspaceId: customer.id },
    });
    expect((sent.body.customer as { email: string }).email).toMatch(/@test\.local$/);
    expect((await planOf(customer)).plan_id).toBe(BASE);
  });

  it('opens the checkout on the method the customer picked, and only on an offered one', async () => {
    const { payment } = await openCheckout(customer, 'basic', 1, { method: 'wallet' });
    expect(created.at(-1)!.body).toMatchObject({ order: payment.id, allowedMethods: 'wallet', defaultMethod: 'wallet', brandColor: '#367a6b' });
    const bnpl = await openCheckout(customer, 'basic', 1, { method: 'valu' });
    expect(created.at(-1)!.body).toMatchObject({ order: bnpl.payment.id, allowedMethods: 'bnpl[valu]', defaultMethod: 'bnpl' });
    // Souhoola is on the live account but not offered by the admin: refused before any session is opened.
    const before = created.length;
    const res = await call(customer, 'POST', '/api/payments/kashier', { planId: 'basic', method: 'souhoola' });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors).toEqual({ method: ['Choose one of the offered methods'] });
    expect(created.length).toBe(before);
  });

  it('refuses manual transfers for priced plans while Kashier is live for the account', async () => {
    const res = await call(customer, 'POST', '/api/plan-requests', { planId: 'basic', payment: { method: 'vodafone_cash', senderPhone: '01012345678' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('pay_online');
  });

  it('handles Kashier outages when opening a session without leaking keys', async () => {
    for (const kind of ['network', 'http500'] as const) {
      outage = kind;
      const res = await call(customer, 'POST', '/api/payments/kashier', { planId: 'basic' });
      expect(res.statusCode).toBe(502);
      expect(res.json().code).toBe('kashier_error');
      expect(res.body).not.toContain(CREDS.live.secretKey);
    }
  });

  // --- webhook security --------------------------------------------------------------------------

  it('rejects unsigned, wrongly signed and tampered webhooks', async () => {
    const { session, payment } = await openCheckout();
    session.status = 'PAID';
    expect((await deliver('live', { order: payment.id, status: 'SUCCESS' }, { signature: '' })).statusCode).toBe(400);
    expect((await deliver('live', { order: payment.id, status: 'SUCCESS' }, { signature: 'f'.repeat(64) })).statusCode).toBe(400);
    expect((await deliver('live', { order: payment.id, status: 'SUCCESS' }, { apiKey: 'some-other-key' })).statusCode).toBe(400);
    // Signed with the test key, posted to the live endpoint.
    expect((await deliver('live', { order: payment.id, status: 'SUCCESS' }, { apiKey: CREDS.test.apiKey })).statusCode).toBe(400);
    expect((await paymentRow(payment.id)).status).toBe('pending');
    expect((await planOf(customer)).plan_id).toBe(BASE);
    session.status = 'EXPIRED';
    await deliver('live', { order: payment.id, status: 'FAILURE' });
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'failed', error: 'expired' });
  });

  it('never activates on the webhook alone: the state comes from Kashier', async () => {
    const { session, payment } = await openCheckout();
    // A correctly signed "SUCCESS" while Kashier still reports the session unpaid.
    expect((await deliver('live', { order: payment.id, status: 'SUCCESS', transactionId: 'TX-early' })).statusCode).toBe(200);
    expect((await paymentRow(payment.id)).status).toBe('pending');
    // While Kashier can't be reached, the event is refused so Kashier delivers it again (and it isn't marked handled).
    session.status = 'PAID';
    for (const kind of ['network', 'http500'] as const) {
      outage = kind;
      expect((await deliver('live', { order: payment.id, status: 'SUCCESS', transactionId: 'TX-retry' })).statusCode).toBe(503);
    }
    outage = 'none';
    expect((await paymentRow(payment.id)).status).toBe('pending');
    expect((await sql`select 1 from payment_events where provider = 'kashier' and event_id = 'TX-retry:SUCCESS:pay'`).length).toBe(0);
    expect((await deliver('live', { order: payment.id, status: 'SUCCESS', transactionId: 'TX-retry' })).statusCode).toBe(200);
    expect((await paymentRow(payment.id)).status).toBe('paid');
    await resetPlan(customer);
  });

  // --- activation --------------------------------------------------------------------------------

  it('activates exactly once, however many times and however concurrently it is reported', async () => {
    await resetPlan(customer);
    const before = await approvedKashier(customer);
    const { session, payment } = await openCheckout(customer, 'basic', 1);
    expect((await call(customer, 'POST', `/api/payments/${payment.id}/check`)).json().data.status).toBe('pending');
    session.status = 'PAID';
    expect((await deliver('live', { order: payment.id, status: 'SUCCESS', transactionId: 'TX-once' })).statusCode).toBe(200);
    expect((await paymentRow(payment.id)).status).toBe('paid');
    const activated = await planOf(customer);
    expect(activated.plan_id).toBe('basic');
    const days = (activated.plan_expires_at!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);
    // The same event again: 409, which Kashier counts as delivered.
    expect((await deliver('live', { order: payment.id, status: 'SUCCESS', transactionId: 'TX-once' })).statusCode).toBe(409);
    const again = await Promise.all([
      deliver('live', { order: payment.id, status: 'SUCCESS', transactionId: 'TX-once' }),
      deliver('live', { order: payment.id, status: 'SUCCESS', transactionId: 'TX-once-b' }),
      deliver('live', { order: payment.id, status: 'SUCCESS', transactionId: 'TX-once-c' }, { event: 'idempotency' }),
      call(customer, 'POST', `/api/payments/${payment.id}/check`),
      deliver('live', { order: payment.id, status: 'SUCCESS', transactionId: 'TX-once-b' }),
    ]);
    for (const res of again) expect([200, 409]).toContain(res.statusCode);
    expect(await approvedKashier(customer)).toBe(before + 1);
    expect((await planOf(customer)).plan_expires_at!.getTime()).toBe(activated.plan_expires_at!.getTime());
    const [request] = await sql<{ payment: Record<string, unknown> }[]>`select payment from plan_requests where id = ${(await paymentRow(payment.id)).plan_request_id}`;
    expect(request!.payment).toMatchObject({ method: 'kashier', sessionId: session.id, paymentMethod: 'card' });
    expect(request!.payment.test).toBeUndefined();
  });

  it('settles from the dashboard check when the webhook is late', async () => {
    await resetPlan(customer);
    const { session, payment } = await openCheckout(customer, 'plus', 1);
    session.status = 'PAID';
    expect((await call(customer, 'POST', `/api/payments/${payment.id}/check`)).json().data.status).toBe('paid');
    expect((await planOf(customer)).plan_id).toBe('plus');
  });

  it('a failed payment never activates, and a later genuine success on the same session still counts', async () => {
    await resetPlan(customer);
    const { session, payment } = await openCheckout();
    session.status = 'FAILED';
    await deliver('live', { order: payment.id, status: 'FAILURE' });
    expect((await paymentRow(payment.id)).status).toBe('failed');
    expect((await planOf(customer)).plan_id).toBe(BASE);
    session.status = 'PAID';
    await deliver('live', { order: payment.id, status: 'SUCCESS' });
    expect((await paymentRow(payment.id)).status).toBe('paid');
    expect((await planOf(customer)).plan_id).toBe('basic');
  });

  it('out of order: a refund reported before the payment never activates the plan', async () => {
    await resetPlan(customer);
    const { session, payment } = await openCheckout();
    session.status = 'REFUNDED';
    await deliver('live', { order: payment.id, status: 'SUCCESS' }, { event: 'refund' });
    await deliver('live', { order: payment.id, status: 'SUCCESS' }, { event: 'pay' });
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'refunded', error: 'refunded_before_paid' });
    expect((await planOf(customer)).plan_id).toBe(BASE);
  });

  it('marks a refunded payment and tells the admin, leaving the plan for the admin to decide', async () => {
    await resetPlan(customer);
    const { session, payment } = await openCheckout();
    session.status = 'PAID';
    await deliver('live', { order: payment.id, status: 'SUCCESS' });
    session.status = 'PARTIALLY_REFUNDED';
    await deliver('live', { order: payment.id, status: 'SUCCESS', transactionId: 'TX-part' }, { event: 'partial_refund' });
    expect((await paymentRow(payment.id)).status).toBe('paid');
    session.status = 'REFUNDED';
    await deliver('live', { order: payment.id, status: 'SUCCESS', transactionId: 'TX-full' }, { event: 'refund' });
    expect((await paymentRow(payment.id)).status).toBe('refunded');
    expect((await planOf(customer)).plan_id).toBe('basic');
    const [log] = await sql<{ n: number }[]>`select count(*)::int as n from audit_logs where action = 'payment.refunded' and target_id = ${payment.id}`;
    expect(log!.n).toBe(2);
  });

  it.each([
    ['amount_mismatch', (s: FakeSession) => Object.assign(s, { amount: (Number(s.amount) - 1).toFixed(2) })],
    ['currency_mismatch', (s: FakeSession) => Object.assign(s, { currency: 'USD' })],
    ['merchant_mismatch', (s: FakeSession) => Object.assign(s, { merchantId: 'MID-OTHER-9' })],
    ['order_mismatch', (s: FakeSession) => Object.assign(s, { order: '00000000-0000-4000-8000-000000000000' })],
  ])('holds a PAID session for review without activating: %s', async (reason, tamper) => {
    await resetPlan(customer);
    const { session, payment } = await openCheckout();
    session.status = 'PAID';
    tamper(session);
    expect((await deliver('live', { order: payment.id, status: 'SUCCESS' })).statusCode).toBe(200);
    const row = await paymentRow(payment.id);
    expect(row.status).toBe('review');
    expect(row.error).toContain(reason);
    expect((await planOf(customer)).plan_id).toBe(BASE);
    const [request] = await sql<{ status: string; payment: { review: string[] } }[]>`select status, payment from plan_requests where id = ${row.plan_request_id}`;
    expect(request).toMatchObject({ status: 'pending' });
    expect(request!.payment.review).toContain(reason);
  });

  it('ignores orders that are not ours and keeps payments private to their workspace', async () => {
    expect((await deliver('live', { order: '00000000-0000-4000-8000-000000000000', status: 'SUCCESS' })).statusCode).toBe(200);
    expect((await deliver('live', { order: 'not-a-uuid', status: 'SUCCESS' })).statusCode).toBe(200);
    const { payment } = await openCheckout();
    expect((await call(admin, 'GET', `/api/payments/${payment.id}`)).statusCode).toBe(404);
    expect((await call(admin, 'POST', `/api/payments/${payment.id}/check`)).statusCode).toBe(404);
  });

  // --- test mode and isolation -------------------------------------------------------------------

  it('test mode serves admins only by default, and test payments settle only on the test endpoint', async () => {
    await configure({ mode: 'test' });
    expect((await call(customer, 'GET', '/api/payments/kashier')).json().data.enabled).toBe(false);
    expect((await call(customer, 'POST', '/api/payments/kashier', { planId: 'basic' })).statusCode).toBe(503);
    expect((await call(admin, 'GET', '/api/payments/kashier')).json().data).toEqual({ enabled: true, mode: 'test', methods: ['card', 'wallet', 'valu'] });
    await resetPlan(admin);
    const t = await openCheckout(admin);
    expect(t.payment.mode).toBe('test');
    expect(created.at(-1)!.mode).toBe('test');
    expect(created.at(-1)!.body.serverWebhook).toBe('https://wa.codefiye.com/api/payments/kashier/webhook/test');
    // A test payment can't be settled through the live endpoint (unknown order there), only the test one.
    t.session.status = 'PAID';
    await deliver('live', { order: t.payment.id, status: 'SUCCESS' });
    expect((await paymentRow(t.payment.id)).status).toBe('pending');
    await deliver('test', { order: t.payment.id, status: 'SUCCESS' });
    const paid = await paymentRow(t.payment.id);
    expect(paid.status).toBe('paid');
    // A sandbox payment never activates a plan, and leaves no plan request an admin could approve.
    expect(paid.plan_request_id).toBeNull();
    expect((await planOf(admin)).plan_id).toBe(BASE);
    const [log] = await sql<{ details: { activated: boolean } }[]>`select details from audit_logs where action = 'payment.test_paid' and target_id = ${t.payment.id}`;
    expect(log!.details.activated).toBe(false);
    expect((await call(admin, 'POST', `/api/payments/${t.payment.id}/check`)).json().data).toMatchObject({ status: 'paid', mode: 'test' });
  });

  it('a listed test account gets the sandbox checkout too, and loses it when unlisted', async () => {
    await configure({ mode: 'test' });
    const [row] = await sql<{ email: string }[]>`select email from users where id = ${customer.userId}`;
    const listed = await call(admin, 'PUT', '/api/admin/kashier', { enabled: true, mode: 'test', methods: ['card'], testers: [row!.email.toUpperCase()] });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().data.testers).toEqual([row!.email.toLowerCase()]);
    expect((await call(customer, 'GET', '/api/payments/kashier')).json().data).toEqual({ enabled: true, mode: 'test', methods: ['card'] });
    // The listed customer pays in the sandbox: verified, recorded, and their plan is untouched.
    await resetPlan(customer);
    const t = await openCheckout(customer);
    expect(t.payment.mode).toBe('test');
    t.session.status = 'PAID';
    await deliver('test', { order: t.payment.id, status: 'SUCCESS' });
    expect(await paymentRow(t.payment.id)).toMatchObject({ status: 'paid', plan_request_id: null });
    expect((await planOf(customer)).plan_id).toBe(BASE);
    // Only existing accounts can be listed; the audit keeps a count, never the addresses.
    const unknown = await call(admin, 'PUT', '/api/admin/kashier', { enabled: true, mode: 'test', methods: ['card'], testers: [row!.email, 'nobody-here@test.local'] });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().code).toBe('unknown_tester');
    expect(JSON.stringify(unknown.json().errors)).toContain('nobody-here@test.local');
    const logs = await sql<{ details: unknown }[]>`select details from audit_logs where actor_id = ${admin.userId} and action = 'kashier.update'`;
    expect(JSON.stringify(logs)).not.toContain(row!.email.toLowerCase());
    expect((await call(admin, 'PUT', '/api/admin/kashier', { enabled: true, mode: 'test', methods: ['card'], testers: [] })).statusCode).toBe(200);
    expect((await call(customer, 'GET', '/api/payments/kashier')).json().data.enabled).toBe(false);
  });

  it('never falls back between modes, and the manual request is the fallback when Kashier is off', async () => {
    // Live chosen while its credentials are missing: off for everyone, even though Test is complete.
    await saveKashierSettings(sql, encryptionKey, { enabled: true, mode: 'live', methods: ['card'], test: { ...CREDS.test }, live: { clear: true } });
    expect((await call(admin, 'GET', '/api/payments/kashier')).json().data.enabled).toBe(false);
    expect((await call(admin, 'POST', '/api/payments/kashier', { planId: 'basic' })).statusCode).toBe(503);
    await configure({ enabled: false });
    expect((await call(customer, 'GET', '/api/payments/kashier')).json().data.enabled).toBe(false);
    // (The review tests above may have left a held request pending for this plan.)
    await sql`update plan_requests set status = 'cancelled' where workspace_id = ${customer.id} and status = 'pending'`;
    const manual = await call(customer, 'POST', '/api/plan-requests', { planId: 'basic' });
    expect(manual.statusCode, manual.body).toBe(201);
    await sql`update plan_requests set status = 'cancelled' where workspace_id = ${customer.id} and status = 'pending'`;
  });

  // --- admin -------------------------------------------------------------------------------------

  it('lets only admins read or change the Kashier configuration, and never returns a key', async () => {
    for (const [method, path, body] of [
      ['GET', '/api/admin/kashier', undefined],
      ['PUT', '/api/admin/kashier', { enabled: false, mode: 'test', methods: ['card'] }],
      ['POST', '/api/admin/kashier/test', { mode: 'live' }],
      ['GET', '/api/admin/payments?mode=live', undefined],
    ] as const) {
      expect((await call(customer, method, path, body)).statusCode, `${method} ${path}`).toBe(403);
    }
    const res = await call(admin, 'GET', '/api/admin/kashier');
    expect(res.json().data.live).toMatchObject({ merchantId: CREDS.live.merchantId, secretKeyHint: '••••-key', apiKeyHint: '••••-key', webhookUrl: 'https://wa.codefiye.com/api/payments/kashier/webhook/live' });
    for (const k of [CREDS.live.secretKey, CREDS.live.apiKey, CREDS.test.secretKey, CREDS.test.apiKey]) expect(res.body).not.toContain(k);
    const [stored] = await sql<{ value: unknown }[]>`select value from settings where key = 'kashier'`;
    for (const k of [CREDS.live.secretKey, CREDS.live.apiKey]) expect(JSON.stringify(stored!.value)).not.toContain(k);
  });

  it('tests the connection without moving money and narrows methods to the account', async () => {
    accountMethods.live = accountShape(['card']);
    const good = await call(admin, 'POST', '/api/admin/kashier/test', { mode: 'live' });
    expect(good.json().data).toMatchObject({ ok: true, error: null });
    expect(good.json().data.settings.live).toMatchObject({ accountMethods: ['card'], apiKeyUnconfirmed: true });
    // Kashier offers only cards on this account: the session asks for cards only.
    await openCheckout();
    expect(created.at(-1)!.body.allowedMethods).toBeUndefined();
    accountMethods.live = LIVE_FULL();
    // A signed webhook confirms the Payment API Key.
    const { session, payment } = await openCheckout();
    session.status = 'PAID';
    await deliver('live', { order: payment.id, status: 'SUCCESS' });
    expect((await call(admin, 'GET', '/api/admin/kashier')).json().data.live).toMatchObject({ apiKeyUnconfirmed: false });
    expect((await call(admin, 'GET', '/api/admin/kashier')).json().data.live.lastWebhookAt).not.toBeNull();
    await saveKashierSettings(sql, encryptionKey, { enabled: true, mode: 'live', methods: ['card'], live: { secretKey: 'secret-wrong-key' } });
    expect((await call(admin, 'POST', '/api/admin/kashier/test', { mode: 'live' })).json().data).toMatchObject({ ok: false, error: 'invalid_secret_key' });
    await configure();
  });

  it('reads the methods from the real Kashier paymentMethods answer (regression: it used to read none)', async () => {
    await configure({ mode: 'test' });
    const tested = await call(admin, 'POST', '/api/admin/kashier/test', { mode: 'test' });
    expect(tested.json().data.settings.test.accountMethods).toEqual(['card', 'wallet', 'bank_installments', 'valu', 'souhoola']);
    // Switching Kashier on in test mode with cards and wallets now works, and the admin gets the checkout.
    const on = await call(admin, 'PUT', '/api/admin/kashier', { enabled: true, mode: 'test', methods: ['card', 'wallet'] });
    expect(on.statusCode, on.body).toBe(200);
    expect((await call(admin, 'GET', '/api/payments/kashier')).json().data).toEqual({ enabled: true, mode: 'test', methods: ['card', 'wallet'] });
    // A live account Kashier hasn't provisioned yet answers empty lists: nothing can be offered there.
    accountMethods.live = accountShape([]);
    const live = await call(admin, 'POST', '/api/admin/kashier/test', { mode: 'live' });
    expect(live.json().data.settings.live.accountMethods).toEqual([]);
    const liveOn = await call(admin, 'PUT', '/api/admin/kashier', { enabled: true, mode: 'live', methods: ['card'], confirmLive: true });
    expect(liveOn.statusCode).toBe(422);
  });

  // Production on 2026-11-01 00:40Z: test mode, keys saved and tested, account methods read, the customer
  // on the test list, but the switch never saved on. Every condition held except `enabled`.
  it('the production state: everything set except the switch, so the listed customer still gets the manual request', async () => {
    await configure({ enabled: false, mode: 'test', methods: ['card', 'wallet'] });
    expect((await call(admin, 'POST', '/api/admin/kashier/test', { mode: 'test' })).json().data.ok).toBe(true);
    const [row] = await sql<{ email: string }[]>`select email from users where id = ${customer.userId}`;
    const saved = await call(admin, 'PUT', '/api/admin/kashier', { enabled: false, mode: 'test', methods: ['card', 'wallet'], testers: [row!.email] });
    expect(saved.statusCode, saved.body).toBe(200);
    const settings = saved.json().data;
    expect(settings).toMatchObject({ enabled: false, mode: 'test', methods: ['card', 'wallet'], testers: [row!.email.toLowerCase()] });
    expect(settings.test.accountMethods).toEqual(expect.arrayContaining(['card', 'wallet']));
    // With the switch off, the listed customer is told online payment isn't available…
    expect((await call(customer, 'GET', '/api/payments/kashier')).json().data).toEqual({ enabled: false, mode: 'test', methods: [] });
    expect((await call(customer, 'POST', '/api/payments/kashier', { planId: 'pro' })).statusCode).toBe(503);
    // …and the switch alone turns it on, for that customer only (another customer stays on the manual request).
    expect((await call(admin, 'PUT', '/api/admin/kashier', { enabled: true, mode: 'test', methods: ['card', 'wallet'] })).statusCode).toBe(200);
    expect((await call(customer, 'GET', '/api/payments/kashier')).json().data).toEqual({ enabled: true, mode: 'test', methods: ['card', 'wallet'] });
    await resetPlan(customer);
    const t = await openCheckout(customer, 'pro');
    expect(t.payment).toMatchObject({ mode: 'test', status: 'pending' });
    expect(created.at(-1)!.mode).toBe('test');
    const other = await makeAccount('other', 'user');
    try {
      expect((await call(other, 'GET', '/api/payments/kashier')).json().data.enabled).toBe(false);
    } finally {
      await sql`delete from workspaces where id = ${other.id}`;
      await sql`delete from users where id = ${other.userId}`;
    }
    expect((await call(admin, 'PUT', '/api/admin/kashier', { enabled: true, mode: 'test', methods: ['card', 'wallet'], testers: [] })).statusCode).toBe(200);
  });

  it('switches live payments on only after a passing connection test and an explicit confirmation', async () => {
    await configure({ enabled: false, mode: 'test' });
    const untested = await call(admin, 'PUT', '/api/admin/kashier', { enabled: true, mode: 'live', methods: ['card'], confirmLive: true });
    expect(untested.json().code, untested.body).toBe('test_connection_first');
    expect((await call(admin, 'POST', '/api/admin/kashier/test', { mode: 'live' })).json().data.ok).toBe(true);
    const unconfirmed = await call(admin, 'PUT', '/api/admin/kashier', { enabled: true, mode: 'live', methods: ['card'] });
    expect(unconfirmed.json().code, unconfirmed.body).toBe('confirm_live');
    const on = await call(admin, 'PUT', '/api/admin/kashier', { enabled: true, mode: 'live', methods: ['card'], confirmLive: true });
    expect(on.statusCode, on.body).toBe(200);
    expect((await call(customer, 'GET', '/api/payments/kashier')).json().data).toEqual({ enabled: true, mode: 'live', methods: ['card'] });
    const logs = await sql<{ action: string; details: unknown }[]>`select action, details from audit_logs where actor_id = ${admin.userId} and action like 'kashier.%'`;
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['kashier.live_enabled', 'kashier.test_connection']));
    for (const k of [CREDS.live.secretKey, CREDS.live.apiKey]) expect(JSON.stringify(logs)).not.toContain(k);
  });

  it('lists each mode’s payments separately with their provider', async () => {
    const live = (await call(admin, 'GET', '/api/admin/payments?mode=live')).json().data as { mode: string; provider: string }[];
    const test = (await call(admin, 'GET', '/api/admin/payments?mode=test')).json().data as { mode: string; provider: string }[];
    expect(live.length).toBeGreaterThan(0);
    expect(test.length).toBeGreaterThan(0);
    expect(new Set(live.map((p) => p.mode))).toEqual(new Set(['live']));
    expect(new Set(test.map((p) => p.mode))).toEqual(new Set(['test']));
    expect(live.some((p) => p.provider === 'kashier')).toBe(true);
  });
});
