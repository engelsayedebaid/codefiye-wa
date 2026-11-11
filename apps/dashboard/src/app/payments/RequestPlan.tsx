import './checkout.css';
import { discountPercent } from '@wa/shared/plan-pricing';
import {
  enabledPaymentMethods,
  PAYMENT_MONTHS,
  type PaymentDetails,
  type PaymentMethod,
  type PaymentMonths,
  type PaymentSettings,
  planPriceEgp,
} from '@wa/shared/payments';
import { useMutation } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Crown,
  ImagePlus,
  Info,
  Loader2,
  Lock,
  Receipt,
  ShieldCheck,
} from '../../icons';
import {
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { api, ApiRequestError, errorMessage } from '../../api';
import { useCurrencyRates } from '../../currency';
import { useI18n } from '../../i18n';
import type { PricedPlan } from '../../site/content';
import { Button, cx, ErrorNote, Field, flip, LangSwitch, Logo, ThemeSwitch, usePlanName } from '../../ui';
import { CopyLine, METHOD_LOOK, MethodGlyph, shrinkImage, usePaymentSettings } from './methods';
import { CheckoutFrame, type OpenedCheckout, useKashierConfig } from './OnlineCheckout';
import { CheckoutSubmitButton, OnlinePaymentPanel } from './OnlinePay';
import { PaymentSecurityFooter, RateLine } from './Trust';

type Proof = { mimetype: 'image/jpeg'; data: string; previewUrl: string };

/** A USD price as the customer pays it: in Egyptian pounds at the rate charged today, else in dollars. */
function usePayPrice(egpPerUsd: number) {
  const { t } = useI18n();
  const p = t.subscription.payment;
  return (usd: number, months = 1) => (egpPerUsd > 0 ? p.egp(planPriceEgp(usd, months, egpPerUsd)!) : p.usd(usd * months));
}

/**
 * Minimal enterprise checkout header: back navigation, secure-payment badge, Help Center link,
 * language & theme switchers, and CodeFiye brand mark.
 */
export function CheckoutHeader({ test, onClose }: { test: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const o = t.subscription.payment.online;
  return (
    <header className="checkout-header shrink-0">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-2 px-3.5 py-2.5 sm:gap-4 sm:px-6 sm:py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:gap-3">
          <button
            type="button"
            onClick={onClose}
            aria-label={o.backToPlans}
            className="inline-flex h-8.5 items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 text-xs font-semibold text-ink-2 transition-colors hover:bg-raised hover:text-ink"
          >
            <ArrowLeft className={cx('size-3.5 shrink-0', flip)} />
            <span className="hidden sm:inline">{o.backToPlans}</span>
          </button>

          <span className="hidden items-center gap-1.5 text-xs font-semibold text-ink-2 md:inline-flex">
            <Lock className="size-3.5 shrink-0 text-[var(--co-accent-ink)]" />
            <span>{o.headerSecure}</span>
          </span>

          <a
            href="/contact"
            target="_blank"
            rel="noreferrer"
            className="hidden items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-muted transition-colors hover:bg-raised hover:text-ink sm:inline-flex"
          >
            <CircleHelp className="size-3.5 shrink-0" />
            <span>{o.helpCenter}</span>
          </a>

          <LangSwitch className="h-8.5 rounded-full border border-line bg-card px-2.5 text-xs" />
          <ThemeSwitch />

          {test && (
            <span className="rounded-full bg-warning/15 px-2.5 py-0.5 text-[10px] font-bold tracking-wide text-warning uppercase">
              {o.testBadge}
            </span>
          )}
        </div>

        <Logo markClassName="size-7" />
      </div>
    </header>
  );
}

/**
 * Three-step checkout progress indicator:
 * 1. Choose Plan (completed) -> 2. Payment (active) -> 3. Account Activation (upcoming or active during verification).
 */
export function CheckoutProgress({ activating = false }: { activating?: boolean }) {
  const { t } = useI18n();
  const o = t.subscription.payment.online;
  const steps: { key: string; label: string; state: 'done' | 'active' | 'upcoming' }[] = [
    { key: 'plan', label: o.progress.choosePlan, state: 'done' },
    { key: 'payment', label: o.progress.payment, state: activating ? 'done' : 'active' },
    { key: 'activation', label: o.progress.activation, state: activating ? 'active' : 'upcoming' },
  ];

  return (
    <nav aria-label={o.progressLabel} className="w-full">
      <ol className="flex items-center justify-between gap-2 sm:gap-3">
        {steps.map((s, idx) => {
          const isDone = s.state === 'done';
          const isActive = s.state === 'active';
          return (
            <li key={s.key} className={cx('flex items-center gap-2 sm:gap-2.5', idx < steps.length - 1 && 'flex-1')}>
              <span className="flex shrink-0 items-center gap-1.5 sm:gap-2">
                <span
                  aria-current={isActive ? 'step' : undefined}
                  className={cx(
                    'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-colors sm:size-6.5',
                    isDone || isActive
                      ? 'bg-brand text-on-brand shadow-xs'
                      : 'bg-[var(--co-elevated)] text-muted',
                  )}
                >
                  {isDone ? <Check className="size-3.5" strokeWidth={2.75} /> : idx + 1}
                </span>
                <span
                  className={cx(
                    'text-xs whitespace-nowrap transition-colors sm:text-[13px]',
                    isActive ? 'font-bold text-ink' : isDone ? 'font-semibold text-ink-2' : 'font-medium text-muted',
                  )}
                >
                  {s.label}
                </span>
              </span>
              {idx < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className={cx(
                    'h-0.5 min-w-4 flex-1 rounded-full transition-colors',
                    isDone ? 'bg-brand' : 'bg-line',
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Segmented billing-duration selector (1, 3, 6, 12 months) with dynamic pricing, compare-at strikethrough,
 * active badge, and keyboard arrow navigation.
 */
export function BillingPeriodSelector({
  plan,
  egpPerUsd,
  value,
  onChange,
  disabled = false,
}: {
  plan: PricedPlan;
  egpPerUsd: number;
  value: PaymentMonths;
  onChange: (m: PaymentMonths) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const p = t.subscription.payment;
  const price = usePayPrice(egpPerUsd);
  const compare = discountPercent(plan.priceUsd, plan.compareAtUsd) !== null ? plan.compareAtUsd : null;
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const idx = PAYMENT_MONTHS.indexOf(value);
    if (idx < 0) return;
    let nextIdx = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      nextIdx = (idx + 1) % PAYMENT_MONTHS.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      nextIdx = (idx - 1 + PAYMENT_MONTHS.length) % PAYMENT_MONTHS.length;
    }
    if (nextIdx >= 0) {
      e.preventDefault();
      const nextMonth = PAYMENT_MONTHS[nextIdx]!;
      onChange(nextMonth);
      btnRefs.current[nextIdx]?.focus();
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-bold text-ink">{p.duration}</span>
      </div>
      <div
        role="radiogroup"
        aria-label={p.duration}
        onKeyDown={onKeyDown}
        className="grid grid-cols-2 gap-2.5 sm:grid-cols-4"
      >
        {PAYMENT_MONTHS.map((m, i) => {
          const active = m === value;
          return (
            <button
              key={m}
              ref={(el) => {
                btnRefs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange(m)}
              className={cx(
                'relative flex min-w-0 flex-col items-center justify-center gap-1 rounded-xl border px-2.5 py-2.5 text-center transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-[var(--co-accent-ink)] disabled:cursor-not-allowed disabled:opacity-55',
                active
                  ? 'border-[var(--co-accent-ink)] bg-[var(--co-accent-soft)] shadow-[0_0_0_1px_var(--co-accent-ink)]'
                  : 'border-line bg-card hover:border-line-strong hover:bg-raised/40',
              )}
            >
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute start-2 top-2 flex size-4 items-center justify-center rounded-full bg-brand text-on-brand"
                >
                  <Check className="size-2.5" strokeWidth={3} />
                </span>
              )}
              <span className={cx('text-xs font-bold sm:text-[13px]', active ? 'text-[var(--co-accent-ink)]' : 'text-ink')}>
                {p.months(m)}
              </span>
              <span className="ltr flex flex-wrap items-center justify-center gap-1 text-[11px] font-semibold text-muted tabular-nums">
                {compare !== null && <span className="line-through opacity-65">{price(compare, m)}</span>}
                <span className={cx(active && 'text-ink')}>{price(plan.priceUsd, m)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Deep indigo Subscription Summary card matching the reference design:
 * Crown icon badge, dynamic plan name & blurb, collapsible/responsive plan features list,
 * original price, discount calculation, dynamic total due in EGP, exchange rate, and 100% SSL badge.
 */
export function SubscriptionSummary({
  plan,
  months,
  egpPerUsd,
}: {
  plan: PricedPlan;
  months: PaymentMonths;
  egpPerUsd: number;
}) {
  const { t } = useI18n();
  const s = t.subscription;
  const p = s.payment;
  const o = p.online;
  const planName = usePlanName();
  const price = usePayPrice(egpPerUsd);
  const [featuresOpen, setFeaturesOpen] = useState(false);

  const features = t.plans.features(plan);
  const off = discountPercent(plan.priceUsd, plan.compareAtUsd);
  const compare = off !== null ? plan.compareAtUsd : null;

  const totalUsd = plan.priceUsd * months;
  const totalEgp = planPriceEgp(plan.priceUsd, months, egpPerUsd);
  const compareEgp = compare !== null ? planPriceEgp(compare, months, egpPerUsd) : null;
  const inEgp = totalEgp !== null && egpPerUsd > 0;

  const totalLabel = inEgp ? p.egp(totalEgp) : p.usd(totalUsd);
  const baseLabel = compare !== null ? price(compare, months) : price(plan.priceUsd, months);
  const savingsLabel =
    compare !== null
      ? inEgp && compareEgp !== null
        ? p.egp(Math.max(0, compareEgp - totalEgp))
        : p.usd(Math.max(0, (compare - plan.priceUsd) * months))
      : null;

  return (
    <section aria-label={o.summary} className="checkout-summary-card p-5 sm:p-6 lg:p-7">
      {/* Subtle decorative wave at bottom-end, inspired by the reference card */}
      <svg
        viewBox="0 0 360 120"
        fill="none"
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-28 w-full object-cover opacity-55"
        preserveAspectRatio="none"
      >
        <path
          d="M0 72C68 30 135 110 218 68C278 38 322 52 360 88V120H0V72Z"
          fill="url(#co-wave-grad)"
        />
        <defs>
          <linearGradient id="co-wave-grad" x1="0" y1="0" x2="360" y2="120" gradientUnits="userSpaceOnUse">
            <stop stopColor="#25D366" stopOpacity="0.45" />
            <stop offset="1" stopColor="#087548" stopOpacity="0.12" />
          </linearGradient>
        </defs>
      </svg>

      <div className="space-y-5 lg:space-y-6">
        {/* Plan header with Crown badge */}
        <div className="flex items-center justify-between gap-3.5">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-extrabold tracking-tight text-white sm:text-2xl">
              {s.planTitle(planName(plan))}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-white/75 sm:text-[13px]">
              {t.plans.blurbs[plan.id]}
            </p>
          </div>
          <span className="flex size-13 shrink-0 items-center justify-center rounded-2xl border border-white/15 bg-[#124d34]/75 text-[#3dd68c] shadow-inner sm:size-14">
            <Crown className="size-6 sm:size-7" />
          </span>
        </div>

        {/* Mobile toggle to expand/collapse plan benefits */}
        <div className="lg:hidden">
          <button
            type="button"
            onClick={() => setFeaturesOpen((v) => !v)}
            aria-expanded={featuresOpen}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/8 px-3 py-1.5 text-xs font-semibold text-white/90 transition-colors hover:bg-white/12"
          >
            <span>{featuresOpen ? o.hideFeatures : o.showFeatures(features.length)}</span>
            {featuresOpen ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </button>
        </div>

        {/* Plan benefits list */}
        <ul className={cx('space-y-2.5 text-xs sm:text-[13px]', featuresOpen ? 'grid' : 'hidden lg:grid')}>
          {features.map((feat) => (
            <li key={feat} className="flex items-center gap-2.5 text-white/90">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[#25D366]/20 text-[#3dd68c] ring-1 ring-[#25D366]/30">
                <Check className="size-3" strokeWidth={2.75} />
              </span>
              <span className="min-w-0 flex-1 leading-snug">{feat}</span>
            </li>
          ))}
        </ul>

        {/* Pricing breakdown */}
        <div className="space-y-3 border-t border-white/12 pt-4 lg:pt-5">
          <div className="flex items-center justify-between gap-3 text-xs sm:text-sm">
            <span className="text-white/75">{months === 1 ? o.monthlyPrice : o.basePrice}</span>
            <span
              className={cx(
                'ltr font-semibold tabular-nums',
                compare !== null ? 'text-white/55 line-through' : 'text-white/90',
              )}
            >
              {baseLabel}
            </span>
          </div>

          {off !== null && savingsLabel !== null && (
            <div className="flex items-center justify-between gap-3 text-xs sm:text-sm">
              <span className="font-semibold text-[#3dd68c]">{o.specialDiscount(off)}</span>
              <span className="ltr font-bold text-[#3dd68c] tabular-nums">- {savingsLabel}</span>
            </div>
          )}

          {months > 1 && (
            <div className="flex items-center justify-between gap-3 text-xs sm:text-sm">
              <span className="text-white/75">{p.duration}</span>
              <span className="font-semibold text-white/90">{p.months(months)}</span>
            </div>
          )}

          {/* Total payable highlight box */}
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/25 px-4 py-3.5 shadow-inner">
            <div className="min-w-0">
              <span className="block text-sm font-bold text-white">{o.totalRequired}</span>
              <span className="block text-[11px] text-white/60">{p.months(months)}</span>
            </div>
            <div className="shrink-0 text-end">
              <span className="ltr block text-2xl font-extrabold tracking-tight text-white tabular-nums sm:text-[26px]">
                {plan.priceUsd === 0 ? p.usd(0) : totalLabel}
              </span>
              {inEgp && plan.priceUsd > 0 && (
                <span className="ltr block text-[11px] text-white/60 tabular-nums">{p.usd(totalUsd)}</span>
              )}
            </div>
          </div>

          {inEgp && plan.priceUsd > 0 && <RateLine className="px-1 pt-0.5" />}
        </div>

        {/* 100% Secure SSL footer inside summary card */}
        <div className="flex items-center gap-3 border-t border-white/12 pt-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/10 text-[#3dd68c]">
            <ShieldCheck className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold text-white sm:text-[13px]">{o.secureBadgeTitle}</p>
            <p className="mt-0.5 text-[11px] leading-snug text-white/70">{o.secureBadgeText}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function MethodPicker({
  methods,
  value,
  onChange,
}: {
  methods: PaymentMethod[];
  value: PaymentMethod | null;
  onChange: (m: PaymentMethod) => void;
}) {
  const { t } = useI18n();
  const p = t.subscription.payment;
  return (
    <div role="radiogroup" aria-label={p.chooseMethod} className="grid gap-2.5 sm:grid-cols-3">
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

/** The full-screen shell of the checkout: minimal header + centered max-w-6xl two-column workspace. */
function OnlinePayScreen({
  title,
  test,
  onClose,
  children,
}: {
  title: string;
  test: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const screenRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    screenRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab') return;
      const focusable = Array.from(
        screenRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), iframe, [tabindex="0"]',
        ) ?? [],
      ).filter((el) => el.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (e.shiftKey && (document.activeElement === first || document.activeElement === screenRef.current)) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus({ preventScroll: true });
    };
  }, [onClose]);

  return (
    <div
      ref={screenRef}
      tabIndex={-1}
      role="dialog"
      aria-modal
      aria-label={title}
      className="checkout-stage animate-fade-in fixed inset-0 z-50 flex flex-col outline-none"
    >
      <CheckoutHeader test={test} onClose={onClose} />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-3.5 py-4 sm:px-6 sm:py-7 lg:py-10">{children}</div>
      </main>
    </div>
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
  const o = p.online;
  const planName = usePlanName();
  const settings = usePaymentSettings();
  const rates = useCurrencyRates();
  const methods = settings.data ? enabledPaymentMethods(settings.data) : [];
  // The rate every price here is worked out at: today's market rate, never below the platform's floor (the server charges at the same one).
  const egpPerUsd = rates.data?.egp.effective ?? 0;

  const [months, setMonths] = useState<PaymentMonths>(1);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [step, setStep] = useState<'plan' | 'details'>('plan');
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
  const [paymentLocked, setPaymentLocked] = useState(false);

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
    return {
      method,
      senderName: fields.senderName.trim(),
      ...(fields.bankName.trim() ? { bankName: fields.bankName.trim() } : {}),
      ...(fields.reference.trim() ? { reference: fields.reference.trim() } : {}),
      ...base,
    };
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

  const topError =
    request.error instanceof ApiRequestError && request.error.code === 'duplicate_request'
      ? s.duplicate
      : request.isError && !Object.keys(fieldErrors).length
        ? errorMessage(request.error)
        : null;
  const err = (key: string) => fieldErrors[key] ?? fieldErrors[`payment.${key}`];
  const detailsReady =
    proof !== null &&
    ((method === 'vodafone_cash' && fields.senderPhone.trim().length >= 11) ||
      (method === 'instapay' && fields.sender.trim().length >= 3) ||
      (method === 'bank_transfer' && fields.senderName.trim().length >= 2));

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

  return (
    <OnlinePayScreen title={s.modalTitle(planName(plan))} test={kashier.data?.mode === 'test'} onClose={onClose}>
      <div className="checkout-grid">
        {/* Main Payment Card: right side in RTL, left side in LTR on desktop */}
        <section className="checkout-main-card min-w-0 space-y-6 p-4 sm:p-6 lg:p-8">
          <CheckoutProgress activating={paymentLocked || request.isPending} />

          <div className="space-y-1 border-b border-line pb-4">
            <h1 className="text-xl font-extrabold tracking-tight text-ink sm:text-2xl">{o.frameTitle}</h1>
            <p className="text-xs text-muted sm:text-sm">{o.subtitle(planName(plan))}</p>
          </div>

          {online && totalEgp !== null ? (
            <>
              <BillingPeriodSelector
                plan={plan}
                egpPerUsd={egpPerUsd}
                value={months}
                onChange={setMonths}
                disabled={paymentLocked}
              />

              {loadingMethods ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="size-5 animate-spin text-brand" />
                </div>
              ) : (
                <OnlinePaymentPanel
                  methods={kashierMethods}
                  planId={plan.id}
                  months={months}
                  amountLabel={p.egp(totalEgp)}
                  test={kashier.data?.mode === 'test'}
                  onNeedsPhone={onNeedsPhone}
                  onDone={onPaid}
                  onOpened={setCheckout}
                  onLockedChange={setPaymentLocked}
                />
              )}

              <PaymentSecurityFooter showKashier />
            </>
          ) : (
            <form onSubmit={submit} className="space-y-5">
              {step === 'plan' ? (
                <>
                  <BillingPeriodSelector
                    plan={plan}
                    egpPerUsd={egpPerUsd}
                    value={months}
                    onChange={setMonths}
                    disabled={request.isPending}
                  />

                  {loadingMethods ? (
                    <div className="flex justify-center py-6">
                      <Loader2 className="size-5 animate-spin text-brand" />
                    </div>
                  ) : payable ? (
                    <div className="space-y-2.5">
                      <p className="text-sm font-bold text-ink">{p.chooseMethod}</p>
                      <MethodPicker methods={methods} value={method} onChange={setMethod} />
                      {egpPerUsd > 0 && <p className="text-xs text-muted">{p.approx}</p>}
                    </div>
                  ) : (
                    <div className="flex items-start gap-3 rounded-xl border border-line bg-raised/20 p-3.5 text-sm text-ink-2">
                      <Info className="mt-0.5 size-4 shrink-0 text-muted" />
                      {free ? p.free : p.noMethods}
                    </div>
                  )}

                  {!payable && !loadingMethods && (
                    <Field
                      label={s.noteLabel}
                      placeholder={s.notePlaceholder}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      maxLength={500}
                    />
                  )}

                  <ErrorNote>{topError}</ErrorNote>

                  <div className="pt-2">
                    {payable ? (
                      <CheckoutSubmitButton
                        type="button"
                        disabled={!method}
                        onClick={goDetails}
                        label={`${p.next} — ${totalEgp !== null && egpPerUsd > 0 ? p.egp(totalEgp) : p.usd(totalUsd)}`}
                      />
                    ) : (
                      <CheckoutSubmitButton
                        type="submit"
                        loading={request.isPending}
                        disabled={loadingMethods}
                        label={s.submit}
                      />
                    )}
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
                        <Field
                          label={p.fields.senderPhone}
                          value={fields.senderPhone}
                          onChange={(e) => setFields({ ...fields, senderPhone: e.target.value })}
                          inputMode="tel"
                          dir="ltr"
                          placeholder="01xxxxxxxxx"
                          required
                          autoFocus
                          error={err('senderPhone')}
                        />
                      )}
                      {method === 'instapay' && (
                        <Field
                          label={p.fields.sender}
                          value={fields.sender}
                          onChange={(e) => setFields({ ...fields, sender: e.target.value })}
                          dir="ltr"
                          placeholder="name@instapay"
                          required
                          autoFocus
                          error={err('sender')}
                        />
                      )}
                      {method === 'bank_transfer' && (
                        <>
                          <Field
                            label={p.fields.senderName}
                            value={fields.senderName}
                            onChange={(e) => setFields({ ...fields, senderName: e.target.value })}
                            required
                            autoFocus
                            error={err('senderName')}
                          />
                          <Field
                            label={p.fields.bankName}
                            value={fields.bankName}
                            onChange={(e) => setFields({ ...fields, bankName: e.target.value })}
                            error={err('bankName')}
                          />
                          <Field
                            label={p.fields.reference}
                            value={fields.reference}
                            onChange={(e) => setFields({ ...fields, reference: e.target.value })}
                            dir="ltr"
                            error={err('reference')}
                          />
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
                    <Field
                      label={s.noteLabel}
                      placeholder={s.notePlaceholder}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      maxLength={500}
                    />
                    <ErrorNote>{topError}</ErrorNote>

                    <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                      <Button variant="ghost" icon={<ArrowLeft className={cx('size-4', flip)} />} onClick={() => setStep('plan')}>
                        {p.back}
                      </Button>
                      <div className="min-w-[12rem] flex-1 sm:flex-none">
                        <CheckoutSubmitButton
                          type="submit"
                          loading={request.isPending}
                          disabled={!detailsReady}
                          icon={<Receipt className="size-4.5" />}
                          label={p.submit}
                        />
                      </div>
                    </div>
                  </>
                )
              )}

              <PaymentSecurityFooter showKashier={false} />
            </form>
          )}
        </section>

        {/* Subscription Summary Card: left side in RTL, right side in LTR on desktop; top on mobile */}
        <aside className="order-first min-w-0 lg:order-none lg:sticky lg:top-6">
          <SubscriptionSummary plan={plan} months={months} egpPerUsd={egpPerUsd} />
        </aside>
      </div>
    </OnlinePayScreen>
  );
}
