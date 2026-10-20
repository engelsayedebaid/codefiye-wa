/**
 * The AI layer of the auto-reply agent: which providers exist, how to ask one for a reply, and how
 * to read the language of a message. Zod-free and browser-safe, so the dashboard can import the
 * registry and the types while the API and the worker do the talking.
 *
 * Every provider is reached over plain `fetch`: no SDK, so the worker doesn't carry six of them,
 * and a local (OpenAI-compatible) server is the same code path as a hosted API.
 */

export const AI_PROVIDER_IDS = ['anthropic', 'openai', 'gemini', 'groq', 'mistral', 'custom'] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export type AiProviderInfo = {
  id: AiProviderId;
  /** The provider's API root; a custom one is whatever the admin typed. */
  baseUrl: string;
  /** Models the provider is known to serve. The admin can still type any other model. */
  models: string[];
  defaultModel: string;
  /** OpenAI's chat-completions shape (OpenAI, Groq, Mistral, and most local servers). */
  openaiCompatible: boolean;
  /** Whether the provider needs an API key (a local server usually doesn't). */
  needsKey: boolean;
};

const strip = (url: string) => url.replace(/\/+$/, '');

export const AI_PROVIDERS: Record<AiProviderId, AiProviderInfo> = {
  anthropic: {
    id: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
    defaultModel: 'claude-sonnet-5-5',
    openaiCompatible: false,
    needsKey: true,
  },
  openai: {
    id: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
    defaultModel: 'gpt-4o-mini',
    openaiCompatible: true,
    needsKey: true,
  },
  gemini: {
    id: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest'],
    defaultModel: 'gemini-3.8-flash',
    openaiCompatible: false,
    needsKey: true,
  },
  groq: {
    id: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b'],
    defaultModel: 'llama-3.3-70b-versatile',
    openaiCompatible: true,
    needsKey: true,
  },
  mistral: {
    id: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-small-latest', 'mistral-large-latest', 'open-mistral-nemo'],
    defaultModel: 'mistral-small-latest',
    openaiCompatible: true,
    needsKey: true,
  },
  custom: {
    id: 'custom',
    baseUrl: '',
    models: [],
    defaultModel: '',
    openaiCompatible: true,
    needsKey: false,
  },
};

/** A provider by id; an unknown id (an old row) falls back to the first one. */
export function aiProvider(id: string | null | undefined): AiProviderInfo {
  return AI_PROVIDERS[(id as AiProviderId) in AI_PROVIDERS ? (id as AiProviderId) : 'anthropic'];
}

