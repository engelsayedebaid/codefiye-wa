import type { KashierMethod, KashierPublicConfig } from '@wa/shared/kashier';
import type { OnlinePaymentStatus } from '@wa/shared/payments';
import { getPlan } from '@wa/shared/plans';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, CheckCircle2, ExternalLink, Hourglass, Info, Loader2, Lock, ShieldCheck, X } from '../../icons';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../../api';
import { useI18n } from '../../i18n';
import { qk } from '../../queries';
import { Button, cx, flip, Modal, usePlanName } from '../../ui';
import { KASHIER_METHOD_ICON } from './methods';
import { KashierMark, RateLine, TrustStrip } from './Trust';

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

/** Label / value rows of an order or a receipt. */
function SummaryRows({ rows, className }: { rows: [string, ReactNode][]; className?: string }) {
  return (
    <dl className={cx('grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm', className)}>
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="min-w-0 text-end font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** An opened Kashier session: our payment row and the checkout to show. */
export type OpenedCheckout = { payment: OnlinePayment; sessionUrl: string };

/**
 * The payment step: the order as it will be charged, then Kashier's checkout for the method picked in the
 * first step (the plan is priced on the server). `onOpened` shows it in `CheckoutFrame` on our page.
 */
export function KashierCheckout({
  planId,
  months,
  method,
  amountLabel,
  usdLabel,
  test,
  onBack,
  onNeedsPhone,
  onOpened,
}: {
  planId: string;
  months: number;
  method: KashierMethod | null;
  amountLabel: string;
  usdLabel?: string;
  test: boolean;
  onBack: () => void;
  onNeedsPhone: () => void;
  onOpened: (checkout: OpenedCheckout) => void;
}) {
  const { t, lang } = useI18n();
  const p = t.subscription.payment;
  const o = p.online;
  const x = t.admin.payments.kashier;
  const planName = usePlanName();
  const MethodIcon = method ? KASHIER_METHOD_ICON[method] : ShieldCheck;
  const open = useMutation({
    mutationFn: () => api<OpenedCheckout>('/api/payments/kashier', { method: 'POST', body: { planId, months, locale: lang, ...(method ? { method } : {}) }, timeoutMs: 30_000 }),
    onSuccess: onOpened,
    onError: (err) => {
      if (err instanceof ApiRequestError && err.code === 'phone_unverified') onNeedsPhone();
    },
  });
  const leaving = open.isPending;

  return (
    <div className="space-y-4">
      {/* the order, as it will be charged */}
      <section className="overflow-hidden rounded-2xl border border-line">
        <header className="flex items-center justify-between gap-3 border-b border-line/60 bg-raised/30 px-4 py-2.5">
          <span className="text-sm font-semibold">{o.summary}</span>
          <KashierMark />
        </header>
        <div className="space-y-3 p-4">
          <SummaryRows
            rows={[
              [o.plan, planName(getPlan(planId))],
              [o.period, p.months(months)],
              [
                o.method,
                <span key="m" className="inline-flex items-center gap-2">
                  <span className="flex size-6 items-center justify-center rounded-md bg-brand/12 text-brand">
                    <MethodIcon className="size-3.5" />
                  </span>
                  {method ? x.methodNames[method] : o.secure}
                  <button type="button" onClick={onBack} disabled={leaving} className="text-xs font-medium text-brand hover:underline disabled:opacity-50">
                    {o.change}
                  </button>
                </span>,
              ],
            ]}
          />
          <div className="flex items-end justify-between gap-3 border-t border-dashed border-line pt-3">
            <span className="text-sm font-medium">{o.due}</span>
            <span className="text-end">
              <span className="ltr block text-2xl font-bold tabular-nums">{amountLabel}</span>
              {usdLabel && <span className="ltr block text-xs text-muted tabular-nums">{usdLabel}</span>}
            </span>
          </div>
          <RateLine />
        </div>
      </section>

      {/* what happens next */}
      <section className="rounded-xl bg-raised/20 p-4">
        <p className="mb-2 text-sm font-semibold">{o.whatNext}</p>
        <ol className="grid gap-2 text-sm text-ink-2">
          {o.steps2.map((step, i) => (
            <li key={step} className="flex items-start gap-2.5">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand/15 text-[11px] font-semibold text-brand tabular-nums">{i + 1}</span>
              {step}
            </li>
          ))}
        </ol>
      </section>

      <TrustStrip />
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <ShieldCheck className="size-3.5 shrink-0 text-brand" /> {o.trust.noStore} · {o.secureHint}
      </p>

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
          {p.back}
        </Button>
        <Button variant="brand" size="lg" loading={leaving} icon={leaving ? undefined : <Lock className="size-4" />} onClick={() => open.mutate()}>
          {leaving ? o.opening : o.payNow(amountLabel)}
        </Button>
      </div>
    </div>
  );
}

/** The paid order's facts under the outcome: plan, period, amount, reference and time. */
function Receipt({ payment }: { payment: OnlinePayment }) {
  const { t, fmt } = useI18n();
  const p = t.subscription.payment;
  const o = p.online;
  const planName = usePlanName();
  return (
    <div className="mx-auto w-full max-w-sm overflow-hidden rounded-xl border border-line text-start">
      <p className="border-b border-line/60 bg-raised/30 px-4 py-2 text-xs font-semibold text-muted uppercase">{o.receipt.title}</p>
      <SummaryRows
        className="p-4"
        rows={[
          [o.plan, planName(getPlan(payment.planId))],
          [o.period, p.months(payment.months)],
          [o.receipt.amount, <span key="a" className="ltr tabular-nums">{payment.currency === 'EGP' ? p.egp(payment.amountCents / 100) : `${payment.currency} ${(payment.amountCents / 100).toLocaleString('en-US')}`}</span>],
          [o.receipt.reference, <span key="r" className="ltr font-mono text-xs">{payment.id.slice(0, 8).toUpperCase()}</span>],
          [o.receipt.date, fmt.dateTime(payment.paidAt ?? payment.createdAt)],
        ]}
      />
    </div>
  );
}

/**
 * A payment's outcome, confirmed by the server (which asks Kashier); a redirect or a message from the
 * checkout proves nothing on its own.
 */
function PaymentResult({ id, onDone }: { id: string; onDone: () => void }) {
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
    <div className="pb-4">
      {result === undefined ? (
        <OutcomeView tone="wait" icon={<Loader2 className="animate-spin" />} title={o.confirming} text={o.confirmingText} />
      ) : result?.status === 'paid' && result.mode === 'test' ? (
        // A verified sandbox payment: the flow works, but test payments never activate a plan.
        <OutcomeView tone="good" icon={<CheckCircle2 />} title={o.testPaidTitle} text={o.testPaidText}>
          <Receipt payment={result} />
          <Button variant="outline" onClick={onDone}>
            {o.done}
          </Button>
        </OutcomeView>
      ) : result?.status === 'paid' ? (
        <OutcomeView tone="good" icon={<CheckCircle2 />} title={o.paidTitle} text={o.paidText(planName(getPlan(result.planId)))}>
          <Receipt payment={result} />
          <Button variant="brand" onClick={onDone}>
            {o.done}
          </Button>
        </OutcomeView>
      ) : result?.status === 'review' ? (
        <OutcomeView tone="wait" icon={<Hourglass />} title={o.reviewTitle} text={o.reviewText}>
          <Receipt payment={result} />
          <Button variant="outline" onClick={onDone}>
            {o.done}
          </Button>
        </OutcomeView>
      ) : result === null || result.status === 'failed' || result.status === 'refunded' ? (
        <OutcomeView tone="bad" icon={<AlertTriangle />} title={o.failedTitle} text={result?.error === 'expired' ? o.expired : o.declined}>
          <Button variant="outline" onClick={onDone}>
            {o.done}
          </Button>
        </OutcomeView>
      ) : (
        <OutcomeView tone="wait" icon={<Hourglass />} title={o.slowTitle} text={o.slowText}>
          <Button variant="outline" onClick={onDone}>
            {o.done}
          </Button>
        </OutcomeView>
      )}
      <div className="mt-2 flex justify-center">
        <KashierMark />
      </div>
    </div>
  );
}

/**
 * Back from a full-page Kashier checkout (`/subscription?payment=<id>`, the fallback when the frame can't
 * be used): the page was reloaded, so confirm the outcome with the server.
 */
export function PaymentReturnModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Modal title={t.subscription.payment.online.returnTitle} onClose={onClose}>
      <PaymentResult id={id} onDone={onClose} />
    </Modal>
  );
}

