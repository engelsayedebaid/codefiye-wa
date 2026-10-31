import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, auditLogs, eq, paymentEvents, payments, planRequests, type Db, type Sql } from '@wa/db';
import { decrypt, deriveKey, encrypt } from '@wa/provider';
import {
  keyMode,
  type PaymentDetails,
  XPAY_METHODS,
  XPAY_MODES,
  type XPayConnectionError,
  type XPayMethod,
  type XPayMode,
  type XPayModeView,
  type XPayPublicConfig,
  xpayReady,
  type XPaySettings,
  type XPaySettingsInput,
} from '@wa/shared';
import { applyPlan } from './plans';

/**
 * XPay (Egypt) online payments: the server opens a Checkout Session (`uiMode: custom`), the dashboard
 * renders XPay's PaymentElement inside our own payment popup (themed with our colours), and XPay
 * reports the result with a signed webhook. Test and Live are kept fully apart: own keys, own webhook
 * endpoint and secret, and a payment is only ever handled with the keys of the mode it was opened in.
 * https://docs.xpay.app
 */
export const XPAY_API = 'https://api.xpay.app';
const TIMEOUT_MS = 20_000;

// --- stored settings -----------------------------------------------------------------------------

type StoredMode = {
  publishableKey: string;
  /** Hex of the sealed blob (AES-256-GCM, key derived from AUTH_ENCRYPTION_KEY, AAD = mode + name). */
  secretKey: string | null;
  webhookSecret: string | null;
  validatedAt: string | null;
  validationError: XPayConnectionError | null;
  lastWebhookAt: string | null;
};

/** Stored in `settings` under `xpay`. */
type StoredXPay = { enabled: boolean; mode: XPayMode; methods: XPayMethod[]; test: StoredMode; live: StoredMode };

const EMPTY_MODE: StoredMode = { publishableKey: '', secretKey: null, webhookSecret: null, validatedAt: null, validationError: null, lastWebhookAt: null };
const SALT = 'wa-xpay';
type SecretName = 'secretKey' | 'webhookSecret';

const aad = (mode: XPayMode, name: SecretName) => `xpay:${mode}:${name}`;

function seal(master: Buffer, mode: XPayMode, name: SecretName, plaintext: string) {
  return encrypt(deriveKey(master, SALT), Buffer.from(plaintext, 'utf8'), aad(mode, name)).toString('hex');
}

/** Opens a sealed secret; null when missing or unreadable (wrong AUTH_ENCRYPTION_KEY, or tampered). */
function open(master: Buffer | null, mode: XPayMode, name: SecretName, hex: string | null): string | null {
  if (!master || !hex) return null;
  try {
    return decrypt(deriveKey(master, SALT), Buffer.from(hex, 'hex'), aad(mode, name)).toString('utf8');
  } catch {
    return null;
  }
}

/** `sk_live_••••a1b2`: enough to recognise a key, never enough to use it. */
function hint(secret: string): string {
  const prefix = /^(sk_(?:test|live)_|whsec_)/.exec(secret)?.[1] ?? '';
  return `${prefix}••••${secret.slice(-4)}`;
}

async function readStored(sql: Sql): Promise<StoredXPay> {
  const [row] = await sql<{ value: Record<string, unknown> }[]>`select value from settings where key = 'xpay'`;
  const v = row?.value ?? {};
  const methods = Array.isArray(v.methods) ? (v.methods as string[]).filter((m): m is XPayMethod => (XPAY_METHODS as readonly string[]).includes(m)) : ['card' as const];
  const stored: StoredXPay = {
    enabled: v.enabled === true,
    mode: v.mode === 'live' ? 'live' : 'test',
    methods,
    test: { ...EMPTY_MODE, ...(v.test as Partial<StoredMode> | undefined) },
    live: { ...EMPTY_MODE, ...(v.live as Partial<StoredMode> | undefined) },
  };
  // A first version kept one flat set of keys: file it under the mode its publishable key belongs to.
  // (Its secrets were sealed without the mode, so they read as unreadable and must be entered again.)
  if (typeof v.publishableKey === 'string' && !v.test && !v.live) {
    const mode = keyMode(v.publishableKey) ?? 'test';
    stored[mode] = { ...EMPTY_MODE, publishableKey: v.publishableKey, secretKey: (v.secretKey as string | null) ?? null, webhookSecret: (v.webhookSecret as string | null) ?? null };
    stored.mode = mode;
  }
  return stored;
}

