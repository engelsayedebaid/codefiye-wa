import { createHmac } from 'node:crypto';
import { keyMode, type XPayCapabilities, xpayAvailableMethods, type XPayModeView, xpayLiveForCustomers, xpayReady, type XPaySettings } from '@wa/shared';
import { describe, expect, it, vi } from 'vitest';
import { reviewReasons, testConnection, verifyWebhook, type XPayAccount, type XPaySession } from '../src/lib/xpay';

const SECRET = 'whsec_test_secret';
const now = Date.UTC(2026, 9, 31, 12);
const t = Math.floor(now / 1000);
const body = JSON.stringify({ id: 'evt_test_1', type: 'checkout.session.completed', livemode: false, data: { object: { id: 'cs_1' } } });
const sign = (payload: string, ts = t, secret = SECRET) => `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex')}`;

// Format per https://docs.xpay.app/en/integrate/webhooks/verifying-signatures:
// `XPay-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`, 300 s window.
describe('XPay webhook signature', () => {
  it('accepts a correctly signed event', () => {
    expect(verifyWebhook(body, sign(body), SECRET, now)?.data.object.id).toBe('cs_1');
  });

  it('rejects a changed body, a wrong secret, a malformed or missing header', () => {
    expect(verifyWebhook(body.replace('cs_1', 'cs_2'), sign(body), SECRET, now)).toBeNull();
    expect(verifyWebhook(body, sign(body, t, 'whsec_other'), SECRET, now)).toBeNull();
    expect(verifyWebhook(body, undefined, SECRET, now)).toBeNull();
    expect(verifyWebhook(body, 'garbage', SECRET, now)).toBeNull();
    expect(verifyWebhook(body, `t=${t}`, SECRET, now)).toBeNull();
    expect(verifyWebhook(body, `v1=${sign(body).split('v1=')[1]}`, SECRET, now)).toBeNull();
  });

  it('verifies the raw bytes: the same JSON re-serialised differently fails', () => {
    const spaced = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifyWebhook(spaced, sign(body), SECRET, now)).toBeNull();
  });

  it('enforces the five-minute replay window both ways', () => {
    expect(verifyWebhook(body, sign(body, t - 301), SECRET, now)).toBeNull();
    expect(verifyWebhook(body, sign(body, t - 299), SECRET, now)).not.toBeNull();
    expect(verifyWebhook(body, sign(body, t + 301), SECRET, now)).toBeNull();
    expect(verifyWebhook(body, sign(body, t + 299), SECRET, now)).not.toBeNull();
  });

  it('accepts an uppercase hex signature and rejects a signed body that is not an event', () => {
    expect(verifyWebhook(body, sign(body).toUpperCase().replace('T=', 't=').replace('V1=', 'v1='), SECRET, now)).not.toBeNull();
    const notEvent = JSON.stringify({ hello: 'world' });
    expect(verifyWebhook(notEvent, sign(notEvent), SECRET, now)).toBeNull();
  });
});

const view = (over: Partial<XPayModeView> = {}): XPayModeView => ({
  publishableKey: '',
  secretKeyHint: null,
  webhookSecretHint: null,
  unreadable: false,
  webhookUrl: '',
  validatedAt: null,
  validationError: null,
  lastWebhookAt: null,
  capabilities: null,
  ...over,
});
const settings = (over: Partial<XPaySettings> = {}): XPaySettings => ({
  enabled: true,
  mode: 'live',
  methods: ['card'],
  encryptionReady: true,
  test: view({ publishableKey: 'pk_test_x', secretKeyHint: 'sk_test_••••abcd', webhookSecretHint: 'whsec_••••abcd' }),
  live: view({ publishableKey: 'pk_live_x', secretKeyHint: 'sk_live_••••abcd', webhookSecretHint: 'whsec_••••abcd' }),
  ...over,
});