/** A failure worded for the person who set the agent up (shown in the dashboard and the log). */
export class AiError extends Error {
  constructor(
    message: string,
    /** The provider's own status code, when there was one. */
    readonly status?: number,
    /** Whether trying another key can safely help. */
    readonly scope: 'key' | 'provider' | 'request' = 'provider',
    /** A provider-supplied retry delay, when available. */
    readonly retryAfterMs?: number,
    readonly code: 'invalid_credentials' | 'model_unavailable' | 'rate_limited' | 'invalid_request' | 'provider_unavailable' | 'configuration' = 'provider_unavailable',
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export type AiMessage = { role: 'user' | 'assistant'; content: string };

export type AiRequest = {
  provider: AiProviderId;
  /** The provider's key; empty for a local server that needs none. */
  apiKey: string;
  model: string;
  /** The system prompt: who the agent is and how it answers. */
  system: string;
  /** The conversation so far, oldest first. */
  messages: AiMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Overrides the provider's base URL (a custom or local server). */
  baseUrl?: string;
  timeoutMs?: number;
};

export type AiResult = {
  text: string;
  /** The model that answered (the provider may report its own version). */
  model: string;
  inputTokens: number;
  outputTokens: number;
};

const DEFAULT_TIMEOUT_MS = 45_000;

/**
 * The provider's own explanation (`error.message` in the OpenAI, Anthropic and Gemini shapes), cut
 * short and with anything that looks like a key removed, so the admin sees *why* (which quota, which
 * model) without a secret reaching the dashboard or the logs.
 */
function providerExplanation(body: string): string {
  let message = '';
  try {
    const data = JSON.parse(body);
    const raw = data?.error?.message ?? data?.message;
    message = typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
  return message
    .replace(/\b(?:sk|gsk|xai)[-_][\w-]{6,}/g, '••••')
    .replace(/\bAIza[\w-]{10,}/g, '••••')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

/** Gemini sends its retry delay in the body (`RetryInfo.retryDelay: "17s"`), not in a header. */
function bodyRetryDelayMs(body: string): number | undefined {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return match ? Math.ceil(Number(match[1]) * 1_000) : undefined;
}

/** The body a provider refused, in one short line for the dashboard. */
async function refusal(res: Response, body: string): Promise<never> {
  const retryHeader = res.headers.get('retry-after');
  const retrySeconds = retryHeader && /^\d+(?:\.\d+)?$/.test(retryHeader.trim()) ? Number(retryHeader) : null;
  const retryDate = retryHeader && retrySeconds === null ? Date.parse(retryHeader) : Number.NaN;
  const retryAfterMs = retrySeconds !== null
    ? Math.max(0, Math.ceil(retrySeconds * 1_000))
    : Number.isFinite(retryDate)
      ? Math.max(0, retryDate - Date.now())
      : bodyRetryDelayMs(body);
  const explained = providerExplanation(body);
  const why = explained ? `: ${explained}` : '';
  if (res.status === 401 || res.status === 403) {
    throw new AiError(`The API key was refused by the provider${why}`, res.status, 'key', undefined, 'invalid_credentials');
  }
  const detail = body.toLowerCase();
  if (res.status === 400 && (
    detail.includes('api_key_invalid')
    || detail.includes('api key not valid')
    || detail.includes('invalid api key')
  )) {
    throw new AiError('The API key was refused by the provider', res.status, 'key', undefined, 'invalid_credentials');
  }
  if (res.status === 429) {
    // Only an exhausted balance holds for every key of the account (OpenAI `insufficient_quota`,
    // a billing message): then the fallback provider takes over. Everything else — Gemini's
    // RESOURCE_EXHAUSTED (sent for every 429, per-minute ones included), OpenAI's "rate limit
    // reached … in organization …" — is this key's limit for a while: rest it, try the next key.
    const providerWide = ['insufficient_quota', 'billing', 'credit balance'].some((marker) => detail.includes(marker));
    throw new AiError(
      `The provider limited this key (429)${why}`,
      res.status,
      providerWide ? 'provider' : 'key',
      retryAfterMs,
      'rate_limited',
    );
  }
  if (res.status === 400) {
    throw new AiError(`The provider rejected the request (400)${why || '; check the model and settings'}`, res.status, 'request', undefined, 'invalid_request');
  }
  if (res.status === 404) {
    throw new AiError(`The model is not available for this API key and API version (404)${why}`, res.status, 'key', undefined, 'model_unavailable');
  }
  // Deliberately omit the response body. Some compatible servers echo headers or request data,
  // which must never put an API key, prompt, or customer message in application logs.
  throw new AiError(
    `The provider answered ${res.status}`,
    res.status,
    res.status >= 500 ? 'provider' : 'request',
    retryAfterMs,
    res.status >= 500 ? 'provider_unavailable' : 'invalid_request',
  );
}

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<{ data: any; res: Response }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if ((err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError') {
      throw new AiError('The provider took too long to answer', undefined, 'provider', undefined, 'provider_unavailable');
    }
    throw new AiError('Could not reach the provider', undefined, 'provider', undefined, 'provider_unavailable');
  }
  const text = await res.text();
  if (!res.ok) await refusal(res, text);
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new AiError('The provider answered with something that is not JSON');
  }
  return { data, res };
}

/** OpenAI's chat-completions shape: OpenAI, Groq, Mistral and most local servers. */
async function openaiCompatible(req: AiRequest, base: string): Promise<AiResult> {
  const { data } = await post(
    `${strip(base)}/chat/completions`,
    { authorization: `Bearer ${req.apiKey}` },
    {
      model: req.model,
      messages: [{ role: 'system', content: req.system }, ...req.messages],
      temperature: req.temperature ?? 0.7,
      max_tokens: req.maxTokens ?? 800,
    },
    req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const choice = data?.choices?.[0]?.message?.content;
  const text = typeof choice === 'string' ? choice : '';
  if (!text.trim()) throw new AiError('The provider answered with no text', undefined, 'request');
  return {
    text: text.trim(),
    model: data?.model ?? req.model,
    inputTokens: data?.usage?.prompt_tokens ?? 0,
    outputTokens: data?.usage?.completion_tokens ?? 0,
  };
}

/** Anthropic's messages API: the system prompt is its own field, not a message. */
async function anthropic(req: AiRequest, base: string): Promise<AiResult> {
  const { data } = await post(
    `${strip(base)}/messages`,
    { 'x-api-key': req.apiKey, 'anthropic-version': '2023-06-01' },
    {
      model: req.model,
      max_tokens: req.maxTokens ?? 800,
      temperature: req.temperature ?? 0.7,
      system: req.system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    },
    req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const text = (Array.isArray(data?.content) ? data.content : [])
    .filter((b: { type?: string }) => b?.type === 'text')
    .map((b: { text?: string }) => b.text ?? '')
    .join('');
  if (!text.trim()) throw new AiError('The provider answered with no text', undefined, 'request');
  return {
    text: text.trim(),
    model: data?.model ?? req.model,
    inputTokens: data?.usage?.input_tokens ?? 0,
    outputTokens: data?.usage?.output_tokens ?? 0,
  };
}

export type GeminiModel = {
  id: string;
  displayName: string;
  supportedGenerationMethods: string[];
};

/** Accepts both the short id and the `models/...` resource name returned by models.list. */
export function normalizeGeminiModel(model: string): string {
  return model.trim().replace(/^models\//, '');
}

/** Lists the models visible to one Gemini credential without ever returning or logging that key. */
export async function listGeminiModels(options: {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<GeminiModel[]> {
  const base = strip(options.baseUrl?.trim() || AI_PROVIDERS.gemini.baseUrl);
  const models: GeminiModel[] = [];
  let pageToken = '';
  for (let page = 0; page < 10; page += 1) {
    const query = new URLSearchParams({ pageSize: '1000' });
    if (pageToken) query.set('pageToken', pageToken);
    let res: Response;
    try {
      res = await fetch(`${base}/models?${query}`, {
        headers: { 'x-goog-api-key': options.apiKey },
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      if ((err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError') {
        throw new AiError('The provider took too long to list its models', undefined, 'provider', undefined, 'provider_unavailable');
      }
      throw new AiError('Could not reach the provider', undefined, 'provider', undefined, 'provider_unavailable');
    }
    const text = await res.text();
    if (!res.ok) await refusal(res, text);
    let data: any;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new AiError('The provider answered with something that is not JSON', undefined, 'provider');
    }
    for (const model of Array.isArray(data?.models) ? data.models : []) {
      const id = normalizeGeminiModel(typeof model?.name === 'string' ? model.name : '');
      if (!id) continue;
      models.push({
        id,
        displayName: typeof model?.displayName === 'string' ? model.displayName : id,
        supportedGenerationMethods: Array.isArray(model?.supportedGenerationMethods)
          ? model.supportedGenerationMethods.filter((method: unknown): method is string => typeof method === 'string')
          : [],
      });
    }
    pageToken = typeof data?.nextPageToken === 'string' ? data.nextPageToken : '';
    if (!pageToken) break;
  }
  return models;
}

/** Verifies model access with the same credential used for generation and returns usable ids. */
export async function validateGeminiModelAccess(options: {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<string[]> {
  const requested = normalizeGeminiModel(options.model);
  const models = await listGeminiModels(options);
  const available = models
    .filter((model) => model.supportedGenerationMethods.includes('generateContent'))
    .map((model) => model.id);
  if (!available.includes(requested)) {
    const suggestions = available.slice(0, 12).join(', ');
    throw new AiError(
      suggestions
        ? `The model "${requested}" is not available to this API key. Available models: ${suggestions}`
        : `The model "${requested}" is not available to this API key for generateContent`,
      404,
      'key',
      undefined,
      'model_unavailable',
    );
  }
  return available;
}

/** Thinking tokens Gemini may spend before it writes, on models whose thinking can't be switched off. */
const GEMINI_THINKING_HEADROOM = 2_048;

/**
 * Gemini 2.5+ "thinks" before answering, and the thinking is paid out of `maxOutputTokens`: with a
 * WhatsApp-sized budget it can use all of it and return no text (and it adds seconds). 2.5 Flash and
 * Flash-Lite can turn thinking off; other models get headroom on top of the reply's own budget.
 */
function geminiGenerationConfig(model: string, temperature: number, maxTokens: number) {
  if (/^gemini-2\.5-flash/.test(model)) {
    return { temperature, maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } };
  }
  const thinks = /^gemini-(?:2\.5|[3-9])/.test(model) || model === 'gemini-flash-latest';
  return { temperature, maxOutputTokens: thinks ? maxTokens + GEMINI_THINKING_HEADROOM : maxTokens };
}

/** Gemini's generateContent: the system prompt is `systemInstruction`, the model role is `model`. */
async function gemini(req: AiRequest, base: string): Promise<AiResult> {
  const model = normalizeGeminiModel(req.model);
  const { data } = await post(
    `${strip(base)}/models/${encodeURIComponent(model)}:generateContent`,
    { 'x-goog-api-key': req.apiKey },
    {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: geminiGenerationConfig(model, req.temperature ?? 0.7, req.maxTokens ?? 800),
    },
    req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (data?.promptFeedback?.blockReason) throw new AiError('The model declined to answer this message', undefined, 'request');
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const text = parts
    .filter((p: { thought?: boolean }) => !p?.thought)
    .map((p: { text?: string }) => p?.text ?? '')
    .join('');
  if (!text.trim() && candidate?.finishReason === 'MAX_TOKENS') {
    throw new AiError('The model used its whole token budget before writing an answer; raise "max tokens"', undefined, 'request', undefined, 'invalid_request');
  }
  if (!text.trim()) throw new AiError('The provider answered with no text', undefined, 'request');
  const usage = data?.usageMetadata ?? {};
  return {
    text: text.trim(),
    model: data?.modelVersion ?? model,
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
  };
}

/**
 * Asks a provider for a reply. Throws an `AiError` worded for the person who set the agent up;
 * the caller decides whether to fall back to another provider or to give up.
 */
export async function generateText(req: AiRequest): Promise<AiResult> {
  const info = aiProvider(req.provider);
  const base = req.baseUrl?.trim() || info.baseUrl;
  if (!base) throw new AiError('This provider needs a base URL (an OpenAI-compatible address)');
  if (!req.model.trim()) throw new AiError('No model is set for this provider');
  if (info.needsKey && !req.apiKey.trim()) throw new AiError('This provider needs an API key');
  if (req.provider === 'anthropic') return anthropic(req, base);
  if (req.provider === 'gemini') return gemini(req, base);
  return openaiCompatible(req, base);
}

/** The languages the agent answers in. */
export type ReplyLanguage = 'ar' | 'en';

/**
 * Whether a message is Arabic or English: the share of Arabic letters among the letters it has.
 * A message with no letters at all (a sticker, an emoji) counts as English.
 */
export function detectLanguage(text: string): ReplyLanguage {
  const arabic = (text.match(/[؀-ۿݐ-ݿࢠ-ࣿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (arabic === 0) return 'en';
  if (latin === 0) return 'ar';
  return arabic / (arabic + latin) >= 0.3 ? 'ar' : 'en';
}

/** A cheap check that a message is worth answering at all (a sticker or a voice note is not). */
export function hasWords(text: string | null | undefined): boolean {
  return Boolean(text && text.trim().length > 0);
}
