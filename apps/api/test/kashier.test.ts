import { kashierAvailableMethods, kashierLiveForCustomers, type KashierModeView, kashierReady, type KashierSettings } from '@wa/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  allowedMethodsParam,
  type KashierAccount,
  kashierAmount,
  kashierEventId,
  kashierReviewReasons,
  kashierSignature,
  parseKashierAmount,
  testKashierConnection,
  verifyKashierWebhook,
} from '../src/lib/kashier';

// The worked example of https://developers.kashier.io/docs/webhooks#step-4-verify-the-signature:
// Payment API Key `11111`, digest 9610477b2255b2a8ef84fd89adfaa5f1305ff9c20324205851890f1ea03109f4.
const OFFICIAL = {
  amount: 1,
  channel: 'online | e-commerce',
  currency: 'EGP',
  kashierOrderId: '9ad06b17-755b-4e21-9774-aff3e2726ac9',
  merchantOrderId: '1653481557813',
  method: 'card',
  orderReference: 'TEST-ORD-38855',
  status: 'SUCCESS',
  transactionId: 'TX-249893963',
  transactionResponseCode: '00',
  signatureKeys: ['amount', 'channel', 'currency', 'kashierOrderId', 'merchantOrderId', 'method', 'orderReference', 'status', 'transactionId', 'transactionResponseCode'],
};
const OFFICIAL_DIGEST = '9610477b2255b2a8ef84fd89adfaa5f1305ff9c20324205851890f1ea03109f4';

describe('Kashier webhook signature', () => {
  it('reproduces the official worked example exactly', () => {
    expect(kashierSignature(OFFICIAL, '11111')).toBe(OFFICIAL_DIGEST);
    expect(verifyKashierWebhook(OFFICIAL, OFFICIAL_DIGEST, '11111')).toBe(true);
  });

  it('sorts signatureKeys itself and compares hex case-insensitively', () => {
    const shuffled = { ...OFFICIAL, signatureKeys: [...OFFICIAL.signatureKeys].reverse() };
    expect(kashierSignature(shuffled, '11111')).toBe(OFFICIAL_DIGEST);
    expect(verifyKashierWebhook(shuffled, OFFICIAL_DIGEST.toUpperCase(), '11111')).toBe(true);
  });

  it('rejects a changed value, a wrong key, a missing header, or no signature keys', () => {
    expect(verifyKashierWebhook({ ...OFFICIAL, status: 'FAILURE' }, OFFICIAL_DIGEST, '11111')).toBe(false);
    expect(verifyKashierWebhook({ ...OFFICIAL, amount: 2 }, OFFICIAL_DIGEST, '11111')).toBe(false);
    expect(verifyKashierWebhook(OFFICIAL, OFFICIAL_DIGEST, '22222')).toBe(false);
    expect(verifyKashierWebhook(OFFICIAL, undefined, '11111')).toBe(false);
    expect(verifyKashierWebhook({ ...OFFICIAL, signatureKeys: [] }, OFFICIAL_DIGEST, '11111')).toBe(false);
    expect(verifyKashierWebhook({ ...OFFICIAL, signatureKeys: undefined }, OFFICIAL_DIGEST, '11111')).toBe(false);
    // A signed key that is missing from data can't be verified.
    const { transactionId: _drop, ...missing } = OFFICIAL;
    expect(verifyKashierWebhook(missing, OFFICIAL_DIGEST, '11111')).toBe(false);
  });

  it('only covers the signed keys: unsigned extras do not matter, but they are never trusted either', () => {
    expect(verifyKashierWebhook({ ...OFFICIAL, merchantDetails: { businessEmail: 'x@y' }, extra: 'z' }, OFFICIAL_DIGEST, '11111')).toBe(true);
  });

  it('dedupes on transaction + status + event, as Kashier advises', () => {
    expect(kashierEventId('pay', OFFICIAL)).toBe('TX-249893963:SUCCESS:pay');
    expect(kashierEventId('refund', { ...OFFICIAL, status: 'SUCCESS' })).toBe('TX-249893963:SUCCESS:refund');
  });
});

