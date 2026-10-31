import { createHmac } from 'node:crypto';
import { keyMode, type XPayModeView, xpayLiveForCustomers, xpayReady, type XPaySettings } from '@wa/shared';
import { describe, expect, it } from 'vitest';
import { reviewReasons, verifyWebhook, type XPaySession } from '../src/lib/xpay';

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
