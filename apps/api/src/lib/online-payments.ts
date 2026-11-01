import { and, auditLogs, eq, payments, planRequests } from '@wa/db';
import type { PaymentDetails } from '@wa/shared';
import { applyPlan, type Tx } from './plans';

type PaymentRow = typeof payments.$inferSelect;

/** Cancels a manual request still waiting: moot once the customer paid online. */
async function cancelPendingRequests(tx: Tx, workspaceId: string) {
  await tx
    .update(planRequests)
    .set({ status: 'cancelled', decidedAt: new Date() })
    .where(and(eq(planRequests.workspaceId, workspaceId), eq(planRequests.status, 'pending')));
}

/**
 * Activates the plan a verified online payment paid for, inside the caller's transaction (which holds
 * the payment row lock, so this runs once): an approved `plan_requests` row records it, the payment
 * turns `paid`, and the audit log gets `payment.paid`.
 */
export async function activatePaidPayment(tx: Tx, payment: PaymentRow, details: PaymentDetails, extra: { providerPaymentId: string | null; raw: unknown; audit: Record<string, unknown> }) {
  await cancelPendingRequests(tx, payment.workspaceId);
  const [request] = await tx
    .insert(planRequests)
    .values({
      workspaceId: payment.workspaceId,
      planId: payment.planId,
      months: payment.months,
      status: 'approved',
      payment: details,
      adminNote: `${payment.provider === 'kashier' ? 'Kashier' : 'XPay'}${payment.mode === 'test' ? ' (test)' : ''}`,
      decidedAt: new Date(),
    })
    .returning({ id: planRequests.id });
  const { after } = await applyPlan(tx, payment.workspaceId, payment.planId, payment.months);
  await tx
    .update(payments)
    .set({ status: 'paid', providerPaymentId: extra.providerPaymentId, error: null, raw: extra.raw as never, paidAt: new Date(), planRequestId: request!.id })
    .where(eq(payments.id, payment.id));
  await tx.insert(auditLogs).values({
    action: 'payment.paid',
    targetType: 'payment',
    targetId: payment.id,
    targetLabel: after.name,
    details: {
      provider: payment.provider,
      mode: payment.mode,
      planId: payment.planId,
      months: payment.months,
      amountCents: payment.amountCents,
      expiresAt: after.planExpiresAt?.toISOString() ?? null,
      ...extra.audit,
    },
  });
}

/**
 * Holds a payment the provider reports as paid but whose order, merchant, currency or amount doesn't
 * match: no plan is activated; a pending plan request carrying the reasons lets an admin decide.
 */
export async function holdPaymentForReview(tx: Tx, payment: PaymentRow, details: PaymentDetails, reasons: string[], extra: { providerPaymentId: string | null; raw: unknown; audit: Record<string, unknown> }) {
  await cancelPendingRequests(tx, payment.workspaceId);
  const [request] = await tx
    .insert(planRequests)
    .values({
      workspaceId: payment.workspaceId,
      planId: payment.planId,
      months: payment.months,
      status: 'pending',
      payment: { ...details, review: reasons } as PaymentDetails,
      note: `${payment.provider === 'kashier' ? 'Kashier' : 'XPay'} payment held for review`,
    })
    .returning({ id: planRequests.id });
  await tx
    .update(payments)
    .set({ status: 'review', providerPaymentId: extra.providerPaymentId, error: reasons.join(','), raw: extra.raw as never, planRequestId: request!.id })
    .where(eq(payments.id, payment.id));
  await tx.insert(auditLogs).values({
    action: 'payment.review',
    targetType: 'payment',
    targetId: payment.id,
    details: { provider: payment.provider, mode: payment.mode, reasons, expectedCents: payment.amountCents, ...extra.audit },
  });
}