describe('XPay readiness and mode isolation', () => {
  it('needs the active mode complete, a method, the encryption key, and the switch on', () => {
    expect(xpayReady(settings())).toBe(true);
    expect(xpayReady(settings({ enabled: false }))).toBe(false);
    expect(xpayReady(settings({ methods: [] }))).toBe(false);
    expect(xpayReady(settings({ encryptionReady: false }))).toBe(false);
    expect(xpayReady(settings({ live: view({ publishableKey: 'pk_live_x', secretKeyHint: 'sk_live_••••abcd' }) }))).toBe(false);
    expect(xpayReady(settings({ live: view({ publishableKey: 'pk_live_x', secretKeyHint: 'x', webhookSecretHint: 'y', unreadable: true }) }))).toBe(false);
  });

  it('never falls back to the other mode', () => {
    // Live chosen but incomplete: off, even though Test is complete.
    expect(xpayReady(settings({ live: view() }))).toBe(false);
    // A test publishable key in the live slot doesn't count as live.
    expect(xpayReady(settings({ live: view({ publishableKey: 'pk_test_x', secretKeyHint: 'a', webhookSecretHint: 'b' }) }))).toBe(false);
  });

  it('only live mode is offered to customers', () => {
    expect(xpayLiveForCustomers(settings())).toBe(true);
    expect(xpayLiveForCustomers(settings({ mode: 'test' }))).toBe(false);
    expect(keyMode('sk_live_abc')).toBe('live');
    expect(keyMode('pk_test_abc')).toBe('test');
    expect(keyMode('sk_abc')).toBeNull();
  });
});

describe('XPay amount and order checks', () => {
  const payment = { id: 'p-1', workspaceId: 'w-1', amountCents: 30_000, currency: 'EGP', mode: 'live' as const };
  const paid = (over: Partial<XPaySession> = {}): XPaySession => ({
    id: 'cs_1',
    status: 'complete',
    paymentStatus: 'paid',
    livemode: true,
    currency: 'EGP',
    amountSubtotal: 30_000,
    amountTotal: 30_000,
    totalDetails: { amountDiscount: 0, amountTax: 0 },
    metadata: { paymentId: 'p-1', workspaceId: 'w-1' },
    ...over,
  });

  it('passes an exact payment', () => {
    expect(reviewReasons(paid(), payment)).toEqual([]);
  });

  it('passes XPay fees and VAT passed through to the customer when itemised', () => {
    expect(reviewReasons(paid({ amountTotal: 31_050, totalDetails: { amountDiscount: 0, amountTax: 0, amountPlatformFee: 900, amountCollectedVat: 150 } }), payment)).toEqual([]);
    // Amounts as strings (the SDK prints them so) still count.
    expect(reviewReasons(paid({ amountSubtotal: '30000', amountTotal: '30900', totalDetails: { amountDiscount: 0, amountTax: 0, amountPlatformFee: 900 } }), payment)).toEqual([]);
  });

  it('flags a short payment, an unexplained surplus, a discount, or excessive fees', () => {
    expect(reviewReasons(paid({ amountSubtotal: 29_900, amountTotal: 29_900 }), payment)).toContain('subtotal_mismatch');
    expect(reviewReasons(paid({ amountTotal: 31_000 }), payment)).toContain('total_mismatch');
    expect(reviewReasons(paid({ amountTotal: 29_000 }), payment)).toContain('total_mismatch');
    expect(reviewReasons(paid({ amountTotal: 27_000, totalDetails: { amountDiscount: 3_000, amountTax: 0 } }), payment)).toContain('discounted');
    expect(reviewReasons(paid({ amountTotal: 40_000, totalDetails: { amountDiscount: 0, amountTax: 0, amountPlatformFee: 10_000 } }), payment)).toContain('fees_too_high');
    expect(reviewReasons(paid({ amountTotal: undefined }), payment)).toContain('total_mismatch');
  });

  it('flags another currency, another order, or the other mode', () => {
    expect(reviewReasons(paid({ currency: 'USD' }), payment)).toContain('currency_mismatch');
    expect(reviewReasons(paid({ metadata: { paymentId: 'p-2', workspaceId: 'w-1' } }), payment)).toContain('order_mismatch');
    expect(reviewReasons(paid({ metadata: { paymentId: 'p-1', workspaceId: 'w-2' } }), payment)).toContain('order_mismatch');
    expect(reviewReasons(paid({ metadata: undefined }), payment)).toContain('order_mismatch');
    expect(reviewReasons(paid({ livemode: false }), payment)).toContain('mode_mismatch');
    expect(reviewReasons(paid({ livemode: undefined }), payment)).toContain('mode_mismatch');
  });
});

const caps = (over: Partial<XPayCapabilities> = {}): XPayCapabilities => ({ accountName: 'Shop', methods: ['card', 'fawry'], applePayOnWebsite: false, livePaymentsEnabled: true, ...over });

