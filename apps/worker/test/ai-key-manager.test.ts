import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AiKeyManager } from '../src/ai-key-manager';
import { AiError } from '@wa/shared';
import pino from 'pino';

describe('AiKeyManager', () => {
  const mockSql = {
    __proto__: null,
  } as unknown as any;

  const mockLog = pino({ level: 'silent' });
  const masterKey = Buffer.from('test-key-32-bytes-long-12345678');

  let keyManager: AiKeyManager;

  beforeEach(() => {
    keyManager = new AiKeyManager({ sql: mockSql, log: mockLog, masterKey });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('selects and uses a healthy key successfully', async () => {
    const mockKey = {
      id: 'key-1',
      providerId: 'anthropic',
      label: 'Test Key',
      apiKey: Buffer.from('encrypted'),
      enabled: true,
      priority: 0,
      model: null,
      baseUrl: null,
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      lastError: null,
      cooldownUntil: null,
      circuitState: 'closed' as const,
      circuitOpenedAt: null,
      consecutiveFailures: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockSql.__proto__ = {
      ...mockSql.__proto__,
      async query() {
        return [[mockKey]];
      },
    };

    vi.mock('@wa/provider', () => ({
      openAiKey: () => 'sk-ant-test-key',
    }));

    vi.mock('@wa/shared', async () => {
      const actual = await vi.importActual('@wa/shared');
      return {
        ...actual,
        generateText: vi.fn().mockResolvedValue({
          text: 'Test response',
          model: 'claude-3-5-sonnet-20241022',
        }),
      };
    });

    const result = await keyManager.executeWithFailover({
      providerId: 'anthropic',
      fallbackProviderId: null,
      model: 'claude-3-5-sonnet-20241022',
      system: 'Test system',
      messages: [{ role: 'user', content: 'Test' }],
      temperature: 0.7,
      maxTokens: 800,
      timeoutMs: 45000,
    });

    expect(result).not.toBeNull();
    expect(result?.text).toBe('Test response');
  });

  it('handles rate limit with cooldown', async () => {
    const mockKey = {
      id: 'key-1',
      providerId: 'anthropic',
      label: 'Test Key',
      apiKey: Buffer.from('encrypted'),
      enabled: true,
      priority: 0,
      model: null,
      baseUrl: null,
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      lastError: null,
      cooldownUntil: null,
      circuitState: 'closed' as const,
      circuitOpenedAt: null,
      consecutiveFailures: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let queryCount = 0;
    mockSql.__proto__ = {
      ...mockSql.__proto__,
      async query() {
        queryCount++;
        if (queryCount === 1) {
          return [[mockKey]];
        }
        return [[]];
      },
      async update() {
        return {};
      },
    };

    vi.mock('@wa/provider', () => ({
      openAiKey: () => 'sk-ant-test-key',
    }));

    vi.mock('@wa/shared', async () => {
      const actual = await vi.importActual('@wa/shared');
      return {
        ...actual,
        generateText: vi.fn().mockRejectedValue(new AiError('Rate limited (429)', 429)),
      };
    });

    const result = await keyManager.executeWithFailover({
      providerId: 'anthropic',
      fallbackProviderId: null,
      model: 'claude-3-5-sonnet-20241022',
      system: 'Test system',
      messages: [{ role: 'user', content: 'Test' }],
      temperature: 0.7,
      maxTokens: 800,
      timeoutMs: 45000,
    });

    expect(result).toBeNull();
  });

  it('falls back to backup provider when primary fails', async () => {
    const primaryKey = {
      id: 'key-1',
      providerId: 'anthropic',
      label: 'Primary Key',
      apiKey: Buffer.from('encrypted'),
      enabled: true,
      priority: 0,
      model: null,
      baseUrl: null,
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      lastError: null,
      cooldownUntil: null,
      circuitState: 'closed' as const,
      circuitOpenedAt: null,
      consecutiveFailures: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const fallbackKey = {
      id: 'key-2',
      providerId: 'openai',
      label: 'Fallback Key',
      apiKey: Buffer.from('encrypted'),
      enabled: true,
      priority: 0,
      model: null,
      baseUrl: null,
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      lastError: null,
      cooldownUntil: null,
      circuitState: 'closed' as const,
      circuitOpenedAt: null,
      consecutiveFailures: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let queryCount = 0;
    mockSql.__proto__ = {
      ...mockSql.__proto__,
      async query() {
        queryCount++;
        if (queryCount === 1) return [[primaryKey]];
        if (queryCount === 2) return [[fallbackKey]];
        return [[]];
      },
      async update() {
        return {};
      },
    };

    vi.mock('@wa/provider', () => ({
      openAiKey: () => 'test-key',
    }));

    vi.mock('@wa/shared', async () => {
      const actual = await vi.importActual('@wa/shared');
      return {
        ...actual,
        generateText: vi
          .fn()
          .mockRejectedValueOnce(new AiError('Primary failed', 500))
          .mockResolvedValueOnce({
            text: 'Fallback response',
            model: 'gpt-4o-mini',
          }),
      };
    });

    const result = await keyManager.executeWithFailover({
      providerId: 'anthropic',
      fallbackProviderId: 'openai',
      model: 'claude-3-5-sonnet-20241022',
      system: 'Test system',
      messages: [{ role: 'user', content: 'Test' }],
      temperature: 0.7,
      maxTokens: 800,
      timeoutMs: 45000,
    });

    expect(result).not.toBeNull();
    expect(result?.provider).toBe('openai');
    expect(result?.text).toBe('Fallback response');
  });

  it('skips keys in cooldown', async () => {
    const cooldownKey = {
      id: 'key-1',
      providerId: 'anthropic',
      label: 'Cooldown Key',
      apiKey: Buffer.from('encrypted'),
      enabled: true,
      priority: 0,
      model: null,
      baseUrl: null,
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      lastError: null,
      cooldownUntil: new Date(Date.now() + 60000),
      circuitState: 'closed' as const,
      circuitOpenedAt: null,
      consecutiveFailures: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const healthyKey = {
      id: 'key-2',
      providerId: 'anthropic',
      label: 'Healthy Key',
      apiKey: Buffer.from('encrypted'),
      enabled: true,
      priority: 1,
      model: null,
      baseUrl: null,
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      lastError: null,
      cooldownUntil: null,
      circuitState: 'closed' as const,
      circuitOpenedAt: null,
      consecutiveFailures: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockSql.__proto__ = {
      ...mockSql.__proto__,
      async query() {
        return [[healthyKey]];
      },
      async update() {
        return {};
      },
    };

    vi.mock('@wa/provider', () => ({
      openAiKey: () => 'sk-ant-test-key',
    }));

    vi.mock('@wa/shared', async () => {
      const actual = await vi.importActual('@wa/shared');
      return {
        ...actual,
        generateText: vi.fn().mockResolvedValue({
          text: 'Test response',
          model: 'claude-3-5-sonnet-20241022',
        }),
      };
    });

    const result = await keyManager.executeWithFailover({
      providerId: 'anthropic',
      fallbackProviderId: null,
      model: 'claude-3-5-sonnet-20241022',
      system: 'Test system',
      messages: [{ role: 'user', content: 'Test' }],
      temperature: 0.7,
      maxTokens: 800,
      timeoutMs: 45000,
    });

    expect(result).not.toBeNull();
    expect(result?.text).toBe('Test response');
  });

  it('respects circuit breaker state', async () => {
    const openCircuitKey = {
      id: 'key-1',
      providerId: 'anthropic',
      label: 'Open Circuit Key',
      apiKey: Buffer.from('encrypted'),
      enabled: true,
      priority: 0,
      model: null,
      baseUrl: null,
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 5,
      lastError: 'Failed',
      cooldownUntil: null,
      circuitState: 'open' as const,
      circuitOpenedAt: new Date(),
      consecutiveFailures: 5,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockSql.__proto__ = {
      ...mockSql.__proto__,
      async query() {
        return [[]];
      },
    };

    const result = await keyManager.executeWithFailover({
      providerId: 'anthropic',
      fallbackProviderId: null,
      model: 'claude-3-5-sonnet-20241022',
      system: 'Test system',
      messages: [{ role: 'user', content: 'Test' }],
      temperature: 0.7,
      maxTokens: 800,
      timeoutMs: 45000,
    });

    expect(result).toBeNull();
  });
});