/** Where Kashier's checkout posts its messages from. */
const KASHIER_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*kashier\.io$/;
/** Kashier's events (`e.data.message`) for a checkout shown in our own frame. */
type CheckoutMessage = { message?: unknown; params?: { redirectUrl?: unknown }; redirectUrl?: unknown };
/** No sign of life from the frame by then: offer the full-page checkout. */
const STUCK_MS = 15_000;
/** While the checkout is open, the payment row is read this often, in case the frame's message never comes. */
const WATCH_MS = 5_000;

/**
 * Kashier's checkout inside our page, under our own header (plan, amount, security) — the customer never
 * leaves the site. Card details stay in Kashier's frame. The frame's messages are only hints (they can be
 * forged or lost): every outcome is confirmed with the server by `PaymentResult`, and the payment row is
 * also watched, so a webhook that settles it ends the checkout even without a message.
 */
export function CheckoutFrame({
  checkout,
  planLabel,
  amountLabel,
  test,
  onBack,
  onDone,
}: {
  checkout: OpenedCheckout;
  planLabel: string;
  amountLabel: string;
  test: boolean;
  onBack: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const o = t.subscription.payment.online;
  const id = checkout.payment.id;
  const [loaded, setLoaded] = useState(false);
  const [stuck, setStuck] = useState(false);
  const [finished, setFinished] = useState(false);
  const back = useRef(onBack);
  useEffect(() => {
    back.current = onBack;
  }, [onBack]);

  useEffect(() => {
    const finish = () => setFinished(true);
    // A redirect to our own return link means the checkout is over: confirm here instead of reloading the app.
    // Anywhere else (a bank's or wallet's page) needs the whole window.
    const follow = (raw: unknown) => {
      if (typeof raw !== 'string') return;
      let url: URL;
      try {
        url = new URL(raw, window.location.href);
      } catch {
        return;
      }
      if (url.origin === window.location.origin) finish();
      else if (url.protocol === 'https:') window.location.assign(url.href);
    };
    const onMessage = (e: MessageEvent) => {
      if (!KASHIER_ORIGIN.test(e.origin)) return;
      let data: unknown = e.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }
      if (!data || typeof data !== 'object') return;
      const m = data as CheckoutMessage;
      switch (m.message) {
        case 'contentLoaded':
        case 'iframeLoaded':
          setLoaded(true);
          break;
        case 'paymentSuccess':
          finish();
          break;
        case 'closeIframe':
        case 'iframeHide':
          back.current();
          break;
        case 'urlRedirection':
        case 'merchantStoreRedirect':
          follow(m.params?.redirectUrl ?? m.redirectUrl);
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // The webhook may settle the payment before (or without) any message from the frame.
  useEffect(() => {
    if (finished) return;
    const timer = setInterval(() => {
      void api<OnlinePayment>(`/api/payments/${id}`)
        .then((p) => p.status !== 'pending' && setFinished(true))
        .catch(() => undefined);
    }, WATCH_MS);
    return () => clearInterval(timer);
  }, [id, finished]);

  useEffect(() => {
    if (loaded) return;
    const timer = setTimeout(() => setStuck(true), STUCK_MS);
    return () => clearTimeout(timer);
  }, [loaded]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !finished && back.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finished]);

  return (
    <div role="dialog" aria-modal aria-label={o.frameTitle} className="animate-fade-in fixed inset-0 z-50 flex flex-col bg-bg">
      <header className="border-b border-line bg-card">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-4 py-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand/12 text-brand">
            <ShieldCheck className="size-4.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-sm font-semibold">
              {o.frameTitle}
              {test && <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-bold text-warning">{o.testBadge}</span>}
            </span>
            <span className="block truncate text-xs text-muted">{planLabel}</span>
          </span>
          <span className="shrink-0 text-end">
            <span className="block text-[10px] text-muted uppercase">{o.due}</span>
            <span className="ltr block text-base font-bold tabular-nums">{amountLabel}</span>
          </span>
          {!finished && (
            <button type="button" onClick={onBack} aria-label={t.common.close} className="ms-1 flex size-9 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-ink">
              <X className="size-4" />
            </button>
          )}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-3 px-4 py-4">
          {finished ? (
            <div className="animate-fade-up mx-auto w-full max-w-lg rounded-2xl border border-line bg-card p-6">
              <PaymentResult id={id} onDone={onDone} />
            </div>
          ) : (
            <>
              {stuck && !loaded && (
                <p className="animate-fade-up flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
                  <AlertTriangle className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1">{o.stuck}</span>
                  <button type="button" onClick={() => window.location.assign(checkout.sessionUrl)} className="inline-flex items-center gap-1 font-semibold underline-offset-2 hover:underline">
                    {o.openFull} <ExternalLink className={cx('size-3.5', flip)} />
                  </button>
                </p>
              )}
              {/* Kashier's page is light: it sits on a white card in both themes. */}
              <div className="relative min-h-[34rem] flex-1 overflow-hidden rounded-2xl border border-line bg-white shadow-sm">
                {!loaded && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white text-sm text-neutral-500">
                    <Loader2 className="size-6 animate-spin text-[#367a6b]" />
                    {o.opening}
                  </div>
                )}
                <iframe
                  src={checkout.sessionUrl}
                  title={o.frameTitle}
                  // Apple Pay and the browser's payment sheet need the Payment Request API inside the frame.
                  allow="payment"
                  onLoad={() => setLoaded(true)}
                  className="absolute inset-0 size-full border-0"
                />
              </div>
              <TrustStrip />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
