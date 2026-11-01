import { and, eq, payments } from '@wa/db';
import {
  KASHIER_METHODS,
  KASHIER_MODES,
  type KashierMode,
  listedPriceUsd,
  ok,
  ONLINE_PAYMENT_STATUSES,
  paymentMonthsSchema,
  planPriceEgp,
  PLANS,
  REQUESTABLE_PLANS,
  successSchema,
  XPAY_MODES,
  type XPayMode,
} from '@wa/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps';
import { requirePat } from '../lib/auth';
import { ApiError, forbidden, notFound, unavailable, unprocessable } from '../lib/errors';
import { getEgpQuote } from '../lib/currency';
import { getPlanPricing } from '../lib/plan-pricing';
import { publicBaseUrl } from '../lib/public-url';
import {
  allowedMethodsParam,
  createPaymentSession,
  EGYPTIAN_MOBILE,
  getKashierAccountFor,
  getKashierModeAccount,
  getKashierPublicConfig,
  getKashierSettings,
  getSessionPayment,
  initiateWalletPayment,
  type KashierAccount,
  KashierError,
  kashierEventId,
  kashierEventSeen,
  type KashierSettled,
  KashierWalletError,
  reconcileWalletPayment,
  recordKashierEvent,
  recordKashierWebhookSeen,
  settleKashierPayment,
  settleKashierWalletPayment,
  verifyKashierWebhook,
} from '../lib/kashier';
import {
  eventSeen,
  getCheckoutSession,
  getXPayModeAccount,
  recordEvent,
  recordRefund,
  recordWebhookSeen,
  settlePayment,
  type Settled,
  verifyWebhook,
  XPayError,
} from '../lib/xpay';

type Options = { publicUrl: string; corsOrigins: string[] };

const tags = ['Account'];

const paymentDto = z.object({
  id: z.uuid(),
  status: z.enum(ONLINE_PAYMENT_STATUSES),
  planId: z.string(),
  months: z.number(),
  amountCents: z.number(),
  currency: z.string(),
  /** `kashier`, or `xpay` for payments made before the switch. */
  provider: z.string(),
  mode: z.enum(XPAY_MODES),
  /** Why it failed or is held: `expired`, `payment_failed`, or the review reasons. */
  error: z.string().nullable(),
  createdAt: z.string(),
  paidAt: z.string().nullable(),
});

type PaymentRow = typeof payments.$inferSelect;
const toPaymentDto = (p: PaymentRow) => ({
  id: p.id,
  status: p.status,
  planId: p.planId,
  months: p.months,
  amountCents: p.amountCents,
  currency: p.currency,
  provider: p.provider,
  mode: p.mode,
  error: p.error,
  createdAt: p.createdAt.toISOString(),
  paidAt: p.paidAt?.toISOString() ?? null,
});

