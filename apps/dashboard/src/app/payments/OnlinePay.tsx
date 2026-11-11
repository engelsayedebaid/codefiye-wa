import type { KashierMethod } from '@wa/shared/kashier';
import { useMutation } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  Check,
  CreditCard,
  ExternalLink,
  Eye,
  EyeOff,
  Info,
  Landmark,
  Loader2,
  Lock,
  ShieldCheck,
  Smartphone,
  User,
  Wallet,
} from '../../icons';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../../api';
import { useI18n } from '../../i18n';
import { cx, flip } from '../../ui';
import { type OnlinePayment, type OpenedCheckout, PaymentResult, WalletPanel } from './OnlineCheckout';
import { CardMarks } from './Trust';

/**
 * Each method in the colours of the company behind it, as a customer would recognise it on a shop's
 * checkout: a glyph and, where there is one, a wordmark. No artwork of theirs is shipped — colours and names only.
 */
const BRAND: Record<KashierMethod, { bg: string; fg?: string; mark?: string; textMark?: string; textColor?: string; icon?: typeof Smartphone }> = {
  card: { bg: 'bg-brand text-on-brand', icon: CreditCard },
  wallet: { bg: 'bg-[#e60000]', icon: Wallet },
  bank_installments: { bg: 'bg-[#0f4c81]', icon: Landmark },
  valu: { bg: 'bg-[#6a1b9a]', mark: 'valU', textMark: 'valU', textColor: 'text-[#6a1b9a] dark:text-[#c084fc]' },
  souhoola: { bg: 'bg-[#00a651]', mark: 'سهولة', textMark: 'سهولة', textColor: 'text-[#008f45] dark:text-[#4ade80]' },
  aman: { bg: 'bg-[#00897b]', mark: 'أمان', textMark: 'أمان', textColor: 'text-[#00897b] dark:text-[#2dd4bf]' },
  contact: { bg: 'bg-[#00aeef]', mark: 'contact', textMark: 'contact', textColor: 'text-[#0284c7] dark:text-[#38bdf8]' },
};

export function BrandGlyph({ method, size = 'md' }: { method: KashierMethod; size?: 'sm' | 'md' }) {
  const b = BRAND[method];
  const dims = size === 'sm' ? 'size-8 rounded-lg [&>svg]:size-4 text-[10px]' : 'size-11 rounded-xl [&>svg]:size-5 text-[11px]';
  return (
    <span className={cx('flex shrink-0 items-center justify-center font-black tracking-tight text-white shadow-xs', dims, b.bg, b.fg)}>
      {b.icon ? <b.icon /> : <span className="px-1 leading-none">{b.mark}</span>}
    </span>
  );
}

/** Visual mark inside a payment method tile: crisp icon for card/wallet/bank, recognizable typographic mark for BNPL. */
function MethodTileMark({ method, active }: { method: KashierMethod; active: boolean }) {
  const b = BRAND[method];
  if (b.textMark) {
    return <span className={cx('text-base leading-none font-extrabold tracking-tight', b.textColor)}>{b.textMark}</span>;
  }
  const Icon = b.icon ?? CreditCard;
  return (
    <span
      className={cx(
        'flex size-8 items-center justify-center rounded-lg transition-colors',
        active ? 'bg-brand/15 text-brand' : 'bg-ink/[0.04] text-ink-2',
      )}
    >
      <Icon className="size-5" />
    </span>
  );
}

