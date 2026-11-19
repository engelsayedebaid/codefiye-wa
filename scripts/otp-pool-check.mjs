/**
 * Local checks for the OTP router and delivery seal.
 * No database, no WhatsApp, no network.
 * Run: node --experimental-strip-types scripts/otp-pool-check.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { chooseOtpSession, decideResend, formatOtpMessage } from '../packages/shared/src/otp-pool.ts';
import { decrypt, encrypt, otpDeliveryKey } from '../packages/provider/src/crypto.ts';

const base = {
  enabled: true,
  membership: 'active',
  connected: true,
  restricted: false,
  queued: 0,
  inFlight: 0,
  avgSendMs: 2_000,
  lastAssignedAt: null,
};

function candidate(patch) {
  return { ...base, ...patch };
}

const opts = { ttlRemainingMs: 300_000, maxQueue: 40 };

const skipped = chooseOtpSession(
  [
    candidate({ sessionId: 'a', enabled: false }),
    candidate({ sessionId: 'b', membership: 'draining' }),
    candidate({ sessionId: 'c', connected: false }),
    candidate({ sessionId: 'd', restricted: true }),
    candidate({ sessionId: 'e', queued: 40 }),
    candidate({ sessionId: 'f', queued: 200 }),
  ],
  opts,
);
assert.equal(skipped, null);

const busy = chooseOtpSession(
  [candidate({ sessionId: 'busy', queued: 10 }), candidate({ sessionId: 'idle', queued: 1, lastAssignedAt: 9 })],
  opts,
);
assert.equal(busy.sessionId, 'idle');

const tie = chooseOtpSession(
  [
    candidate({ sessionId: 'newer', lastAssignedAt: 50 }),
    candidate({ sessionId: 'older', lastAssignedAt: 10 }),
  ],
  opts,
);
assert.equal(tie.sessionId, 'older');

const now = 1_000_000;
const common = {
  verifyStatus: 'open',
  deliveryStatus: 'sent',
  sendStarted: true,
  sends: 1,
  maxSends: 5,
  lastSentAtMs: now - 120_000,
  cooldownSec: 60,
  expiresAtMs: now + 60_000,
  nowMs: now,
  sessionRestricted: false,
  sessionId: 'session-a',
};

assert.deepEqual(decideResend(common), { action: 'replay', sessionId: 'session-a' });
assert.equal(decideResend({ ...common, deliveryStatus: 'uncertain' }).code, 'uncertain_delivery');
assert.equal(decideResend({ ...common, sessionRestricted: true, deliveryStatus: 'failed', sendStarted: false }).code, 'session_restricted');
assert.equal(decideResend({ ...common, deliveryStatus: 'failed', sendStarted: false, sessionRestricted: false }).action, 'reroute');
assert.equal(decideResend({ ...common, verifyStatus: 'verified' }).code, 'consumed');
assert.equal(decideResend({ ...common, sends: 5 }).code, 'too_many_sends');
assert.equal(decideResend({ ...common, lastSentAtMs: now - 1_000 }).code, 'cooldown');

const text = formatOtpMessage('482913', 'en', 300);
assert.match(text, /482913/);
assert.doesNotMatch(text, /••••••/);

const key = otpDeliveryKey(Buffer.alloc(32, 7));
const blob = encrypt(key, Buffer.from(text), 'otp:challenge-1');
assert.equal(decrypt(key, blob, 'otp:challenge-1').toString(), text);
assert.throws(() => decrypt(key, blob, 'otp:challenge-2'));

const hash = (id, code) => createHmac('sha256', Buffer.from('test-key')).update(`${id}:${code}`).digest('base64url');
const stored = hash('id-1', '482913');
const actual = Buffer.from(hash('id-1', '482913'));
const expected = Buffer.from(stored);
assert.equal(actual.length === expected.length && timingSafeEqual(actual, expected), true);
assert.notEqual(hash('id-1', '482913'), hash('id-2', '482913'));

const gateway = readFileSync(new URL('../apps/api/src/routes/otp-gateway.ts', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../apps/worker/src/runner.ts', import.meta.url), 'utf8');
assert.match(gateway, /text: '••••••'/);
assert.match(gateway, /status: 'queued'/);
assert.doesNotMatch(gateway, /data: \{[^}]*code/);
assert.match(worker, /markOtpSendStarted/);
assert.match(worker, /uncertain/);
assert.match(worker, /finishOtpDelivery/);

console.log('otp-pool-check: ok');
