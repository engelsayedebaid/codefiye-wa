import { isTestKey, type OnlinePaymentStatus, type XPayPublicConfig } from '@wa/shared/payments';
import { getPlan } from '@wa/shared/plans';
import { useQuery } from '@tanstack/react-query';
import type { Appearance, InitCheckoutResult, PaymentElement, PaymentElementChangeEvent } from '@xpayeg/sdk';
import { loadXPay } from '@xpayeg/sdk';
import { AlertTriangle, ArrowLeft, CheckCircle2, Hourglass, Info, Loader2, Lock, RefreshCw, ShieldCheck } from '../../icons';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../../api';
import { useI18n } from '../../i18n';
import { qk } from '../../queries';
import { useTheme } from '../../theme';
import { Button, cx, flip, Modal, usePlanName } from '../../ui';
import { useAccount } from '../account';

export type OnlinePayment = {
  id: string;
  status: OnlinePaymentStatus;
  planId: string;
  months: number;
  amountCents: number;
  currency: string;
  error: string | null;
  createdAt: string;
  paidAt: string | null;
};

/** Whether plans are paid online (XPay on): then the manual transfers are hidden. */
export function useXPayConfig(enabled = true) {
  return useQuery({ queryKey: qk.xpay, queryFn: ({ signal }) => api<XPayPublicConfig>('/api/payments/xpay', { signal }), enabled, staleTime: 5 * 60_000 });
}

