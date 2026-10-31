import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { apiKeys, createDb, createListener, type Db, runMigrations, type Sql, users, workspaces } from '@wa/db';
import { listedPriceUsd, planPriceEgp, type XPayMode } from '@wa/shared';
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
import { getXPayModeAccount, getXPayPublicConfig, getXPaySettings, saveXPaySettings } from '../src/lib/xpay';

const url = process.env.TEST_DATABASE_URL;
const KEYS = {
  test: { publishableKey: 'pk_test_flow', secretKey: 'sk_test_flow', webhookSecret: 'whsec_flowtest' },
  live: { publishableKey: 'pk_live_flow', secretKey: 'sk_live_flow', webhookSecret: 'whsec_flowlive' },
} as const;
const hook = (mode: XPayMode) => `/api/payments/xpay/webhook/${mode}`;

type FakeSession = {
  id: string;
  object: 'checkout.session';
  status: 'open' | 'complete' | 'expired';
  paymentStatus: 'paid' | 'unpaid';
  livemode: boolean;
  amountSubtotal: number;
  amountTotal: number;
  totalDetails: Record<string, number>;
  currency: string;
  metadata: Record<string, unknown>;
  paymentIntentId: string | null;
  isExpired: boolean;
};

/**
 * End to end against the isolated test database, with XPay replaced by an in-memory fake behind
 * `fetch` (no real XPay call is made: real Sandbox behaviour still needs checking with test keys).
 */
