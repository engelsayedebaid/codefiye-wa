import type { AiProviderKeyRow, AiProviderRow, Sql } from '@wa/db';
import { AiError, type AiResult } from '@wa/shared';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiKeyManager } from '../src/ai-key-manager';

const provider = (id: string): AiProviderRow => ({ id, enabled: true, baseUrl: null, model: null, hasKeys: false });
const key = (id: string, providerId = 'anthropic'): AiProviderKeyRow => ({
  id,
  providerId,
  label: id,
  apiKey: Buffer.from(`sealed-${id}`),
  enabled: true,
  priority: 0,
  model: null,
  baseUrl: null,
  totalRequests: 0,
  successRequests: 0,
  failedRequests: 0,
  lastError: null,
  cooldownUntil: null,
  circuitState: 'closed',
  circuitOpenedAt: null,
  consecutiveFailures: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const answer = (text: string, model = 'test-model'): AiResult => ({
  text,
  model,
  inputTokens: 1,
  outputTokens: 1,
});

describe('AiKeyManager', () => {
  const generate = vi.fn();
  const success = vi.fn(async () => {});
  const failure = vi.fn(async () => {});
  const coolDownProvider = vi.fn(async () => {});
  const loadProvider = vi.fn(async (id: string) => provider(id));
  const keysByProvider = new Map<string, AiProviderKeyRow[]>();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

  const manager = () => new AiKeyManager({
    sql: {} as Sql,
    masterKey: Buffer.alloc(32),
    log,
    services: {
      generate,
      success,
      failure,
      coolDownProvider,
      loadProvider,
      loadKeys: async (id) => keysByProvider.get(id) ?? [],
      openKey: (_providerId, blob) => blob.toString('utf8'),
    },
  });

  const request = {
    providerId: 'anthropic' as const,
    fallbackProviderId: null,
    model: 'primary-model',
    system: 'system',
    messages: [{ role: 'user' as const, content: 'hello' }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    loadProvider.mockImplementation(async (id) => provider(id));
    keysByProvider.clear();
  });

  it('uses a healthy key and records success', async () => {
    loadProvider.mockImplementation(async (id) => ({ ...provider(id), hasKeys: true }));
    keysByProvider.set('anthropic', [key('key-1')]);
    generate.mockResolvedValue(answer('done'));

    const result = await manager().executeWithFailover(request);

    expect(result).toMatchObject({ text: 'done', provider: 'anthropic', keyId: 'key-1' });
    expect(success).toHaveBeenCalledWith('key-1');
    expect(generate.mock.calls[0]?.[0].apiKey).toBe('sealed-key-1');
  });

  it('disables a refused key and immediately rotates to the next one', async () => {
    loadProvider.mockImplementation(async (id) => ({ ...provider(id), hasKeys: true }));
    keysByProvider.set('anthropic', [key('bad'), key('good')]);
    generate
      .mockRejectedValueOnce(new AiError('The API key was refused by the provider', 401, 'key'))
      .mockResolvedValueOnce(answer('from second'));

    const result = await manager().executeWithFailover(request);

    expect(result?.keyId).toBe('good');
    expect(failure).toHaveBeenCalledWith('bad', expect.objectContaining({ disable: true, openCircuit: true }));
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('puts a key-scoped rate limit in cooldown and rotates without sleeping', async () => {
    loadProvider.mockImplementation(async (id) => ({ ...provider(id), hasKeys: true }));
    keysByProvider.set('anthropic', [key('limited'), key('ready')]);
    generate
      .mockRejectedValueOnce(new AiError('rate limited', 429, 'key', 12_000))
      .mockResolvedValueOnce(answer('rotated'));

    const result = await manager().executeWithFailover(request);

    expect(result?.keyId).toBe('ready');
    expect(failure).toHaveBeenCalledWith('limited', expect.objectContaining({ cooldownMs: 12_000 }));
  });

  it('does not burn remaining keys when the provider has an account-wide quota restriction', async () => {
    loadProvider.mockImplementation(async (id) => ({ ...provider(id), hasKeys: true }));
    keysByProvider.set('anthropic', [key('primary-1'), key('primary-2')]);
    keysByProvider.set('openai', [key('fallback-1', 'openai')]);
    generate
      .mockRejectedValueOnce(new AiError('provider quota', 429, 'provider', 90_000))
      .mockResolvedValueOnce(answer('fallback answer', 'fallback-model'));

    const result = await manager().executeWithFailover({
      ...request,
      fallbackProviderId: 'openai',
      fallbackModel: 'fallback-model',
    });

    expect(result?.provider).toBe('openai');
    expect(generate).toHaveBeenCalledTimes(2);
    expect(coolDownProvider).toHaveBeenCalledWith('anthropic', 'provider quota', 90_000);
    expect(generate.mock.calls[1]?.[0].model).toBe('fallback-model');
  });

  it('uses a keyless custom provider when it is enabled', async () => {
    generate.mockResolvedValue(answer('local'));

    const result = await manager().executeWithFailover({
      ...request,
      providerId: 'custom',
      model: 'local-model',
    });

    expect(result).toMatchObject({ text: 'local', provider: 'custom', keyId: null });
    expect(generate.mock.calls[0]?.[0].apiKey).toBe('');
  });
});