/** Customer endpoints for online payments (`/api/payments/…`): Kashier checkouts, and settling any payment. */
export function paymentRoutes(deps: Deps, options: Options): FastifyPluginAsyncZod {
  const { sql, db, auth } = deps;
  const corsOrigins = options.corsOrigins.map((o) => o.replace(/\/+$/, ''));
  /** Where the customer comes back after paying: the dashboard they paid from, when it's one of ours. */
  const returnOrigin = (req: FastifyRequest) => {
    const publicOrigin = new URL(publicBaseUrl(options.publicUrl, req)).origin;
    const origin = req.headers.origin;
    return typeof origin === 'string' && (origin === publicOrigin || corsOrigins.includes(origin)) ? origin : publicOrigin;
  };
  const caller = (req: FastifyRequest) => ({ isAdmin: req.auth.isAdmin, userId: req.auth.userId });

  const owned = async (req: FastifyRequest, id: string) => {
    const [row] = await db
      .select()
      .from(payments)
      .where(and(eq(payments.id, id), eq(payments.workspaceId, req.auth.workspaceId)));
    if (!row) throw notFound('Payment not found');
    return row;
  };
  /** Reads a Kashier payment back the way it was made (session, or Direct API wallet order) and settles it. */
  const settleKashier = (account: KashierAccount, payment: PaymentRow) =>
    payment.sessionId
      ? getSessionPayment(account, payment.sessionId).then((result) => settleKashierPayment(db, account, payment.sessionId!, result))
      : payment.kashierOrderId
        ? reconcileWalletPayment(account, payment.kashierOrderId).then((result) => settleKashierWalletPayment(db, account, payment.kashierOrderId!, result))
        : Promise.resolve(null);

  return async (app) => {
    app.get(
      '/payments/kashier',
      {
        schema: {
          tags,
          summary: 'Whether this account pays online through Kashier',
          description: 'Live mode: everyone. Test mode: admins and the test accounts the admin listed; everyone else requests plans manually.',
          response: { 200: successSchema(z.object({ enabled: z.boolean(), mode: z.enum(KASHIER_MODES), methods: z.array(z.enum(KASHIER_METHODS)) })) },
        },
      },
      async (req) => {
        requirePat(req);
        return ok(await getKashierPublicConfig(sql, deps.encryptionKey, caller(req)));
      },
    );

    app.post(
      '/payments/kashier',
      {
        schema: {
          tags,
          summary: 'Open a Kashier checkout for a plan',
          description:
            'Prices the plan in EGP for `months` on the server (any price the client has in mind is ignored), opens a Kashier payment session and ' +
            "returns its `sessionUrl`: send the customer there to pay on Kashier's page. They come back to `/subscription?payment={id}`; the plan is " +
            'activated only once Kashier confirms the payment and its order, merchant, currency and amount check out. Poll `POST /api/payments/{id}/check`. ' +
            "`method` (one of `GET /api/payments/kashier`'s `methods`) opens Kashier's page on that method alone; without it every offered method is shown.",
          body: z.object({
            planId: z.enum(REQUESTABLE_PLANS),
            months: paymentMonthsSchema.default(1),
            locale: z.enum(['ar', 'en']).default('ar'),
            method: z.enum(KASHIER_METHODS).optional(),
          }),
          response: { 201: successSchema(z.object({ payment: paymentDto, sessionUrl: z.string() })) },
        },
      },
      async (req, reply) => {
        requirePat(req);
        if (!req.auth.isAdmin && !req.auth.phoneVerified) throw forbidden('Verify your phone number before paying for a plan', 'phone_unverified');
        // Test mode serves only admins and the listed test accounts: a customer never pays in the sandbox.
        const account = await getKashierAccountFor(sql, deps.encryptionKey, caller(req));
        if (!account) throw unavailable('Online payment is not available right now', 'kashier_off');
        const { planId, months, locale, method } = req.body;
        if (method && !account.methods.includes(method)) throw unprocessable('This payment method is not available', { method: ['Choose one of the offered methods'] });
        // Priced at the live EGP rate (floored at the admin's), the same quote the dashboard showed.
        const [quote, pricing, view] = await Promise.all([getEgpQuote(sql, (err) => req.log.warn({ err }, 'exchange rates refresh failed')), getPlanPricing(sql), getKashierSettings(sql, deps.encryptionKey, publicBaseUrl(options.publicUrl, req))]);
        const egp = planPriceEgp(listedPriceUsd(planId, pricing), months, quote.effective);
        if (egp === null || egp <= 0) throw unprocessable('This plan cannot be paid online', { planId: ['Request this plan instead'] });
        const [customer] = await sql<{ email: string }[]>`
          select email from users where id = coalesce(${req.auth.userId}::uuid, (select owner_id from workspaces where id = ${req.auth.workspaceId}))`;
        if (!customer) throw forbidden('This workspace has no owner to bill', 'no_owner');

        const amountCents = egp * 100;
        const [payment] = await db
          .insert(payments)
          .values({ workspaceId: req.auth.workspaceId, userId: req.auth.userId, provider: 'kashier', planId, months, amountCents, currency: 'EGP', mode: account.mode })
          .returning();
        try {
          const session = await createPaymentSession(account, {
            amountCents,
            reference: payment!.id,
            workspaceId: req.auth.workspaceId,
            customerEmail: customer.email,
            description: `${PLANS[planId].name} plan × ${months} ${months === 1 ? 'month' : 'months'}`,
            redirectUrl: `${returnOrigin(req)}/subscription?payment=${payment!.id}`,
            webhookUrl: view[account.mode].webhookUrl,
            locale,
            allowedMethods: allowedMethodsParam(method ? [method] : account.methods, view[account.mode].accountMethods),
            ...(method ? { defaultMethod: method } : {}),
          });
          const [saved] = await db.update(payments).set({ sessionId: session._id }).where(eq(payments.id, payment!.id)).returning();
          reply.code(201);
          return ok({ payment: toPaymentDto(saved!), sessionUrl: session.sessionUrl });
        } catch (err) {
          if (!(err instanceof KashierError)) throw err;
          // Only a status is kept (never a key); the customer just sees "try again".
          await db.update(payments).set({ status: 'failed', error: `session_failed:${err.status}` }).where(eq(payments.id, payment!.id));
          req.log.warn({ status: err.status, message: err.message, mode: account.mode }, 'kashier payment session failed');
          throw new ApiError(502, 'Kashier could not open the payment. Please try again shortly.', undefined, { code: 'kashier_error' });
        }
      },
    );

    app.post(
      '/payments/kashier/wallet',
      {
        schema: {
          tags,
          summary: 'Pay for a plan from a mobile wallet, on this page',
          description:
            'Prices the plan in EGP on the server and asks Kashier to send a request-to-pay to the customer’s wallet app (Vodafone Cash and the other ' +
            'Egyptian wallets). The customer approves it in the app; poll `POST /api/payments/{id}/check` until the payment is no longer `pending` ' +
            '(the webhook settles it too). A number no wallet knows is refused at once (422 `unregistered_wallet`). Nothing is activated on the ' +
            'app’s word: the order is read back from Kashier first.',
          body: z.object({ planId: z.enum(REQUESTABLE_PLANS), months: paymentMonthsSchema.default(1), mobile: z.string().trim().regex(EGYPTIAN_MOBILE, 'An Egyptian mobile number (01xxxxxxxxx)') }),
          response: { 201: successSchema(z.object({ payment: paymentDto })) },
        },
      },
      async (req, reply) => {
        requirePat(req);
        if (!req.auth.isAdmin && !req.auth.phoneVerified) throw forbidden('Verify your phone number before paying for a plan', 'phone_unverified');
        const account = await getKashierAccountFor(sql, deps.encryptionKey, caller(req));
        if (!account) throw unavailable('Online payment is not available right now', 'kashier_off');
        if (!account.methods.includes('wallet')) throw unprocessable('Wallet payment is not available', { method: ['Choose one of the offered methods'] });
        const { planId, months, mobile } = req.body;
        const [quote, pricing, view] = await Promise.all([getEgpQuote(sql, (err) => req.log.warn({ err }, 'exchange rates refresh failed')), getPlanPricing(sql), getKashierSettings(sql, deps.encryptionKey, publicBaseUrl(options.publicUrl, req))]);
        const egp = planPriceEgp(listedPriceUsd(planId, pricing), months, quote.effective);
        if (egp === null || egp <= 0) throw unprocessable('This plan cannot be paid online', { planId: ['Request this plan instead'] });
        const [customer] = await sql<{ email: string }[]>`
          select email from users where id = coalesce(${req.auth.userId}::uuid, (select owner_id from workspaces where id = ${req.auth.workspaceId}))`;
        if (!customer) throw forbidden('This workspace has no owner to bill', 'no_owner');

        const amountCents = egp * 100;
        const [payment] = await db
          .insert(payments)
          .values({ workspaceId: req.auth.workspaceId, userId: req.auth.userId, provider: 'kashier', planId, months, amountCents, currency: 'EGP', mode: account.mode })
          .returning();
        try {
          const order = await initiateWalletPayment(account, { amountCents, reference: payment!.id, workspaceId: req.auth.workspaceId, customerEmail: customer.email, mobile, webhookUrl: view[account.mode].webhookUrl });
          const [saved] = await db
            .update(payments)
            .set({ kashierOrderId: order.systemOrderId, raw: { wallet: { mobile: `${mobile.slice(0, 3)}•••••${mobile.slice(-3)}`, transactionId: order.transactionId } } as never })
            .where(eq(payments.id, payment!.id))
            .returning();
          reply.code(201);
          return ok({ payment: toPaymentDto(saved!) });
        } catch (err) {
          if (!(err instanceof KashierError)) throw err;
          const refusal = err instanceof KashierWalletError ? err.refusal : null;
          // Only a status is kept (never a key); a refused number is the customer's to fix, anything else "try again".
          await db.update(payments).set({ status: 'failed', error: refusal ?? `initiate_failed:${err.status}` }).where(eq(payments.id, payment!.id));
          if (refusal === 'unregistered_wallet') throw unprocessable('This number is not registered with any mobile wallet', { mobile: ['Enter the number of an active wallet'] }, { code: 'unregistered_wallet' });
          req.log.warn({ status: err.status, message: err.message, mode: account.mode }, 'kashier wallet request failed');
          throw new ApiError(502, 'Kashier could not start the wallet payment. Please try again shortly.', undefined, { code: 'kashier_error' });
        }
      },
    );

    app.get(
      '/payments/:id',
      { schema: { tags, summary: 'An online payment of this workspace', params: z.object({ id: z.uuid() }), response: { 200: successSchema(paymentDto) } } },
      async (req) => {
        requirePat(req);
        return ok(toPaymentDto(await owned(req, req.params.id)));
      },
    );

    app.post(
      '/payments/:id/check',
      {
        schema: {
          tags,
          summary: 'Ask the payment provider for the payment now',
          description:
            'Reads the session from Kashier (or XPay, for payments made before Kashier) with the secret key of the mode it was opened in and settles the payment, ' +
            'so the plan turns on even before the webhook arrives. A redirect back from the checkout is never trusted on its own.',
          params: z.object({ id: z.uuid() }),
          response: { 200: successSchema(paymentDto) },
        },
      },
      async (req) => {
        requirePat(req);
        const payment = await owned(req, req.params.id);
        if ((payment.status === 'pending' || payment.status === 'paid') && (payment.sessionId || payment.kashierOrderId)) {
          let settled: { activated: boolean; workspaceId: string } | null = null;
          try {
            if (payment.provider === 'kashier') {
              const account = await getKashierModeAccount(sql, deps.encryptionKey, payment.mode);
              if (account) settled = await settleKashier(account, payment);
            } else if (payment.status === 'pending' && payment.sessionId) {
              const account = await getXPayModeAccount(sql, deps.encryptionKey, payment.mode);
              if (account) settled = await settlePayment(db, payment.mode, await getCheckoutSession(account, payment.sessionId));
            }
          } catch (err) {
            // The webhook still settles it; the dashboard keeps polling.
            if (!(err instanceof KashierError) && !(err instanceof XPayError)) throw err;
            req.log.warn({ status: err.status, provider: payment.provider, mode: payment.mode }, 'payment session lookup failed');
          }
          if (settled?.activated) await auth.revoke({ workspaceIds: [settled.workspaceId] });
        }
        return ok(toPaymentDto(await owned(req, req.params.id)));
      },
    );
  };
}

