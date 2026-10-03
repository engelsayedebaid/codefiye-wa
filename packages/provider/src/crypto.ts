import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Parses AUTH_ENCRYPTION_KEY (base64 or hex) and insists on exactly 32 bytes. */
export function parseKey(value: string | undefined): Buffer {
  if (!value) throw new Error('AUTH_ENCRYPTION_KEY is not set (32 bytes, base64 or hex)');
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error(`AUTH_ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}`);
  return key;
}

/**
 * AES-256-GCM. Output layout: iv (12) ‖ tag (16) ‖ ciphertext. `aad` binds the ciphertext to where
 * it is stored, so a row copied to another session/key id fails to decrypt.
 */
export function encrypt(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decrypt(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (blob.length < IV_BYTES + TAG_BYTES) throw new Error('ciphertext too short');
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}
