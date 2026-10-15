import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Authenticator-app codes (RFC 6238: HMAC-SHA1, 6 digits, 30 s steps), as Google Authenticator,
 * Microsoft Authenticator, Authy and 1Password expect by default.
 */
export const TOTP = { digits: 6, periodSec: 30, /** Steps accepted either side of now, for clock drift. */ window: 1 } as const;

/** How long a one-time skip of the setup screen lasts. After it, setup is mandatory. */
export const TWO_FACTOR_GRACE_MS = 48 * 60 * 60 * 1000;

/**
 * End of a one-time skip, while it still lets the dashboard through.
 * Null when the user never skipped, or the 48 hours have passed.
 */
export function twoFactorGraceUntil(skippedAt: Date | string | null, now = Date.now()): Date | null {
  if (!skippedAt) return null;
  const at = skippedAt instanceof Date ? skippedAt.getTime() : Date.parse(skippedAt);
  if (!Number.isFinite(at)) return null;
  const until = at + TWO_FACTOR_GRACE_MS;
  return until > now ? new Date(until) : null;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret, base32 (what the app's "enter a setup key" field takes). */
export const generateTotpSecret = () => base32Encode(randomBytes(20));

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / TOTP.periodSec);

export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP.digits;
  return String(bin).padStart(TOTP.digits, '0');
}

/**
 * The step a code matches, within ±window of now, or null. Steps at or before `lastStep` are
 * refused, so a code seen once (shoulder-surfed, phished) can't be used again.
 */
export function matchTotp(secret: string, code: string, lastStep: number | null, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = currentStep(now);
  for (let s = step - TOTP.window; s <= step + TOTP.window; s++) {
    if (lastStep !== null && s <= lastStep) continue;
    const expected = Buffer.from(totpAt(secret, s));
    if (timingSafeEqual(expected, Buffer.from(code))) return s;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer: string) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(TOTP.digits), period: String(TOTP.periodSec) });
  return `otpauth://totp/${label}?${params}`;
}

/**
 * The secret is stored encrypted (AES-256-GCM, AAD = user id) under a key derived from the OTP HMAC
 * key, so a leaked users table alone doesn't give away anyone's codes. Changing OTP_SECRET (or
 * WORKER_SECRET when OTP_SECRET is unset) makes stored secrets unreadable: every user would have to
 * set two-factor up again.
 */
export function totpCipher(otpKey: Buffer) {
  const key = Buffer.from(hkdfSync('sha256', otpKey, 'wa-platform', 'totp-secret-v1', 32));
  return {
    seal(secret: string, userId: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(userId));
      const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      return `v1.${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')}`;
    },
    open(sealed: string, userId: string): string {
      const raw = Buffer.from(sealed.replace(/^v1\./, ''), 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(userId));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

export type TotpCipher = ReturnType<typeof totpCipher>;

/** Recovery codes: `xxxxx-xxxxx` (lowercase base32, ~50 bits each), shown once; only SHA-256 is stored. */
export const RECOVERY_CODE_COUNT = 10;

export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const s = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

export const normalizeRecoveryCode = (code: string) => code.trim().toLowerCase().replace(/[\s-]/g, '');

export const hashRecoveryCode = (code: string) => createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');

export const looksLikeRecoveryCode = (code: string) => /^[a-z2-7]{10}$/.test(normalizeRecoveryCode(code));