/**
 * XPay's webhooks, one endpoint per mode (`/api/payments/xpay/webhook/test|live`), each verified with that
 * mode's own signing secret. Public, so trusted only through `XPay-Signature` over the raw body; then
 * deduplicated by event id, and the session's state is read back from XPay before anything is settled.
 */
export function xpayWebhookRoutes(deps: Deps): FastifyPluginAsyncZod {
  const { sql, db, auth } = deps;
  return async (app) => {
    // The signature covers the exact bytes XPay sent, so this scope keeps the body as a string.
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    app.post('/:mode', { schema: { hide: true, params: z.object({ mode: z.enum(XPAY_MODES) }) } }, async (req, reply) => {
      const mode: XPayMode = req.params.mode;
      // Payments already opened in this mode still settle after the admin switches XPay off or to the other mode.
      const account = await getXPayModeAccount(sql, deps.encryptionKey, mode);
      if (!account) return reply.code(503).send({ received: false });
      const header = req.headers['xpay-signature'];
      const event = verifyWebhook(typeof req.body === 'string' ? req.body : '', typeof header === 'string' ? header : undefined, account.webhookSecret);
      if (!event) {
        req.log.warn({ mode }, 'xpay webhook with a bad signature');
        return reply.code(400).send({ received: false });
      }
      // A live event on the test endpoint (or the reverse) is a misconfiguration, never processed.
      if (typeof event.livemode === 'boolean' && event.livemode !== (mode === 'live')) {
        req.log.warn({ mode, eventId: event.id }, 'xpay webhook for the other mode');
        return reply.code(400).send({ received: false });
      }
      await recordWebhookSeen(sql, mode);
      if (await eventSeen(sql, event.id)) return reply.code(200).send({ received: true, duplicate: true });

      const object = event.data.object;
      const objectId = typeof object.id === 'string' ? object.id : null;
      let settled: Settled | null = null;
      let outcome = 'ignored';
      if (event.type.startsWith('checkout.session.') && objectId) {
        // The signed payload only says which session changed; its state comes from XPay itself, read
        // with this mode's key. If XPay can't be reached, a 503 makes it deliver the event again.
        try {
          const session = await getCheckoutSession(account, objectId);
          settled = await settlePayment(db, mode, session, event.type === 'checkout.session.async_payment_failed');
          outcome = settled?.status ?? 'unknown_session';
        } catch (err) {
          if (!(err instanceof XPayError)) throw err;
          if (err.status === 404) {
            // Not a session of this account and mode: nothing to settle, and retrying won't change that.
            outcome = 'unknown_session';
          } else {
            req.log.warn({ status: err.status, code: err.code, eventId: event.id, mode }, 'xpay session lookup failed; asking for a retry');
            return reply.code(503).send({ received: false });
          }
        }
      } else if (event.type === 'charge.refunded') {
        settled = await recordRefund(db, mode, object);
        outcome = settled ? `refund:${settled.status}` : 'unknown_payment';
      }
      if (settled?.activated) await auth.revoke({ workspaceIds: [settled.workspaceId] });
      await recordEvent(db, event, mode, objectId, outcome);
      req.log.info({ event: event.type, eventId: event.id, mode, object: objectId, outcome }, 'xpay webhook');
      return reply.code(200).send({ received: true });
    });
  };
}