describe('Kashier amounts', () => {
  it('sends EGP major units with two decimals and reads them back as piastres', () => {
    expect(kashierAmount(30_000)).toBe('300.00');
    expect(kashierAmount(16_550)).toBe('165.50');
    expect(parseKashierAmount('300.00')).toBe(30_000);
    expect(parseKashierAmount('165.5')).toBe(16_550);
    expect(parseKashierAmount(300)).toBe(30_000);
    for (const bad of ['', 'abc', '1e3', '-5', '10.999', null, undefined, {}]) expect(parseKashierAmount(bad)).toBeNaN();
  });
});

describe('Kashier payment checks', () => {
  const payment = { id: 'p-1', amountCents: 30_000, currency: 'EGP' };
  const paid = { status: 'PAID', merchantId: 'MID-1-2', merchantOrderId: 'p-1', amount: '300.00', currency: 'EGP' };
  it('passes the exact order', () => {
    expect(kashierReviewReasons(paid, payment, 'MID-1-2')).toEqual([]);
    expect(kashierReviewReasons({ ...paid, merchantId: 'mid-1-2' }, payment, 'MID-1-2')).toEqual([]);
  });
  it('flags another merchant, order, currency or amount', () => {
    expect(kashierReviewReasons({ ...paid, merchantId: 'MID-9-9' }, payment, 'MID-1-2')).toContain('merchant_mismatch');
    expect(kashierReviewReasons({ ...paid, merchantOrderId: 'p-2' }, payment, 'MID-1-2')).toContain('order_mismatch');
    expect(kashierReviewReasons({ ...paid, currency: 'USD' }, payment, 'MID-1-2')).toContain('currency_mismatch');
    expect(kashierReviewReasons({ ...paid, amount: '299.99' }, payment, 'MID-1-2')).toContain('amount_mismatch');
    expect(kashierReviewReasons({ ...paid, amount: '300.01' }, payment, 'MID-1-2')).toContain('amount_mismatch');
    expect(kashierReviewReasons({ ...paid, amount: undefined }, payment, 'MID-1-2')).toContain('amount_mismatch');
  });
});

describe('Kashier methods', () => {
  it('requests BNPL providers as bnpl[x] and omits the list when everything the account has is offered', () => {
    expect(allowedMethodsParam(['card', 'wallet', 'valu'], ['card', 'wallet', 'valu', 'souhoola'])).toBe('card,wallet,bnpl[valu]');
    expect(allowedMethodsParam(['card', 'wallet'], ['card', 'wallet'])).toBeUndefined();
    expect(allowedMethodsParam(['card'], null)).toBe('card');
  });
  it('offers only what the admin picked and the account has', () => {
    expect(kashierAvailableMethods(['card', 'wallet', 'valu'], ['card', 'valu'])).toEqual(['card', 'valu']);
    expect(kashierAvailableMethods(['card', 'wallet'], null)).toEqual(['card', 'wallet']);
  });
});

const view = (over: Partial<KashierModeView> = {}): KashierModeView => ({
  merchantId: '',
  secretKeyHint: null,
  apiKeyHint: null,
  unreadable: false,
  webhookUrl: '',
  validatedAt: null,
  validationError: null,
  apiKeyUnconfirmed: false,
  lastWebhookAt: null,
  accountMethods: null,
  ...over,
});
const complete = (over: Partial<KashierModeView> = {}) => view({ merchantId: 'MID-1-2', secretKeyHint: '••••abcd', apiKeyHint: '••••efgh', ...over });
const settings = (over: Partial<KashierSettings> = {}): KashierSettings => ({ enabled: true, mode: 'live', methods: ['card'], test: complete(), live: complete(), encryptionReady: true, testers: [], ...over });

