import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, auditLogs, eq, paymentEvents, payments, type Db, type Sql } from '@wa/db';
import { decrypt, deriveKey, encrypt } from '@wa/provider';
import {
  KASHIER_BNPL,
  KASHIER_METHODS,
  KASHIER_MODES,
  kashierAvailableMethods,
  kashierReady,
  type KashierConnectionError,
  type KashierMethod,
  type KashierMode,
  type KashierModeView,
  type KashierPublicConfig,
  type KashierSettings,
  type KashierSettingsInput,
  type PaymentDetails,
} from '@wa/shared';
import { activatePaidPayment, holdPaymentForReview } from './online-payments';

/**
 * Kashier (Egypt) online payments: Payment Sessions with Kashier's hosted checkout. The server opens a
 * session for the plan at our price, the customer pays on Kashier's page, and Kashier reports the
 * result with a signed webhook. Nothing is activated on the webhook's word: the session is read back
 * from Kashier with the Secret Key of the payment's own mode and checked against our order first.
 * https://developers.kashier.io/docs
 */
export const KASHIER_API: Record<KashierMode, string> = { test: 'https://test-api.kashier.io', live: 'https://api.kashier.io' };
const TIMEOUT_MS = 20_000;

// --- stored settings -----------------------------------------------------------------------------

type StoredMode = {
  merchantId: string;
  /** Hex of the sealed blob (AES-256-GCM, key derived from AUTH_ENCRYPTION_KEY, AAD = mode + name). */
  secretKey: string | null;
  apiKey: string | null;
  validatedAt: string | null;
  validationError: KashierConnectionError | null;
  apiKeyUnconfirmed: boolean;
  lastWebhookAt: string | null;
  accountMethods: KashierMethod[] | null;
};

/** Stored in `settings` under `kashier`. */
type StoredKashier = { enabled: boolean; mode: KashierMode; methods: KashierMethod[]; test: StoredMode; live: StoredMode; testers: string[] };

const EMPTY_MODE: StoredMode = {
  merchantId: '',
  secretKey: null,
  apiKey: null,
  validatedAt: null,
  validationError: null,
  apiKeyUnconfirmed: false,
  lastWebhookAt: null,
  accountMethods: null,
};
const SALT = 'wa-kashier';
type SecretName = 'secretKey' | 'apiKey';

const aad = (mode: KashierMode, name: SecretName) => `kashier:${mode}:${name}`;

function seal(master: Buffer, mode: KashierMode, name: SecretName, plaintext: string) {
  return encrypt(deriveKey(master, SALT), Buffer.from(plaintext, 'utf8'), aad(mode, name)).toString('hex');
}

/** Opens a sealed key; null when missing or unreadable (wrong AUTH_ENCRYPTION_KEY, or tampered). */
function open(master: Buffer | null, mode: KashierMode, name: SecretName, hex: string | null): string | null {
  if (!master || !hex) return null;
  try {
    return decrypt(deriveKey(master, SALT), Buffer.from(hex, 'hex'), aad(mode, name)).toString('utf8');
  } catch {
    return null;
  }
}

/** `••••a1b2`: enough to recognise a key, never enough to use it. */
const hint = (secret: string) => `••••${secret.slice(-4)}`;

const knownMethods = (v: unknown): KashierMethod[] => (Array.isArray(v) ? v.filter((m): m is KashierMethod => (KASHIER_METHODS as readonly unknown[]).includes(m)) : []);

async function readStored(sql: Sql): Promise<StoredKashier> {
  const [row] = await sql<{ value: Record<string, unknown> }[]>`select value from settings where key = 'kashier'`;
  const v = row?.value ?? {};
  const mode = (m: KashierMode): StoredMode => {
    const s = { ...EMPTY_MODE, ...(v[m] as Partial<StoredMode> | undefined) };
    return { ...s, accountMethods: s.accountMethods === null ? null : knownMethods(s.accountMethods) };
  };
  return {
    enabled: v.enabled === true,
    mode: v.mode === 'live' ? 'live' : 'test',
    methods: v.methods === undefined ? ['card', 'wallet'] : knownMethods(v.methods),
    test: mode('test'),
    live: mode('live'),
    testers: Array.isArray(v.testers) ? v.testers.filter((e): e is string => typeof e === 'string') : [],
  };
}