describe.skipIf(!url)('xpay payments (integration)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sql: Sql;
  let db: Db;
  let end: () => Promise<unknown>;
  let events: EventBus;
  let encryptionKey: Buffer;
  let customer: { id: string; pat: string; userId: string };
  let admin: { id: string; pat: string; userId: string };

  // --- the fake XPay ---------------------------------------------------------------------------
  const sessions = new Map<string, FakeSession>();
  const created: { body: Record<string, unknown>; idempotencyKey: string | null; key: string | null }[] = [];
  let outage: 'none' | 'http500' | 'network' = 'none';
  // What each mode's XPay account reports in GET /account.
  const account = { test: { methods: ['card', 'fawry', 'valu'], live: true }, live: { methods: ['card', 'fawry', 'valu'], live: true } };
  const realFetch = globalThis.fetch;
  const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith('https://api.xpay.app/')) return realFetch(input, init);
    if (outage === 'network') throw new TypeError('fetch failed');
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (outage === 'http500') return json(500, { error: { type: 'api_error', code: 'internal', message: 'boom' } });
    const headers = new Headers(init?.headers);
    const key = headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
    const mode = key === KEYS.live.secretKey ? 'live' : key === KEYS.test.secretKey ? 'test' : null;
    if (!mode) return json(401, { error: { code: 'unauthorized', message: 'Invalid API key' } });
    const path = new URL(href).pathname;
    if ((!init?.method || init.method === 'GET') && path === '/account') {
      return json(200, {
        id: `acct_${mode}`,
        displayName: 'CodeFiye',
        defaultCurrency: 'EGP',
        defaultLocale: 'ar',
        livemode: mode === 'live',
        livePaymentsEnabled: mode === 'live' ? account.live.live : false,
        apiKey: { type: 'SECRET', mode, permissions: [] },
        supportedCurrencies: [{ code: 'EGP', decimals: 2, paymentMethodTypes: account[mode].methods }],
        wallets: [],
      });
    }
    if (init?.method === 'POST' && path === '/checkout/sessions') {
      const body = JSON.parse(String(init.body)) as { lineItems: { priceData: { unitAmount: number } }[]; metadata: Record<string, unknown> };
      created.push({ body: body as never, idempotencyKey: headers.get('idempotency-key'), key });
      const amount = body.lineItems[0]!.priceData.unitAmount;
      const id = `cs_${mode}_${randomBytes(6).toString('hex')}`;
      const s: FakeSession = {
        id,
        object: 'checkout.session',
        status: 'open',
        paymentStatus: 'unpaid',
        livemode: mode === 'live',
        amountSubtotal: amount,
        amountTotal: amount,
        totalDetails: { amountDiscount: 0, amountTax: 0 },
        currency: 'EGP',
        metadata: body.metadata,
        paymentIntentId: null,
        isExpired: false,
      };
      sessions.set(id, s);
      return json(200, { ...s, clientSecret: `${id}_secret_x` });
    }
    const match = /^\/checkout\/sessions\/([^/]+)$/.exec(path);
    if (match && (!init?.method || init.method === 'GET')) {
      const s = sessions.get(decodeURIComponent(match[1]!));
      // Sessions belong to one mode: the other mode's key doesn't see them (404, as XPay documents).
      return s && s.livemode === (mode === 'live') ? json(200, s) : json(404, { error: { code: 'resource_missing', message: 'No such checkout session' } });
    }
    return json(404, { error: { code: 'not_found', message: path } });
  });

  // --- helpers ---------------------------------------------------------------------------------
  const call = (who: { pat: string }, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) =>
    app.inject({ method, url: path, headers: { authorization: `Bearer ${who.pat}` }, ...(body !== undefined ? { payload: body as object } : {}) });
  const signature = (raw: string, secret: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
  const deliver = (mode: XPayMode, event: { id?: string; type: string; object: Record<string, unknown>; livemode?: boolean }, opts: { t?: number; secret?: string; header?: string } = {}) => {
    const raw = JSON.stringify({ id: event.id ?? `evt_${mode}_${randomBytes(6).toString('hex')}`, type: event.type, livemode: event.livemode ?? mode === 'live', data: { object: event.object } });
    return app.inject({
      method: 'POST',
      url: hook(mode),
      headers: { 'content-type': 'application/json', 'xpay-signature': opts.header ?? signature(raw, opts.secret ?? KEYS[mode].webhookSecret, opts.t) },
      payload: raw,
    });
  };
  const planOf = async (ws: { id: string }) => (await sql<{ plan_id: string; plan_expires_at: Date | null }[]>`select plan_id, plan_expires_at from workspaces where id = ${ws.id}`)[0]!;
  const approvedXPay = async (ws: { id: string }) =>
    (await sql<{ n: number }[]>`select count(*)::int as n from plan_requests where workspace_id = ${ws.id} and status = 'approved' and payment->>'method' = 'xpay'`)[0]!.n;
  const paymentRow = async (id: string) =>
    (await sql<{ status: string; error: string | null; plan_request_id: string | null; mode: string; refunded_cents: number }[]>`select status, error, plan_request_id, mode, refunded_cents from payments where id = ${id}`)[0]!;
  const openCheckout = async (who = customer, planId = 'basic', months = 1) => {
    const res = await call(who, 'POST', '/api/payments/xpay', { planId, months, locale: 'en' });
    expect(res.statusCode, res.body).toBe(201);
    const { payment, clientSecret } = res.json().data as { payment: { id: string; amountCents: number; status: string; mode: XPayMode }; clientSecret: string };
    const [row] = await sql<{ session_id: string }[]>`select session_id from payments where id = ${payment.id}`;
    return { payment, clientSecret, session: sessions.get(row!.session_id)! };
  };
  const markPaid = (s: FakeSession, intent = `pi_${randomBytes(4).toString('hex')}`) => Object.assign(s, { status: 'complete', paymentStatus: 'paid', paymentIntentId: intent });
  // An expired Pro plan: Pro's rate limit leaves room for the whole suite (Trial allows 10 calls a minute),
  // and every purchase below shows as a plan change.
  const BASE = 'pro';
  const resetPlan = (ws: { id: string }) => sql`update workspaces set plan_id = ${BASE}, plan_expires_at = now() - interval '1 day', trial_ends_at = null where id = ${ws.id}`;
  /** Live mode on with complete live keys (and test keys stored too), as the admin would leave it. */
  const configure = (over: Partial<Parameters<typeof saveXPaySettings>[2]> = {}) =>
    saveXPaySettings(sql, encryptionKey, { enabled: true, mode: 'live', methods: ['card'], test: { ...KEYS.test }, live: { ...KEYS.live }, ...over });

  const makeAccount = async (name: string, role: 'user' | 'admin') => {
    const [user] = await db
      .insert(users)
      .values({ email: `xpay-flow-${name}-${randomInt(1e9)}@test.local`, name: 'Pay Er', role, phone: `+2010${String(randomInt(1e8)).padStart(8, '0')}`, phoneVerifiedAt: new Date() })
      .returning();
    const [w] = await db.insert(workspaces).values({ name: `xpay-flow-${name}`, ownerId: user!.id, planId: BASE, planExpiresAt: new Date(Date.now() - 86_400_000) }).returning();
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
      { logger, corsOrigins: [], publicUrl: 'http://test' },
    );
    customer = await makeAccount('customer', 'user');
    admin = await makeAccount('admin', 'admin');
    await configure();
    vi.stubGlobal('fetch', fakeFetch);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (sql) {
      await sql`delete from settings where key = 'xpay'`;
      await sql`delete from payment_events where event_id like 'evt_test_%' or event_id like 'evt_live_%'`;
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

  beforeEach(async () => {
    outage = 'none';
  });

  // --- checkout ----------------------------------------------------------------------------------

  it('opens a live checkout priced from the plan, with an idempotency key and our own return link', async () => {
    expect((await call(customer, 'GET', '/api/payments/xpay')).json().data).toEqual({ enabled: true, publishableKey: KEYS.live.publishableKey, mode: 'live' });
    const [settings, pricing] = await Promise.all([getPaymentSettings(sql), getPlanPricing(sql)]);
    const expectedCents = planPriceEgp(listedPriceUsd('basic', pricing), 3, settings.egpPerUsd)! * 100;
    const { payment, clientSecret, session } = await openCheckout(customer, 'basic', 3);
    expect(payment).toMatchObject({ status: 'pending', mode: 'live', amountCents: expectedCents });
    expect(clientSecret).toBe(`${session.id}_secret_x`);
    const sent = created.at(-1)!;
    expect(sent.key).toBe(KEYS.live.secretKey);
    expect(sent.idempotencyKey).toBe(payment.id);
    expect(sent.body).toMatchObject({
      uiMode: 'custom',
      currency: 'EGP',
      paymentMethodTypes: ['card'],
      metadata: { paymentId: payment.id, workspaceId: customer.id },
      afterCompletion: { type: 'redirect', redirect: { url: `http://test/subscription?payment=${payment.id}` } },
    });
    expect((sent.body.lineItems as { priceData: { unitAmount: number } }[])[0]!.priceData.unitAmount).toBe(expectedCents);
    expect((await planOf(customer)).plan_id).toBe(BASE);
  });

  it('refuses manual transfers for priced plans while XPay is live', async () => {
    const res = await call(customer, 'POST', '/api/plan-requests', { planId: 'basic', payment: { method: 'vodafone_cash', senderPhone: '01012345678' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('pay_online');
  });

  it('handles XPay outages when opening a checkout without leaking details', async () => {
    for (const kind of ['network', 'http500'] as const) {
      outage = kind;
      const res = await call(customer, 'POST', '/api/payments/xpay', { planId: 'basic', months: 1 });
      expect(res.statusCode).toBe(502);
      expect(res.json().code).toBe('xpay_error');
      expect(res.body).not.toContain('sk_');
    }
    outage = 'none';
    const [row] = await sql<{ status: string; error: string }[]>`select status, error from payments where workspace_id = ${customer.id} order by created_at desc limit 1`;
    expect(row).toMatchObject({ status: 'failed' });
    expect(row!.error).toMatch(/^session_failed:/);
  });

  // --- webhook security --------------------------------------------------------------------------

  it('rejects unsigned, wrongly signed, tampered and replayed webhooks', async () => {
    const { session, payment } = await openCheckout();
    markPaid(session);
    const object = { id: session.id };
    expect((await deliver('live', { type: 'checkout.session.completed', object }, { header: '' })).statusCode).toBe(400);
    expect((await deliver('live', { type: 'checkout.session.completed', object }, { header: 'nonsense' })).statusCode).toBe(400);
    expect((await deliver('live', { type: 'checkout.session.completed', object }, { secret: 'whsec_wrong' })).statusCode).toBe(400);
    // Outside the five-minute window either way (the exact edge is unit-tested with a fixed clock).
    expect((await deliver('live', { type: 'checkout.session.completed', object }, { t: Math.floor(Date.now() / 1000) - 360 })).statusCode).toBe(400);
    expect((await deliver('live', { type: 'checkout.session.completed', object }, { t: Math.floor(Date.now() / 1000) + 360 })).statusCode).toBe(400);
    const raw = JSON.stringify({ id: 'evt_live_tamper', type: 'checkout.session.completed', livemode: true, data: { object } });
    const tampered = await app.inject({ method: 'POST', url: hook('live'), headers: { 'content-type': 'application/json', 'xpay-signature': signature(raw, KEYS.live.webhookSecret) }, payload: raw.replace('"livemode":true', '"livemode": true') });
    expect(tampered.statusCode).toBe(400);
    expect((await paymentRow(payment.id)).status).toBe('pending');
    expect((await planOf(customer)).plan_id).toBe(BASE);
    expect(await approvedXPay(customer)).toBe(0);
    Object.assign(session, { status: 'expired', paymentStatus: 'unpaid', isExpired: true });
    await deliver('live', { type: 'checkout.session.expired', object });
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'failed', error: 'expired' });
  });

  it('keeps Test and Live apart: secrets, endpoints and payments', async () => {
    const { session, payment } = await openCheckout();
    markPaid(session);
    // Signed with the test secret, posted to the live endpoint.
    expect((await deliver('live', { type: 'checkout.session.completed', object: { id: session.id } }, { secret: KEYS.test.webhookSecret })).statusCode).toBe(400);
    // A live event on the test endpoint, even correctly signed for it.
    expect((await deliver('test', { type: 'checkout.session.completed', object: { id: session.id }, livemode: true })).statusCode).toBe(400);
    // A test event naming a live session: the test key can't read it (404), so nothing settles.
    const viaTest = await deliver('test', { type: 'checkout.session.completed', object: { id: session.id } });
    expect(viaTest.statusCode).toBe(200);
    expect((await paymentRow(payment.id)).status).toBe('pending');
    // The right endpoint settles it.
    expect((await deliver('live', { type: 'checkout.session.completed', object: { id: session.id } })).statusCode).toBe(200);
    expect((await paymentRow(payment.id)).status).toBe('paid');
    await resetPlan(customer);
  });

  it('never activates on the payload alone: the state comes from XPay', async () => {
    const { session, payment } = await openCheckout();
    // A signed event whose payload claims "paid" while XPay still says unpaid.
    const res = await deliver('live', { type: 'checkout.session.completed', object: { ...session, status: 'complete', paymentStatus: 'paid' } });
    expect(res.statusCode).toBe(200);
    expect((await paymentRow(payment.id)).status).toBe('pending');
    expect((await planOf(customer)).plan_id).toBe(BASE);
    // While XPay can't be reached, the event is refused so XPay delivers it again (and it isn't marked handled).
    markPaid(session);
    for (const kind of ['network', 'http500'] as const) {
      outage = kind;
      expect((await deliver('live', { id: 'evt_live_retry', type: 'checkout.session.completed', object: { id: session.id } })).statusCode).toBe(503);
    }
    outage = 'none';
    expect((await paymentRow(payment.id)).status).toBe('pending');
    expect((await sql`select 1 from payment_events where event_id = 'evt_live_retry'`).length).toBe(0);
    // XPay's retry of the same event then settles it.
    expect((await deliver('live', { id: 'evt_live_retry', type: 'checkout.session.completed', object: { id: session.id } })).statusCode).toBe(200);
    expect((await paymentRow(payment.id)).status).toBe('paid');
    await resetPlan(customer);
  });

  // --- activation --------------------------------------------------------------------------------

  it('activates once for a paid session, however many times and however concurrently it is reported', async () => {
    await resetPlan(customer);
    const before = await approvedXPay(customer);
    const { session, payment } = await openCheckout(customer, 'basic', 1);
    expect((await call(customer, 'POST', `/api/payments/${payment.id}/check`)).json().data.status).toBe('pending');

    markPaid(session, 'pi_live_once');
    const event = { id: 'evt_live_once', type: 'checkout.session.completed', object: { id: session.id } };
    expect((await deliver('live', event)).statusCode).toBe(200);
    const paid = await paymentRow(payment.id);
    expect(paid.status).toBe('paid');
    const activated = await planOf(customer);
    expect(activated.plan_id).toBe('basic');
    const days = (activated.plan_expires_at!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);

    // The same event again is recognised by its id and not processed.
    const dup = await deliver('live', event);
    expect(dup.json()).toEqual({ received: true, duplicate: true });
    // Concurrent redeliveries, new event ids for the same session, and the dashboard's check.
    const again = await Promise.all([
      deliver('live', event),
      deliver('live', { ...event, id: 'evt_live_once_b' }),
      deliver('live', { ...event, id: 'evt_live_once_c' }),
      call(customer, 'POST', `/api/payments/${payment.id}/check`),
      deliver('live', { ...event, id: 'evt_live_once_b' }),
    ]);
    for (const res of again) expect(res.statusCode).toBe(200);
    expect(await approvedXPay(customer)).toBe(before + 1);
    expect((await planOf(customer)).plan_expires_at!.getTime()).toBe(activated.plan_expires_at!.getTime());
    const [request] = await sql<{ payment: Record<string, unknown> }[]>`select payment from plan_requests where id = ${paid.plan_request_id}`;
    expect(request!.payment).toMatchObject({ method: 'xpay', sessionId: session.id, paymentId: 'pi_live_once' });
    expect(request!.payment.test).toBeUndefined();
    const [handled] = await sql<{ outcome: string; mode: string }[]>`select outcome, mode from payment_events where event_id = 'evt_live_once'`;
    expect(handled).toEqual({ outcome: 'paid', mode: 'live' });
  });

  it('settles from the dashboard check when the webhook is late', async () => {
    await resetPlan(customer);
    const { session, payment } = await openCheckout(customer, 'plus', 1);
    markPaid(session);
    expect((await call(customer, 'POST', `/api/payments/${payment.id}/check`)).json().data.status).toBe('paid');
    expect((await planOf(customer)).plan_id).toBe('plus');
  });

  it('a failed or unpaid payment never activates, and a later genuine success still counts', async () => {
    await resetPlan(customer);
    const before = await approvedXPay(customer);
    const { session, payment } = await openCheckout();
    session.status = 'complete'; // a Fawry reference: complete, not paid
    expect((await deliver('live', { type: 'checkout.session.completed', object: { id: session.id } })).statusCode).toBe(200);
    expect((await paymentRow(payment.id)).status).toBe('pending');
    expect((await deliver('live', { type: 'checkout.session.async_payment_failed', object: { id: session.id } })).statusCode).toBe(200);
    expect((await paymentRow(payment.id)).status).toBe('failed');
    expect((await planOf(customer)).plan_id).toBe(BASE);
    expect(await approvedXPay(customer)).toBe(before);
    markPaid(session);
    await deliver('live', { type: 'checkout.session.async_payment_succeeded', object: { id: session.id } });
    expect((await paymentRow(payment.id)).status).toBe('paid');
    expect((await planOf(customer)).plan_id).toBe('basic');
  });

  // One test per case: each walks a whole checkout → webhook → redelivery against the test database.
  const reviewCases: [string, (s: FakeSession, amount: number) => void][] = [
    ['subtotal_mismatch', (s, a) => Object.assign(s, { amountSubtotal: a - 100, amountTotal: a - 100 })],
    ['total_mismatch', (s, a) => Object.assign(s, { amountTotal: a + 5_000 })],
    ['currency_mismatch', (s) => Object.assign(s, { currency: 'USD' })],
    ['discounted', (s, a) => Object.assign(s, { amountTotal: a - 1_000, totalDetails: { amountDiscount: 1_000, amountTax: 0 } })],
    ['order_mismatch', (s) => Object.assign(s, { metadata: { paymentId: '00000000-0000-4000-8000-000000000000', workspaceId: customer.id } })],
  ];
  it.each(reviewCases)('holds a paid session for review without activating: %s', async (reason, tamper) => {
    await resetPlan(customer);
    const { session, payment } = await openCheckout();
    markPaid(session);
    tamper(session, payment.amountCents);
    expect((await deliver('live', { type: 'checkout.session.completed', object: { id: session.id } })).statusCode).toBe(200);
    const row = await paymentRow(payment.id);
    expect(row.status).toBe('review');
    expect(row.error).toContain(reason);
    expect((await planOf(customer)).plan_id).toBe(BASE);
    // The admin sees it as a pending request carrying the reasons.
    const [request] = await sql<{ status: string; payment: { review: string[] } }[]>`select status, payment from plan_requests where id = ${row.plan_request_id}`;
    expect(request).toMatchObject({ status: 'pending' });
    expect(request!.payment.review).toContain(reason);
    // A redelivery doesn't change the held payment.
    await deliver('live', { type: 'checkout.session.completed', object: { id: session.id } });
    expect((await paymentRow(payment.id)).status).toBe('review');
  });

  it("accepts XPay's fee passed through to the customer when itemised", async () => {
    await resetPlan(customer);
    const fee = await openCheckout();
    markPaid(fee.session);
    Object.assign(fee.session, { amountTotal: fee.payment.amountCents + 1_500, totalDetails: { amountDiscount: 0, amountTax: 0, amountPlatformFee: 1_500 } });
    await deliver('live', { type: 'checkout.session.completed', object: { id: fee.session.id } });
    expect((await paymentRow(fee.payment.id)).status).toBe('paid');
    expect((await planOf(customer)).plan_id).toBe('basic');
  });

  it('marks a refunded payment and tells the admin, leaving the plan for the admin to decide', async () => {
    await resetPlan(customer);
    const { session, payment } = await openCheckout();
    markPaid(session, 'pi_live_refund');
    await deliver('live', { type: 'checkout.session.completed', object: { id: session.id } });
    expect((await paymentRow(payment.id)).status).toBe('paid');
    const partial = await deliver('live', { type: 'charge.refunded', object: { id: 'ch_1', paymentIntentId: 'pi_live_refund', amount: payment.amountCents, amountRefunded: 1_000, refunded: false } });
    expect(partial.statusCode).toBe(200);
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'paid', refunded_cents: 1_000 });
    await deliver('live', { type: 'charge.refunded', object: { id: 'ch_1', paymentIntentId: 'pi_live_refund', amount: payment.amountCents, amountRefunded: payment.amountCents, refunded: true } });
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'refunded', refunded_cents: payment.amountCents });
    expect((await planOf(customer)).plan_id).toBe('basic');
    const [log] = await sql<{ n: number }[]>`select count(*)::int as n from audit_logs where action = 'payment.refunded' and target_id = ${payment.id}`;
    expect(log!.n).toBe(2);
    // A refund event for the same intent on the test endpoint touches nothing.
    await deliver('test', { type: 'charge.refunded', object: { id: 'ch_1', paymentIntentId: 'pi_live_refund', amount: 1, amountRefunded: 1, refunded: true } });
    expect((await paymentRow(payment.id)).refunded_cents).toBe(payment.amountCents);
  });

  it('ignores sessions that are not ours and events that are not about payments', async () => {
    sessions.set('cs_live_foreign', {
      id: 'cs_live_foreign',
      object: 'checkout.session',
      status: 'complete',
      paymentStatus: 'paid',
      livemode: true,
      amountSubtotal: 1,
      amountTotal: 1,
      totalDetails: {},
      currency: 'EGP',
      metadata: {},
      paymentIntentId: null,
      isExpired: false,
    });
    expect((await deliver('live', { type: 'checkout.session.completed', object: { id: 'cs_live_foreign' } })).statusCode).toBe(200);
    expect((await deliver('live', { type: 'customer.created', object: { id: 'cus_1' } })).statusCode).toBe(200);
  });

  it('keeps payments private to their workspace', async () => {
    const { payment } = await openCheckout();
    expect((await call(admin, 'GET', `/api/payments/${payment.id}`)).statusCode).toBe(404);
    expect((await call(admin, 'POST', `/api/payments/${payment.id}/check`)).statusCode).toBe(404);
  });

  // --- test mode -----------------------------------------------------------------------------------

  it('test mode is for admins only, and never falls back to the other mode', async () => {
    await configure({ mode: 'test' });
    expect((await call(customer, 'GET', '/api/payments/xpay')).json().data.enabled).toBe(false);
    expect((await call(customer, 'POST', '/api/payments/xpay', { planId: 'basic' })).statusCode).toBe(503);
    // Customers keep the manual transfers while XPay is only in test.
    expect((await call(customer, 'POST', '/api/plan-requests', { planId: 'basic', payment: { method: 'vodafone_cash', senderPhone: '01012345678' } })).json().code).not.toBe('pay_online');
    await sql`update plan_requests set status = 'cancelled' where workspace_id = ${customer.id} and status = 'pending'`;
    expect((await call(admin, 'GET', '/api/payments/xpay')).json().data).toEqual({ enabled: true, publishableKey: KEYS.test.publishableKey, mode: 'test' });
    const { payment, session } = await openCheckout(admin);
    expect(payment.mode).toBe('test');
    expect(created.at(-1)!.key).toBe(KEYS.test.secretKey);
    markPaid(session);
    expect((await deliver('test', { type: 'checkout.session.completed', object: { id: session.id } })).statusCode).toBe(200);
    expect((await paymentRow(payment.id)).status).toBe('paid');
    const [request] = await sql<{ payment: { test?: boolean } }[]>`select payment from plan_requests where id = ${(await paymentRow(payment.id)).plan_request_id}`;
    expect(request!.payment.test).toBe(true);

    // Live chosen while the live keys are missing: off for everyone, even though Test is complete.
    await saveXPaySettings(sql, encryptionKey, { enabled: true, mode: 'live', methods: ['card'], live: { clear: true } });
    expect((await call(customer, 'GET', '/api/payments/xpay')).json().data.enabled).toBe(false);
    expect((await call(admin, 'GET', '/api/payments/xpay')).json().data.enabled).toBe(false);
    expect((await call(admin, 'POST', '/api/payments/xpay', { planId: 'basic' })).statusCode).toBe(503);
    await configure();
  });

  it('fails closed without the encryption key', async () => {
    const view = await getXPaySettings(sql, null, 'http://test');
    expect(view.encryptionReady).toBe(false);
    expect(view.live.secretKeyHint).toBeNull();
    expect(await getXPayModeAccount(sql, null, 'live')).toBeNull();
    expect((await getXPayPublicConfig(sql, null, true)).enabled).toBe(false);
    // Another key can't open what this one sealed.
    expect(await getXPayModeAccount(sql, randomBytes(32), 'live')).toBeNull();
    expect((await getXPaySettings(sql, randomBytes(32), 'http://test')).live.unreadable).toBe(true);
  });

  // --- admin configuration -----------------------------------------------------------------------

  it('lets only admins read or change the XPay configuration', async () => {
    for (const [method, path, body] of [
      ['GET', '/api/admin/xpay', undefined],
      ['PUT', '/api/admin/xpay', { enabled: false, mode: 'test', methods: ['card'] }],
      ['POST', '/api/admin/xpay/test', { mode: 'live' }],
    ] as const) {
      expect((await call(customer, method, path, body)).statusCode, `${method} ${path}`).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/api/admin/xpay' })).statusCode).toBe(401);
  });

  it('never returns or logs a secret: only masked hints', async () => {
    const res = await call(admin, 'GET', '/api/admin/xpay');
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.live).toMatchObject({ publishableKey: KEYS.live.publishableKey, secretKeyHint: 'sk_live_••••flow', webhookSecretHint: 'whsec_••••live', webhookUrl: 'http://test/api/payments/xpay/webhook/live' });
    expect(data.test.webhookUrl).toBe('http://test/api/payments/xpay/webhook/test');
    for (const k of [KEYS.live.secretKey, KEYS.live.webhookSecret, KEYS.test.secretKey, KEYS.test.webhookSecret]) expect(res.body).not.toContain(k);
    const [stored] = await sql<{ value: unknown }[]>`select value from settings where key = 'xpay'`;
    for (const k of [KEYS.live.secretKey, KEYS.live.webhookSecret]) expect(JSON.stringify(stored!.value)).not.toContain(k);
  });

  it('refuses keys of the wrong mode', async () => {
    const res = await call(admin, 'PUT', '/api/admin/xpay', { enabled: false, mode: 'test', methods: ['card'], test: { secretKey: 'sk_live_wrongslot' } });
    expect(res.statusCode).toBe(422);
    expect(Object.keys(res.json().errors)).toContain('test.secretKey');
  });

  it('tests the connection with a read-only request and records the result', async () => {
    const good = await call(admin, 'POST', '/api/admin/xpay/test', { mode: 'live' });
    expect(good.json().data).toMatchObject({ ok: true, error: null });
    expect(good.json().data.settings.live.validatedAt).not.toBeNull();
    const probe = fakeFetch.mock.calls.at(-1)!;
    expect(String(probe[0])).toBe('https://api.xpay.app/account');
    expect(probe[1]?.method ?? 'GET').toBe('GET');

    outage = 'network';
    expect((await call(admin, 'POST', '/api/admin/xpay/test', { mode: 'live' })).json().data).toMatchObject({ ok: false, error: 'unreachable' });
    outage = 'none';

    // A revoked/invalid key: XPay answers 401.
    await saveXPaySettings(sql, encryptionKey, { enabled: true, mode: 'live', methods: ['card'], test: { secretKey: 'sk_test_revoked' } });
    expect((await call(admin, 'POST', '/api/admin/xpay/test', { mode: 'test' })).json().data).toMatchObject({ ok: false, error: 'invalid_key' });
    await configure();
  });

  it('switches live payments on only after a passing connection test and an explicit confirmation', async () => {
    await configure({ enabled: false, mode: 'test' });
    // Fresh keys: no passing test yet.
    await saveXPaySettings(sql, encryptionKey, { enabled: false, mode: 'test', methods: ['card'], live: { secretKey: 'sk_live_flow' } });
    const untested = await call(admin, 'PUT', '/api/admin/xpay', { enabled: true, mode: 'live', methods: ['card'], confirmLive: true });
    expect(untested.statusCode).toBe(422);
    expect(untested.json().code).toBe('test_connection_first');

    expect((await call(admin, 'POST', '/api/admin/xpay/test', { mode: 'live' })).json().data.ok).toBe(true);
    const unconfirmed = await call(admin, 'PUT', '/api/admin/xpay', { enabled: true, mode: 'live', methods: ['card'] });
    expect(unconfirmed.statusCode).toBe(422);
    expect(unconfirmed.json().code).toBe('confirm_live');

    const on = await call(admin, 'PUT', '/api/admin/xpay', { enabled: true, mode: 'live', methods: ['card'], confirmLive: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().data).toMatchObject({ enabled: true, mode: 'live' });
    expect((await call(customer, 'GET', '/api/payments/xpay')).json().data.enabled).toBe(true);

    // Rotating the webhook secret: a blank keeps the rest, the new one replaces the old.
    const rotated = await call(admin, 'PUT', '/api/admin/xpay', { enabled: true, mode: 'live', methods: ['card'], live: { webhookSecret: 'whsec_rotated' } });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().data.live).toMatchObject({ secretKeyHint: 'sk_live_••••flow', webhookSecretHint: 'whsec_••••ated' });
    const { session } = await openCheckout();
    markPaid(session);
    expect((await deliver('live', { type: 'checkout.session.completed', object: { id: session.id } })).statusCode).toBe(400);
    expect((await deliver('live', { type: 'checkout.session.completed', object: { id: session.id } }, { secret: 'whsec_rotated' })).statusCode).toBe(200);

    // The audit trail says what changed, never the secrets themselves.
    const logs = await sql<{ action: string; details: unknown }[]>`select action, details from audit_logs where actor_id = ${admin.userId} and action like 'xpay.%'`;
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['xpay.live_enabled', 'xpay.update', 'xpay.test_connection']));
    const dump = JSON.stringify(logs);
    for (const k of ['sk_live_flow', 'whsec_rotated', 'whsec_flowlive', 'sk_test_flow']) expect(dump).not.toContain(k);

    // Switching off leaves the platform working: customers fall back to the manual transfers.
    expect((await call(admin, 'PUT', '/api/admin/xpay', { enabled: false, mode: 'live', methods: ['card'] })).statusCode).toBe(200);
    expect((await call(customer, 'GET', '/api/payments/xpay')).json().data.enabled).toBe(false);
    expect((await call(customer, 'POST', '/api/plan-requests', { planId: 'basic', payment: { method: 'vodafone_cash', senderPhone: '01012345678' } })).json().code).not.toBe('pay_online');
    await sql`update plan_requests set status = 'cancelled' where workspace_id = ${customer.id} and status = 'pending'`;
  });

  // --- payment methods per XPay account --------------------------------------------------------------

  it('offers only the methods the XPay account has, and refuses the others in the settings', async () => {
    await configure();
    account.live.methods = ['fawry'];
    const tested = await call(admin, 'POST', '/api/admin/xpay/test', { mode: 'live' });
    expect(tested.json().data.settings.live.capabilities).toMatchObject({ methods: ['fawry'], livePaymentsEnabled: true, applePayOnWebsite: false });

    // Cards only, on an account without cards: refused, and XPay is off rather than offering something else.
    const refused = await call(admin, 'PUT', '/api/admin/xpay', { enabled: true, mode: 'live', methods: ['card'] });
    expect(refused.statusCode).toBe(422);
    expect(Object.keys(refused.json().errors)).toContain('methods');
    await saveXPaySettings(sql, encryptionKey, { enabled: true, mode: 'live', methods: ['card'] });
    expect((await call(customer, 'GET', '/api/payments/xpay')).json().data.enabled).toBe(false);

    // Cards + Fawry: the checkout offers Fawry only.
    expect((await call(admin, 'PUT', '/api/admin/xpay', { enabled: true, mode: 'live', methods: ['card', 'fawry'] })).statusCode).toBe(200);
    await openCheckout();
    expect(created.at(-1)!.body.paymentMethodTypes).toEqual(['fawry']);
    account.live.methods = ['card', 'fawry', 'valu'];
    await configure();
  });

  it('cannot switch live on for an account XPay has not enabled for live payments', async () => {
    await configure({ enabled: false, mode: 'test' });
    account.live.live = false;
    expect((await call(admin, 'POST', '/api/admin/xpay/test', { mode: 'live' })).json().data).toMatchObject({ ok: false, error: 'live_not_enabled' });
    const res = await call(admin, 'PUT', '/api/admin/xpay', { enabled: true, mode: 'live', methods: ['card'], confirmLive: true });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('test_connection_first');
    account.live.live = true;
    await configure();
  });

  // --- switching environments ----------------------------------------------------------------------

  it('switching modes keeps payments, secrets and records apart', async () => {
    // A test checkout opened by the admin while in test mode…
    await configure({ mode: 'test' });
    await resetPlan(admin);
    const test = await openCheckout(admin);
    expect(test.payment.mode).toBe('test');
    // …then the admin switches to live.
    await configure();
    const live = await openCheckout(customer);
    expect(live.payment.mode).toBe('live');

    // The test payment still settles on the test endpoint, with the test keys…
    markPaid(test.session);
    expect((await deliver('test', { id: 'evt_test_switch', type: 'checkout.session.completed', object: { id: test.session.id } })).statusCode).toBe(200);
    expect(await paymentRow(test.payment.id)).toMatchObject({ status: 'paid', mode: 'test' });
    // …and never through the live endpoint (the live key can't see a test session).
    expect((await deliver('live', { id: 'evt_live_switch', type: 'checkout.session.completed', object: { id: test.session.id } })).statusCode).toBe(200);
    const [handled] = await sql<{ outcome: string }[]>`select outcome from payment_events where event_id = 'evt_live_switch'`;
    expect(handled!.outcome).toBe('unknown_session');
    // The live payment isn't touched by the test endpoint either.
    markPaid(live.session);
    await deliver('test', { type: 'checkout.session.completed', object: { id: live.session.id } });
    expect((await paymentRow(live.payment.id)).status).toBe('pending');

    // The admin lists each mode's payments separately, labelled.
    const testList = (await call(admin, 'GET', '/api/admin/xpay/payments?mode=test')).json().data as { id: string; mode: string }[];
    const liveList = (await call(admin, 'GET', '/api/admin/xpay/payments?mode=live')).json().data as { id: string; mode: string }[];
    expect(testList.map((p) => p.id)).toContain(test.payment.id);
    expect(testList.map((p) => p.id)).not.toContain(live.payment.id);
    expect(liveList.map((p) => p.id)).toContain(live.payment.id);
    expect(liveList.map((p) => p.id)).not.toContain(test.payment.id);
    expect(new Set(testList.map((p) => p.mode))).toEqual(new Set(['test']));
    expect(new Set(liveList.map((p) => p.mode))).toEqual(new Set(['live']));
    expect((await call(customer, 'GET', '/api/admin/xpay/payments?mode=live')).statusCode).toBe(403);
  });
});