/**
 * Kashier's webhooks, one endpoint per mode (`/api/payments/kashier/webhook/test|live`; sent with every
 * payment as `serverWebhook`), each verified with that mode's own Payment API Key. Public, so trusted
 * only through `x-kashier-signature`; then de-duplicated by `transactionId` + `status` (Kashier's own
 * key; a repeat gets 409, which Kashier counts as delivered), and the session's state is read back from
 * Kashier with the Secret Key before anything is settled.
 */
export function kashierWebhookRoutes(deps: Deps): FastifyPluginAsyncZod {
  const { sql, db, auth } = deps;
  return async (app) => {
    app.post('/:mode', { schema: { hide: true, params: z.object({ mode: z.enum(KASHIER_MODES) }) } }, async (req, reply) => {
      const mode: KashierMode = req.params.mode;
      // Payments already opened in this mode still settle after the admin switches Kashier off or to the other mode.
      const account = await getKashierModeAccount(sql, deps.encryptionKey, mode);
      if (!account) return reply.code(503).send();
      const body = (req.body ?? {}) as { event?: unknown; data?: unknown };
      const event = typeof body.event === 'string' ? body.event : '';
      const header = req.headers['x-kashier-signature'];
      if (!event || !verifyKashierWebhook(body.data, typeof header === 'string' ? header : undefined, account.apiKey)) {
        req.log.warn({ mode }, 'kashier webhook with a bad signature');
        return reply.code(400).send();
      }
      const data = body.data as Record<string, unknown>;
      await recordKashierWebhookSeen(sql, mode);
      const eventId = kashierEventId(event, data);
      if (await kashierEventSeen(sql, eventId)) return reply.code(409).send();

      const orderId = typeof data.merchantOrderId === 'string' ? data.merchantOrderId : null;
      const [payment] = orderId && /^[0-9a-f-]{36}$/i.test(orderId)
        ? await db
            .select()
            .from(payments)
            .where(and(eq(payments.id, orderId), eq(payments.provider, 'kashier'), eq(payments.mode, mode)))
        : [];
      let settled: KashierSettled | null = null;
      let outcome = 'unknown_order';
      if (payment?.sessionId || payment?.kashierOrderId) {
        // The signed payload only says which order changed; its state comes from Kashier itself, read with
        // this mode's Secret Key (the session, or the wallet order). If Kashier can't be reached, a non-2xx
        // makes it deliver the event again.
        try {
          settled = payment.sessionId
            ? await settleKashierPayment(db, account, payment.sessionId, await getSessionPayment(account, payment.sessionId))
            : await settleKashierWalletPayment(db, account, payment.kashierOrderId!, await reconcileWalletPayment(account, payment.kashierOrderId!));
          outcome = settled?.status ?? 'unknown_session';
        } catch (err) {
          if (!(err instanceof KashierError)) throw err;
          if (err.status === 404) outcome = 'unknown_session';
          else {
            req.log.warn({ status: err.status, eventId, mode }, 'kashier session lookup failed; asking for a retry');
            return reply.code(503).send();
          }
        }
      }
      if (settled?.activated) await auth.revoke({ workspaceIds: [settled.workspaceId] });
      await recordKashierEvent(db, eventId, mode, event, orderId, outcome);
      req.log.info({ event, eventId, mode, order: orderId, status: data.status, outcome }, 'kashier webhook');
      return reply.code(200).send();
    });
  };
}
