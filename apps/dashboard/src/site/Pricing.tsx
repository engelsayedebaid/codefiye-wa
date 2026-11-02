import { DEFAULT_PLAN_PRICING, discountPercent, offeredPlans } from '@wa/shared/plan-pricing';
import { BadgePercent, Check } from '../icons';
import type { ReactNode } from 'react';
import { usePlanPricing } from '../app/plan-pricing';
import { CurrencySwitch, useMoney } from '../currency';
import { useI18n } from '../i18n';
import { Link } from '../router';
import { buttonClass, cx, Reveal } from '../ui';
import { type PricedPlan } from './content';

/** One package, exactly as a customer sees it — shared by the pricing grids and the admin preview. */
export function PlanCard({ plan, current, action, embedded }: { plan: PricedPlan; current?: boolean; action?: ReactNode; embedded?: boolean }) {
  const { t } = useI18n();
  const { amount, format, money } = useMoney();
  const pct = discountPercent(plan.priceUsd, plan.compareAtUsd);
  const compare = pct !== null && plan.compareAtUsd !== null ? amount(plan.compareAtUsd) : null;
  const price = amount(plan.priceUsd);
  const priceText = format(price);
  return (
    <article
      className={cx(
        'site-card relative flex h-full flex-col rounded-2xl p-7 transition-colors duration-200',
        !embedded && 'hover:border-line-strong',
        plan.popular && 'border-brand/60 hover:border-brand/80',
      )}
    >
      {(plan.popular || current) && (
        <span
          className={cx(
            'absolute -top-3 left-1/2 -translate-x-1/2 rounded-full border px-3 py-0.5 text-xs font-semibold whitespace-nowrap',
            current ? 'border-info/50 bg-card text-info' : 'border-brand bg-brand text-on-brand',
          )}
        >
          {current ? t.plans.current : t.plans.popular}
        </span>
      )}
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-lg font-semibold">{plan.name}</h3>
        <span className="shrink-0 rounded-full border border-line px-2.5 py-0.5 text-xs font-medium text-muted">
          <span className="ltr font-mono">{money(plan.priceUsd / plan.sessions)}</span> {t.plans.perSession}
        </span>
      </div>
      {pct !== null && (
        <p className="mt-4 inline-flex w-fit items-center gap-1.5 rounded-full border border-warning/40 bg-warning/15 px-2.5 py-1 text-xs font-bold text-warning">
          <BadgePercent className="size-3.5" />
          {t.plans.off(pct)}
        </p>
      )}
      <p className={cx('flex flex-wrap items-baseline gap-x-2 gap-y-1', pct === null ? 'mt-5' : 'mt-3')}>
        {compare !== null && <span className="ltr text-xl font-semibold text-muted line-through decoration-2 decoration-warning/80 tabular-nums">{format(compare)}</span>}
        {/* Long amounts ("IDR 245,000") step down so they still fit a quarter-width card. */}
        <span className={cx('ltr leading-none font-semibold tracking-[-0.04em] tabular-nums', priceText.length > 11 ? 'text-3xl' : priceText.length > 8 ? 'text-4xl' : 'text-[2.75rem]')}>
          {priceText}
        </span>
        <span className="text-sm font-medium text-muted">{t.plans.perMonth}</span>
      </p>
      <p className="mt-1 text-xs text-faint">{compare !== null ? t.plans.save(format(compare - price)) : t.plans.billedMonthly}</p>
      <p className="mt-5 min-h-[4.25rem] text-sm leading-relaxed text-ink-2">{t.plans.blurbs[plan.id]}</p>
      <div className="my-6 h-px bg-line" />
      <ul className="flex-1 space-y-3.5">
        {t.plans.features(plan).map((f) => (
          <li key={f} className="flex items-start gap-3 text-sm">
            <span
              className={cx(
                'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full',
                plan.popular ? 'bg-brand/15 text-brand' : 'bg-ink/[0.07] text-ink-2',
              )}
            >
              <Check className="size-3" strokeWidth={3} />
            </span>
            {plan.id === 'business' && f === t.plans.chatsFeature ? (
              <div className="min-w-0">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {f}
                  <span className="rounded-full border border-brand/40 bg-brand/10 px-2 py-px text-[11px] leading-4 font-semibold text-brand">{t.plans.newBadge}</span>
                </span>
                <ul className="mt-2 space-y-1.5 border-s border-brand/30 ps-3">
                  {t.plans.chatsDetails.map((d) => (
                    <li key={d} className="text-xs leading-snug text-muted">
                      {d}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <span className="text-ink-2">{f}</span>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-8">
        {action ?? (
          <Link
            href="/register"
            className={buttonClass(
              plan.popular ? 'white' : 'outline',
              'lg',
              'h-11 w-full font-semibold',
            )}
          >
            {plan.popular ? t.plans.startNow : t.plans.choose}
          </Link>
        )}
      </div>
    </article>
  );
}

/** What the prices on the cards are in, and that payment is always in Egyptian pounds. */
function CurrencyNote() {
  const { t, lang, fmt } = useI18n();
  const c = t.currency;
  const { code, rates } = useMoney();
  if (code === 'EGP') return <p className="text-sm text-muted">{c.noteEgp}</p>;
  if (code === 'USD') return <p className="text-sm text-muted">{c.noteUsd}</p>;
  let name = code;
  try {
    name = new Intl.DisplayNames([lang], { type: 'currency' }).of(code) ?? code;
  } catch {
    // no Intl.DisplayNames
  }
  return (
    <p className="text-sm text-muted">
      {c.noteOther(name, rates.updatedAt ? fmt.date(rates.updatedAt) : null)}{' '}
      <a href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer" className="text-xs text-faint underline-offset-4 hover:text-ink-2 hover:underline">
        {c.ratesBy}
      </a>
    </p>
  );
}

/** The four plan cards — shared by the landing page and the dashboard's subscription page. */
export function PlanCards({ currentPlanId, action }: { currentPlanId?: string; action?: (plan: PricedPlan) => ReactNode }) {
  const pricing = usePlanPricing();
  const plans = offeredPlans(pricing.data ?? DEFAULT_PLAN_PRICING);
  return (
    <div>
      <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-center">
        <CurrencySwitch withLabel align="start" className="shrink-0" />
        <CurrencyNote />
      </div>
      <div className="grid items-stretch gap-6 md:grid-cols-2 xl:grid-cols-4">
        {plans.map((plan, i) => (
          <Reveal key={plan.id} delay={i * 90} className="h-full">
            <PlanCard plan={plan} current={plan.id === currentPlanId} action={action?.(plan)} />
          </Reveal>
        ))}
      </div>
    </div>
  );
}