async function writeStored(sql: Sql, value: StoredKashier) {
  await sql`
    insert into settings (key, value, updated_at) values ('kashier', ${sql.json(value as never)}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

/** Sets some fields of one mode in place, so a webhook or a connection test never overwrites the admin's edits. */
async function patchMode(sql: Sql, mode: KashierMode, fields: Partial<Omit<StoredMode, 'merchantId' | 'secretKey' | 'apiKey'>>) {
  await sql`
    update settings set value = jsonb_set(value, ${sql.array([mode])}::text[], coalesce(value -> ${mode}, '{}'::jsonb) || ${sql.json(fields as never)}::jsonb), updated_at = now()
    where key = 'kashier'`;
}

export const kashierWebhookUrl = (publicUrl: string, mode: KashierMode) => `${publicUrl.replace(/\/+$/, '')}/api/payments/kashier/webhook/${mode}`;

function modeView(master: Buffer | null, mode: KashierMode, s: StoredMode, publicUrl: string): KashierModeView {
  const secretKey = open(master, mode, 'secretKey', s.secretKey);
  const apiKey = open(master, mode, 'apiKey', s.apiKey);
  return {
    merchantId: s.merchantId,
    secretKeyHint: secretKey ? hint(secretKey) : null,
    apiKeyHint: apiKey ? hint(apiKey) : null,
    unreadable: (s.secretKey !== null && !secretKey) || (s.apiKey !== null && !apiKey),
    webhookUrl: kashierWebhookUrl(publicUrl, mode),
    validatedAt: s.validatedAt,
    validationError: s.validationError,
    apiKeyUnconfirmed: s.apiKeyUnconfirmed,
    lastWebhookAt: s.lastWebhookAt,
    accountMethods: s.accountMethods,
  };
}

/** The admin's view: keys only as masked hints (and only if they can still be opened). */
export async function getKashierSettings(sql: Sql, master: Buffer | null, publicUrl: string): Promise<KashierSettings> {
  const s = await readStored(sql);
  return {
    enabled: s.enabled,
    mode: s.mode,
    methods: s.methods,
    test: modeView(master, 'test', s.test, publicUrl),
    live: modeView(master, 'live', s.live, publicUrl),
    encryptionReady: master !== null,
    testers: s.testers,
  };
}

/**
 * Saves the admin's changes. Keys are sealed per mode; a blank key keeps the stored one, a new one
 * replaces it (rotation), `clear` wipes that mode. Changing a mode's credentials forgets its last
 * connection test, so the status shown always belongs to the credentials in place.
 */
export async function saveKashierSettings(sql: Sql, master: Buffer, input: KashierSettingsInput) {
  const s = await readStored(sql);
  const next: StoredKashier = {
    enabled: input.enabled,
    mode: input.mode,
    methods: [...new Set(input.methods)],
    test: s.test,
    live: s.live,
    testers: input.testers ? [...new Set(input.testers.map((e) => e.trim().toLowerCase()))] : s.testers,
  };
  for (const mode of KASHIER_MODES) {
    const change = input[mode];
    if (!change) continue;
    if (change.clear) {
      next[mode] = { ...EMPTY_MODE };
      continue;
    }
    const current = s[mode];
    const changed = Boolean(change.secretKey || change.apiKey || (change.merchantId !== undefined && change.merchantId !== current.merchantId));
    next[mode] = {
      ...current,
      merchantId: change.merchantId ?? current.merchantId,
      secretKey: change.secretKey ? seal(master, mode, 'secretKey', change.secretKey) : current.secretKey,
      apiKey: change.apiKey ? seal(master, mode, 'apiKey', change.apiKey) : current.apiKey,
      ...(changed ? { validatedAt: null, validationError: null, apiKeyUnconfirmed: false, accountMethods: null } : {}),
      ...(change.apiKey ? { lastWebhookAt: null } : {}),
    };
  }
  await writeStored(sql, next);
}

/** One mode's credentials, opened. `methods` = what its checkouts offer. */
export type KashierAccount = { mode: KashierMode; merchantId: string; secretKey: string; apiKey: string; methods: KashierMethod[] };

/**
 * A mode's account, opened, if complete; null otherwise. Used for that mode's webhooks and for payments
 * opened in it (also after the admin switched modes or turned Kashier off), never as a fallback for the other.
 */
export async function getKashierModeAccount(sql: Sql, master: Buffer | null, mode: KashierMode): Promise<KashierAccount | null> {
  const s = await readStored(sql);
  const m = s[mode];
  const secretKey = open(master, mode, 'secretKey', m.secretKey);
  const apiKey = open(master, mode, 'apiKey', m.apiKey);
  if (!secretKey || !apiKey || !/^MID-[\w-]+$/i.test(m.merchantId)) return null;
  return { mode, merchantId: m.merchantId, secretKey, apiKey, methods: kashierAvailableMethods(s.methods, m.accountMethods) };
}

/** Who is asking: admins and the listed test accounts may use test mode. `userId` = the signed-in user, or the workspace owner for a token. */
export type KashierCaller = { isAdmin: boolean; userId: string | null };

/**
 * The account a caller's new checkouts are opened with: the active mode, when Kashier is on and ready.
 * Live mode serves everyone; test mode only admins and the accounts on the test list, so no real
 * customer ever sees a test checkout (or gets a plan from a test payment). Null = pay manually.
 */
export async function getKashierAccountFor(sql: Sql, master: Buffer | null, caller: KashierCaller): Promise<KashierAccount | null> {
  const settings = await getKashierSettings(sql, master, '');
  if (!kashierReady(settings)) return null;
  if (settings.mode === 'test' && !caller.isAdmin && !(await isTester(sql, settings.testers, caller.userId))) return null;
  return getKashierModeAccount(sql, master, settings.mode);
}

async function isTester(sql: Sql, testers: string[], userId: string | null): Promise<boolean> {
  if (!userId || testers.length === 0) return false;
  const [row] = await sql<{ email: string }[]>`select lower(email) as email from users where id = ${userId}`;
  return Boolean(row && testers.includes(row.email));
}

export async function getKashierPublicConfig(sql: Sql, master: Buffer | null, caller: KashierCaller): Promise<KashierPublicConfig> {
  const account = await getKashierAccountFor(sql, master, caller);
  return account ? { enabled: true, mode: account.mode, methods: account.methods } : { enabled: false, mode: 'test', methods: [] };
}

export const recordKashierWebhookSeen = (sql: Sql, mode: KashierMode) => patchMode(sql, mode, { lastWebhookAt: new Date().toISOString(), apiKeyUnconfirmed: false });

// --- API -----------------------------------------------------------------------------------------

export class KashierError extends Error {
  constructor(
    message: string,
    /** 0 = no answer (timeout, network). */
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(mode: KashierMode, path: string, init: { method?: string; body?: unknown; secretKey?: string; apiKey?: string } = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${KASHIER_API[mode]}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        // Kashier takes the raw Secret Key (no "Bearer") and the Payment API Key in `api-key`.
        ...(init.secretKey ? { authorization: init.secretKey } : {}),
        ...(init.apiKey ? { 'api-key': init.apiKey } : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        accept: 'application/json',
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Timeout or network failure: never retried here (a create could have gone through); the caller decides.
    throw new KashierError(err instanceof Error && err.name === 'TimeoutError' ? 'Kashier did not answer in time' : 'Kashier could not be reached', 0);
  }
  const body = (await res.json().catch(() => null)) as T | null;
  if (!res.ok || body === null) {
    const b = body as { messages?: { en?: string }; message?: string; error?: { cause?: string } } | null;
    throw new KashierError(String(b?.messages?.en ?? b?.message ?? b?.error?.cause ?? `Kashier answered ${res.status}`).slice(0, 300), res.status);
  }
  return body;
}

/** Piastres → Kashier's amount string (EGP major units, two decimals): 30000 → "300.00". */
export const kashierAmount = (cents: number) => (cents / 100).toFixed(2);

/** Kashier's amount (string or number, EGP major units) → piastres; NaN when it isn't a plain amount. */
export function parseKashierAmount(v: unknown): number {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100);
}

/**
 * `allowedMethods` for a session: omitted when every method the account has is offered (Kashier then
 * shows its default list for the account); otherwise the chosen methods, BNPL providers as `bnpl[x]`.
 */
export function allowedMethodsParam(methods: readonly KashierMethod[], accountMethods: readonly KashierMethod[] | null): string | undefined {
  if (accountMethods && accountMethods.every((m) => methods.includes(m))) return undefined;
  return methods.map((m) => (KASHIER_BNPL.includes(m) ? `bnpl[${m}]` : m)).join(',');
}

export type SessionInput = {
  amountCents: number;
  /** Our payment id: Kashier's `order` (unique per merchant) and `merchantOrderId` in the result. */
  reference: string;
  workspaceId: string;
  customerEmail: string;
  description: string;
  /** Where the customer comes back after paying. */
  redirectUrl: string;
  /** This mode's webhook endpoint (`serverWebhook`). */
  webhookUrl: string;
  locale: 'ar' | 'en';
  allowedMethods?: string;
  /** The method the customer picked on our page: Kashier's checkout opens on it. */
  defaultMethod?: KashierMethod;
};

/** Our brand teal (the dashboard's light-theme `--color-brand`): Kashier paints its buttons and selections with it. */
const KASHIER_BRAND_COLOR = '#367a6b';

export type KashierCreatedSession = { _id: string; sessionUrl: string; status?: string; merchantId?: string; paymentParams?: { amount?: string; currency?: string; order?: string } };

/** Opens a payment session for Kashier's hosted checkout. The amount is always ours, never the browser's. */
export async function createPaymentSession(account: KashierAccount, input: SessionInput, fetchImpl?: typeof fetch): Promise<KashierCreatedSession> {
  const amount = kashierAmount(input.amountCents);
  const session = await call<KashierCreatedSession>(
    account.mode,
    '/v3/payment/sessions',
    {
      method: 'POST',
      secretKey: account.secretKey,
      apiKey: account.apiKey,
      body: {
        expireAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        maxFailureAttempts: 3,
        paymentType: 'credit',
        amount,
        currency: 'EGP',
        order: input.reference,
        merchantId: account.merchantId,
        merchantRedirect: input.redirectUrl,
        serverWebhook: input.webhookUrl,
        display: input.locale,
        type: 'one-time',
        ...(input.allowedMethods ? { allowedMethods: input.allowedMethods } : {}),
        // BNPL providers aren't a method of their own on Kashier's page; they open under their `bnpl` tab.
        ...(input.defaultMethod ? { defaultMethod: KASHIER_BNPL.includes(input.defaultMethod) ? 'bnpl' : input.defaultMethod } : {}),
        brandColor: KASHIER_BRAND_COLOR,
        failureRedirect: false,
        manualCapture: false,
        description: input.description.slice(0, 119),
        customer: { email: input.customerEmail, reference: input.workspaceId },
        metaData: { paymentId: input.reference, workspaceId: input.workspaceId },
      },
    },
    fetchImpl,
  );
  if (typeof session._id !== 'string' || typeof session.sessionUrl !== 'string' || !/^https:\/\//.test(session.sessionUrl)) {
    throw new KashierError('Kashier returned no payment session', 502);
  }
  // Kashier echoes what it will charge: it must be our order, at our price.
  const echoed = session.paymentParams;
  if (echoed && ((echoed.amount !== undefined && parseKashierAmount(echoed.amount) !== input.amountCents) || (echoed.order !== undefined && echoed.order !== input.reference))) {
    throw new KashierError('Kashier echoed a different order or amount', 502);
  }
  return session;
}

/** A session's authoritative result (`GET /v3/payment/sessions/{id}/payment`, Secret Key). */
export type KashierSessionPayment = {
  sessionId?: string;
  status?: string;
  merchantId?: string;
  merchantOrderId?: string;
  amount?: string | number;
  currency?: string;
  method?: string;
  orderId?: string;
  metaData?: Record<string, unknown>;
};

export async function getSessionPayment(account: KashierAccount, sessionId: string, fetchImpl?: typeof fetch): Promise<KashierSessionPayment> {
  const res = await call<{ data?: KashierSessionPayment }>(account.mode, `/v3/payment/sessions/${encodeURIComponent(sessionId)}/payment`, { secretKey: account.secretKey }, fetchImpl);
  if (!res.data || typeof res.data !== 'object') throw new KashierError('Kashier returned no session result', 502);
  return res.data;
}

/**
 * Kashier's method names for the account (`acceptedPaymentMethods`) mapped to ours: its "installments"
 * is what sessions call `bank_installments`. Names we don't offer (instapay, basata, …) are dropped.
 */
const ACCOUNT_METHOD_NAMES: Record<string, KashierMethod> = { card: 'card', wallet: 'wallet', installments: 'bank_installments', bank_installments: 'bank_installments' };

/**
 * Reads the merchant's entitlement (`GET /v2/merchants/{mid}/paymentMethods`). Kashier answers
 * `{ acceptedPaymentMethods: ["card", "wallet", "installments", …], acceptedBNPLMethods: ["valu", …], … }`
 * (seen from the live API; the published example shows a `{ card: true, … }` map instead, so that is
 * read too). Null when the answer is in neither shape: then nothing is narrowed (Kashier's checkout
 * applies the entitlement itself), rather than treating an unreadable answer as "no methods".
 */
export function parseAccountMethods(body: unknown): KashierMethod[] | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.acceptedPaymentMethods)) {
    const names = new Set<KashierMethod>();
    for (const m of b.acceptedPaymentMethods) {
      const ours = typeof m === 'string' ? ACCOUNT_METHOD_NAMES[m.toLowerCase()] : undefined;
      if (ours) names.add(ours);
    }
    if (Array.isArray(b.acceptedBNPLMethods)) {
      for (const m of b.acceptedBNPLMethods) if (typeof m === 'string' && KASHIER_BNPL.includes(m.toLowerCase() as KashierMethod)) names.add(m.toLowerCase() as KashierMethod);
    }
    return KASHIER_METHODS.filter((m) => names.has(m));
  }
  const flags = Object.entries(b).filter(([, v]) => typeof v === 'boolean');
  if (flags.length > 0) return KASHIER_METHODS.filter((m) => b[m] === true || (m === 'bank_installments' && b.installments === true) || (KASHIER_BNPL.includes(m) && b.bnpl === true && b[m] !== false));
  return null;
}

/** The methods the merchant account has in this mode (`GET /v2/merchants/{mid}/paymentMethods`, no credential); null = unreadable. */
export async function getAccountMethods(mode: KashierMode, merchantId: string, fetchImpl?: typeof fetch): Promise<KashierMethod[] | null> {
  return parseAccountMethods(await call<unknown>(mode, `/v2/merchants/${encodeURIComponent(merchantId)}/paymentMethods`, {}, fetchImpl));
}

export type KashierConnectionResult = { error: KashierConnectionError | null; apiKeyUnconfirmed: boolean; accountMethods: KashierMethod[] | null };

/**
 * Checks one mode's credentials without moving money:
 * 1. `POST /v2/merchants/validate-credentials` with the Secret Key: 401 = wrong Secret Key for this mode.
 *    Kashier hasn't published the response shape, so a key's validity is only read when the answer
 *    states it plainly; otherwise the Payment API Key stays "unconfirmed" until the first signed webhook.
 * 2. `GET /v2/merchants/{mid}/paymentMethods`: the Merchant ID exists, and which methods it has.
 */
export async function testKashierConnection(account: KashierAccount, fetchImpl?: typeof fetch): Promise<KashierConnectionResult> {
  const fail = (error: KashierConnectionError): KashierConnectionResult => ({ error, apiKeyUnconfirmed: false, accountMethods: null });
  let verdict: unknown;
  try {
    verdict = await call(account.mode, '/v2/merchants/validate-credentials', {
      method: 'POST',
      secretKey: account.secretKey,
      body: { secretKeys: [{ mode: account.mode, key: account.secretKey }], apiKeys: [{ mode: account.mode, key: account.apiKey }] },
    }, fetchImpl);
  } catch (err) {
    if (!(err instanceof KashierError)) throw err;
    if (err.status === 401) return fail('invalid_secret_key');
    if (err.status === 403) return fail('forbidden');
    if (err.status === 0) return fail('unreachable');
    return fail('unexpected');
  }
  const secretOk = plainVerdict(verdict, 'secretKeys');
  const apiOk = plainVerdict(verdict, 'apiKeys');
  if (secretOk === false) return fail('wrong_mode');
  if (apiOk === false) return fail('invalid_api_key');
  let accountMethods: KashierMethod[] | null;
  try {
    accountMethods = await getAccountMethods(account.mode, account.merchantId, fetchImpl);
  } catch (err) {
    if (!(err instanceof KashierError)) throw err;
    if (err.status === 400 || err.status === 404) return fail('invalid_merchant');
    if (err.status === 0) return fail('unreachable');
    return fail('unexpected');
  }
  return { error: null, apiKeyUnconfirmed: apiOk !== true, accountMethods };
}

/** `true`/`false` when the validate-credentials answer plainly states the first key's validity; null when it doesn't. */
function plainVerdict(body: unknown, list: 'secretKeys' | 'apiKeys'): boolean | null {
  const entries = (body as Record<string, unknown> | null)?.[list] ?? ((body as { data?: Record<string, unknown> } | null)?.data?.[list] as unknown);
  const first = Array.isArray(entries) ? (entries[0] as Record<string, unknown> | undefined) : undefined;
  for (const key of ['valid', 'isValid'] as const) if (typeof first?.[key] === 'boolean') return first[key] as boolean;
  return null;
}

export async function recordKashierConnectionTest(sql: Sql, mode: KashierMode, result: KashierConnectionResult) {
  await patchMode(
    sql,
    mode,
    result.error
      ? { validationError: result.error }
      : { validatedAt: new Date().toISOString(), validationError: null, apiKeyUnconfirmed: result.apiKeyUnconfirmed, accountMethods: result.accountMethods },
  );
}

// --- webhooks ------------------------------------------------------------------------------------

/** RFC 3986 encoding of one value, as Kashier's samples do (`query-string`, `PHP_QUERY_RFC3986`, `Uri.EscapeDataString`). */
const rfc3986 = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Kashier's webhook signature (https://developers.kashier.io/docs/webhooks#step-4-verify-the-signature):
 * sort `data.signatureKeys`, take each key's value from `data`, URL-encode only the value, join as
 * `k=v&k=v`, HMAC-SHA256 with the mode's Payment API Key, compare (case-insensitive hex) with
 * `x-kashier-signature`.
 */
export function kashierSignature(data: Record<string, unknown>, apiKey: string): string | null {
  const keys = data.signatureKeys;
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === 'string')) return null;
  const parts: string[] = [];
  for (const key of [...(keys as string[])].sort()) {
    const value = data[key];
    if (value === undefined || value === null || typeof value === 'object') return null;
    parts.push(`${key}=${rfc3986(String(value))}`);
  }
  return createHmac('sha256', apiKey).update(parts.join('&')).digest('hex');
}

export function verifyKashierWebhook(data: unknown, header: string | undefined, apiKey: string): boolean {
  if (!header || !data || typeof data !== 'object') return false;
  const expected = kashierSignature(data as Record<string, unknown>, apiKey);
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(header.trim().toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Kashier's own de-duplication key: one transaction reaching one status (plus the event kind). */
export const kashierEventId = (event: string, data: Record<string, unknown>) =>
  `${String(data.transactionId ?? data.kashierOrderId ?? 'na')}:${String(data.status ?? 'na')}:${event}`;

export async function kashierEventSeen(sql: Sql, eventId: string): Promise<boolean> {
  const [row] = await sql<{ one: number }[]>`select 1 as one from payment_events where provider = 'kashier' and event_id = ${eventId}`;
  return Boolean(row);
}

export async function recordKashierEvent(db: Db, eventId: string, mode: KashierMode, type: string, objectId: string | null, outcome: string) {
  await db.insert(paymentEvents).values({ provider: 'kashier', eventId, mode, type, objectId, outcome }).onConflictDoNothing();
}

// --- settling ------------------------------------------------------------------------------------

const FAILED = new Set(['FAILED', 'EXPIRED', 'ABANDONED', 'REJECTED', 'VOIDED', 'REVERSED']);
const REFUNDED = new Set(['REFUNDED', 'PARTIALLY_REFUNDED', 'REFUND_PENDING']);

/** Why a session reported PAID must not activate its plan (empty = fine). */
export function kashierReviewReasons(result: KashierSessionPayment, payment: { id: string; amountCents: number; currency: string }, merchantId: string): string[] {
  const reasons: string[] = [];
  if (String(result.merchantId ?? '').toUpperCase() !== merchantId.toUpperCase()) reasons.push('merchant_mismatch');
  if (result.merchantOrderId !== payment.id) reasons.push('order_mismatch');
  if (String(result.currency ?? '').toUpperCase() !== payment.currency) reasons.push('currency_mismatch');
  if (parseKashierAmount(result.amount) !== payment.amountCents) reasons.push('amount_mismatch');
  return reasons;
}

export type KashierSettled = { paymentId: string; workspaceId: string; status: string; activated: boolean };

/**
 * Records a session's authoritative result (read from Kashier with the payment's own mode key) against
 * its payment, under a row lock so concurrent and out-of-order deliveries settle one at a time:
 * - PAID and every check passes → activate the plan once; a check fails → `review` (no plan);
 * - FAILED / EXPIRED / ABANDONED / REJECTED / VOIDED / REVERSED → a pending payment turns `failed`;
 * - REFUNDED (also when it arrives before we saw it paid) → `refunded`, never activated; a partial
 *   refund is audited and leaves the plan alone (the admin decides);
 * - CREATED / OPENED / PENDING → stays pending.
 * Returns null when the session isn't one of ours in this mode.
 */
export async function settleKashierPayment(db: Db, account: KashierAccount, sessionId: string, result: KashierSessionPayment): Promise<KashierSettled | null> {
  return db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.sessionId, sessionId), eq(payments.provider, 'kashier')))
      .for('update');
    if (!payment || payment.mode !== account.mode) return null;
    const base = { paymentId: payment.id, workspaceId: payment.workspaceId };
    const status = String(result.status ?? '').toUpperCase();
    const providerPaymentId = result.orderId && result.orderId !== 'NA' ? result.orderId : null;
    const details: PaymentDetails = {
      method: 'kashier',
      sessionId,
      ...(providerPaymentId ? { orderId: providerPaymentId } : {}),
      ...(result.method ? { paymentMethod: result.method } : {}),
      amount: payment.amountCents / 100,
      ...(payment.mode === 'test' ? { test: true } : {}),
    };

    if (REFUNDED.has(status)) {
      const full = status === 'REFUNDED';
      if (payment.status === 'paid' && full) await tx.update(payments).set({ status: 'refunded', raw: result as never }).where(eq(payments.id, payment.id));
      // Refunded before we ever saw it paid (out of order): the money went back, so nothing is activated.
      else if (payment.status === 'pending') await tx.update(payments).set({ status: full ? 'refunded' : 'review', error: full ? 'refunded_before_paid' : 'partial_refund_before_paid', raw: result as never }).where(eq(payments.id, payment.id));
      await tx.insert(auditLogs).values({ action: 'payment.refunded', targetType: 'payment', targetId: payment.id, details: { provider: 'kashier', mode: payment.mode, workspaceId: payment.workspaceId, planId: payment.planId, status, full } });
      const [after] = await tx.select({ status: payments.status }).from(payments).where(eq(payments.id, payment.id));
      return { ...base, status: after!.status, activated: false };
    }
    if (payment.status !== 'pending' && payment.status !== 'failed') return { ...base, status: payment.status, activated: false };

    if (status === 'PAID') {
      const reasons = kashierReviewReasons(result, payment, account.merchantId);
      const extra = { providerPaymentId, raw: result, audit: { sessionId, kashierStatus: status, method: result.method ?? null, amount: result.amount ?? null } };
      if (payment.mode === 'test') {
        // A sandbox payment proves the flow end to end but buys nothing: it is verified and recorded,
        // never turned into a plan or a plan request (so no admin approval can activate one either).
        await tx
          .update(payments)
          .set({ status: reasons.length > 0 ? 'review' : 'paid', providerPaymentId, error: reasons.length > 0 ? reasons.join(',') : null, raw: result as never, paidAt: reasons.length > 0 ? null : new Date() })
          .where(eq(payments.id, payment.id));
        await tx.insert(auditLogs).values({
          action: 'payment.test_paid',
          targetType: 'payment',
          targetId: payment.id,
          details: { provider: 'kashier', mode: 'test', planId: payment.planId, months: payment.months, amountCents: payment.amountCents, activated: false, reasons, ...extra.audit },
        });
        return { ...base, status: reasons.length > 0 ? 'review' : 'paid', activated: false };
      }
      if (reasons.length > 0) {
        await holdPaymentForReview(tx, payment, details, reasons, extra);
        return { ...base, status: 'review', activated: false };
      }
      await activatePaidPayment(tx, payment, details, extra);
      return { ...base, status: 'paid', activated: true };
    }
    if (FAILED.has(status) && payment.status === 'pending') {
      await tx.update(payments).set({ status: 'failed', error: status.toLowerCase(), raw: result as never }).where(and(eq(payments.id, payment.id), eq(payments.status, 'pending')));
      return { ...base, status: 'failed', activated: false };
    }
    return { ...base, status: payment.status, activated: false };
  });
}