describe('XPay payment methods offered', () => {
  it('offers only what the admin picked and the account can charge', () => {
    expect(xpayAvailableMethods(['card', 'valu', 'fawry'], caps())).toEqual(['card', 'fawry']);
    // Unknown until the first connection test: the admin's choice stands.
    expect(xpayAvailableMethods(['card', 'valu'], null)).toEqual(['card', 'valu']);
  });

  it('offers Apple Pay only when XPay reports it ready for our website', () => {
    expect(xpayAvailableMethods(['card', 'apple_pay'], caps({ methods: ['card', 'apple_pay'] }))).toEqual(['card']);
    expect(xpayAvailableMethods(['card', 'apple_pay'], caps({ methods: ['card', 'apple_pay'], applePayOnWebsite: true }))).toEqual(['card', 'apple_pay']);
  });

  it('is not ready when none of the chosen methods is on the account', () => {
    const live = view({ publishableKey: 'pk_live_x', secretKeyHint: 'a', webhookSecretHint: 'b', capabilities: caps({ methods: ['fawry'] }) });
    expect(xpayReady(settings({ methods: ['card'], live }))).toBe(false);
    expect(xpayReady(settings({ methods: ['card', 'fawry'], live }))).toBe(true);
  });
});

describe('XPay connection test (GET /account)', () => {
  const account = (mode: 'test' | 'live'): XPayAccount => ({ mode, publishableKey: `pk_${mode}_x`, secretKey: `sk_${mode}_x`, webhookSecret: 'whsec_x', methods: ['card'] });
  const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  const accountBody = (over: Record<string, unknown> = {}) => ({
    id: 'acct_1',
    displayName: 'CodeFiye',
    livemode: true,
    livePaymentsEnabled: true,
    apiKey: { type: 'SECRET', mode: 'live', permissions: [] },
    supportedCurrencies: [
      { code: 'EGP', decimals: 2, paymentMethodTypes: ['card', 'fawry', 'valu', 'apple_pay'] },
      { code: 'USD', decimals: 2, paymentMethodTypes: ['card'] },
    ],
    wallets: [{ type: 'apple_pay', websiteReady: true }],
    ...over,
  });

  it('reads the account with the secret key and records what it can do in EGP', async () => {
    const fetchImpl = answer(200, accountBody());
    const result = await testConnection(account('live'), fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ error: null, capabilities: { accountName: 'CodeFiye', methods: ['card', 'apple_pay', 'valu', 'fawry'], applePayOnWebsite: true, livePaymentsEnabled: true } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.xpay.app/account');
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk_live_x');
  });

  it('refuses a key of the other mode, a live account without live payments, or no EGP', async () => {
    expect((await testConnection(account('live'), answer(200, accountBody({ apiKey: { mode: 'test' }, livemode: false })) as never)).error).toBe('wrong_mode');
    expect((await testConnection(account('live'), answer(200, accountBody({ livePaymentsEnabled: false })) as never)).error).toBe('live_not_enabled');
    expect((await testConnection(account('live'), answer(200, accountBody({ supportedCurrencies: [{ code: 'USD', decimals: 2, paymentMethodTypes: ['card'] }] })) as never)).error).toBe('egp_unsupported');
    expect((await testConnection(account('live'), answer(200, accountBody({ supportedCurrencies: [{ code: 'EGP', decimals: 3, paymentMethodTypes: ['card'] }] })) as never)).error).toBe('unexpected');
    // A test account needs no live payments.
    expect((await testConnection(account('test'), answer(200, accountBody({ apiKey: { mode: 'test' }, livemode: false, livePaymentsEnabled: false })) as never)).error).toBeNull();
  });

  it('maps XPay errors and outages', async () => {
    expect((await testConnection(account('live'), answer(401, { error: { code: 'unauthorized' } }) as never)).error).toBe('invalid_key');
    expect((await testConnection(account('live'), answer(403, { error: { code: 'forbidden' } }) as never)).error).toBe('forbidden');
    expect((await testConnection(account('live'), answer(500, { error: { code: 'internal' } }) as never)).error).toBe('unexpected');
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await testConnection(account('live'), down as never)).error).toBe('unreachable');
    expect((await testConnection({ ...account('live'), secretKey: 'sk_test_x' }, down as never)).error).toBe('wrong_mode');
    expect(down).toHaveBeenCalledTimes(1);
  });

  it('only knows the methods XPay documents: no mobile wallets appear even if listed', async () => {
    const body = accountBody({ supportedCurrencies: [{ code: 'EGP', decimals: 2, paymentMethodTypes: ['card', 'vodafone_cash', 'wallet'] }] });
    expect((await testConnection(account('live'), answer(200, body) as never)).capabilities?.methods).toEqual(['card']);
  });
});
