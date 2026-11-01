import type { KashierMethod } from '@wa/shared/kashier';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Check, CreditCard, ExternalLink, Landmark, Loader2, Lock, ShieldCheck, Smartphone } from '../../icons';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../../api';
import { useI18n } from '../../i18n';
import { Button, cx, Field, flip } from '../../ui';
import { type OnlinePayment, type OpenedCheckout, PaymentResult, WalletPanel } from './OnlineCheckout';
import { CardMarks, KashierMark } from './Trust';

/**
 * Each method in the colours of the company behind it, as a customer would recognise it on a shop's
 * checkout: a glyph and, where there is one, a wordmark. No artwork of theirs is shipped — colours and names only.
 */
const BRAND: Record<KashierMethod, { bg: string; fg?: string; mark?: string; icon?: typeof Smartphone }> = {
  card: { bg: 'bg-[#1a1f71]', icon: CreditCard },
  wallet: { bg: 'bg-[#e60000]', icon: Smartphone },
  bank_installments: { bg: 'bg-[#0f4c81]', icon: Landmark },
  valu: { bg: 'bg-[#6a1b9a]', mark: 'valU' },
  souhoola: { bg: 'bg-[#00a651]', mark: 'سهولة' },
  aman: { bg: 'bg-[#1565c0]', mark: 'أمان' },
  contact: { bg: 'bg-[#00aeef]', mark: 'contact' },
};

/** Egypt's wallet networks, as four dots in their colours (Vodafone, Orange, Etisalat, WE). */
const WALLET_NETWORKS = ['bg-[#e60000]', 'bg-[#ff7900]', 'bg-[#5cb531]', 'bg-[#5b2a86]'];

export function BrandGlyph({ method, size = 'md' }: { method: KashierMethod; size?: 'sm' | 'md' }) {
  const b = BRAND[method];
  const dims = size === 'sm' ? 'size-8 rounded-lg [&>svg]:size-4 text-[10px]' : 'size-11 rounded-xl [&>svg]:size-5 text-[11px]';
  return (
    <span className={cx('flex shrink-0 items-center justify-center font-black tracking-tight text-white shadow-sm', dims, b.bg, b.fg)}>
      {b.icon ? <b.icon /> : <span className="px-1 leading-none">{b.mark}</span>}
    </span>
  );
}