/** Single payment method option card with keyboard radio accessibility and clear selected state. */
function MethodTile({ method, active, onPick, name, disabled }: { method: KashierMethod; active: boolean; onPick: () => void; name: string; disabled: boolean }) {
  const { t } = useI18n();
  const x = t.admin.payments.kashier;
  const o = t.subscription.payment.online;
  const label = method === 'card' ? o.card.title : x.methodNames[method];
  return (
    <label className={cx('relative min-w-0', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}>
      <input type="radio" name={name} value={method} checked={active} onChange={onPick} disabled={disabled} className="peer sr-only" />
      <span
        data-active={active || undefined}
        data-disabled={disabled || undefined}
        className={cx(
          'checkout-method-tile h-full peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--co-accent-ink)]',
          disabled && !active && 'opacity-55',
        )}
      >
        {active && (
          <span
            aria-hidden="true"
            className="animate-scale-in absolute start-2.5 top-2.5 flex size-5 items-center justify-center rounded-full bg-brand text-on-brand shadow-xs"
          >
            <Check className="size-3" strokeWidth={3} />
          </span>
        )}
        <MethodTileMark method={method} active={active} />
        <span className={cx('block text-xs leading-snug font-semibold sm:text-[13px]', active ? 'text-brand' : 'text-ink')}>
          {label}
        </span>
      </span>
    </label>
  );
}

/** Payment method selector grid for all enabled Kashier methods. */
export function PaymentMethodSelector({
  methods,
  active,
  disabled,
  onSelect,
}: {
  methods: KashierMethod[];
  active: KashierMethod | null;
  disabled: boolean;
  onSelect: (method: KashierMethod) => void;
}) {
  const { t } = useI18n();
  const o = t.subscription.payment.online;
  const groupName = useId();
  return (
    <fieldset className="min-w-0 space-y-3">
      <legend className="text-sm font-bold text-ink">{o.chooseMethod}</legend>
      <div
        className={cx(
          'grid grid-cols-2 gap-2.5 sm:gap-3',
          methods.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-4',
        )}
      >
        {methods.map((m) => (
          <MethodTile key={m} name={groupName} method={m} active={m === active} disabled={disabled} onPick={() => onSelect(m)} />
        ))}
      </div>
    </fieldset>
  );
}

/** Prominent primary payment confirmation button with lock icon, dynamic EGP total, and directional arrow. */
export function CheckoutSubmitButton({
  label,
  loading,
  disabled,
  type = 'submit',
  onClick,
  icon,
}: {
  label: string;
  loading?: boolean;
  disabled?: boolean;
  type?: 'submit' | 'button';
  onClick?: () => void;
  icon?: ReactNode;
}) {
  return (
    <button type={type} disabled={disabled || loading} onClick={onClick} className="checkout-cta group">
      {loading ? (
        <Loader2 className="size-5 animate-spin" />
      ) : (
        (icon ?? <Lock className="size-4.5 shrink-0 opacity-90" />)
      )}
      <span>{label}</span>
      {!loading && (
        <ArrowRight
          aria-hidden="true"
          className={cx(
            'ms-1 size-4.5 shrink-0 opacity-90 transition-transform duration-150 group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5',
            flip,
          )}
        />
      )}
    </button>
  );
}

// --- card, paid from the browser ------------------------------------------------------------------

type CardBrand = 'visa' | 'mastercard' | 'meeza' | null;
/** Meeza (Egypt's national scheme) issues under 5078; Mastercard 51–55 and 2221–2720; Visa 4. */
const cardBrandOf = (digits: string): CardBrand => (digits.startsWith('5078') ? 'meeza' : digits.startsWith('4') ? 'visa' : /^(5[1-5]|2[2-7])/.test(digits) ? 'mastercard' : null);
const luhn = (digits: string) => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length >= 13 && digits.length <= 19 && sum % 10 === 0;
};
const groupCard = (digits: string) => digits.replace(/(\d{4})(?=\d)/g, '$1 ');
/** Where Kashier's checkout and 3-D Secure pages post from. */
const KASHIER_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*kashier\.io$/;
/** 3-D Secure ends with Kashier's `merchantStoreRedirect` message, or any redirection of its frame to our return link. */
const THREE_DS_DONE = new Set(['merchantStoreRedirect', 'urlRedirection', 'paymentSuccess']);

type SignedOrder = {
  host: string;
  merchantId: string;
  reference: string;
  amount: number;
  currency: 'EGP';
  hash: string;
  webhookUrl: string;
  merchantRedirect: string;
  description: string;
  customer: { reference: string; email: string };
};
type DirectAnswer = {
  status?: string;
  response?: {
    status?: string;
    authentication?: { redirectUrl?: string; redirectHtml?: string };
    transactionResponseMessage?: { en?: string; ar?: string } | string;
    transactionResponseCode?: string;
  };
  messages?: { en?: string; ar?: string };
  message?: string;
};

/**
 * The card form. The card details go from this browser straight to Kashier's Direct API with the order
 * our server signed (`POST /api/payments/kashier/card`); they never pass through our servers. 3-D Secure
 * opens in a frame right here; the outcome is confirmed with the server (`PaymentResult`), never taken
 * from the browser's side of things.
 */