describe('Kashier readiness and mode isolation', () => {
  it('needs the active mode complete, a method the account has, the encryption key and the switch on', () => {
    expect(kashierReady(settings())).toBe(true);
    expect(kashierReady(settings({ enabled: false }))).toBe(false);
    expect(kashierReady(settings({ encryptionReady: false }))).toBe(false);
    expect(kashierReady(settings({ methods: [] }))).toBe(false);
    expect(kashierReady(settings({ live: complete({ apiKeyHint: null }) }))).toBe(false);
    expect(kashierReady(settings({ live: complete({ merchantId: 'nope' }) }))).toBe(false);
    expect(kashierReady(settings({ live: complete({ unreadable: true }) }))).toBe(false);
    expect(kashierReady(settings({ live: complete({ accountMethods: ['wallet'] }) }))).toBe(false);
  });
  it('never falls back to the other mode, and only live mode serves customers', () => {
    expect(kashierReady(settings({ live: view() }))).toBe(false);
    expect(kashierLiveForCustomers(settings())).toBe(true);
    expect(kashierLiveForCustomers(settings({ mode: 'test' }))).toBe(false);
  });
});

describe('Kashier connection test', () => {
  const account: KashierAccount = { mode: 'live', merchantId: 'MID-1-2', secretKey: 'secret-live-key', apiKey: 'api-live-key', methods: ['card'] };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const route = (handlers: Record<string, () => Response>) =>
    vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      const key = Object.keys(handlers).find((k) => path.startsWith(k));
      if (!key) throw new Error(`unexpected ${path}`);
      return handlers[key]!();
    });

  it('validates the keys and reads the account methods, on the mode host', async () => {
    const fetchImpl = route({ '/v2/merchants/validate-credentials': () => json(200, { ok: true }), '/v2/merchants/MID-1-2/paymentMethods': () => json(200, { card: true, wallet: true, bank_installments: false }) });
    const result = await testKashierConnection(account, fetchImpl as never);
    expect(result).toEqual({ error: null, apiKeyUnconfirmed: true, accountMethods: ['card', 'wallet'] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.kashier.io/v2/merchants/validate-credentials');
    expect(new Headers(init.headers).get('authorization')).toBe('secret-live-key');
    expect(JSON.parse(String(init.body))).toEqual({ secretKeys: [{ mode: 'live', key: 'secret-live-key' }], apiKeys: [{ mode: 'live', key: 'api-live-key' }] });
  });

  it('reads a plainly stated verdict, and maps errors and outages', async () => {
    const ok = route({ '/v2/merchants/validate-credentials': () => json(200, { apiKeys: [{ valid: true }], secretKeys: [{ valid: true }] }), '/v2/merchants/': () => json(200, { card: true }) });
    expect((await testKashierConnection(account, ok as never)).apiKeyUnconfirmed).toBe(false);
    const badApi = route({ '/v2/merchants/validate-credentials': () => json(200, { apiKeys: [{ valid: false }] }) });
    expect((await testKashierConnection(account, badApi as never)).error).toBe('invalid_api_key');
    const wrongMode = route({ '/v2/merchants/validate-credentials': () => json(200, { secretKeys: [{ isValid: false }] }) });
    expect((await testKashierConnection(account, wrongMode as never)).error).toBe('wrong_mode');
    expect((await testKashierConnection(account, route({ '/v2/merchants/validate-credentials': () => json(401, { messages: { en: 'unauthorized' } }) }) as never)).error).toBe('invalid_secret_key');
    expect((await testKashierConnection(account, route({ '/v2/merchants/validate-credentials': () => json(403, {}) }) as never)).error).toBe('forbidden');
    const badMid = route({ '/v2/merchants/validate-credentials': () => json(200, {}), '/v2/merchants/MID-1-2': () => json(400, { message: 'Merchant not found' }) });
    expect((await testKashierConnection(account, badMid as never)).error).toBe('invalid_merchant');
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await testKashierConnection(account, down as never)).error).toBe('unreachable');
  });

  it('never lists a method Kashier has no name for', async () => {
    const fetchImpl = route({ '/v2/merchants/validate-credentials': () => json(200, {}), '/v2/merchants/': () => json(200, { card: true, fawry: true, instapay: true, wallet: false }) });
    expect((await testKashierConnection(account, fetchImpl as never)).accountMethods).toEqual(['card']);
  });
});
