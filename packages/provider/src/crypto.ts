import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

export function parseKey(base64 = process.env.AUTH_ENCRYPTION_KEY): Buffer {
  if (!base64) throw new Error('AUTH_ENCRYPTION_KEY is not set');
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('AUTH_ENCRYPTION_KEY must be 32 bytes (base64-encoded)');
  return key;
}

/**
 * AES-256-GCM. Layout: [version:1][iv:12][tag:16][ciphertext].
 * `aad` binds the ciphertext to its row (e.g. sessionId/type/id) so rows can't be swapped.
 */
export function encrypt(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decrypt(key: Buffer, payload: Buffer, aad: string): Buffer {
  if (payload[0] !== VERSION) throw new Error(`Unsupported ciphertext version ${payload[0]}`);
  const iv = payload.subarray(1, 1 + IV_LEN);
  const tag = payload.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload.subarray(1 + IV_LEN + TAG_LEN)), decipher.final()]);
}
