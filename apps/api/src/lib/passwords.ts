import { randomBytes, scrypt, type ScryptOptions, timingSafeEqual } from 'node:crypto';

/** OWASP's scrypt equivalent for 16 MiB of memory: N=2^14, r=8, p=5. Older hashes (p=1) are upgraded on login. */
const PARAMS = { N: 16_384, r: 8, p: 5 } as const;
const KEY_LENGTH = 64;

function derive(password: string, salt: Buffer, options: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { ...options, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

/** `scrypt$N$r$p$salt$hash` (base64). Parameters travel with the hash so they can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parts = stored?.split('$');
  if (!parts || parts.length !== 6 || parts[0] !== 'scrypt') {
    // Burn comparable time so unknown emails aren't distinguishable by latency.
    await derive(password, randomBytes(16), PARAMS);
    return false;
  }
  const [, N, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), { N: Number(N), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** True when a stored hash uses weaker parameters than today's, so it should be rewritten after a successful login. */
export function needsRehash(stored: string | null): boolean {
  const parts = stored?.split('$');
  if (!parts || parts.length !== 6 || parts[0] !== 'scrypt') return false;
  return Number(parts[1]) < PARAMS.N || Number(parts[2]) < PARAMS.r || Number(parts[3]) < PARAMS.p;
}

/** The most common passwords of at least 8 characters (breach corpora); refused at signup and on change. */
const COMMON = new Set([
  '12345678', '123456789', '1234567890', '12345678910', '11111111', '00000000', '88888888', '87654321', '123123123', '12341234',
  '11223344', '1q2w3e4r', '1qaz2wsx', 'qwertyui', 'qwertyuiop', 'asdfghjk', 'zxcvbnm1', 'password', 'password1', 'password123',
  'passw0rd', 'iloveyou', 'sunshine', 'princess', 'football', 'baseball', 'welcome1', 'abc12345', 'abcd1234', 'aaaaaaaa',
  'superman', 'whatever', 'trustno1', 'letmein1', 'qwerty123', 'q1w2e3r4', 'admin123', 'administrator', 'changeme', 'computer',
]);

/** Field errors for a new password, or null when it's acceptable (NIST 800-63B style: length + blocklist, no composition rules). */
export function passwordProblems(password: string, email?: string): string[] | null {
  const problems: string[] = [];
  const lower = password.toLowerCase();
  if (password.length < 8) problems.push('Use at least 8 characters');
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) problems.push('This password is too common');
  if (email && lower === email.toLowerCase()) problems.push("Don't use your email as the password");
  return problems.length ? problems : null;
}
