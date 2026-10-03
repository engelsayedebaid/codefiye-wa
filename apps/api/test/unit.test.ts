import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { trustRule } from '../src/app';
import { scrubUrl } from '../src/lib/log';
import { generateOtp, hashOtp, OTP_POLICY, otpKey, otpMatches, otpText } from '../src/lib/otp';
import { hashPassword, needsRehash, passwordProblems, verifyPassword } from '../src/lib/passwords';
import { createFailureGuard } from '../src/lib/throttle';
import { normalizeCode } from '../src/lib/verification';

describe('passwords', () => {
  it('hashes with today’s parameters and verifies', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$16384\$8\$5\$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batterz', hash)).toBe(false);
    expect(needsRehash(hash)).toBe(false);
  });

  it('still verifies older, weaker hashes and flags them for an upgrade', async () => {
    const salt = randomBytes(16);
    const key = scryptSync('old one', salt, 64, { N: 16_384, r: 8, p: 1 });
    const legacy = ['scrypt', 16_384, 8, 1, salt.toString('base64'), key.toString('base64')].join('$');
    expect(await verifyPassword('old one', legacy)).toBe(true);
    expect(needsRehash(legacy)).toBe(true);
  });

  it('spends time and fails for accounts without a password', async () => {
    expect(await verifyPassword('anything', null)).toBe(false);
    expect(needsRehash(null)).toBe(false);
  });

  it('refuses short, common and email-equal passwords only', () => {
    expect(passwordProblems('short')).toEqual(['Use at least 8 characters']);
    expect(passwordProblems('Password123')).toEqual(['This password is too common']);
    expect(passwordProblems('aaaaaaaaaaaa')).toEqual(['This password is too common']);
    expect(passwordProblems('me@example.com', 'ME@example.com')).toEqual(["Don't use your email as the password"]);
    expect(passwordProblems('a long passphrase', 'me@example.com')).toBeNull();
  });
});

describe('verification codes', () => {
  const key = otpKey(undefined, 'x'.repeat(16));

  it('generates six random digits', () => {
    const codes = new Set(Array.from({ length: 200 }, generateOtp));
    for (const code of codes) expect(code).toMatch(/^\d{6}$/);
    expect(codes.size).toBeGreaterThan(190);
  });

  it('stores an HMAC bound to the verification, never the code', () => {
    const hash = hashOtp(key, 'v1', '123456');
    expect(hash).not.toContain('123456');
    expect(otpMatches(key, 'v1', '123456', hash)).toBe(true);
    expect(otpMatches(key, 'v1', '123457', hash)).toBe(false);
    // The same code for another verification, or under another key, doesn't match.
    expect(otpMatches(key, 'v2', '123456', hash)).toBe(false);
    expect(otpMatches(otpKey('y'.repeat(32), 'x'.repeat(16)), 'v1', '123456', hash)).toBe(false);
  });

  it('derives a stable key when OTP_SECRET is not set', () => {
    expect(otpKey(undefined, 'x'.repeat(16)).equals(key)).toBe(true);
    expect(otpKey(undefined, 'z'.repeat(16)).equals(key)).toBe(false);
  });

  it('localises the message and states the validity', () => {
    expect(otpText('654321', 'en')).toContain('654321');
    expect(otpText('654321', 'en')).toContain(`${OTP_POLICY.ttlSec / 60} minutes`);
    expect(otpText('654321', 'ar')).toContain('654321');
    expect(otpText('654321', 'ar')).toContain('رمز التحقق');
  });

  it('reads codes typed with Arabic digits or separators', () => {
    expect(normalizeCode('١٢٣ ٤٥٦')).toBe('123456');
    expect(normalizeCode('123-456')).toBe('123456');
  });
});

describe('logging', () => {
  it('drops query strings and phone numbers from logged URLs', () => {
    expect(scrubUrl('/api/admin/users?q=someone@example.com')).toBe('/api/admin/users');
    expect(scrubUrl('/api/on-whatsapp/+201012345678')).toBe('/api/on-whatsapp/+***');
    expect(scrubUrl('/api/messages/42')).toBe('/api/messages/42');
  });
});

describe('proxy trust', () => {
  it('turns a hop count into "trust the nearest N peers"', () => {
    const rule = trustRule(1) as (address: string, hop: number) => boolean;
    expect(rule('10.0.0.1', 0)).toBe(true);
    expect(rule('203.0.113.9', 1)).toBe(false);
  });

  it('passes other settings through and defaults to no trust', () => {
    expect(trustRule(undefined)).toBe(false);
    expect(trustRule('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(trustRule(true)).toBe(true);
  });
});

describe('failed-auth guard', () => {
  it('blocks an address after too many failures, per address', () => {
    const guard = createFailureGuard({ limit: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      guard.check('1.1.1.1');
      guard.fail('1.1.1.1');
    }
    expect(() => guard.check('1.1.1.1')).toThrow(/Too many failed/);
    expect(() => guard.check('2.2.2.2')).not.toThrow();
  });

  it('forgets failures once the window has passed', async () => {
    const guard = createFailureGuard({ limit: 1, windowMs: 20 });
    guard.fail('1.1.1.1');
    expect(() => guard.check('1.1.1.1')).toThrow();
    await new Promise((r) => setTimeout(r, 30));
    expect(() => guard.check('1.1.1.1')).not.toThrow();
  });
});