export function CardPanel({
  planId,
  months,
  amountLabel,
  test,
  onNeedsPhone,
  onDone,
  onFallback,
  onLockedChange,
}: {
  planId: string;
  months: number;
  amountLabel: string;
  test: boolean;
  onNeedsPhone: () => void;
  onDone: () => void;
  onFallback: () => void;
  onLockedChange: (locked: boolean) => void;
}) {
  const { t, lang } = useI18n();
  const o = t.subscription.payment.online;
  const c = o.card;
  const [number, setNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvc, setCvc] = useState('');
  const [showCvc, setShowCvc] = useState(false);
  const [name, setName] = useState('');
  const [errors, setErrors] = useState<Partial<Record<'number' | 'expiry' | 'cvc' | 'name', string>>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; unreachable?: boolean } | null>(null);
  const [payment, setPayment] = useState<OnlinePayment | null>(null);
  const [threeDs, setThreeDs] = useState<{ url?: string; html?: string } | null>(null);
  const [nudge, setNudge] = useState(0);
  const digits = number.replace(/\D/g, '');
  const brand = cardBrandOf(digits);
  const locked = busy || payment !== null;
  useEffect(() => onLockedChange(locked), [locked, onLockedChange]);

  // A message from Kashier's 3-D Secure frame: only a hint that it is over; the server confirms. `nudge` re-polls at once.
  useEffect(() => {
    if (!threeDs) return;
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
      const message = (data as { message?: unknown } | null)?.message;
      if (typeof message === 'string' && THREE_DS_DONE.has(message)) {
        setThreeDs(null);
        setNudge((n) => n + 1);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [threeDs]);

  const validate = () => {
    const next: typeof errors = {};
    if (!luhn(digits)) next.number = c.invalidNumber;
    const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(expiry.trim());
    const month = m ? Number(m[1]) : 0;
    const year = m ? 2000 + Number(m[2]) : 0;
    const now = new Date();
    if (!m || month < 1 || month > 12 || year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) next.expiry = c.invalidExpiry;
    if (!/^\d{3,4}$/.test(cvc)) next.cvc = c.invalidCvc;
    if (name.trim().length < 2) next.name = c.invalidName;
    setErrors(next);
    return Object.keys(next).length === 0 ? { month: m![1]!, year: m![2]! } : null;
  };

  const pay = async (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const exp = validate();
    if (!exp || busy) return;
    setBusy(true);
    setProblem(null);
    let signed: { payment: OnlinePayment; order: SignedOrder };
    try {
      signed = await api<{ payment: OnlinePayment; order: SignedOrder }>('/api/payments/kashier/card', { method: 'POST', body: { planId, months }, timeoutMs: 30_000 });
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiRequestError && err.code === 'phone_unverified') return onNeedsPhone();
      return setProblem({ text: errorMessage(err) });
    }
    const { order } = signed;
    let answer: DirectAnswer | null = null;
    let httpOk = false;
    try {
      // Straight to Kashier: the hash signs merchant + reference + amount + currency, so nothing here can change the price.
      const res = await fetch(`${order.host}/v3/orders/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'kashier-hash': order.hash },
        body: JSON.stringify({
          apiOperation: 'PAY',
          paymentMethod: { type: 'CARD', card: { number: digits, expiry: { month: exp.month, year: exp.year }, nameOnCard: name.trim(), securityCode: cvc, save: false, enable3DS: true } },
          order: { reference: order.reference, amount: order.amount, currency: order.currency, description: order.description },
          interactionSource: 'ECOMMERCE',
          reconciliation: { webhookUrl: order.webhookUrl, merchantRedirect: order.merchantRedirect, redirect: false },
          customer: order.customer,
          merchantId: order.merchantId,
          newPaymentUI: true,
          display: lang,
        }),
        signal: AbortSignal.timeout(45_000),
      });
      httpOk = res.ok;
      answer = (await res.json().catch(() => null)) as DirectAnswer | null;
    } catch {
      setBusy(false);
      return setProblem({ text: c.unreachable, unreachable: true });
    }
    setBusy(false);
    const r = answer?.response;
    const status = String(r?.status ?? '').toUpperCase();
    if (httpOk && status === 'AUTHENTICATION_INITIATED' && (r?.authentication?.redirectUrl || r?.authentication?.redirectHtml)) {
      setPayment(signed.payment);
      setThreeDs({ url: r.authentication?.redirectUrl, html: r.authentication?.redirectHtml });
      return;
    }
    if (httpOk && (status === 'SUCCESS' || status === 'CAPTURED' || status === 'PENDING')) return setPayment(signed.payment);
    // Declined (or a bad request): say what the bank said, and let the row settle as failed in the background.
    const said = r?.transactionResponseMessage;
    const text = (typeof said === 'object' ? said?.[lang] ?? said?.en : said) ?? answer?.messages?.[lang] ?? answer?.messages?.en ?? answer?.message;
    setProblem({ text: text && !/^authentication/i.test(String(text)) ? String(text).slice(0, 200) : c.declined });
    void api(`/api/payments/${signed.payment.id}/check`, { method: 'POST' }).catch(() => undefined);
  };

  if (payment) {
    return (
      <PaymentResult
        key={`${payment.id}:${nudge}`}
        id={payment.id}
        onDone={onDone}
        wait={{ forMs: 6 * 60_000, everyMs: 3_000 }}
        failedText={c.declined}
        onRetry={() => {
          setPayment(null);
          setThreeDs(null);
        }}
        waiting={
          threeDs ? (
            <div className="space-y-3">
              <p className="flex items-start gap-2 text-sm">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand" />
                <span>
                  <span className="block font-semibold">{c.threeDs}</span>
                  <span className="block text-xs text-muted">{c.threeDsText}</span>
                </span>
              </p>
              <div className="relative min-h-[28rem] overflow-hidden rounded-xl border border-line bg-white">
                <iframe title={c.threeDs} className="absolute inset-0 size-full border-0" {...(threeDs.url ? { src: threeDs.url } : { srcDoc: threeDs.html })} />
              </div>
            </div>
          ) : undefined
        }
      />
    );
  }

  return (
    <form onSubmit={pay} className="space-y-5" autoComplete="on" noValidate>
      <div className="checkout-form-well space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-ink sm:text-base">{c.sectionTitle}</h3>
          <span className="inline-flex items-center gap-1 text-xs text-muted">
            <Lock className="size-3.5 text-[var(--co-accent-ink)]" />
            {o.trust.ssl}
          </span>
        </div>

        {/* Card number */}
        <label className="grid gap-1.5">
          <span className="text-xs font-semibold text-ink-2 sm:text-[13px]">{c.number}</span>
          <span className="relative block" dir="ltr">
            <span className="pointer-events-none absolute inset-y-0 start-0 flex w-10 items-center justify-center text-muted">
              <CreditCard className="size-4.5" />
            </span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="cc-number"
              dir="ltr"
              placeholder="1234 5678 9012 3456"
              value={groupCard(digits)}
              disabled={busy}
              aria-invalid={errors.number ? true : undefined}
              onChange={(e) => {
                setNumber(e.target.value.replace(/\D/g, '').slice(0, 19));
                setErrors((er) => ({ ...er, number: undefined }));
              }}
              className="checkout-input ps-10 pe-32 font-mono tracking-wider"
            />
            <span className="pointer-events-none absolute inset-y-0 end-2.5 flex items-center">
              <CardMarks activeBrand={brand} />
            </span>
          </span>
          {errors.number && <span className="text-xs font-medium text-destructive-ink">{errors.number}</span>}
        </label>

        {/* Expiration date & CVV */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="grid content-start gap-1.5">
            <span className="text-xs font-semibold text-ink-2 sm:text-[13px]">{c.expiry}</span>
            <span className="relative block" dir="ltr">
              <input
                type="text"
                inputMode="numeric"
                autoComplete="cc-exp"
                dir="ltr"
                placeholder="MM / YY"
                value={expiry}
                disabled={busy}
                aria-invalid={errors.expiry ? true : undefined}
                onChange={(e) => {
                  const d = e.target.value.replace(/\D/g, '').slice(0, 4);
                  setExpiry(d.length > 2 ? `${d.slice(0, 2)} / ${d.slice(2)}` : d);
                  setErrors((er) => ({ ...er, expiry: undefined }));
                }}
                className="checkout-input ps-3.5 pe-10 font-mono tracking-wider"
              />
              <span className="pointer-events-none absolute inset-y-0 end-0 flex w-10 items-center justify-center text-muted">
                <CalendarDays className="size-4" />
              </span>
            </span>
            {errors.expiry && <span className="text-xs font-medium text-destructive-ink">{errors.expiry}</span>}
          </label>

          <label className="grid content-start gap-1.5">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-2 sm:text-[13px]">
              <span>{c.cvc}</span>
              <span title={c.cvcTooltip} aria-label={c.cvcTooltip} className="inline-flex text-muted">
                <Info className="size-3.5" />
              </span>
            </span>
            <span className="relative block" dir="ltr">
              <input
                type={showCvc ? 'text' : 'password'}
                inputMode="numeric"
                autoComplete="cc-csc"
                dir="ltr"
                placeholder="123"
                value={cvc}
                disabled={busy}
                aria-invalid={errors.cvc ? true : undefined}
                onChange={(e) => {
                  setCvc(e.target.value.replace(/\D/g, '').slice(0, 4));
                  setErrors((er) => ({ ...er, cvc: undefined }));
                }}
                className="checkout-input ps-3.5 pe-10 font-mono tracking-wider"
              />
              <button
                type="button"
                onClick={() => setShowCvc((s) => !s)}
                onMouseDown={(e) => e.preventDefault()}
                disabled={busy}
                aria-label={showCvc ? t.common.hidePassword : t.common.showPassword}
                aria-pressed={showCvc}
                title={showCvc ? t.common.hidePassword : t.common.showPassword}
                className="absolute inset-y-0 end-0 flex w-10 items-center justify-center rounded-e-xl text-muted transition-colors hover:text-ink focus-visible:text-ink focus-visible:outline-none"
              >
                {showCvc ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </span>
            {errors.cvc && <span className="text-xs font-medium text-destructive-ink">{errors.cvc}</span>}
          </label>
        </div>

        {/* Name on card */}
        <label className="grid gap-1.5">
          <span className="text-xs font-semibold text-ink-2 sm:text-[13px]">{c.name}</span>
          <span className="relative block" dir="ltr">
            <input
              type="text"
              autoComplete="cc-name"
              dir="ltr"
              placeholder="AHMED MOHAMED"
              value={name}
              disabled={busy}
              aria-invalid={errors.name ? true : undefined}
              onChange={(e) => {
                setName(e.target.value);
                setErrors((er) => ({ ...er, name: undefined }));
              }}
              className="checkout-input ps-3.5 pe-10 tracking-wide uppercase"
            />
            <span className="pointer-events-none absolute inset-y-0 end-0 flex w-10 items-center justify-center text-muted">
              <User className="size-4" />
            </span>
          </span>
          {errors.name && <span className="text-xs font-medium text-destructive-ink">{errors.name}</span>}
        </label>

        {test && <p className="ltr rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">{c.testHint}</p>}
        <p className="flex items-start gap-1.5 text-xs text-muted">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-[var(--co-accent-ink)]" />
          <span>{c.direct}</span>
        </p>
      </div>

      {problem && (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-destructive-ink/25 bg-destructive-ink/10 px-3.5 py-2.5 text-sm text-destructive-ink">
          <AlertTriangle className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">{problem.text}</span>
          {problem.unreachable && (
            <button type="button" onClick={onFallback} className="inline-flex items-center gap-1 font-semibold underline-offset-2 hover:underline">
              {o.openFull} <ExternalLink className={cx('size-3.5', flip)} />
            </button>
          )}
        </div>
      )}

      <CheckoutSubmitButton label={busy ? c.sending : o.payNow(amountLabel)} loading={busy} />
    </form>
  );
}

// --- the other methods: Kashier's own window ------------------------------------------------------

/** Installments and buy-now-pay-later run on the provider's own pages: Kashier's checkout opens in our frame on them. */
export function FramePanel({
  method,
  planId,
  months,
  amountLabel,
  onNeedsPhone,
  onOpened,
  onLockedChange,
}: {
  method: Exclude<KashierMethod, 'card' | 'wallet'>;
  planId: string;
  months: number;
  amountLabel: string;
  onNeedsPhone: () => void;
  onOpened: (c: OpenedCheckout) => void;
  onLockedChange: (locked: boolean) => void;
}) {
  const { t, lang } = useI18n();
  const o = t.subscription.payment.online;
  const x = t.admin.payments.kashier;
  const open = useMutation({
    mutationFn: () => api<OpenedCheckout>('/api/payments/kashier', { method: 'POST', body: { planId, months, locale: lang, method }, timeoutMs: 30_000 }),
    onSuccess: onOpened,
    onError: (err) => {
      if (err instanceof ApiRequestError && err.code === 'phone_unverified') onNeedsPhone();
    },
  });
  useEffect(() => onLockedChange(open.isPending), [open.isPending, onLockedChange]);
  return (
    <div className="space-y-5">
      <div className="checkout-form-well space-y-3 p-4 sm:p-5">
        <div className="flex items-center gap-3">
          <BrandGlyph method={method} size="sm" />
          <div>
            <h3 className="text-sm font-bold text-ink">{x.methodNames[method]}</h3>
            <p className="text-xs text-muted">{o.card.hints[method]}</p>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-ink-2">{x.methodHints[method]}</p>
        <p className="flex items-start gap-1.5 text-xs text-muted">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-[var(--co-accent-ink)]" /> {o.viaKashier}
        </p>
      </div>
      {open.isError && (
        <p role="alert" className="flex items-start gap-2 rounded-xl border border-destructive-ink/25 bg-destructive-ink/10 px-3.5 py-2.5 text-sm text-destructive-ink">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {errorMessage(open.error)}
        </p>
      )}
      <CheckoutSubmitButton
        type="button"
        loading={open.isPending}
        onClick={() => open.mutate()}
        label={open.isPending ? o.opening : `${o.continueTo(x.methodNames[method])} — ${amountLabel}`}
      />
    </div>
  );
}

// --- the whole payment side ----------------------------------------------------------------------

/**
 * All available methods stay visible above a separate form. Pending payments lock the choices
 * and the order duration without removing alternatives or unmounting their confirmation flow.
 */
export function OnlinePaymentPanel({
  methods,
  planId,
  months,
  amountLabel,
  test,
  onNeedsPhone,
  onDone,
  onOpened,
  onLockedChange,
}: {
  methods: KashierMethod[];
  planId: string;
  months: number;
  amountLabel: string;
  test: boolean;
  onNeedsPhone: () => void;
  onDone: () => void;
  onOpened: (c: OpenedCheckout) => void;
  onLockedChange: (locked: boolean) => void;
}) {
  const { t, lang } = useI18n();
  const o = t.subscription.payment.online;
  const [picked, setPicked] = useState<KashierMethod | null>(null);
  const active = picked && methods.includes(picked) ? picked : methods[0] ?? null;
  const [paymentLocked, setPaymentLocked] = useState(false);
  const fallback = useMutation({
    mutationFn: () => api<OpenedCheckout>('/api/payments/kashier', { method: 'POST', body: { planId, months, locale: lang, method: 'card' }, timeoutMs: 30_000 }),
    onSuccess: onOpened,
    onError: (err) => {
      if (err instanceof ApiRequestError && err.code === 'phone_unverified') onNeedsPhone();
    },
  });
  const locked = paymentLocked || fallback.isPending;
  useEffect(() => onLockedChange(locked), [locked, onLockedChange]);

  return (
    <div className="space-y-5">
      <PaymentMethodSelector
        methods={methods}
        active={active}
        disabled={locked}
        onSelect={(m) => {
          setPicked(m);
          fallback.reset();
        }}
      />
      {locked && (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-[var(--co-accent-border)] bg-[var(--co-accent-soft)] p-3 text-xs leading-relaxed text-ink-2">
          <Lock className="mt-0.5 size-4 shrink-0 text-[var(--co-accent-ink)]" />
          {o.methodLocked}
        </p>
      )}
      {active && (
        <section key={active} aria-label={o.paymentDetails} className="animate-fade-up">
          <fieldset disabled={fallback.isPending} className="min-w-0">
            {active === 'card' ? (
              <CardPanel planId={planId} months={months} amountLabel={amountLabel} test={test} onNeedsPhone={onNeedsPhone} onDone={onDone} onFallback={() => fallback.mutate()} onLockedChange={setPaymentLocked} />
            ) : active === 'wallet' ? (
              <WalletPanel planId={planId} months={months} amountLabel={amountLabel} test={test} onNeedsPhone={onNeedsPhone} onDone={onDone} onLockedChange={setPaymentLocked} />
            ) : (
              <FramePanel method={active} planId={planId} months={months} amountLabel={amountLabel} onNeedsPhone={onNeedsPhone} onOpened={onOpened} onLockedChange={setPaymentLocked} />
            )}
          </fieldset>
          {fallback.isPending && <p role="status" className="mt-3 text-sm text-muted">{o.opening}</p>}
          {fallback.isError && <p role="alert" className="mt-3 text-sm text-destructive-ink">{errorMessage(fallback.error)}</p>}
        </section>
      )}
      {!methods.length && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> {t.common.loading}
        </p>
      )}
    </div>
  );
}
