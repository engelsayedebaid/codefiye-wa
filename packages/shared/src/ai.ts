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
    models: ['gemini-flash-latest', 'gemini-pro-latest', 'gemini-2.5-flash'],
    defaultModel: 'gemini-flash-latest',
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

/** The body a provider refused, in one short line for the dashboard. */
async function refusal(res: Response, body: string): Promise<never> {
  const retryHeader = res.headers.get('retry-after');
  const retrySeconds = retryHeader && /^\d+(?:\.\d+)?$/.test(retryHeader.trim()) ? Number(retryHeader) : null;
  const retryDate = retryHeader && retrySeconds === null ? Date.parse(retryHeader) : Number.NaN;
  const retryAfterMs = retrySeconds !== null
    ? Math.max(0, Math.ceil(retrySeconds * 1_000))
    : Number.isFinite(retryDate)
      ? Math.max(0, retryDate - Date.now())
      : undefined;
  if (res.status === 401 || res.status === 403) {
    throw new AiError('The API key was refused by the provider', res.status, 'key');
  }
  if (res.status === 429) {
    // A hard account/project quota applies to every key in that account. Do not burn through keys
    // when the provider explicitly says that is the restriction; move to the fallback provider.
    const detail = body.toLowerCase();
    const providerWide = [
      'insufficient_quota',
      'billing',
      'hard limit',
      'monthly limit',
      'daily limit',
      'organization',
      'organisation',
      'project quota',
      'resource_exhausted',
    ].some((marker) => detail.includes(marker));
    throw new AiError(
      'The provider is rate-limited or out of quota (429)',
      res.status,
      providerWide ? 'provider' : 'key',
      retryAfterMs,
    );
  }
  if (res.status === 400) throw new AiError('The provider rejected the request (400); check the model and settings', res.status, 'request');
  if (res.status === 404) throw new AiError('The model was not found (404); check the model name', res.status, 'request');
  // Deliberately omit the response body. Some compatible servers echo headers or request data,
  // which must never put an API key, prompt, or customer message in application logs.
  throw new AiError(`The provider answered ${res.status}`, res.status, res.status >= 500 ? 'provider' : 'request', retryAfterMs);
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
      throw new AiError('The provider took too long to answer', undefined, 'provider');
    }
    throw new AiError('Could not reach the provider', undefined, 'provider');
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
  if (!text.trim()) throw new AiError('The provider answered with no text');
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
  if (!text.trim()) throw new AiError('The provider answered with no text');
  return {
    text: text.trim(),
    model: data?.model ?? req.model,
    inputTokens: data?.usage?.input_tokens ?? 0,
    outputTokens: data?.usage?.output_tokens ?? 0,
  };
}

/** Gemini's generateContent: the system prompt is `systemInstruction`, the model role is `model`. */
async function gemini(req: AiRequest, base: string): Promise<AiResult> {
  const { data } = await post(
    `${strip(base)}/models/${encodeURIComponent(req.model)}:generateContent`,
    { 'x-goog-api-key': req.apiKey },
    {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { temperature: req.temperature ?? 0.7, maxOutputTokens: req.maxTokens ?? 800 },
    },
    req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (data?.promptFeedback?.blockReason) throw new AiError('The model declined to answer this message');
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .filter((p: { thought?: boolean }) => !p?.thought)
    .map((p: { text?: string }) => p?.text ?? '')
    .join('');
  if (!text.trim()) throw new AiError('The provider answered with no text');
  const usage = data?.usageMetadata ?? {};
  return {
    text: text.trim(),
    model: data?.modelVersion ?? req.model,
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
