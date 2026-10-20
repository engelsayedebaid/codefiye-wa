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
    const fetch = vi.fn(async () => new Response(JSON.stringify({
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
      generationConfig: { maxOutputTokens: 32 },
    });
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

  it('marks an account-wide Gemini quota as provider-scoped and keeps Retry-After', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 429, message: 'Project quota exceeded', status: 'RESOURCE_EXHAUSTED' },
    }), { status: 429, headers: { 'retry-after': '12' } })));

    const error = await generateText(request).catch((cause) => cause);

    expect(error).toMatchObject({ code: 'rate_limited', scope: 'provider', status: 429, retryAfterMs: 12_000 });
  });
});
