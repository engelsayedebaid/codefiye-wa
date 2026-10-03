import { createHash, randomBytes } from 'node:crypto';

export type KeyKind = 'session' | 'pat';

const PREFIX: Record<KeyKind, string> = { session: 'was', pat: 'wap' };

/** `was_…` = session key, `wap_…` = workspace personal access token. 192 bits of entropy. */
export function generateKey(kind: KeyKind) {
  const key = `${PREFIX[kind]}_${randomBytes(24).toString('base64url')}`;
  return { key, hash: hashKey(key), prefix: key.slice(0, 12) };
}

/** Only this SHA-256 is stored (README §5). */
export function hashKey(key: string) {
  return createHash('sha256').update(key).digest('hex');
}
