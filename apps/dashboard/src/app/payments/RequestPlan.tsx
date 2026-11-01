import { discountPercent } from '@wa/shared/plan-pricing';
import { enabledPaymentMethods, PAYMENT_MONTHS, type PaymentDetails, type PaymentMethod, type PaymentMonths, type PaymentSettings, planPriceEgp } from '@wa/shared/payments';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, Check, ImagePlus, Info, Loader2, Receipt, ShieldCheck, X } from '../../icons';
import { type DragEvent, type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../../api';
import { useCurrencyRates } from '../../currency';
import { useI18n } from '../../i18n';
import type { PricedPlan } from '../../site/content';
import { Button, cx, ErrorNote, Field, flip, Modal, usePlanName } from '../../ui';
import { CopyLine, METHOD_LOOK, MethodGlyph, shrinkImage, usePaymentSettings } from './methods';
import { CheckoutFrame, type OpenedCheckout, useKashierConfig } from './OnlineCheckout';
import { OnlinePaymentPanel } from './OnlinePay';
import { RateLine, TrustStrip } from './Trust';

type Proof = { mimetype: 'image/jpeg'; data: string; previewUrl: string };

/** Paying means accepting the terms and the refund policy; both open in a new tab so the popup keeps its state. */
function PayAgreement() {
  const { t } = useI18n();
  const l = t.legal;
  const link = 'text-muted underline underline-offset-2 hover:text-ink';
  return (
    <p className="text-xs text-faint">
      {l.payAgree.lead}{' '}
      <a href="/terms" target="_blank" rel="noreferrer" className={link}>
        {l.terms}
      </a>
      {l.payAgree.and}
      <a href="/refund" target="_blank" rel="noreferrer" className={link}>
        {l.refund}
      </a>
      {l.payAgree.tail}
    </p>
  );
}

/** A USD price as the customer pays it: in Egyptian pounds at the rate charged today, else in dollars. */
function usePayPrice(egpPerUsd: number) {
  const { t } = useI18n();
  const p = t.subscription.payment;
  return (usd: number, months = 1) => (egpPerUsd > 0 ? p.egp(planPriceEgp(usd, months, egpPerUsd)!) : p.usd(usd * months));
}

/** Months → total, as a row of choices; the yearly one is marked as the best value when it is cheaper per month. */
function MonthsPicker({ plan, egpPerUsd, value, onChange }: { plan: PricedPlan; egpPerUsd: number; value: PaymentMonths; onChange: (m: PaymentMonths) => void }) {
  const { t } = useI18n();
  const p = t.subscription.payment;
  const price = usePayPrice(egpPerUsd);
  const compare = discountPercent(plan.priceUsd, plan.compareAtUsd) !== null ? plan.compareAtUsd : null;
  return (
    <div role="radiogroup" aria-label={p.duration} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {PAYMENT_MONTHS.map((m) => {
        const active = m === value;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(m)}
            className={cx(
              'relative flex flex-col items-center gap-0.5 rounded-xl border px-2 py-2.5 text-center transition-all',
              active ? 'border-brand bg-brand/10 shadow-[0_0_0_1px_var(--color-brand)]' : 'border-line hover:border-line-strong hover:bg-raised/40',
            )}
          >
            <span className={cx('text-sm font-semibold', active && 'text-brand')}>{p.months(m)}</span>
            <span className="ltr flex flex-col text-[11px] text-muted tabular-nums">
              {compare !== null && <span className="line-through opacity-70">{price(compare, m)}</span>}
              <span>{price(plan.priceUsd, m)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function MethodPicker({ methods, value, onChange }: { methods: PaymentMethod[]; value: PaymentMethod | null; onChange: (m: PaymentMethod) => void }) {
  const { t } = useI18n();
  const p = t.subscription.payment;
  return (
    <div role="radiogroup" aria-label={p.chooseMethod} className="grid gap-2 sm:grid-cols-3">
      {methods.map((m, i) => {
        const active = m === value;
        const look = METHOD_LOOK[m];
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(m)}
            className={cx(
              'animate-fade-up relative flex items-center gap-3 rounded-xl border p-3 text-start transition-all sm:flex-col sm:items-start sm:gap-2.5',
              active ? cx('bg-raised/40 shadow-sm', look.ring) : 'border-line hover:border-line-strong hover:bg-raised/30',
            )}
            style={{ animationDelay: `${i * 50}ms` }}
          >
            <MethodGlyph method={m} />
            <span className="text-sm font-semibold">{p.methods[m]}</span>
            {active && (
              <span className="absolute end-2 top-2 flex size-5 items-center justify-center rounded-full bg-brand text-on-brand">
                <Check className="size-3" />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Where to send the money, for the chosen method. */
function ReceivingAccount({ method, settings }: { method: PaymentMethod; settings: PaymentSettings }) {
  const { t } = useI18n();
  const p = t.subscription.payment;
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <div className="flex items-center gap-3 border-b border-line/60 bg-raised/30 px-3.5 py-2.5">
        <MethodGlyph method={method} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{p.methods[method]}</span>
          <span className="block text-xs text-muted">{p.methodHints[method]}</span>
        </span>
      </div>
      <div className="grid gap-2 p-3">
        {method === 'vodafone_cash' && (
          <>
            <CopyLine label={p.walletNumber} value={settings.vodafone_cash.number} />
            {settings.vodafone_cash.name && <CopyLine label={p.accountName} value={settings.vodafone_cash.name} mono={false} />}
          </>
        )}
        {method === 'instapay' && (
          <>
            <CopyLine label={p.instapayAddress} value={settings.instapay.address} />
            {settings.instapay.name && <CopyLine label={p.accountName} value={settings.instapay.name} mono={false} />}
          </>
        )}
        {method === 'bank_transfer' && (
          <>
            {settings.bank_transfer.bankName && <CopyLine label={p.bank} value={settings.bank_transfer.bankName} mono={false} />}
            {settings.bank_transfer.accountName && <CopyLine label={p.accountName} value={settings.bank_transfer.accountName} mono={false} />}
            {settings.bank_transfer.accountNumber && <CopyLine label={p.accountNumber} value={settings.bank_transfer.accountNumber} />}
            {settings.bank_transfer.iban && <CopyLine label={p.iban} value={settings.bank_transfer.iban} />}
          </>
        )}
      </div>
    </div>
  );
}

/** Picks a screenshot (click or drop), shrinks it, shows a preview. */
function ScreenshotPicker({ proof, onChange, error }: { proof: Proof | null; onChange: (p: Proof | null) => void; error: string | null }) {
  const { t } = useI18n();
  const p = t.subscription.payment;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  const take = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return setProblem(p.imageInvalid);
    setProblem(null);
    setBusy(true);
    try {
      const shrunk = await shrinkImage(file);
      onChange({ mimetype: shrunk.mimetype, data: shrunk.data, previewUrl: shrunk.previewUrl });
    } catch {
      setProblem(p.imageFailed);
    } finally {
      setBusy(false);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void take(e.dataTransfer.files[0]);
  };
  const shown = problem ?? error;

  return (
    <div className="grid gap-2">
      <span className="flex items-center justify-between text-sm leading-none font-medium">
        {p.screenshot}
        {proof && (
          <button type="button" onClick={() => input.current?.click()} className="text-xs font-medium text-brand hover:underline">
            {p.changeImage}
          </button>
        )}
      </span>
      <input ref={input} type="file" accept="image/*" className="sr-only" onChange={(e) => void take(e.target.files?.[0])} />
      {proof ? (
        <button type="button" onClick={() => input.current?.click()} className="group relative block overflow-hidden rounded-xl border border-line bg-black/40">
          <img src={proof.previewUrl} alt="" className="mx-auto max-h-64 object-contain" />
          <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-3 pt-6 pb-2 text-xs font-medium text-white">
            <Check className="size-3.5 text-brand" /> {p.proofAttached}
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          disabled={busy}
          className={cx(
            'flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-7 text-center transition-colors',
            over ? 'border-brand bg-brand/10' : shown ? 'border-destructive-ink/50' : 'border-line hover:border-line-strong hover:bg-raised/30',
          )}
        >
          {busy ? <Loader2 className="size-6 animate-spin text-brand" /> : <ImagePlus className="size-6 text-muted" />}
          <span className="text-sm font-medium">{p.chooseImage}</span>
          <span className="text-xs text-muted">{p.dropImage}</span>
        </button>
      )}
      {shown ? <span className="text-sm text-destructive-ink">{shown}</span> : <span className="text-xs text-muted">{p.screenshotHint}</span>}
    </div>
  );
}

/** The full-screen shell of the online checkout: a header with the plan, the amount and a close button over a scrolling page. */
function OnlinePayScreen({ title, amountLabel, test, onClose, children }: { title: string; amountLabel: string; test: boolean; onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  const o = t.subscription.payment.online;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal aria-label={title} className="animate-fade-in fixed inset-0 z-50 flex flex-col bg-bg">
      <header className="shrink-0 border-b border-line bg-card">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand/12 text-brand">
            <ShieldCheck className="size-4.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-sm font-semibold">
              {title}
              {test && <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-bold text-warning">{o.testBadge}</span>}
            </span>
            <span className="block truncate text-xs text-muted">{o.secureHint}</span>
          </span>
          <span className="shrink-0 text-end">
            <span className="block text-[10px] text-muted uppercase">{o.due}</span>
            <span className="ltr block text-base font-bold tabular-nums">{amountLabel}</span>
          </span>
          <button type="button" onClick={onClose} aria-label={t.common.close} className="ms-1 flex size-9 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-ink">
            <X className="size-4" />
          </button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:py-8">{children}</div>
      </main>
    </div>
  );
}

/** The plan, its discount and the total as it will be charged, over the exchange rate behind it. */
function OrderSummary({ plan, months, egpPerUsd }: { plan: PricedPlan; months: PaymentMonths; egpPerUsd: number }) {
  const { t } = useI18n();
  const p = t.subscription.payment;
  const planName = usePlanName();
  const price = usePayPrice(egpPerUsd);
  const totalUsd = plan.priceUsd * months;
  const totalEgp = planPriceEgp(plan.priceUsd, months, egpPerUsd);
  const off = discountPercent(plan.priceUsd, plan.compareAtUsd);
  const compare = off !== null ? plan.compareAtUsd : null;
  const inEgp = totalEgp !== null && egpPerUsd > 0;
  return (
    <section className="overflow-hidden rounded-2xl border border-line">
      <div className="flex items-start justify-between gap-4 bg-gradient-to-br from-brand/12 via-transparent to-transparent p-4">
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-wide text-muted uppercase">{p.online.plan}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-lg font-semibold">
            {planName(plan)}
            {off !== null && <span className="rounded-full border border-warning/40 bg-warning/15 px-2 py-0.5 text-[11px] font-bold text-warning">{t.plans.off(off)}</span>}
          </p>
          <p className="ltr mt-1 text-sm text-muted">
            {compare !== null && <span className="me-1.5 line-through opacity-70">{price(compare)}</span>}
            {p.perMonth(price(plan.priceUsd))}
          </p>
        </div>
        <div className="shrink-0 text-end">
          <p className="text-[11px] font-medium tracking-wide text-muted uppercase">{p.total}</p>
          {/* Paid in pounds: the EGP total leads, the dollar price is the reference. */}
          <p className="ltr text-2xl font-bold tabular-nums">{inEgp ? p.egp(totalEgp) : p.usd(totalUsd)}</p>
          {inEgp && <p className="ltr text-xs text-muted tabular-nums">{p.usd(totalUsd)}</p>}
        </div>
      </div>
      {inEgp && <RateLine className="border-t border-line/60 bg-raised/20 px-4 py-2" />}
    </section>
  );
}

export function RequestPlanModal({
  plan,
  onClose,
  onSent,
  onPaid,
  onNeedsPhone,
}: {
  plan: PricedPlan;
  onClose: () => void;
  onSent: () => void;
  /** An online payment reached its outcome (shown to the customer) and they closed it. */
  onPaid: () => void;
  onNeedsPhone: () => void;
}) {
  const { t } = useI18n();
  const s = t.subscription;
  const p = s.payment;
  const planName = usePlanName();
  const settings = usePaymentSettings();
  const rates = useCurrencyRates();
  const methods = settings.data ? enabledPaymentMethods(settings.data) : [];
  // The rate every price here is worked out at: today's market rate, never below the platform's floor (the server charges at the same one).
  const egpPerUsd = rates.data?.egp.effective ?? 0;

  const [months, setMonths] = useState<PaymentMonths>(1);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [step, setStep] = useState<'plan' | 'details' | 'pay'>('plan');
  const [fields, setFields] = useState({ senderPhone: '', sender: '', senderName: '', bankName: '', reference: '', amount: '' });
  const [proof, setProof] = useState<Proof | null>(null);
  const [note, setNote] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const totalUsd = plan.priceUsd * months;
  const totalEgp = planPriceEgp(plan.priceUsd, months, egpPerUsd);
  // No transfer when nothing is configured, or the plan is free after a 100% discount.
  const free = plan.priceUsd === 0;
  const kashier = useKashierConfig();
  // With Kashier taking payments for this account, priced plans are paid online and the manual transfers are hidden.
  const online = Boolean(kashier.data?.enabled) && !free && totalEgp !== null && totalEgp > 0;
  const payable = !online && methods.length > 0 && !free;
  const loadingMethods = settings.isPending || kashier.isPending || rates.isPending;
  const kashierMethods = kashier.data?.methods ?? [];
  // Kashier's checkout (installments, BNPL), once opened, takes over from the dialog (on our page, in its own frame).
  const [checkout, setCheckout] = useState<OpenedCheckout | null>(null);

  const request = useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/api/plan-requests', { method: 'POST', body, timeoutMs: 60_000 }),
    onSuccess: onSent,
    onError: (err) => {
      if (err instanceof ApiRequestError && err.code === 'phone_unverified') onNeedsPhone();
      if (err instanceof ApiRequestError && err.status === 422 && err.errors) setFieldErrors(err.errors);
    },
  });

  const payment = (): PaymentDetails | null => {
    if (!method) return null;
    const amount = fields.amount.trim() ? Number(fields.amount.replace(/[^\d.]/g, '')) : undefined;
    const base = amount && Number.isFinite(amount) && amount > 0 ? { amount } : {};
    if (method === 'vodafone_cash') return { method, senderPhone: fields.senderPhone.trim(), ...base };
    if (method === 'instapay') return { method, sender: fields.sender.trim(), ...base };
    return { method, senderName: fields.senderName.trim(), ...(fields.bankName.trim() ? { bankName: fields.bankName.trim() } : {}), ...(fields.reference.trim() ? { reference: fields.reference.trim() } : {}), ...base };
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // Online payments confirm from the checkout's own button; Enter must not file a manual request.
    if (request.isPending || online) return;
    setFieldErrors({});
    const body: Record<string, unknown> = { planId: plan.id, months, note: note.trim() || undefined };
    if (payable) {
      const details = payment();
      if (!details || !proof) return;
      body.payment = details;
      body.proof = { mimetype: proof.mimetype, data: proof.data };
    }
    request.mutate(body);
  };

  const goDetails = () => {
    if (!method) return;
    if (!fields.amount && totalEgp) setFields((f) => ({ ...f, amount: String(totalEgp) }));
    setStep('details');
  };

  const topError = request.error instanceof ApiRequestError && request.error.code === 'duplicate_request' ? s.duplicate : request.isError && !Object.keys(fieldErrors).length ? errorMessage(request.error) : null;
  const err = (key: string) => fieldErrors[key] ?? fieldErrors[`payment.${key}`];
  const detailsReady =
    proof !== null &&
    ((method === 'vodafone_cash' && fields.senderPhone.trim().length >= 11) || (method === 'instapay' && fields.sender.trim().length >= 3) || (method === 'bank_transfer' && fields.senderName.trim().length >= 2));
  const totalLabel = totalEgp !== null && egpPerUsd > 0 ? p.egp(totalEgp) : p.usd(totalUsd);

  if (checkout) {
    return (
      <CheckoutFrame
        checkout={checkout}
        planLabel={`${planName(plan)} · ${p.months(checkout.payment.months)}`}
        amountLabel={p.egp(checkout.payment.amountCents / 100)}
        test={checkout.payment.mode === 'test'}
        onBack={() => setCheckout(null)}
        onDone={onPaid}
      />
    );
  }

  if (online && totalEgp !== null) {
    // Online payment takes the whole screen, as a shop's checkout: the order on one side, the payment
    // methods (each opening into its own form) on the other, with room for all of them. Not a <form>:
    // each method's panel is its own form, and the page itself never submits anything.
    return (
      <OnlinePayScreen title={s.modalTitle(planName(plan))} amountLabel={p.egp(totalEgp)} test={kashier.data?.mode === 'test'} onClose={onClose}>
        <div className="grid gap-6 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] md:gap-8 lg:gap-10">
          <aside className="space-y-4 md:sticky md:top-4 md:self-start">
            <OrderSummary plan={plan} months={months} egpPerUsd={egpPerUsd} />
            <div className="space-y-2">
              <p className="text-sm font-medium">{p.duration}</p>
              <MonthsPicker plan={plan} egpPerUsd={egpPerUsd} value={months} onChange={setMonths} />
            </div>
            <TrustStrip />
            <PayAgreement />
          </aside>
          <section className="min-w-0">
            {loadingMethods ? (
              <div className="flex justify-center py-10">
                <Loader2 className="size-5 animate-spin text-brand" />
              </div>
            ) : (
              <OnlinePaymentPanel
                // The chosen length changes the amount, so a payment under way is never silently repriced: the panel starts over.
                key={months}
                methods={kashierMethods}
                planId={plan.id}
                months={months}
                amountLabel={p.egp(totalEgp)}
                test={kashier.data?.mode === 'test'}
                onNeedsPhone={onNeedsPhone}
                onDone={onPaid}
                onOpened={setCheckout}
              />
            )}
          </section>
        </div>
      </OnlinePayScreen>
    );
  }

  return (
    <Modal title={s.modalTitle(planName(plan))} description={step === 'details' ? p.steps.details : undefined} onClose={onClose} size="lg" tall>
      <form onSubmit={submit} className="space-y-5">
        {/* step indicator (manual transfers only: online payment is one screen) */}
        {payable && (
          <ol className="flex items-center gap-2 text-xs">
            {(['plan', 'details'] as const).map((k, i) => {
              const done = k === 'plan' && step !== 'plan';
              const active = k === step;
              return (
                <li key={k} className="flex items-center gap-2">
                  {i > 0 && <span className={cx('h-px w-8 transition-colors', done ? 'bg-brand' : 'bg-line')} />}
                  <span className={cx('flex size-5 items-center justify-center rounded-full text-[11px] font-semibold transition-colors', active || done ? 'bg-brand text-on-brand' : 'bg-raised text-muted')}>
                    {done ? <Check className="size-3" /> : i + 1}
                  </span>
                  <span className={cx('font-medium', active ? 'text-ink' : 'text-muted')}>{p.steps[k]}</span>
                </li>
              );
            })}
          </ol>
        )}

        {step === 'plan' ? (
          <>
            <OrderSummary plan={plan} months={months} egpPerUsd={egpPerUsd} />

            <div className="space-y-2">
              <p className="text-sm font-medium">{p.duration}</p>
              <MonthsPicker plan={plan} egpPerUsd={egpPerUsd} value={months} onChange={setMonths} />
            </div>

            {loadingMethods ? (
              <div className="flex justify-center py-4">
                <Loader2 className="size-5 animate-spin text-brand" />
              </div>
            ) : payable ? (
              <div className="space-y-2">
                <p className="text-sm font-medium">{p.chooseMethod}</p>
                <MethodPicker methods={methods} value={method} onChange={setMethod} />
                {egpPerUsd > 0 && <p className="text-xs text-muted">{p.approx}</p>}
              </div>
            ) : (
              <div className="flex items-start gap-3 rounded-lg border border-line bg-raised/20 p-3 text-sm text-ink-2">
                <Info className="mt-0.5 size-4 shrink-0 text-muted" />
                {free ? p.free : p.noMethods}
              </div>
            )}

            {!payable && !loadingMethods && <Field label={s.noteLabel} placeholder={s.notePlaceholder} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}
            {payable && <PayAgreement />}
            <ErrorNote>{topError}</ErrorNote>
            <div className="sticky bottom-0 z-10 -mx-6 flex items-center justify-between gap-3 border-t border-line bg-card px-6 py-4">
              {/* The total travels with the footer, so it stays in view while the form scrolls. */}
              <span className="min-w-0">
                <span className="block text-[11px] text-muted uppercase">{p.total}</span>
                <span className="ltr block text-base font-bold tabular-nums">{free ? p.usd(0) : totalLabel}</span>
              </span>
              <span className="flex gap-2">
                <Button variant="outline" onClick={onClose}>
                  {t.common.cancel}
                </Button>
                {payable ? (
                  <Button variant="brand" disabled={!method} onClick={goDetails}>
                    {p.next}
                  </Button>
                ) : (
                  <Button type="submit" variant="brand" loading={request.isPending} disabled={loadingMethods}>
                    {s.submit}
                  </Button>
                )}
              </span>
            </div>
          </>
        ) : (
          method &&
          settings.data && (
            <>
              <ReceivingAccount method={method} settings={settings.data} />
              {settings.data.instructions && (
                <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                  <Info className="mt-px size-3.5 shrink-0" />
                  <bdi>{settings.data.instructions}</bdi>
                </p>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                {method === 'vodafone_cash' && (
                  <Field label={p.fields.senderPhone} value={fields.senderPhone} onChange={(e) => setFields({ ...fields, senderPhone: e.target.value })} inputMode="tel" dir="ltr" placeholder="01xxxxxxxxx" required autoFocus error={err('senderPhone')} />
                )}
                {method === 'instapay' && (
                  <Field label={p.fields.sender} value={fields.sender} onChange={(e) => setFields({ ...fields, sender: e.target.value })} dir="ltr" placeholder="name@instapay" required autoFocus error={err('sender')} />
                )}
                {method === 'bank_transfer' && (
                  <>
                    <Field label={p.fields.senderName} value={fields.senderName} onChange={(e) => setFields({ ...fields, senderName: e.target.value })} required autoFocus error={err('senderName')} />
                    <Field label={p.fields.bankName} value={fields.bankName} onChange={(e) => setFields({ ...fields, bankName: e.target.value })} error={err('bankName')} />
                    <Field label={p.fields.reference} value={fields.reference} onChange={(e) => setFields({ ...fields, reference: e.target.value })} dir="ltr" error={err('reference')} />
                  </>
                )}
                <Field
                  label={p.fields.amount}
                  value={fields.amount}
                  onChange={(e) => setFields({ ...fields, amount: e.target.value })}
                  inputMode="decimal"
                  dir="ltr"
                  error={err('amount')}
                  aside={totalEgp !== null ? <span className="text-xs text-muted tabular-nums">{p.egp(totalEgp)}</span> : undefined}
                />
              </div>

              <ScreenshotPicker proof={proof} onChange={setProof} error={err('proof')?.join(' ') ?? null} />
              <Field label={s.noteLabel} placeholder={s.notePlaceholder} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
              <ErrorNote>{topError}</ErrorNote>

              {/* Stays in view while the form scrolls inside the dialog. */}
              <div className="sticky bottom-0 z-10 -mx-6 flex items-center justify-between gap-2 border-t border-line bg-card px-6 py-4">
                <Button variant="ghost" icon={<ArrowLeft className={cx('size-4', flip)} />} onClick={() => setStep('plan')}>
                  {p.back}
                </Button>
                <Button type="submit" variant="brand" loading={request.isPending} disabled={!detailsReady} icon={<Receipt className="size-4" />}>
                  {p.submit}
                </Button>
              </div>
            </>
          )
        )}
      </form>
    </Modal>
  );
}
