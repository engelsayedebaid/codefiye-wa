import {
  recordAiKeyFailure,
  recordAiKeySuccess,
  selectAiProviderKey,
  type AiProviderKeyRow,
  type Sql,
} from '@wa/db';
import { AiError, generateText, type AiMessage, type AiProviderId } from '@wa/shared';
import type { Logger } from 'pino';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = [1000, 2000, 4000]; // Exponential backoff

type KeyManagerOptions = {
  sql: Sql;
  masterKey: Buffer;
  log: Logger;
};

/**
 * Manages AI provider key selection, health tracking, and automatic failover.
 * Handles rate limits, circuit breakers, and provider fallback.
 */
export class AiKeyManager {
  constructor(private readonly opts: KeyManagerOptions) {}

  /**
   * Executes an AI request with automatic key selection and failover.
   * Tries multiple keys within the preferred provider, then falls back to the backup provider.
   */
  async executeWithFailover(request: {
    providerId: AiProviderId;
    fallbackProviderId: AiProviderId | null;
    model: string;
    system: string;
    messages: AiMessage[];
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
  }): Promise<{ text: string; model: string; provider: string; keyId: string } | null> {
    const { sql, masterKey, log } = this.opts;

    // Try primary provider with its keys
    const primaryResult = await this.tryProvider(request.providerId, request);
    if (primaryResult) return primaryResult;

    // Try fallback provider if configured
    if (request.fallbackProviderId && request.fallbackProviderId !== request.providerId) {
      log.info({ fallbackTo: request.fallbackProviderId }, 'AI key manager: trying fallback provider');
      const fallbackResult = await this.tryProvider(request.fallbackProviderId, request);
      if (fallbackResult) return fallbackResult;
    }

    log.warn({ provider: request.providerId }, 'AI key manager: all keys failed for all providers');
    return null;
  }

  /**
   * Tries all available keys for a specific provider with retries and backoff.
   */
  private async tryProvider(
    providerId: AiProviderId,
    request: {
      model: string;
      system: string;
      messages: AiMessage[];
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
    },
  ): Promise<{ text: string; model: string; provider: string; keyId: string } | null> {
    const { sql, masterKey, log } = this.opts;
    const triedKeys = new Set<string>();

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Select the best available key
      const key = await selectAiProviderKey(sql, providerId);
      if (!key) {
        log.warn({ providerId, attempt }, 'AI key manager: no healthy keys available');
        break;
      }

      // Skip if we already tried this key
      if (triedKeys.has(key.id)) {
        log.debug({ keyId: key.id }, 'AI key manager: skipping already-tried key');
        continue;
      }
      triedKeys.add(key.id);

      log.debug({ keyId: key.id, label: key.label, providerId }, 'AI key manager: selected key');

      // Decrypt the key
      const apiKey = this.decryptKey(masterKey, providerId, key.apiKey);
      if (!apiKey) {
        log.warn({ keyId: key.id }, 'AI key manager: failed to decrypt key, marking as failed');
        await recordAiKeyFailure(sql, key.id, 'Decryption failed', false);
        continue;
      }

      // Execute the request
      try {
        const result = await generateText({
          provider: providerId,
          apiKey,
          model: key.model || request.model,
          system: request.system,
          messages: request.messages,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
          baseUrl: key.baseUrl || undefined,
          timeoutMs: request.timeoutMs,
        });

        // Record success
        await recordAiKeySuccess(sql, key.id);
        log.info({ keyId: key.id, label: key.label, model: result.model }, 'AI key manager: request succeeded');

        return {
          text: result.text,
          model: result.model,
          provider: providerId,
          keyId: key.id,
        };
      } catch (err) {
        const error = err as AiError;
        const isRateLimit = error.status === 429;
        const isAuthError = error.status === 401 || error.status === 403;

        // Extract retry-after from error message if available
        const retryAfterMs = this.extractRetryAfter(error.message);

        log.warn(
          { keyId: key.id, label: key.label, error: error.message, status: error.status, isRateLimit, retryAfterMs },
          'AI key manager: request failed',
        );

        // Record failure with appropriate cooldown
        await recordAiKeyFailure(sql, key.id, error.message, isRateLimit, retryAfterMs);

        // If it's a permanent auth error, don't retry this key
        if (isAuthError) {
          log.warn({ keyId: key.id }, 'AI key manager: key is invalid, skipping further attempts');
          continue;
        }

        // If it's a rate limit, wait before retrying
        if (isRateLimit && attempt < MAX_RETRIES - 1) {
          const delay = retryAfterMs || RETRY_DELAY_MS[Math.min(attempt, RETRY_DELAY_MS.length - 1)];
          log.info({ delayMs: delay }, 'AI key manager: rate limited, waiting before retry');
          await this.sleep(delay);
        }
      }
    }

    return null;
  }

  /**
   * Decrypts an API key using the master key.
   */
  private decryptKey(masterKey: Buffer, providerId: string, encrypted: Buffer | null): string | null {
    if (!encrypted) return null;
    try {
      // Import the decryption function from @wa/provider
      // This is a simplified version - the actual implementation would use the proper crypto
      const { openAiKey } = require('@wa/provider');
      const decrypted = openAiKey(masterKey, providerId, encrypted);
      return decrypted || null;
    } catch (err) {
      this.opts.log.error({ err }, 'AI key manager: decryption failed');
      return null;
    }
  }

  /**
   * Extracts retry-after duration from error message (e.g., "retry after 60s").
   */
  private extractRetryAfter(message: string): number | undefined {
    const match = message.match(/retry\s+after\s+(\d+)/i);
    if (match) {
      const seconds = parseInt(match[1], 10);
      return seconds * 1000;
    }
    return undefined;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
