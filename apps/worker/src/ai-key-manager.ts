import {
  coolDownAiProviderKeys,
  loadAiProvider,
  loadAvailableAiProviderKeys,
  recordAiKeyFailure,
  recordAiKeySuccess,
  type AiProviderKeyRow,
  type AiProviderRow,
  type Sql,
} from '@wa/db';
import { openAiKey } from '@wa/provider';
import { AI_PROVIDERS, AiError, generateText, type AiMessage, type AiProviderId, type AiResult } from '@wa/shared';
import type { Logger } from 'pino';

const KEY_RATE_LIMIT_COOLDOWN_MS = 60_000;
const MODEL_UNAVAILABLE_COOLDOWN_MS = 5 * 60_000;
const PROVIDER_QUOTA_COOLDOWN_MS = 15 * 60_000;
/** The pause before asking an overloaded (5xx) provider once more. */
const SERVER_ERROR_RETRY_MS = 1_500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type KeyManagerOptions = {
  sql: Sql;
  masterKey: Buffer;
  log: Logger;
  retryDelayMs?: number;
  /** Test seams; production always uses the defaults. */
  services?: {
    loadProvider?: (providerId: string) => Promise<AiProviderRow | null>;
    loadKeys?: (providerId: string) => Promise<AiProviderKeyRow[]>;
    openKey?: (providerId: string, blob: Buffer) => string | null;
    generate?: typeof generateText;
    success?: (keyId: string) => Promise<void>;
    failure?: (keyId: string, options: Parameters<typeof recordAiKeyFailure>[2]) => Promise<void>;
    coolDownProvider?: (providerId: string, message: string, cooldownMs: number) => Promise<void>;
  };
};

export type AiKeyResult = { text: string; model: string; provider: AiProviderId; keyId: string | null };

/** Selects encrypted keys, rotates only for key-scoped failures, and fails over across providers. */
export class AiKeyManager {
  constructor(private readonly opts: KeyManagerOptions) {}

  async executeWithFailover(request: {
    providerId: AiProviderId;
    fallbackProviderId: AiProviderId | null;
    model: string;
    fallbackModel?: string;
    system: string;
    messages: AiMessage[];
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
  }): Promise<AiKeyResult | null> {
    const primary = await this.tryProvider(request.providerId, request.model, request);
    if (primary) return primary;

    if (request.fallbackProviderId && request.fallbackProviderId !== request.providerId) {
      this.opts.log.info({ provider: request.fallbackProviderId }, 'auto-reply: trying fallback AI provider');
      return await this.tryProvider(request.fallbackProviderId, request.fallbackModel ?? '', request);
    }

    this.opts.log.warn({ provider: request.providerId }, 'auto-reply: no AI provider was available');
    return null;
  }

  private async tryProvider(
    providerId: AiProviderId,
    requestedModel: string,
    request: {
      system: string;
      messages: AiMessage[];
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
    },
  ): Promise<AiKeyResult | null> {
    const provider = await this.loadProvider(providerId);
    if (!provider?.enabled) {
      this.opts.log.warn({ provider: providerId }, 'auto-reply: AI provider is disabled');
      return null;
    }

    const keys = await this.loadKeys(providerId);
    const info = AI_PROVIDERS[providerId];
    const model = requestedModel.trim() || provider.model?.trim() || info.defaultModel;

    // A local OpenAI-compatible endpoint can intentionally have no key.
    if (keys.length === 0 && !info.needsKey && !provider.hasKeys) {
      return (await this.callProvider(providerId, provider, null, '', model, request)).result;
    }

    for (const key of keys) {
      const plaintext = this.openKey(providerId, key.apiKey);
      if (!plaintext) {
        await this.failure(key.id, {
          message: 'The encrypted API key could not be opened',
          openCircuit: true,
          disable: true,
        });
        this.opts.log.error({ provider: providerId, keyId: key.id }, 'auto-reply: disabled an unreadable AI key');
        continue;
      }

      const attempt = await this.callProvider(
        providerId,
        provider,
        key,
        plaintext,
        key.model?.trim() || model,
        request,
      );
      if (attempt.result) return attempt.result;
      if (attempt.stop) break;
    }
    return null;
  }

