import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiError, generateText, listGeminiModels, normalizeGeminiModel } from '../src/ai';

const request = {
  provider: 'gemini' as const,
  apiKey: 'secret-test-key',
  model: 'gemini-2.5-flash',
  system: 'Be concise',
  messages: [{ role: 'user' as const, content: 'Hello' }],
  maxTokens: 32,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Gemini provider', () => {
  it('normalizes a models resource name', () => {
    expect(normalizeGeminiModel(' models/gemini-2.5-flash ')).toBe('gemini-2.5-flash');
  });

  it('uses the documented v1beta endpoint, API-key header, and generateContent payload', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'ready' }] } }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
      modelVersion: 'gemini-2.5-flash',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    const result = await generateText({ ...request, model: 'models/gemini-2.5-flash' });

    expect(result.text).toBe('ready');
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(init.headers).toMatchObject({ 'x-goog-api-key': 'secret-test-key' });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      systemInstruction: { parts: [{ text: 'Be concise' }] },
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      generationConfig: { maxOutputTokens: 32, thinkingConfig: { thinkingBudget: 0 } },
    });
  });

  it('leaves room for thinking on models that always think', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'ready' }] } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    await generateText({ ...request, model: 'gemini-3.5-flash' });

    const body = JSON.parse(String(fetch.mock.calls[0]![1].body));
    expect(body.generationConfig.maxOutputTokens).toBe(32 + 2_048);
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
  });

  it('says so when thinking used the whole budget, without resting the provider', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }],
    }), { status: 200 })));

    const error = await generateText(request).catch((cause) => cause);

    expect(error).toMatchObject({ scope: 'request', code: 'invalid_request' });
    expect((error as Error).message).toContain('max tokens');
  });

  it('lists and normalizes models available to one credential', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      models: [{
        name: 'models/gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        supportedGenerationMethods: ['generateContent', 'countTokens'],
      }],
    }), { status: 200 })));

    const models = await listGeminiModels({ apiKey: 'secret-test-key' });

    expect(models).toEqual([{
      id: 'gemini-2.5-flash',
      displayName: 'Gemini 2.5 Flash',
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    }]);
  });

  it('classifies an invalid Gemini credential as a key failure without exposing it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' },
    }), { status: 400 })));

    const error = await generateText(request).catch((cause) => cause);

    expect(error).toBeInstanceOf(AiError);
    expect(error).toMatchObject({ code: 'invalid_credentials', scope: 'key', status: 400 });
    expect((error as Error).message).not.toContain(request.apiKey);
  });

  it('distinguishes a model unavailable to the credential from authentication and quota failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 404, message: 'models/gemini-2.5-flash is not found for API version v1beta', status: 'NOT_FOUND' },
    }), { status: 404 })));

    const error = await generateText(request).catch((cause) => cause);

    expect(error).toMatchObject({ code: 'model_unavailable', scope: 'key', status: 404 });
  });

  it('treats a Gemini 429 (always RESOURCE_EXHAUSTED) as this key\'s limit, with its retry delay and reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 429,
        message: 'You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 10',
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '17s' }],
      },
    }), { status: 429 })));

    const error = await generateText(request).catch((cause) => cause);

    expect(error).toMatchObject({ code: 'rate_limited', scope: 'key', status: 429, retryAfterMs: 17_000 });
    expect((error as Error).message).toContain('limit: 10');
  });

  it('keeps Retry-After from the header', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429, headers: { 'retry-after': '12' } })));

    const error = await generateText(request).catch((cause) => cause);

    expect(error).toMatchObject({ scope: 'key', retryAfterMs: 12_000 });
  });
});

describe('OpenAI-compatible provider', () => {
  const openai = { ...request, provider: 'openai' as const, model: 'gpt-4o-mini' };

  it('treats a per-minute limit that names the organization as this key\'s limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'Rate limit reached for gpt-4o-mini in organization org-abc on requests per min (RPM): Limit 3', type: 'requests', code: 'rate_limit_exceeded' },
    }), { status: 429 })));

    const error = await generateText(openai).catch((cause) => cause);

    expect(error).toMatchObject({ code: 'rate_limited', scope: 'key' });
  });

  it('treats an exhausted balance as the whole provider\'s', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' },
    }), { status: 429 })));

    const error = await generateText(openai).catch((cause) => cause);

    expect(error).toMatchObject({ code: 'rate_limited', scope: 'provider' });
  });

  it('never repeats a key the provider echoed back', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'Incorrect API key provided: sk-proj-abcdef123456. You can find your API key at …' },
    }), { status: 401 })));

    const error = await generateText(openai).catch((cause) => cause);

    expect(error).toMatchObject({ code: 'invalid_credentials' });
    expect((error as Error).message).not.toContain('sk-proj-abcdef123456');
  });
});
