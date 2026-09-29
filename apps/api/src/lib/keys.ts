import { createHash, randomBytes } from 'node:crypto';

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

/** Returns the plaintext key (show once) plus what we persist. */
export function generateApiKey(kind: 'pat' | 'session') {
  const key = `wa_${kind}_${randomBytes(24).toString('base64url')}`;
  return { key, keyHash: hashKey(key), prefix: key.slice(0, 12) };
}
