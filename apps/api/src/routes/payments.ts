import { and, eq, payments } from '@wa/db';
import { listedPriceUsd, ok, ONLINE_PAYMENT_STATUSES, paymentMonthsSchema, planPriceEgp, PLANS, REQUESTABLE_PLANS, successSchema } from '@wa/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps';
import { requirePat } from '../lib/auth';
import { ApiError, forbidden, notFound, unavailable, unprocessable } from '../lib/errors';
import { getPaymentSettings } from '../lib/payments';
import { getPlanPricing } from '../lib/plan-pricing';
import { createCheckoutSession, getCheckoutSession, getXPayAccount, getXPayPublicConfig, settlePayment, verifyWebhook, XPayError, type XPaySession } from '../lib/xpay';

type Options = { publicUrl: string; corsOrigins: string[] };

const tags = ['Account'];

const paymentDto = z.object({
  id: z.uuid(),
  status: z.enum(ONLINE_PAYMENT_STATUSES),
  planId: z.string(),
  months: z.number(),
  amountCents: z.number(),
  currency: z.string(),
  /** Why it failed: `expired`, `payment_failed`, or XPay's message. */
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
      { schema: { tags, summary: 'Whether plans are paid online through XPay, and its publishable key', response: { 200: successSchema(z.object({ enabled: z.boolean(), publishableKey: z.string() })) } } },
      async (req) => {
        requirePat(req);
        return ok(await getXPayPublicConfig(sql, deps.encryptionKey));
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
            'The plan is activated when XPay confirms the payment; poll `GET /api/payments/{id}` (or `POST /api/payments/{id}/check`).',
          body: z.object({ planId: z.enum(REQUESTABLE_PLANS), months: paymentMonthsSchema.default(1), locale: z.enum(['ar', 'en']).default('ar') }),
          response: { 201: successSchema(z.object({ payment: paymentDto, publishableKey: z.string(), clientSecret: z.string() })) },
        },
      },
      async (req, reply) => {
        requirePat(req);
        if (!req.auth.isAdmin && !req.auth.phoneVerified) throw forbidden('Verify your phone number before paying for a plan', 'phone_unverified');
        const account = await getXPayAccount(sql, deps.encryptionKey);
        if (!account) throw unavailable('Online payment is not available right now', 'xpay_off');
        const { planId, months, locale } = req.body;
        const [settings, pricing] = await Promise.all([getPaymentSettings(sql), getPlanPricing(sql)]);
        const egp = planPriceEgp(listedPriceUsd(planId, pricing), months, settings.egpPerUsd);
        if (egp === null || egp <= 0) throw unprocessable('This plan cannot be paid online', { planId: ['Request this plan instead'] });

        const amountCents = egp * 100;
        const [payment] = await db.insert(payments).values({ workspaceId: req.auth.workspaceId, userId: req.auth.userId, planId, months, amountCents, currency: 'EGP' }).returning();
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
          await db
            .update(payments)
            .set({ status: 'failed', error: err instanceof Error ? err.message.slice(0, 300) : 'session_failed' })
            .where(eq(payments.id, payment!.id));
          if (err instanceof XPayError) {
            req.log.warn({ status: err.status, code: err.code, message: err.message }, 'xpay checkout session failed');
            throw new ApiError(502, 'XPay could not open the payment. Please try again shortly.', undefined, { code: 'xpay_error' });
          }
          throw err;
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
          description: 'Reads the checkout session from XPay with the secret key and settles the payment, so the plan turns on even before the webhook arrives.',
          params: z.object({ id: z.uuid() }),
          response: { 200: successSchema(paymentDto) },
        },
      },
      async (req) => {
        requirePat(req);
        const payment = await owned(req, req.params.id);
        if (payment.status === 'pending' && payment.sessionId) {
          const account = await getXPayAccount(sql, deps.encryptionKey);
          if (account) {
            try {
              const settled = await settlePayment(db, await getCheckoutSession(account, payment.sessionId));
              if (settled?.activated) await auth.revoke({ workspaceIds: [settled.workspaceId] });
            } catch (err) {
              // The webhook still settles it; the dashboard keeps polling.
              if (!(err instanceof XPayError)) throw err;
              req.log.warn({ status: err.status, code: err.code }, 'xpay session lookup failed');
            }
          }
        }
        return ok(toPaymentDto(await owned(req, req.params.id)));
      },
    );
  };
}

/** XPay's webhook: public, trusted only through `XPay-Signature`. Needs the raw body, so it parses JSON itself. */
export function xpayWebhookRoutes(deps: Deps): FastifyPluginAsyncZod {
  const { sql, db, auth } = deps;
  return async (app) => {
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    app.post('/', { schema: { hide: true } }, async (req, reply) => {
      const account = await getXPayAccount(sql, deps.encryptionKey);
      if (!account) return reply.code(503).send({ received: false });
      const header = req.headers['xpay-signature'];
      const event = verifyWebhook(typeof req.body === 'string' ? req.body : '', typeof header === 'string' ? header : undefined, account.webhookSecret);
      if (!event) {
        req.log.warn('xpay webhook with a bad signature');
        return reply.code(400).send({ received: false });
      }
      // Payment links, refunds and the rest share the endpoint; only checkout sessions settle plans.
      if (!event.type.startsWith('checkout.session.') || typeof event.data.object.id !== 'string') return reply.code(200).send({ received: true });
      const session = event.data.object as unknown as XPaySession;
      const settled = await settlePayment(db, session, event.type === 'checkout.session.async_payment_failed');
      if (settled?.activated) await auth.revoke({ workspaceIds: [settled.workspaceId] });
      req.log.info({ event: event.type, eventId: event.id, session: session.id, status: settled?.status ?? 'unknown_session' }, 'xpay webhook');
      return reply.code(200).send({ received: true });
    });
  };
}
