import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, auditLogs, eq, payments, planRequests, type Db, type Sql } from '@wa/db';
import { decrypt, deriveKey, encrypt } from '@wa/provider';
import { type PaymentDetails, XPAY_METHODS, type XPayMethod, type XPayPublicConfig, xpayReady, type XPaySettings, type XPaySettingsInput } from '@wa/shared';
import { applyPlan } from './plans';

/**
 * XPay (Egypt) online payments: the server opens a Checkout Session (`uiMode: custom`), the dashboard
 * renders XPay's PaymentElement inside our own payment popup (themed with our colours), and XPay
 * reports the result with a signed webhook. https://docs.xpay.app
 */
export const XPAY_API = 'https://api.xpay.app';

/** Stored in `settings` under `xpay`; the two secrets are sealed with a key derived from AUTH_ENCRYPTION_KEY. */
type StoredXPay = {
  enabled: boolean;
  publishableKey: string;
  methods: XPayMethod[];
  /** Hex of the sealed blob. */
  secretKey: string | null;
  webhookSecret: string | null;
};

const EMPTY: StoredXPay = { enabled: false, publishableKey: '', methods: ['card'], secretKey: null, webhookSecret: null };
const SALT = 'wa-xpay';
type SecretName = 'secretKey' | 'webhookSecret';

function seal(master: Buffer, name: SecretName, plaintext: string) {
  return encrypt(deriveKey(master, SALT), Buffer.from(plaintext, 'utf8'), `xpay:${name}`).toString('hex');
}

function open(master: Buffer | null, name: SecretName, hex: string | null): string | null {
  if (!master || !hex) return null;
  try {
    return decrypt(deriveKey(master, SALT), Buffer.from(hex, 'hex'), `xpay:${name}`).toString('utf8');
  } catch {
    return null;
  }
}

async function readStored(sql: Sql): Promise<StoredXPay> {
  const [row] = await sql<{ value: Partial<StoredXPay> }[]>`select value from settings where key = 'xpay'`;
  const s = { ...EMPTY, ...row?.value };
  return { ...s, methods: s.methods.filter((m) => (XPAY_METHODS as readonly string[]).includes(m)) };
}

export const xpayWebhookUrl = (publicUrl: string) => `${publicUrl.replace(/\/+$/, '')}/api/payments/xpay/webhook`;

/** The admin's view: secrets only as "set or not" (and only if they can still be opened). */
export async function getXPaySettings(sql: Sql, master: Buffer | null, publicUrl: string): Promise<XPaySettings> {
  const s = await readStored(sql);
  return {
    enabled: s.enabled,
    publishableKey: s.publishableKey,
    methods: s.methods,
    hasSecretKey: open(master, 'secretKey', s.secretKey) !== null,
    hasWebhookSecret: open(master, 'webhookSecret', s.webhookSecret) !== null,
    webhookUrl: xpayWebhookUrl(publicUrl),
  };
}

export async function saveXPaySettings(sql: Sql, master: Buffer, input: XPaySettingsInput) {
  const s = await readStored(sql);
  const next: StoredXPay = {
    enabled: input.enabled,
    publishableKey: input.publishableKey,
    methods: [...new Set(input.methods)],
    secretKey: input.secretKey ? seal(master, 'secretKey', input.secretKey) : s.secretKey,
    webhookSecret: input.webhookSecret ? seal(master, 'webhookSecret', input.webhookSecret) : s.webhookSecret,
  };
  await sql`
    insert into settings (key, value, updated_at) values ('xpay', ${sql.json(next)}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

/** Everything a payment needs, opened; null while XPay is off or incomplete. */
export type XPayAccount = { publishableKey: string; secretKey: string; webhookSecret: string; methods: XPayMethod[] };

export async function getXPayAccount(sql: Sql, master: Buffer | null): Promise<XPayAccount | null> {
  const s = await readStored(sql);
  const secretKey = open(master, 'secretKey', s.secretKey);
  const webhookSecret = open(master, 'webhookSecret', s.webhookSecret);
  if (!secretKey || !webhookSecret || !xpayReady({ ...s, hasSecretKey: true, hasWebhookSecret: true })) return null;
  return { publishableKey: s.publishableKey, secretKey, webhookSecret, methods: s.methods };
}

export async function getXPayPublicConfig(sql: Sql, master: Buffer | null): Promise<XPayPublicConfig> {
  const account = await getXPayAccount(sql, master);
  return account ? { enabled: true, publishableKey: account.publishableKey } : { enabled: false, publishableKey: '' };
}

export class XPayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

/** The parts of a Checkout Session we act on. */
export type XPaySession = {
  id: string;
  status: 'open' | 'complete' | 'expired';
  paymentStatus: 'paid' | 'unpaid' | 'no_payment_required';
  isExpired?: boolean;
  amountTotal?: number;
  currency?: string;
  paymentIntentId?: string | null;
  clientSecret?: string | null;
  metadata?: unknown;
};

async function call<T>(account: XPayAccount, path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  const res = await fetchImpl(`${XPAY_API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${account.secretKey}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => null)) as (T & { error?: { message?: string; code?: string } }) | null;
  if (!res.ok || !body) throw new XPayError(body?.error?.message ?? `XPay answered ${res.status}`, res.status, body?.error?.code ?? null);
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

// --- webhooks ------------------------------------------------------------------------------------

export type XPayEvent = { id: string; type: string; data: { object: Record<string, unknown> } };

/**
 * Checks `XPay-Signature: t=<unix>,v1=<hex>`: HMAC-SHA256 of `${t}.${rawBody}` with the endpoint's
 * `whsec_…` secret, within five minutes. Returns the parsed event, or null when it doesn't verify.
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
    return event && typeof event.type === 'string' && event.data?.object ? event : null;
  } catch {
    return null;
  }
}

/**
 * Records a Checkout Session's state against its payment. `paid` (once) activates the plan and logs
 * an approved plan request; an expired or failed session marks a still-pending payment failed; an
 * open or unpaid-but-complete session (a Fawry reference not paid yet) stays pending. Returns null
 * when the session isn't one of ours.
 */
export async function settlePayment(db: Db, session: XPaySession, failed = false): Promise<{ paymentId: string; workspaceId: string; status: string; activated: boolean } | null> {
  return db.transaction(async (tx) => {
    const [payment] = await tx.select().from(payments).where(eq(payments.sessionId, session.id)).for('update');
    if (!payment) return null;
    const base = { paymentId: payment.id, workspaceId: payment.workspaceId };
    if (payment.status === 'paid') return { ...base, status: 'paid', activated: false };

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

    // The session was opened by our server with our secret key for this exact plan and price, so a
    // paid session is enough; XPay may add its customer fee on top, so the total isn't compared.
    const details: PaymentDetails = {
      method: 'xpay',
      sessionId: session.id,
      ...(session.paymentIntentId ? { paymentId: session.paymentIntentId } : {}),
      amount: payment.amountCents / 100,
    };
    // A manual request still waiting is moot now that the plan is paid for.
    await tx
      .update(planRequests)
      .set({ status: 'cancelled', decidedAt: new Date() })
      .where(and(eq(planRequests.workspaceId, payment.workspaceId), eq(planRequests.status, 'pending')));
    const [request] = await tx
      .insert(planRequests)
      .values({ workspaceId: payment.workspaceId, planId: payment.planId, months: payment.months, status: 'approved', payment: details, adminNote: 'XPay', decidedAt: new Date() })
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