/** One payment method, Stripe-style: a radio row that opens into its own form when picked. */
export function MethodTile({ method, active, onPick, children }: { method: KashierMethod; active: boolean; onPick: () => void; children?: ReactNode }) {
  const { t } = useI18n();
  const x = t.admin.payments.kashier;
  const o = t.subscription.payment.online;
  const hint = method === 'wallet' ? o.wallet.networks : o.card.hints[method];
  return (
    <div className={cx('overflow-hidden rounded-xl border transition-all', active ? 'border-brand shadow-[0_0_0_1px_var(--color-brand)]' : 'border-line hover:border-line-strong')}>
      <button type="button" role="radio" aria-checked={active} onClick={onPick} className={cx('flex w-full items-center gap-3 p-3 text-start transition-colors', active ? 'bg-brand/[0.06]' : 'hover:bg-raised/30')}>
        <span className={cx('flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors', active ? 'border-brand bg-brand text-on-brand' : 'border-line-strong')}>{active && <Check className="size-3" />}</span>
        <BrandGlyph method={method} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{x.methodNames[method]}</span>
          <span className="flex items-center gap-1.5 text-xs text-muted">
            {method === 'wallet' && (
              <span className="flex items-center gap-0.5">
                {WALLET_NETWORKS.map((c) => (
                  <span key={c} className={cx('size-2 rounded-full', c)} />
                ))}
              </span>
            )}
            <span className="truncate">{hint}</span>
          </span>
        </span>
        {method === 'card' && <CardMarks className="hidden sm:inline-flex" />}
      </button>
      {active && children && <div className="animate-fade-up border-t border-line/70 bg-card p-4">{children}</div>}
    </div>
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

function BrandMark({ brand }: { brand: CardBrand }) {
  if (!brand) return <CreditCard className="size-5 text-muted" />;
  const pill = 'flex h-6 items-center rounded-[5px] border border-black/10 bg-white px-1.5 shadow-sm';
  if (brand === 'visa') return <span className={pill}><span className="text-[11px] leading-none font-black tracking-tight text-[#1a1f71] italic">VISA</span></span>;
  if (brand === 'meeza') return <span className={pill}><span className="text-[10px] leading-none font-extrabold tracking-tight text-[#5b2d90]">meeza</span></span>;
  return (
    <span className={cx(pill, 'gap-0')}>
      <span className="size-3.5 rounded-full bg-[#eb001b]" />
      <span className="-ms-1.5 size-3.5 rounded-full bg-[#f79e1b] opacity-90" />
    </span>
  );
}

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
type DirectAnswer = { status?: string; response?: { status?: string; authentication?: { redirectUrl?: string; redirectHtml?: string }; transactionResponseMessage?: { en?: string; ar?: string } | string; transactionResponseCode?: string }; messages?: { en?: string; ar?: string }; message?: string };

/**
 * The card form. The card details go from this browser straight to Kashier's Direct API with the order
 * our server signed (`POST /api/payments/kashier/card`); they never pass through our servers. 3-D Secure
 * opens in a frame right here; the outcome is confirmed with the server (`PaymentResult`), never taken
 * from the browser's side of things.
 */
export function CardPanel({ planId, months, amountLabel, test, onNeedsPhone, onDone, onFallback }: { planId: string; months: number; amountLabel: string; test: boolean; onNeedsPhone: () => void; onDone: () => void; onFallback: () => void }) {
  const { t, lang } = useI18n();
  const o = t.subscription.payment.online;
  const c = o.card;
  const [number, setNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvc, setCvc] = useState('');
  const [name, setName] = useState('');
  const [errors, setErrors] = useState<Partial<Record<'number' | 'expiry' | 'cvc' | 'name', string>>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; unreachable?: boolean } | null>(null);
  const [payment, setPayment] = useState<OnlinePayment | null>(null);
  const [threeDs, setThreeDs] = useState<{ url?: string; html?: string } | null>(null);
  const [nudge, setNudge] = useState(0);
  const digits = number.replace(/\D/g, '');
  const brand = cardBrandOf(digits);

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
    <form onSubmit={pay} className="space-y-4" autoComplete="on">
      <Field
        label={c.number}
        value={groupCard(digits)}
        onChange={(e) => {
          setNumber(e.target.value.replace(/\D/g, '').slice(0, 19));
          setErrors((er) => ({ ...er, number: undefined }));
        }}
        inputMode="numeric"
        autoComplete="cc-number"
        dir="ltr"
        placeholder="1234 5678 9012 3456"
        autoFocus
        aside={<BrandMark brand={brand} />}
        error={errors.number ? [errors.number] : undefined}
      />
      <div className="grid grid-cols-2 gap-3">
        <Field
          label={c.expiry}
          value={expiry}
          onChange={(e) => {
            const d = e.target.value.replace(/\D/g, '').slice(0, 4);
            setExpiry(d.length > 2 ? `${d.slice(0, 2)} / ${d.slice(2)}` : d);
            setErrors((er) => ({ ...er, expiry: undefined }));
          }}
          inputMode="numeric"
          autoComplete="cc-exp"
          dir="ltr"
          placeholder="MM / YY"
          error={errors.expiry ? [errors.expiry] : undefined}
        />
        <Field
          label={c.cvc}
          value={cvc}
          onChange={(e) => {
            setCvc(e.target.value.replace(/\D/g, '').slice(0, 4));
            setErrors((er) => ({ ...er, cvc: undefined }));
          }}
          inputMode="numeric"
          autoComplete="cc-csc"
          dir="ltr"
          placeholder="123"
          type="password"
          error={errors.cvc ? [errors.cvc] : undefined}
        />
      </div>
      <Field
        label={c.name}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setErrors((er) => ({ ...er, name: undefined }));
        }}
        autoComplete="cc-name"
        dir="ltr"
        placeholder="AHMED MOHAMED"
        error={errors.name ? [errors.name] : undefined}
      />
      {test && <p className="ltr text-xs text-warning">{c.testHint}</p>}
      <p className="flex items-start gap-1.5 text-xs text-muted">
        <Lock className="mt-0.5 size-3.5 shrink-0 text-brand" /> {c.direct}
      </p>
      {problem && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-destructive-ink/10 px-3 py-2 text-sm text-destructive-ink">
          <AlertTriangle className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">{problem.text}</span>
          {problem.unreachable && (
            <button type="button" onClick={onFallback} className="inline-flex items-center gap-1 font-semibold underline-offset-2 hover:underline">
              {o.openFull} <ExternalLink className={cx('size-3.5', flip)} />
            </button>
          )}
        </div>
      )}
      <Button type="submit" variant="brand" size="lg" className="w-full" loading={busy} icon={busy ? undefined : <Lock className="size-4" />}>
        {busy ? c.sending : o.payNow(amountLabel)}
      </Button>
      <div className="flex justify-center">
        <KashierMark />
      </div>
    </form>
  );
}

