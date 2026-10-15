import { enabledPaymentMethods, PAYMENT_MONTHS, type PaymentDetails, type PaymentMethod, type PaymentMonths, type PaymentSettings, planPriceEgp } from '@wa/shared/payments';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, Check, ImagePlus, Info, Loader2, Receipt } from 'lucide-react';
import { type DragEvent, type FormEvent, useRef, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../../api';
import { useI18n } from '../../i18n';
import type { PricedPlan } from '../../site/content';
import { Button, cx, ErrorNote, Field, flip, Modal, usePlanName } from '../../ui';
import { CopyLine, METHOD_LOOK, MethodGlyph, shrinkImage, usePaymentSettings } from './methods';

type Proof = { mimetype: 'image/jpeg'; data: string; previewUrl: string };

/** Months → total, as a row of choices. */
function MonthsPicker({ plan, value, onChange }: { plan: PricedPlan; value: PaymentMonths; onChange: (m: PaymentMonths) => void }) {
  const { t } = useI18n();
  const p = t.subscription.payment;
  return (
    <div role="radiogroup" aria-label={p.duration} className="grid grid-cols-4 gap-2">
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
              'flex flex-col items-center gap-0.5 rounded-xl border px-2 py-2.5 text-center transition-all',
              active ? 'border-brand bg-brand/10 shadow-[0_0_0_1px_var(--color-brand)]' : 'border-line hover:border-line-strong hover:bg-raised/40',
            )}
          >
            <span className={cx('text-sm font-semibold', active && 'text-brand')}>{p.months(m)}</span>
            <span className="ltr text-[11px] text-muted tabular-nums">{p.usd(plan.priceUsd * m)}</span>
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
  const look = METHOD_LOOK[method];
  return (
    <div className={cx('overflow-hidden rounded-xl border', look.ring)}>
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

export function RequestPlanModal({ plan, onClose, onSent, onNeedsPhone }: { plan: PricedPlan; onClose: () => void; onSent: () => void; onNeedsPhone: () => void }) {
  const { t } = useI18n();
  const s = t.subscription;
  const p = s.payment;
  const planName = usePlanName();
  const settings = usePaymentSettings();
  const methods = settings.data ? enabledPaymentMethods(settings.data) : [];
  const egpPerUsd = settings.data?.egpPerUsd ?? 0;

  const [months, setMonths] = useState<PaymentMonths>(1);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [step, setStep] = useState<'plan' | 'details'>('plan');
  const [fields, setFields] = useState({ senderPhone: '', sender: '', senderName: '', bankName: '', reference: '', amount: '' });
  const [proof, setProof] = useState<Proof | null>(null);
  const [note, setNote] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const totalUsd = plan.priceUsd * months;
  const totalEgp = planPriceEgp(plan.priceUsd, months, egpPerUsd);
  // No way to pay (nothing configured): the request goes without payment details, as before.
  const payable = methods.length > 0;

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
    if (request.isPending) return;
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

  return (
    <Modal title={s.modalTitle(planName(plan))} description={step === 'plan' ? undefined : p.steps.details} onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-5">
        {/* step indicator */}
        {payable && (
          <ol className="flex items-center gap-2 text-xs">
            {(['plan', 'details'] as const).map((k, i) => {
              const done = k === 'plan' && step === 'details';
              const active = k === step;
              return (
                <li key={k} className="flex items-center gap-2">
                  {i > 0 && <span className="h-px w-6 bg-line" />}
                  <span className={cx('flex size-5 items-center justify-center rounded-full text-[11px] font-semibold', active || done ? 'bg-brand text-on-brand' : 'bg-raised text-muted')}>
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
            {/* plan + total */}
            <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-gradient-to-br from-raised/40 to-transparent p-4">
              <div>
                <p className="text-base font-semibold">{planName(plan)}</p>
                <p className="ltr text-sm text-muted">{p.perMonth(p.usd(plan.priceUsd))}</p>
              </div>
              <div className="text-end">
                <p className="text-[11px] text-muted uppercase">{p.total}</p>
                <p className="ltr text-xl font-bold tabular-nums">{p.usd(totalUsd)}</p>
                {totalEgp !== null && egpPerUsd > 0 && <p className="text-xs text-brand tabular-nums">≈ {p.egp(totalEgp)}</p>}
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">{p.duration}</p>
              <MonthsPicker plan={plan} value={months} onChange={setMonths} />
            </div>

            {settings.isPending ? (
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
                {p.noMethods}
              </div>
            )}

            {!payable && !settings.isPending && <Field label={s.noteLabel} placeholder={s.notePlaceholder} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}
            <ErrorNote>{topError}</ErrorNote>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                {t.common.cancel}
              </Button>
              {payable ? (
                <Button variant="brand" disabled={!method} onClick={goDetails}>
                  {p.next}
                </Button>
              ) : (
                <Button type="submit" variant="brand" loading={request.isPending} disabled={settings.isPending}>
                  {s.submit}
                </Button>
              )}
            </div>
          </>
        ) : (
          method &&
          settings.data && (
            <>
              <ReceivingAccount method={method} settings={settings.data} />
              {settings.data.instructions && (
                <p className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200 light:text-amber-800">
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

              <div className="flex items-center justify-between gap-2">
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
