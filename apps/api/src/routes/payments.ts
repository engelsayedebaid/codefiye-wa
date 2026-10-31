import { and, eq, payments } from '@wa/db';
import { listedPriceUsd, ok, ONLINE_PAYMENT_STATUSES, paymentMonthsSchema, planPriceEgp, PLANS, REQUESTABLE_PLANS, successSchema, XPAY_MODES, type XPayMode } from '@wa/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps';
import { requirePat } from '../lib/auth';
import { ApiError, forbidden, notFound, unavailable, unprocessable } from '../lib/errors';
import { getPaymentSettings } from '../lib/payments';
import { getPlanPricing } from '../lib/plan-pricing';
import {
  createCheckoutSession,
  eventSeen,
  getActiveXPayAccount,
  getCheckoutSession,
  getXPayModeAccount,
  getXPayPublicConfig,
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
  mode: p.mode,
  error: p.error,
  createdAt: p.createdAt.toISOString(),
  paidAt: p.paidAt?.toISOString() ?? null,
});

/** Customer endpoints for XPay checkouts (`/api/payments/…`). */
export function paymentRoutes(deps: Deps, options: Options): FastifyPluginAsyncZod {
  const { sql, db, auth } = deps;
  const publicOrigin = new URL(options.publicUrl).origin;
  const allowedOrigins = new Set([publicOrigin, ...options.corsOrigins.map((o) => o.replace(/\/+$/, ''))]);
  /** Where a full-page bank check sends the customer back: the dashboard they paid from, when it's one of ours. */
  const returnOrigin = (req: FastifyRequest) => {
    const origin = req.headers.origin;
    return typeof origin === 'string' && allowedOrigins.has(origin) ? origin : publicOrigin;
  };

  const owned = async (req: FastifyRequest, id: string) => {
    const [row] = await db
      .select()
      .from(payments)
      .where(and(eq(payments.id, id), eq(payments.workspaceId, req.auth.workspaceId)));
    if (!row) throw notFound('Payment not found');
    return row;
  };

  return async (app) => {
    app.get(
      '/payments/xpay',
      {
        schema: {
          tags,
          summary: 'Whether this account pays online through XPay, and the publishable key',
          response: { 200: successSchema(z.object({ enabled: z.boolean(), publishableKey: z.string(), mode: z.enum(XPAY_MODES) })) },
        },
      },
      async (req) => {
        requirePat(req);
        return ok(await getXPayPublicConfig(sql, deps.encryptionKey, req.auth.isAdmin));
      },
    );

    app.post(
      '/payments/xpay',
      {
        schema: {
          tags,
          summary: 'Open an XPay checkout for a plan',
          description:
            'Prices the plan in EGP for `months`, opens an XPay Checkout Session and returns its `clientSecret` for the XPay SDK. ' +
            'The plan is activated only when XPay confirms the payment and its amounts check out; poll `POST /api/payments/{id}/check`.',
          body: z.object({ planId: z.enum(REQUESTABLE_PLANS), months: paymentMonthsSchema.default(1), locale: z.enum(['ar', 'en']).default('ar') }),
          response: { 201: successSchema(z.object({ payment: paymentDto, publishableKey: z.string(), clientSecret: z.string() })) },
        },
      },
      async (req, reply) => {
        requirePat(req);
        if (!req.auth.isAdmin && !req.auth.phoneVerified) throw forbidden('Verify your phone number before paying for a plan', 'phone_unverified');
        const account = await getActiveXPayAccount(sql, deps.encryptionKey);
        // Test mode is for the admins: a customer must never buy a plan with a test card.
        if (!account || (account.mode === 'test' && !req.auth.isAdmin)) throw unavailable('Online payment is not available right now', 'xpay_off');
        const { planId, months, locale } = req.body;
        const [settings, pricing] = await Promise.all([getPaymentSettings(sql), getPlanPricing(sql)]);
        const egp = planPriceEgp(listedPriceUsd(planId, pricing), months, settings.egpPerUsd);
        if (egp === null || egp <= 0) throw unprocessable('This plan cannot be paid online', { planId: ['Request this plan instead'] });

        const amountCents = egp * 100;
        const [payment] = await db
          .insert(payments)
          .values({ workspaceId: req.auth.workspaceId, userId: req.auth.userId, planId, months, amountCents, currency: 'EGP', mode: account.mode })
          .returning();
        try {
          const session = await createCheckoutSession(account, {
            amountCents,
            itemName: `${PLANS[planId].name} plan × ${months} ${months === 1 ? 'month' : 'months'}`,
            reference: payment!.id,
            workspaceId: req.auth.workspaceId,
            redirectUrl: `${returnOrigin(req)}/subscription?payment=${payment!.id}`,
            locale,
          });
          const [saved] = await db.update(payments).set({ sessionId: session.id }).where(eq(payments.id, payment!.id)).returning();
          reply.code(201);
          return ok({ payment: toPaymentDto(saved!), publishableKey: account.publishableKey, clientSecret: session.clientSecret });
        } catch (err) {
          if (!(err instanceof XPayError)) throw err;
          // Only XPay's own wording is kept (never a key); the customer just sees "try again".
          await db.update(payments).set({ status: 'failed', error: `session_failed:${err.code ?? err.status}` }).where(eq(payments.id, payment!.id));
          req.log.warn({ status: err.status, code: err.code, mode: account.mode }, 'xpay checkout session failed');
          throw new ApiError(502, 'XPay could not open the payment. Please try again shortly.', undefined, { code: 'xpay_error' });
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
          summary: 'Ask XPay for the payment now',
          description: 'Reads the checkout session from XPay with the secret key of the mode it was opened in and settles the payment, so the plan turns on even before the webhook arrives.',
          params: z.object({ id: z.uuid() }),
          response: { 200: successSchema(paymentDto) },
        },
      },
      async (req) => {
        requirePat(req);
        const payment = await owned(req, req.params.id);
        if (payment.status === 'pending' && payment.sessionId) {
          const account = await getXPayModeAccount(sql, deps.encryptionKey, payment.mode);
          if (account) {
            try {
              const settled = await settlePayment(db, payment.mode, await getCheckoutSession(account, payment.sessionId));
              if (settled?.activated) await auth.revoke({ workspaceIds: [settled.workspaceId] });
            } catch (err) {
              // The webhook still settles it; the dashboard keeps polling.
              if (!(err instanceof XPayError)) throw err;
              req.log.warn({ status: err.status, code: err.code, mode: payment.mode }, 'xpay session lookup failed');
            }
          }
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