// --- the other methods: Kashier's own window ------------------------------------------------------

/** Installments and buy-now-pay-later run on the provider's own pages: Kashier's checkout opens in our frame on them. */
export function FramePanel({ method, planId, months, amountLabel, onNeedsPhone, onOpened }: { method: KashierMethod; planId: string; months: number; amountLabel: string; onNeedsPhone: () => void; onOpened: (c: OpenedCheckout) => void }) {
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
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">{x.methodHints[method]}</p>
      <p className="flex items-start gap-1.5 text-xs text-muted">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-brand" /> {o.viaKashier}
      </p>
      {open.isError && (
        <p className="flex items-start gap-2 rounded-lg bg-destructive-ink/10 px-3 py-2 text-sm text-destructive-ink">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {errorMessage(open.error)}
        </p>
      )}
      <Button variant="brand" size="lg" className="w-full" loading={open.isPending} onClick={() => open.mutate()} icon={open.isPending ? undefined : <Lock className="size-4" />}>
        {open.isPending ? o.opening : `${o.continueTo(x.methodNames[method])} · ${amountLabel}`}
      </Button>
    </div>
  );
}

// --- the whole payment side ----------------------------------------------------------------------

/**
 * The payment column of the request dialog when Kashier takes payments: the methods as tiles, each
 * opening into its own form — card and wallet on our page, the rest in Kashier's frame.
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
}: {
  methods: KashierMethod[];
  planId: string;
  months: number;
  amountLabel: string;
  test: boolean;
  onNeedsPhone: () => void;
  onDone: () => void;
  onOpened: (c: OpenedCheckout) => void;
}) {
  const { t } = useI18n();
  const o = t.subscription.payment.online;
  const [picked, setPicked] = useState<KashierMethod | null>(null);
  const active = picked ?? methods[0] ?? null;
  // Once a payment is under way (a wallet request sent, 3-D Secure open), the other tiles step aside.
  const [locked, setLocked] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const fallback = () => {
    if (!active) return;
    const el = panelRef.current?.querySelector<HTMLButtonElement>('[data-fallback]');
    el?.click();
  };

  return (
    <div ref={panelRef} className="space-y-3">
      <p className="text-sm font-semibold">{o.payWith}</p>
      <div role="radiogroup" aria-label={o.chooseMethod} className="space-y-2">
        {methods
          .filter((m) => !locked || m === active)
          .map((m) => (
            <MethodTile key={m} method={m} active={m === active} onPick={() => !locked && setPicked(m)}>
              {m === 'card' ? (
                <CardPanel planId={planId} months={months} amountLabel={amountLabel} test={test} onNeedsPhone={onNeedsPhone} onDone={onDone} onFallback={fallback} />
              ) : m === 'wallet' ? (
                <WalletPanel planId={planId} months={months} amountLabel={amountLabel} test={test} onNeedsPhone={onNeedsPhone} onDone={onDone} onStarted={() => setLocked(true)} onReset={() => setLocked(false)} />
              ) : (
                <FramePanel method={m} planId={planId} months={months} amountLabel={amountLabel} onNeedsPhone={onNeedsPhone} onOpened={onOpened} />
              )}
            </MethodTile>
          ))}
      </div>
      {/* The card form's fallback when the browser can't reach Kashier: the same payment in Kashier's own frame. */}
      <HiddenFrameOpener method="card" planId={planId} months={months} onNeedsPhone={onNeedsPhone} onOpened={onOpened} />
      {!methods.length && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> {t.common.loading}
        </p>
      )}
    </div>
  );
}

function HiddenFrameOpener({ method, planId, months, onNeedsPhone, onOpened }: { method: KashierMethod; planId: string; months: number; onNeedsPhone: () => void; onOpened: (c: OpenedCheckout) => void }) {
  const { lang } = useI18n();
  const open = useMutation({
    mutationFn: () => api<OpenedCheckout>('/api/payments/kashier', { method: 'POST', body: { planId, months, locale: lang, method }, timeoutMs: 30_000 }),
    onSuccess: onOpened,
    onError: (err) => {
      if (err instanceof ApiRequestError && err.code === 'phone_unverified') onNeedsPhone();
    },
  });
  return <button type="button" data-fallback hidden onClick={() => open.mutate()} />;
}
