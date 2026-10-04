import { getDict, getLang } from './i18n';

/**
 * The dashboard session lives in an HttpOnly cookie set by the API (never readable from JS). This
 * flag only remembers that we *think* someone is signed in, for UI hints like the landing page
 * button — it grants nothing.
 */
const HINT_KEY = 'wa.session';
/** Where dashboards before the cookie kept their token; migrated once by `adoptLegacyToken`. */
const LEGACY_TOKEN_KEY = 'wa.token';

export const sessionHint = {
  get(): boolean {
    try {
      return localStorage.getItem(HINT_KEY) === '1';
    } catch {
      return false;
    }
  },
  set(signedIn: boolean) {
    try {
      if (signedIn) localStorage.setItem(HINT_KEY, '1');
      else localStorage.removeItem(HINT_KEY);
    } catch {
      // storage unavailable: the hint is optional
    }
  },
};

export class ApiRequestError extends Error {
  constructor(
    /** HTTP status; 0 = no response (offline, timeout). */
    readonly status: number,
    message: string,
    /** Stable reason from the API (`rate_limited`, `account_suspended`, …) or `network` / `timeout`. */
    readonly code?: string,
    readonly errors?: Record<string, string[]>,
    readonly details?: Record<string, unknown>,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** Worth retrying automatically (reads only): no response, rate limited, or a server-side failure. */
  get transient() {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

/** Called for responses that change who is signed in: 401 (session ended) and 403 `account_suspended`. */
type SessionListener = (error: ApiRequestError) => void;
let sessionListener: SessionListener | null = null;
export function onSessionProblem(listener: SessionListener) {
  sessionListener = listener;
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  sessionId?: string;
  /** A bearer token, only for exchanging a workspace token for a session (`/api/auth/session`). */
  token?: string;
  /** Cancels the request (component unmounted, inputs changed). */
  signal?: AbortSignal;
  /** Gives up after this long; nothing in the dashboard may spin forever. */
  timeoutMs?: number;
  /** Extra request headers (e.g. `idempotency-key`). */
  headers?: Record<string, string>;
};

const DEFAULT_TIMEOUT_MS = 20_000;

/** One signal that aborts when either does (AbortSignal.any isn't everywhere yet). */
function combine(a: AbortSignal, b?: AbortSignal) {
  if (!b) return a;
  const controller = new AbortController();
  const abort = (source: AbortSignal) => () => controller.abort(source.reason);
  if (a.aborted || b.aborted) controller.abort();
  a.addEventListener('abort', abort(a), { once: true });
  b.addEventListener('abort', abort(b), { once: true });
  return controller.signal;
}

/** Calls the API and unwraps `{ success, data }`; throws ApiRequestError with the API's message and code otherwise. */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.sessionId) headers['x-session-id'] = options.sessionId;

  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin',
      signal: combine(timeout, options.signal),
    });
  } catch (err) {
    // A caller's own cancellation isn't an error worth showing: pass it through as-is.
    if (options.signal?.aborted) throw err;
    const dict = getDict();
    throw timeout.aborted ? new ApiRequestError(0, dict.errors.timeout, 'timeout') : new ApiRequestError(0, dict.common.networkError, 'network');
  }
  const json = (await res.json().catch(() => null)) as
    | { success: true; data: T }
    | { success: false; message: string; code?: string; errors?: Record<string, string[]>; details?: Record<string, unknown>; requestId?: string }
    | null;
  if (res.ok && json?.success) return json.data;

  const failure = json && json.success === false ? json : null;
  const error = new ApiRequestError(
    res.status,
    failure?.message ?? `HTTP ${res.status}`,
    failure?.code,
    failure?.errors,
    failure?.details,
    failure?.requestId ?? res.headers.get('x-request-id') ?? undefined,
  );
  // A bad credential typed into a form isn't a lost session.
  if (!options.token && (error.status === 401 || error.code === 'account_suspended')) sessionListener?.(error);
  throw error;
}

/** Errors the UI explains in its own words; anything else shows the API's message. */
function friendly(err: ApiRequestError): string | null {
  const e = getDict().errors;
  switch (err.code) {
    case 'network':
      return getDict().common.networkError;
    case 'timeout':
      return e.timeout;
    case 'rate_limited':
      return e.rateLimited(Number(err.details?.retryAfter ?? 0) || null);
    case 'db_unavailable':
    case 'unavailable':
    case 'busy':
    case 'worker_unreachable':
      return e.unavailable;
    case 'session_expired':
      return e.sessionExpired;
    case 'csrf_blocked':
      return e.csrf;
  }
  if (err.status >= 500) return e.server(err.requestId ?? null);
  return null;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    const known = friendly(err);
    if (known) return known;
    const details = err.errors ? Object.entries(err.errors).map(([field, msgs]) => `${field}: ${msgs.join(getLang() === 'ar' ? '، ' : ', ')}`) : [];
    return [err.message, ...details].join(' — ');
  }
  return err instanceof Error ? err.message : getDict().common.unexpectedError;
}

/**
 * Dashboards before the session cookie kept a token in localStorage, where any injected script
 * could read it. Trade it once for the cookie (which retires that token) and erase it.
 */
export async function adoptLegacyToken() {
  let token: string | null = null;
  try {
    token = localStorage.getItem(LEGACY_TOKEN_KEY) ?? sessionStorage.getItem(LEGACY_TOKEN_KEY);
  } catch {
    return;
  }
  if (!token) return;
  try {
    await api('/api/auth/session', { method: 'POST', token, body: { remember: true }, timeoutMs: 8_000 });
    sessionHint.set(true);
  } catch (err) {
    // Offline right now: keep it and try again next time. Otherwise it's expired or revoked.
    if (err instanceof ApiRequestError && err.status === 0) return;
  }
  try {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    sessionStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    // ignore
  }
}