async function writeStored(sql: Sql, value: StoredXPay) {
  await sql`
    insert into settings (key, value, updated_at) values ('xpay', ${sql.json(value as never)}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

/** Sets one field of one mode in place, so a webhook or a connection test never overwrites the admin's edits. */
async function patchMode(sql: Sql, mode: XPayMode, fields: Partial<Pick<StoredMode, 'validatedAt' | 'validationError' | 'lastWebhookAt'>>) {
  await sql`
    update settings set value = jsonb_set(value, ${sql.array([mode])}::text[], coalesce(value -> ${mode}, '{}'::jsonb) || ${sql.json(fields as never)}::jsonb), updated_at = now()
    where key = 'xpay'`;
}

export const xpayWebhookUrl = (publicUrl: string, mode: XPayMode) => `${publicUrl.replace(/\/+$/, '')}/api/payments/xpay/webhook/${mode}`;

function modeView(master: Buffer | null, mode: XPayMode, s: StoredMode, publicUrl: string): XPayModeView {
  const secretKey = open(master, mode, 'secretKey', s.secretKey);
  const webhookSecret = open(master, mode, 'webhookSecret', s.webhookSecret);
  return {
    publishableKey: s.publishableKey,
    secretKeyHint: secretKey ? hint(secretKey) : null,
    webhookSecretHint: webhookSecret ? hint(webhookSecret) : null,
    unreadable: (s.secretKey !== null && !secretKey) || (s.webhookSecret !== null && !webhookSecret),
    webhookUrl: xpayWebhookUrl(publicUrl, mode),
    validatedAt: s.validatedAt,
    validationError: s.validationError,
    lastWebhookAt: s.lastWebhookAt,
  };
}

/** The admin's view: secrets only as masked hints (and only if they can still be opened). */
export async function getXPaySettings(sql: Sql, master: Buffer | null, publicUrl: string): Promise<XPaySettings> {
  const s = await readStored(sql);
  return {
    enabled: s.enabled,
    mode: s.mode,
    methods: s.methods,
    test: modeView(master, 'test', s.test, publicUrl),
    live: modeView(master, 'live', s.live, publicUrl),
    encryptionReady: master !== null,
  };
}

/**
 * Saves the admin's changes. Secrets are sealed per mode; a blank secret keeps the stored one, a new
 * one replaces it (rotation), `clear` wipes that mode's keys. Changing a mode's keys forgets its last
 * connection test, so the status shown always belongs to the keys in place.
 */
export async function saveXPaySettings(sql: Sql, master: Buffer, input: XPaySettingsInput) {
  const s = await readStored(sql);
  const next: StoredXPay = { enabled: input.enabled, mode: input.mode, methods: [...new Set(input.methods)], test: s.test, live: s.live };
  for (const mode of XPAY_MODES) {
    const change = input[mode];
    if (!change) continue;
    if (change.clear) {
      next[mode] = { ...EMPTY_MODE };
      continue;
    }
    const current = s[mode];
    const keysChanged = Boolean(change.secretKey || (change.publishableKey !== undefined && change.publishableKey !== current.publishableKey));
    next[mode] = {
      ...current,
      publishableKey: change.publishableKey ?? current.publishableKey,
      secretKey: change.secretKey ? seal(master, mode, 'secretKey', change.secretKey) : current.secretKey,
      webhookSecret: change.webhookSecret ? seal(master, mode, 'webhookSecret', change.webhookSecret) : current.webhookSecret,
      ...(keysChanged ? { validatedAt: null, validationError: null } : {}),
      ...(change.webhookSecret ? { lastWebhookAt: null } : {}),
    };
  }
  await writeStored(sql, next);
}

/** One mode's keys, opened. */
export type XPayAccount = { mode: XPayMode; publishableKey: string; secretKey: string; webhookSecret: string; methods: XPayMethod[] };

/**
 * A mode's account, opened, if complete; null otherwise. Used for that mode's webhooks and for
 * payments opened in it (also after the admin switched modes), never as a fallback for the other one.
 */
export async function getXPayModeAccount(sql: Sql, master: Buffer | null, mode: XPayMode): Promise<XPayAccount | null> {
  const s = await readStored(sql);
  const m = s[mode];
  const secretKey = open(master, mode, 'secretKey', m.secretKey);
  const webhookSecret = open(master, mode, 'webhookSecret', m.webhookSecret);
  if (!secretKey || !webhookSecret || keyMode(m.publishableKey) !== mode || keyMode(secretKey) !== mode) return null;
  return { mode, publishableKey: m.publishableKey, secretKey, webhookSecret, methods: s.methods };
}

/** The account new checkouts are opened with: the active mode, when XPay is on and ready. */
export async function getActiveXPayAccount(sql: Sql, master: Buffer | null): Promise<XPayAccount | null> {
  const settings = await getXPaySettings(sql, master, '');
  if (!xpayReady(settings)) return null;
  return getXPayModeAccount(sql, master, settings.mode);
}

/** What one caller may use: live mode for everyone; test mode for admins only, so test cards can't buy real plans. */
export async function getXPayPublicConfig(sql: Sql, master: Buffer | null, isAdmin: boolean): Promise<XPayPublicConfig> {
  const account = await getActiveXPayAccount(sql, master);
  if (!account || (account.mode === 'test' && !isAdmin)) return { enabled: false, publishableKey: '', mode: account?.mode ?? 'test' };
  return { enabled: true, publishableKey: account.publishableKey, mode: account.mode };
}

export const recordWebhookSeen = (sql: Sql, mode: XPayMode) => patchMode(sql, mode, { lastWebhookAt: new Date().toISOString() });

// --- API -----------------------------------------------------------------------------------------

export class XPayError extends Error {
  constructor(
    message: string,
    /** 0 = no answer (timeout, network). */
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

/** The parts of a Checkout Session we act on (same shape in the API and in webhooks). Amounts are in piastres. */
export type XPaySession = {
  id: string;
  status: 'open' | 'complete' | 'expired';
  paymentStatus: 'paid' | 'unpaid' | 'no_payment_required';
  livemode?: boolean;
  isExpired?: boolean;
  amountSubtotal?: number | string;
  amountTotal?: number | string;
  currency?: string;
  totalDetails?: { amountDiscount?: number; amountShipping?: number; amountTax?: number; amountPlatformFee?: number; amountCollectedVat?: number } | null;
  paymentIntentId?: string | null;
  clientSecret?: string | null;
  metadata?: unknown;
};

async function call<T>(account: XPayAccount, path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${XPAY_API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${account.secretKey}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Timeout or network failure: never retried here (a create could have gone through); the caller decides.
    throw new XPayError(err instanceof Error && err.name === 'TimeoutError' ? 'XPay did not answer in time' : 'XPay could not be reached', 0, 'unreachable');
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: { message?: string; code?: string } }) | null;
  if (!res.ok || !body) throw new XPayError(String(body?.error?.message ?? `XPay answered ${res.status}`).slice(0, 300), res.status, body?.error?.code ?? null);
  return body;
}

export type SessionInput = {
  amountCents: number;
  /** Shown in XPay's dashboard and receipt. */
  itemName: string;
  /** Our payment id (metadata + idempotency key). */
  reference: string;
  workspaceId: string;
  /** Where a full-page bank verification returns the customer. */
  redirectUrl: string;
  locale: 'ar' | 'en';
};

/** Opens a checkout for our own form (`uiMode: custom`): the dashboard mounts XPay's PaymentElement. */
export function createCheckoutSession(account: XPayAccount, input: SessionInput, fetchImpl?: typeof fetch) {
  return call<XPaySession & { clientSecret: string }>(
    account,
    '/checkout/sessions',
    {
      method: 'POST',
      idempotencyKey: input.reference,
      body: {
        mode: 'payment',
        uiMode: 'custom',
        currency: 'EGP',
        locale: input.locale,
        paymentMethodTypes: account.methods,
        afterCompletion: { type: 'redirect', redirect: { url: input.redirectUrl } },
        lineItems: [{ priceData: { currency: 'EGP', unitAmount: input.amountCents, productData: { name: input.itemName } }, quantity: 1 }],
        metadata: { paymentId: input.reference, workspaceId: input.workspaceId },
        expiresAfterMinutes: 60,
      },
    },
    fetchImpl,
  );
}

export function getCheckoutSession(account: XPayAccount, id: string, fetchImpl?: typeof fetch) {
  return call<XPaySession>(account, `/checkout/sessions/${encodeURIComponent(id)}`, {}, fetchImpl);
}

/**
 * Checks a mode's secret key without changing anything: reads a session id that can't exist.
 * XPay documents `GET /checkout/sessions/{id}` as 401 for an invalid key, 403 for a key without
 * permission and 404 for a session not in this account and mode — so 404 means the key works.
 */
export async function testConnection(account: XPayAccount, fetchImpl?: typeof fetch): Promise<XPayConnectionError | null> {
  if (keyMode(account.secretKey) !== account.mode || keyMode(account.publishableKey) !== account.mode) return 'wrong_mode';
  try {
    await getCheckoutSession(account, `cs_${account.mode}_connection_check`, fetchImpl);
    return 'unexpected';
  } catch (err) {
    if (!(err instanceof XPayError)) throw err;
    if (err.status === 404) return null;
    if (err.status === 401) return 'invalid_key';
    if (err.status === 403) return 'forbidden';
    if (err.status === 0) return 'unreachable';
    return 'unexpected';
  }
}

export async function recordConnectionTest(sql: Sql, mode: XPayMode, error: XPayConnectionError | null) {
  await patchMode(sql, mode, error ? { validationError: error } : { validatedAt: new Date().toISOString(), validationError: null });
}

// --- webhooks ------------------------------------------------------------------------------------

export type XPayEvent = { id: string; type: string; livemode?: boolean; data: { object: Record<string, unknown> } };

/**
 * Checks `XPay-Signature: t=<unix>,v1=<hex>`: HMAC-SHA256 of `${t}.${rawBody}` with the endpoint's
 * `whsec_…` secret, compared in constant time, within five minutes either way (XPay's replay window).
 * Returns the parsed event, or null when it doesn't verify.
 */
export function verifyWebhook(rawBody: string, header: string | undefined, secret: string, now = Date.now()): XPayEvent | null {
  if (!header) return null;
  const parts = new Map(header.split(',').map((p) => p.trim().split('=', 2) as [string, string]));
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1');
  if (!Number.isFinite(t) || !v1) return null;
  if (Math.abs(now / 1000 - t) > 300) return null;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  const given = Buffer.from(v1.toLowerCase());
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const event = JSON.parse(rawBody) as XPayEvent;
    return event && typeof event.id === 'string' && typeof event.type === 'string' && event.data?.object ? event : null;
  } catch {
    return null;
  }
}

/** Whether an event was already handled (a redelivery). */
export async function eventSeen(sql: Sql, eventId: string): Promise<boolean> {
  const [row] = await sql<{ one: number }[]>`select 1 as one from payment_events where provider = 'xpay' and event_id = ${eventId}`;
  return Boolean(row);
}

/** Records a handled event; a concurrent duplicate simply loses the insert. */
export async function recordEvent(db: Db, event: XPayEvent, mode: XPayMode, objectId: string | null, outcome: string) {
  await db.insert(paymentEvents).values({ provider: 'xpay', eventId: event.id, mode, type: event.type, objectId, outcome }).onConflictDoNothing();
}

// --- settling ------------------------------------------------------------------------------------

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

/**
 * Pass-through charges (XPay's processing fee and VAT when the account passes them to the customer, or
 * tax) may add at most this share of the price; anything beyond goes to review.
 */
const MAX_EXTRA_SHARE = 0.15;

/**
 * Why a paid session must not activate its plan (empty = fine). Per XPay's documented semantics all
 * amounts are in the smallest unit: our single line item is `amountCents`, so the subtotal must equal it
 * exactly, nothing may be discounted, and the total must equal the subtotal plus the pass-through
 * amounts XPay itemises in `totalDetails` (each named, none unexplained) within a sane cap.
 */
export function reviewReasons(session: XPaySession, payment: { id: string; workspaceId: string; amountCents: number; currency: string; mode: XPayMode }): string[] {
  const reasons: string[] = [];
  if (session.livemode !== (payment.mode === 'live')) reasons.push('mode_mismatch');
  const meta = (session.metadata ?? {}) as Record<string, unknown>;
  if (meta.paymentId !== payment.id || meta.workspaceId !== payment.workspaceId) reasons.push('order_mismatch');
  if (String(session.currency ?? '').toUpperCase() !== payment.currency) reasons.push('currency_mismatch');
  const subtotal = num(session.amountSubtotal);
  const total = num(session.amountTotal);
  const d = session.totalDetails ?? {};
  const discount = num(d.amountDiscount ?? 0);
  const extras = [d.amountTax, d.amountShipping, d.amountPlatformFee, d.amountCollectedVat].reduce<number>((sum, v) => sum + (v === undefined || v === null ? 0 : num(v)), 0);
  if (subtotal !== payment.amountCents) reasons.push('subtotal_mismatch');
  if (discount !== 0) reasons.push('discounted');
  if (!Number.isFinite(total) || !Number.isFinite(extras) || extras < 0 || Math.abs(total - (subtotal - discount + extras)) > 1) reasons.push('total_mismatch');
  else if (extras > payment.amountCents * MAX_EXTRA_SHARE) reasons.push('fees_too_high');
  return reasons;
}

export type Settled = { paymentId: string; workspaceId: string; status: string; activated: boolean };

/**
 * Records a Checkout Session's authoritative state (read from XPay with the payment's own mode key)
 * against its payment, under a row lock so concurrent deliveries settle one at a time:
 * - paid and every check passes → activate the plan once (an approved `plan_requests` row records it);
 * - paid but a check fails → `review`: no plan; a pending plan request lets an admin decide;
 * - expired or failed (`failed` = an async_payment_failed event) → mark a pending payment failed;
 * - open, or complete-but-unpaid (a Fawry reference) → stays pending.
 * Returns null when the session isn't one of ours.
 */
export async function settlePayment(db: Db, mode: XPayMode, session: XPaySession, failed = false): Promise<Settled | null> {
  return db.transaction(async (tx) => {
    const [payment] = await tx.select().from(payments).where(eq(payments.sessionId, session.id)).for('update');
    // A session only counts in the mode its payment was opened in (a test event never touches a live payment).
    if (!payment || payment.mode !== mode) return null;
    const base = { paymentId: payment.id, workspaceId: payment.workspaceId };
    if (payment.status === 'paid' || payment.status === 'refunded' || payment.status === 'review') return { ...base, status: payment.status, activated: false };

    if (session.paymentStatus !== 'paid') {
      const expired = session.status === 'expired' || session.isExpired === true;
      if ((expired || failed) && payment.status === 'pending') {
        await tx
          .update(payments)
          .set({ status: 'failed', error: expired ? 'expired' : 'payment_failed', raw: session })
          .where(and(eq(payments.id, payment.id), eq(payments.status, 'pending')));
        return { ...base, status: 'failed', activated: false };
      }
      return { ...base, status: payment.status, activated: false };
    }

    const details: PaymentDetails = {
      method: 'xpay',
      sessionId: session.id,
      ...(session.paymentIntentId ? { paymentId: session.paymentIntentId } : {}),
      amount: payment.amountCents / 100,
      ...(payment.mode === 'test' ? { test: true } : {}),
    };
    // A manual request still waiting is moot now that the customer paid.
    await tx
      .update(planRequests)
      .set({ status: 'cancelled', decidedAt: new Date() })
      .where(and(eq(planRequests.workspaceId, payment.workspaceId), eq(planRequests.status, 'pending')));

    const reasons = reviewReasons(session, payment);
    if (reasons.length > 0) {
      // Money may have moved but the amounts don't add up: nothing is activated; an admin approves or rejects.
      const [request] = await tx
        .insert(planRequests)
        .values({ workspaceId: payment.workspaceId, planId: payment.planId, months: payment.months, status: 'pending', payment: { ...details, review: reasons }, note: 'XPay payment held for review' })
        .returning({ id: planRequests.id });
      await tx
        .update(payments)
        .set({ status: 'review', providerPaymentId: session.paymentIntentId ?? null, error: reasons.join(','), raw: session, planRequestId: request!.id })
        .where(eq(payments.id, payment.id));
      await tx.insert(auditLogs).values({
        action: 'payment.review',
        targetType: 'payment',
        targetId: payment.id,
        details: { provider: 'xpay', mode: payment.mode, reasons, sessionId: session.id, expectedCents: payment.amountCents, amountSubtotal: session.amountSubtotal ?? null, amountTotal: session.amountTotal ?? null, currency: session.currency ?? null },
      });
      return { ...base, status: 'review', activated: false };
    }

    const [request] = await tx
      .insert(planRequests)
      .values({ workspaceId: payment.workspaceId, planId: payment.planId, months: payment.months, status: 'approved', payment: details, adminNote: payment.mode === 'test' ? 'XPay (test)' : 'XPay', decidedAt: new Date() })
      .returning({ id: planRequests.id });
    const { after } = await applyPlan(tx, payment.workspaceId, payment.planId, payment.months);
    await tx
      .update(payments)
      .set({ status: 'paid', providerPaymentId: session.paymentIntentId ?? null, error: null, raw: session, paidAt: new Date(), planRequestId: request!.id })
      .where(eq(payments.id, payment.id));
    await tx.insert(auditLogs).values({
      action: 'payment.paid',
      targetType: 'payment',
      targetId: payment.id,
      targetLabel: after.name,
      details: {
        provider: 'xpay',
        mode: payment.mode,
        planId: payment.planId,
        months: payment.months,
        amountCents: payment.amountCents,
        amountTotal: session.amountTotal ?? null,
        sessionId: session.id,
        expiresAt: after.planExpiresAt?.toISOString() ?? null,
      },
    });
    return { ...base, status: 'paid', activated: true };
  });
}

/**
 * A refund applied in XPay (`charge.refunded`). The payment is marked and the admin is told through the
 * audit log; the plan itself is left as it is — whether to end it early is the admin's call.
 */
export async function recordRefund(db: Db, mode: XPayMode, charge: { paymentIntentId?: unknown; amountRefunded?: unknown; refunded?: unknown; amount?: unknown }): Promise<Settled | null> {
  if (typeof charge.paymentIntentId !== 'string') return null;
  const refunded = num(charge.amountRefunded);
  if (!Number.isFinite(refunded)) return null;
  return db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.providerPaymentId, charge.paymentIntentId as string), eq(payments.mode, mode)))
      .for('update');
    if (!payment) return null;
    const full = charge.refunded === true || refunded >= payment.amountCents;
    const status = full && payment.status === 'paid' ? 'refunded' : payment.status;
    await tx.update(payments).set({ refundedCents: refunded, status }).where(eq(payments.id, payment.id));
    await tx.insert(auditLogs).values({
      action: 'payment.refunded',
      targetType: 'payment',
      targetId: payment.id,
      details: { provider: 'xpay', mode, workspaceId: payment.workspaceId, planId: payment.planId, refundedCents: refunded, amountCents: payment.amountCents, full },
    });
    return { paymentId: payment.id, workspaceId: payment.workspaceId, status, activated: false };
  });
}
