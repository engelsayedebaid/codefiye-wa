import type { KashierPublicConfig } from '@wa/shared/kashier';
import type { OnlinePaymentStatus } from '@wa/shared/payments';
import { getPlan } from '@wa/shared/plans';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, CheckCircle2, ExternalLink, Hourglass, Info, Loader2, Lock, ShieldCheck } from '../../icons';
import { type ReactNode, useEffect, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../../api';
import { useI18n } from '../../i18n';
import { qk } from '../../queries';
import { Button, cx, flip, Modal, usePlanName } from '../../ui';

export type OnlinePayment = {
  id: string;
  status: OnlinePaymentStatus;
  provider: string;
  mode: 'test' | 'live';
  planId: string;
  months: number;
  amountCents: number;
  currency: string;
  error: string | null;
  createdAt: string;
  paidAt: string | null;
};

/** Whether this account pays online through Kashier (live: everyone; test: admins and listed test accounts). */
export function useKashierConfig(enabled = true) {
  return useQuery({ queryKey: qk.kashier, queryFn: ({ signal }) => api<KashierPublicConfig>('/api/payments/kashier', { signal }), enabled, staleTime: 5 * 60_000 });
}

const POLL_MS = 2_000;
const POLL_FOR_MS = 40_000;

/**
 * Settles a payment from the dashboard's side: asks the server to check with the provider every 2 s
 * until it is no longer pending, for up to 40 s (the webhook settles it anyway). Resolves to the last state seen.
 */
export async function waitForPayment(id: string, signal: AbortSignal): Promise<OnlinePayment | null> {
  const until = Date.now() + POLL_FOR_MS;
  let last: OnlinePayment | null = null;
  while (!signal.aborted) {
    try {
      last = await api<OnlinePayment>(`/api/payments/${id}/check`, { method: 'POST', signal });
      if (last.status !== 'pending') return last;
    } catch (err) {
      if (signal.aborted) return last;
      if (err instanceof ApiRequestError && err.status === 404) return null;
    }
    if (Date.now() >= until) return last;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return last;
}

/** A big round icon over a title and a line, for the outcome screens. */
export function OutcomeView({ tone, icon, title, text, children }: { tone: 'good' | 'bad' | 'wait'; icon: ReactNode; title: string; text?: ReactNode; children?: ReactNode }) {
  const ring = { good: 'bg-brand/15 text-brand', bad: 'bg-destructive-ink/12 text-destructive-ink', wait: 'bg-info/12 text-info' }[tone];
  return (
    <div className="animate-fade-up flex flex-col items-center gap-3 py-6 text-center">
      <span className={cx('flex size-16 items-center justify-center rounded-full [&>svg]:size-8', ring, tone === 'good' && 'animate-scale-in')}>{icon}</span>
      <p className="text-lg font-semibold">{title}</p>
      {text && <p className="max-w-sm text-sm text-muted">{text}</p>}
      {children && <div className="mt-2 flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  );
}

/**
 * The payment step: opens a Kashier session for the plan (priced on the server) and sends the customer
 * to Kashier's hosted checkout. Card details never touch our pages; the customer comes back to
 * `/subscription?payment=<id>`, where `PaymentReturnModal` confirms the result with the server.
 */
export function KashierCheckout({
  planId,
  months,
  amountLabel,
  test,
  onBack,
  onNeedsPhone,
}: {
  planId: string;
  months: number;
  amountLabel: string;
  test: boolean;
  onBack: () => void;
  onNeedsPhone: () => void;
}) {
  const { t, lang } = useI18n();
  const o = t.subscription.payment.online;
  const open = useMutation({
    mutationFn: () => api<{ payment: OnlinePayment; sessionUrl: string }>('/api/payments/kashier', { method: 'POST', body: { planId, months, locale: lang }, timeoutMs: 30_000 }),
    onSuccess: ({ sessionUrl }) => window.location.assign(sessionUrl),
    onError: (err) => {
      if (err instanceof ApiRequestError && err.code === 'phone_unverified') onNeedsPhone();
    },
  });
  const leaving = open.isPending || open.isSuccess;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-gradient-to-br from-raised/40 to-transparent px-4 py-3">
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand/12 text-brand">
            <ShieldCheck className="size-4.5" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold">{o.secure}</span>
            <span className="block text-xs text-muted">{o.secureHint}</span>
          </span>
        </span>
        <span className="shrink-0 text-end">
          <span className="block text-[11px] text-muted uppercase">{o.due}</span>
          <span className="block text-lg font-bold tabular-nums">{amountLabel}</span>
        </span>
      </div>

      <ul className="grid gap-2 text-sm text-ink-2">
        {o.steps2.map((step, i) => (
          <li key={step} className="flex items-start gap-2.5">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-raised text-[11px] font-semibold text-muted tabular-nums">{i + 1}</span>
            {step}
          </li>
        ))}
      </ul>

      {test && (
        <p className="flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
          <Info className="size-3.5 shrink-0" /> {o.test}
        </p>
      )}

      {open.isError && (
        <p className="flex items-start gap-2 rounded-lg bg-destructive-ink/10 px-3 py-2 text-sm text-destructive-ink">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {errorMessage(open.error)}
        </p>
      )}

      <div className="sticky bottom-0 z-10 -mx-6 flex items-center justify-between gap-2 border-t border-line bg-card px-6 py-4">
        <Button variant="ghost" icon={<ArrowLeft className={cx('size-4', flip)} />} onClick={onBack} disabled={leaving}>
          {t.subscription.payment.back}
        </Button>
        <Button variant="brand" size="lg" loading={leaving} icon={leaving ? undefined : <Lock className="size-4" />} onClick={() => open.mutate()}>
          {leaving ? o.redirecting : o.payNow(amountLabel)}
          {!leaving && <ExternalLink className={cx('size-3.5 opacity-70', flip)} />}
        </Button>
      </div>
    </div>
  );
}

/**
 * Back from Kashier's checkout (`/subscription?payment=<id>`): the page was reloaded, so ask the server
 * (which asks Kashier) for the outcome and show it. The redirect itself proves nothing.
 */
export function PaymentReturnModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  const o = t.subscription.payment.online;
  const planName = usePlanName();
  const [result, setResult] = useState<OnlinePayment | null | undefined>(undefined);

  useEffect(() => {
    const ctl = new AbortController();
    void waitForPayment(id, ctl.signal).then((final) => !ctl.signal.aborted && setResult(final));
    return () => ctl.abort();
  }, [id]);

  return (
    <Modal title={o.returnTitle} onClose={onClose}>
      <div className="pb-4">
        {result === undefined ? (
          <OutcomeView tone="wait" icon={<Loader2 className="animate-spin" />} title={o.confirming} text={o.confirmingText} />
        ) : result?.status === 'paid' && result.mode === 'test' ? (
          // A verified sandbox payment: the flow works, but test payments never activate a plan.
          <OutcomeView tone="good" icon={<CheckCircle2 />} title={o.testPaidTitle} text={o.testPaidText}>
            <Button variant="outline" onClick={onClose}>
              {o.done}
            </Button>
          </OutcomeView>
        ) : result?.status === 'paid' ? (
          <OutcomeView tone="good" icon={<CheckCircle2 />} title={o.paidTitle} text={o.paidText(planName(getPlan(result.planId)))}>
            <Button variant="brand" onClick={onClose}>
              {o.done}
            </Button>
          </OutcomeView>
        ) : result?.status === 'review' ? (
          <OutcomeView tone="wait" icon={<Hourglass />} title={o.reviewTitle} text={o.reviewText}>
            <Button variant="outline" onClick={onClose}>
              {o.done}
            </Button>
          </OutcomeView>
        ) : result === null || result.status === 'failed' || result.status === 'refunded' ? (
          <OutcomeView tone="bad" icon={<AlertTriangle />} title={o.failedTitle} text={result?.error === 'expired' ? o.expired : o.declined}>
            <Button variant="outline" onClick={onClose}>
              {o.done}
            </Button>
          </OutcomeView>
        ) : (
          <OutcomeView tone="wait" icon={<Hourglass />} title={o.slowTitle} text={o.slowText}>
            <Button variant="outline" onClick={onClose}>
              {o.done}
            </Button>
          </OutcomeView>
        )}
      </div>
    </Modal>
  );
}
