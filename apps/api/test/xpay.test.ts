import { createHmac } from 'node:crypto';
import { xpayReady } from '@wa/shared';
import { describe, expect, it } from 'vitest';
import { verifyWebhook } from '../src/lib/xpay';

const SECRET = 'whsec_test_secret';
const now = Date.UTC(2026, 9, 31, 12);
const t = Math.floor(now / 1000);
const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', status: 'complete', paymentStatus: 'paid' } } });
const sign = (payload: string, ts = t, secret = SECRET) => `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex')}`;

describe('XPay webhook signature', () => {
  it('accepts a correctly signed event', () => {
    expect(verifyWebhook(body, sign(body), SECRET, now)?.data.object.id).toBe('cs_1');
  });

  it('rejects a changed body, a wrong secret, or a missing header', () => {
    expect(verifyWebhook(body.replace('paid', 'unpaid'), sign(body), SECRET, now)).toBeNull();
    expect(verifyWebhook(body, sign(body, t, 'whsec_other'), SECRET, now)).toBeNull();
    expect(verifyWebhook(body, undefined, SECRET, now)).toBeNull();
    expect(verifyWebhook(body, 'garbage', SECRET, now)).toBeNull();
  });

  it('rejects a replay outside five minutes', () => {
    expect(verifyWebhook(body, sign(body, t - 301), SECRET, now)).toBeNull();
    expect(verifyWebhook(body, sign(body, t - 299), SECRET, now)).not.toBeNull();
  });
});

describe('XPay readiness', () => {
  const ready = { enabled: true, publishableKey: 'pk_test_x', methods: ['card' as const], hasSecretKey: true, hasWebhookSecret: true };
  it('needs every key and a method', () => {
    expect(xpayReady(ready)).toBe(true);
    expect(xpayReady({ ...ready, enabled: false })).toBe(false);
    expect(xpayReady({ ...ready, hasWebhookSecret: false })).toBe(false);
    expect(xpayReady({ ...ready, methods: [] })).toBe(false);
  });
});