/** A theme token as #rrggbb (XPay takes hex only; ours are oklch), read back from a 1-pixel canvas. */
function tokenHex(name: string): string | undefined {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();
  if (!value) return undefined;
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!ctx) return undefined;
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((c) => (c ?? 0).toString(16).padStart(2, '0')).join('')}`;
}

/** XPay's payment fields in our colours, corners and type, for the current theme. */
function appearanceFor(theme: 'light' | 'dark', lang: 'ar' | 'en'): Appearance {
  return {
    colorMode: theme,
    borderStyle: 'rounded',
    spacing: 'normal',
    inputSize: 'medium',
    inputStyle: 'outlined',
    formLayout: 'compact',
    fontFamily: lang === 'ar' ? '"IBM Plex Sans Arabic", "Instrument Sans", system-ui, sans-serif' : '"Instrument Sans", "IBM Plex Sans Arabic", system-ui, sans-serif',
    colors: {
      primary: tokenHex('brand'),
      primaryForeground: tokenHex('on-brand'),
      background: tokenHex('card'),
      foreground: tokenHex('ink'),
      muted: tokenHex('raised'),
      mutedForeground: tokenHex('muted'),
      accent: tokenHex('brand-strong'),
      accentForeground: tokenHex('on-brand'),
      border: tokenHex('line'),
      input: tokenHex('line-strong'),
      ring: tokenHex('ring'),
      destructive: tokenHex('destructive-ink'),
    },
  };
}

const POLL_MS = 2_000;
const POLL_FOR_MS = 40_000;

/**
 * Settles a payment from the dashboard's side: asks the server to check with XPay every 2 s until it is
 * paid or failed, for up to 40 s (the webhook settles it anyway). Resolves to the last state seen.
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

type Phase = 'opening' | 'form' | 'confirming' | 'paid' | 'failed' | 'slow' | 'awaiting' | 'error';

/**
 * The payment step: opens an XPay checkout for the plan and mounts XPay's PaymentElement inside our
 * dialog, themed with our tokens (and re-themed live when the theme changes). Our own button confirms;
 * 3-D Secure runs in XPay's overlay on top of the page.
 */
export function XPayCheckout({
  planId,
  planLabel,
  months,
  amountLabel,
  onBack,
  onPaid,
  onNeedsPhone,
}: {
  planId: string;
  planLabel: string;
  months: number;
  amountLabel: string;
  onBack: () => void;
  onPaid: () => void;
  onNeedsPhone: () => void;
}) {
  const { t, lang } = useI18n();
  const o = t.subscription.payment.online;
  const { theme } = useTheme();
  const { account } = useAccount();
  const host = useRef<HTMLDivElement>(null);
  const checkout = useRef<InitCheckoutResult | null>(null);
  const element = useRef<PaymentElement | null>(null);
  const poll = useRef<AbortController | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>('opening');
  const [payment, setPayment] = useState<OnlinePayment | null>(null);
  const [test, setTest] = useState(false);
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // One checkout per attempt. (StrictMode runs this twice in development; the cancelled run's checkout just expires unused.)
  useEffect(() => {
    let cancelled = false;
    setPhase('opening');
    setReady(false);
    setProblem(null);
    (async () => {
      try {
        const opened = await api<{ payment: OnlinePayment; publishableKey: string; clientSecret: string }>('/api/payments/xpay', {
          method: 'POST',
          body: { planId, months, locale: lang },
          timeoutMs: 30_000,
        });
        if (cancelled) return;
        setPayment(opened.payment);
        setTest(isTestKey(opened.publishableKey));
        const xpay = await loadXPay(opened.publishableKey);
        if (!xpay || cancelled) return;
        const started = await xpay.initCheckout({ clientSecret: opened.clientSecret, appearance: appearanceFor(theme, lang), locale: lang });
        if (cancelled) return;
        checkout.current = started;
        if (started.status.type === 'expired') {
          setProblem(o.expired);
          return setPhase('failed');
        }
        const el = started.getElements().create('payment', { layout: 'tabs' });
        el.on('change', (e) => setReady((e as PaymentElementChangeEvent).complete && started.canConfirm));
        element.current = el;
        setPhase('form');
        // The host renders with the form phase; mount on the next frame.
        requestAnimationFrame(() => host.current && !cancelled && el.mount(host.current));
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiRequestError && err.code === 'phone_unverified') return onNeedsPhone();
        setProblem(err instanceof ApiRequestError ? errorMessage(err) : o.loadFailed);
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
      element.current?.destroy();
      element.current = null;
      checkout.current = null;
    };
    // The theme and language are applied live below; a new checkout only on retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, planId, months]);

  useEffect(() => {
    checkout.current?.changeAppearance(appearanceFor(theme, lang));
  }, [theme, lang]);

  useEffect(() => () => poll.current?.abort(), []);

  const settle = useCallback(
    async (id: string) => {
      poll.current?.abort();
      const ctl = new AbortController();
      poll.current = ctl;
      const final = await waitForPayment(id, ctl.signal);
      if (ctl.signal.aborted) return;
      if (final) setPayment(final);
      if (final?.status === 'paid') return setPhase('paid');
      if (final?.status === 'failed') {
        setProblem(final.error === 'expired' ? o.expired : o.declined);
        return setPhase('failed');
      }
      setPhase('slow');
    },
    [o.declined, o.expired],
  );

  const pay = async () => {
    const c = checkout.current;
    if (!c || !payment || phase !== 'form') return;
    setProblem(null);
    setPhase('confirming');
    const result = await c.confirm({
      customerDetails: { email: account?.user?.email, name: account?.user?.name ?? undefined, phone: account?.user?.phone ?? undefined },
      redirect: 'if_required',
    });
    if (result.type === 'error') {
      setProblem(result.error.message || o.declined);
      return setPhase('form');
    }
    // A Fawry reference completes unpaid: the plan turns on when it's paid (webhook).
    const status = result.session.status;
    if (status.type === 'complete' && status.paymentStatus === 'unpaid') return setPhase('awaiting');
    await settle(payment.id);
  };

  if (phase === 'paid') {
    return (
      <OutcomeView tone="good" icon={<CheckCircle2 />} title={o.paidTitle} text={o.paidText(planLabel)}>
        <Button variant="brand" onClick={onPaid}>
          {o.done}
        </Button>
      </OutcomeView>
    );
  }
  if (phase === 'awaiting' || phase === 'slow') {
    return (
      <OutcomeView tone="wait" icon={<Hourglass />} title={o.slowTitle} text={phase === 'awaiting' ? o.awaiting : o.slowText}>
        <Button variant="outline" onClick={onPaid}>
          {o.done}
        </Button>
      </OutcomeView>
    );
  }
  if (phase === 'failed' || phase === 'error') {
    return (
      <OutcomeView tone="bad" icon={<AlertTriangle />} title={phase === 'failed' ? o.failedTitle : o.loadFailed} text={phase === 'failed' ? problem : problem !== o.loadFailed ? problem : null}>
        <Button variant="ghost" icon={<ArrowLeft className={cx('size-4', flip)} />} onClick={onBack}>
          {t.subscription.payment.back}
        </Button>
        <Button variant="brand" icon={<RefreshCw className="size-4" />} onClick={() => setAttempt((n) => n + 1)}>
          {phase === 'failed' ? o.startOver : o.retry}
        </Button>
      </OutcomeView>
    );
  }

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

      {test && (
        <p className="flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
          <Info className="size-3.5 shrink-0" /> {o.test}
        </p>
      )}

      <div className="relative min-h-44">
        {phase === 'opening' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted">
            <Loader2 className="size-6 animate-spin text-brand" />
            {o.opening}
          </div>
        )}
        <div ref={host} className={cx('transition-opacity duration-300', phase === 'opening' ? 'opacity-0' : 'opacity-100', phase === 'confirming' && 'pointer-events-none opacity-60')} />
      </div>

      {problem && (
        <p className="flex items-start gap-2 rounded-lg bg-destructive-ink/10 px-3 py-2 text-sm text-destructive-ink">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {problem}
        </p>
      )}

      <div className="sticky bottom-0 z-10 -mx-6 flex items-center justify-between gap-2 border-t border-line bg-card px-6 py-4">
        <Button variant="ghost" icon={<ArrowLeft className={cx('size-4', flip)} />} onClick={onBack} disabled={phase === 'confirming'}>
          {t.subscription.payment.back}
        </Button>
        <Button variant="brand" size="lg" loading={phase === 'confirming'} disabled={phase === 'form' ? !ready : phase !== 'confirming'} icon={<Lock className="size-4" />} onClick={() => void pay()}>
          {phase === 'confirming' ? o.confirming : o.payNow(amountLabel)}
        </Button>
      </div>
    </div>
  );
}

/**
 * Back from a full-page bank check (`/subscription?payment=<id>`): the page was reloaded, so ask the
 * server for the outcome and show it.
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
        ) : result?.status === 'paid' ? (
          <OutcomeView tone="good" icon={<CheckCircle2 />} title={o.paidTitle} text={o.paidText(planName(getPlan(result.planId)))}>
            <Button variant="brand" onClick={onClose}>
              {o.done}
            </Button>
          </OutcomeView>
        ) : result?.status === 'failed' || result === null ? (
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
