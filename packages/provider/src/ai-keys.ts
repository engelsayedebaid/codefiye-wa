import { decrypt, deriveKey, encrypt } from './crypto';

/**
 * The AI providers' API keys, sealed with a key derived from the master key (AUTH_ENCRYPTION_KEY).
 * The salt and the AAD live here, so the API (which seals) and the worker (which opens) always
 * agree — and a sealed key copied into another provider's row can't be read.
 */
const SALT = 'wa-ai-providers';
const aad = (id: string) => `ai-provider:${id}`;

/** The key the AI providers' API keys are sealed with. */
export function aiKey(master: Buffer): Buffer {
  return deriveKey(master, SALT);
}

/** Seals an API key for one provider. */
export function sealAiKey(master: Buffer, id: string, plaintext: string): Buffer {
  return encrypt(aiKey(master), Buffer.from(plaintext, 'utf8'), aad(id));
}

/** Opens a sealed API key; null when it isn't there or can't be read. */
export function openAiKey(master: Buffer, id: string, blob: Buffer | null): string | null {
  if (!blob) return null;
  try {
    return decrypt(aiKey(master), blob, aad(id)).toString('utf8');
  } catch {
    return null;
  }
}