  private async callProvider(
    providerId: AiProviderId,
    provider: AiProviderRow,
    key: AiProviderKeyRow | null,
    apiKey: string,
    model: string,
    request: {
      system: string;
      messages: AiMessage[];
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
    },
  ): Promise<{ result: AiKeyResult | null; stop: boolean }> {
    try {
      const ask = () => this.generate({
        provider: providerId,
        apiKey,
        model,
        system: request.system,
        messages: request.messages,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        baseUrl: key?.baseUrl?.trim() || provider.baseUrl?.trim() || undefined,
        timeoutMs: request.timeoutMs,
      });
      let result: AiResult;
      try {
        result = await ask();
      } catch (first) {
        // A provider that is briefly overloaded usually answers a second later.
        if (!(first instanceof AiError) || first.status === undefined || first.status < 500) throw first;
        await sleep(this.opts.retryDelayMs ?? SERVER_ERROR_RETRY_MS);
        result = await ask();
      }
      if (key) await this.success(key.id);
      this.opts.log.info({ provider: providerId, keyId: key?.id ?? null, model: result.model }, 'auto-reply: AI request succeeded');
      return {
        result: { text: result.text, model: result.model, provider: providerId, keyId: key?.id ?? null },
        stop: false,
      };
    } catch (cause) {
      const error = cause instanceof AiError ? cause : new AiError('The provider request failed');
      const safe = { provider: providerId, keyId: key?.id ?? null, status: error.status, scope: error.scope };

      if (!key) {
        this.opts.log.warn(safe, 'auto-reply: keyless AI provider failed');
        return { result: null, stop: true };
      }

      if (error.scope === 'key') {
        const auth = error.code === 'invalid_credentials';
        const modelUnavailable = error.code === 'model_unavailable';
        await this.failure(key.id, {
          message: error.message,
          cooldownMs: error.status === 429
            ? (error.retryAfterMs ?? KEY_RATE_LIMIT_COOLDOWN_MS)
            : modelUnavailable
              ? MODEL_UNAVAILABLE_COOLDOWN_MS
              : undefined,
          openCircuit: auth,
          disable: auth,
          countTowardsCircuit: !modelUnavailable,
        });
        this.opts.log.warn(safe, 'auto-reply: AI key unavailable; rotating to the next key');
        return { result: null, stop: false };
      }

      await this.failure(key.id, { message: error.message, countTowardsCircuit: false });
      // Only an exhausted account balance rests every key. A timeout or a 5xx ("model overloaded")
      // passes in seconds: resting the provider for it would leave the next customers unanswered.
      if (error.scope === 'provider' && error.status === 429) {
        await this.coolDownProvider(providerId, error.message, error.retryAfterMs ?? PROVIDER_QUOTA_COOLDOWN_MS);
      }
      this.opts.log.warn(safe, 'auto-reply: AI provider unavailable; skipping its remaining keys');
      return { result: null, stop: true };
    }
  }

  private loadProvider(providerId: string) {
    return this.opts.services?.loadProvider?.(providerId) ?? loadAiProvider(this.opts.sql, providerId);
  }

  private loadKeys(providerId: string) {
    return this.opts.services?.loadKeys?.(providerId) ?? loadAvailableAiProviderKeys(this.opts.sql, providerId);
  }

  private openKey(providerId: string, blob: Buffer) {
    return this.opts.services?.openKey?.(providerId, blob) ?? openAiKey(this.opts.masterKey, providerId, blob);
  }

  private generate(request: Parameters<typeof generateText>[0]): Promise<AiResult> {
    return (this.opts.services?.generate ?? generateText)(request);
  }

  private success(keyId: string) {
    return this.opts.services?.success?.(keyId) ?? recordAiKeySuccess(this.opts.sql, keyId);
  }

  private failure(keyId: string, options: Parameters<typeof recordAiKeyFailure>[2]) {
    return this.opts.services?.failure?.(keyId, options) ?? recordAiKeyFailure(this.opts.sql, keyId, options);
  }

  private coolDownProvider(providerId: string, message: string, cooldownMs: number) {
    return this.opts.services?.coolDownProvider?.(providerId, message, cooldownMs)
      ?? coolDownAiProviderKeys(this.opts.sql, providerId, message, cooldownMs);
  }
}
