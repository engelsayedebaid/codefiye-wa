import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Link } from '../router';
import { buttonClass, cx, Reveal } from '../ui';
import { type PricedPlan, PRICED_PLANS } from './content';

/** The four plan cards — shared by the landing page and the dashboard's subscription page. */
export function PlanCards({ currentPlanId, action }: { currentPlanId?: string; action?: (plan: PricedPlan) => ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="grid items-stretch gap-6 md:grid-cols-2 xl:grid-cols-4">
      {PRICED_PLANS.map((plan, i) => {
        const current = plan.id === currentPlanId;
        return (
          <Reveal key={plan.id} delay={i * 90} className="h-full">
            <article
              className={cx(
                'lift card-luxury relative flex h-full flex-col rounded-3xl border p-7',
                plan.popular
                  ? 'border-brand/60 bg-gradient-to-b from-brand/[0.08] via-card to-card shadow-[0_24px_70px_-25px_rgba(36,211,102,0.4)] xl:-mt-4'
                  : 'border-line',
              )}
            >
              {(plan.popular || current) && (
                <span
                  className={cx(
                    'absolute -top-3.5 left-1/2 -translate-x-1/2 rounded-full border px-3.5 py-1 text-xs font-bold whitespace-nowrap shadow-sm backdrop-blur-md',
                    current ? 'border-info/50 bg-info/15 text-info' : 'border-brand/60 bg-brand text-on-brand',
                  )}
                >
                  {current ? t.plans.current : t.plans.popular}
                </span>
              )}
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xl font-bold tracking-tight">{plan.name}</h3>
                <span className="rounded-full border border-line bg-ink/[0.03] px-2.5 py-0.5 font-mono text-xs font-medium text-muted">
                  <span className="ltr">${(plan.priceUsd / plan.sessions).toFixed(2)}</span> {t.plans.perSession}
                </span>
              </div>
              <p className="mt-5 flex items-baseline gap-1.5">
                <span className="ltr text-5xl font-bold tracking-tight tabular-nums">${plan.priceUsd}</span>
                <span className="text-sm font-medium text-muted">{t.plans.perMonth}</span>
              </p>
              <p className="mt-1 text-xs text-faint">{t.plans.billedMonthly}</p>
              <p className="mt-5 min-h-[4.25rem] text-sm leading-relaxed text-ink-2">{t.plans.blurbs[plan.id]}</p>
              <div className="my-6 h-px bg-gradient-to-r from-transparent via-line-strong to-transparent" />
              <ul className="flex-1 space-y-3.5">
                {t.plans.features(plan).map((f) => (
                  <li key={f} className="flex items-start gap-3 text-sm">
                    <span
                      className={cx(
                        'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full',
                        plan.popular ? 'bg-brand/15 text-brand' : 'border border-line-strong bg-ink/[0.03] text-ink-2',
                      )}
                    >
                      <Check className="size-3" strokeWidth={3} />
                    </span>
                    {plan.id === 'business' && f === t.plans.chatsFeature ? (
                      <div className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2 font-medium">
                          {f}
                          <span className="rounded-full border border-brand/40 bg-brand/10 px-2 py-px text-[11px] leading-4 font-semibold text-brand">
                            {t.plans.newBadge}
                          </span>
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
                {action ? (
                  action(plan)
                ) : (
                  <Link
                    href="/register"
                    className={buttonClass(
                      plan.popular ? 'brand' : 'outline',
                      'lg',
                      cx('h-12 w-full rounded-xl font-semibold', plan.popular && 'shine bg-gradient-to-r from-brand to-teal text-on-brand'),
                    )}
                  >
                    {plan.popular ? t.plans.startNow : t.plans.choose}
                  </Link>
                )}
              </div>
            </article>
          </Reveal>
        );
      })}
    </div>
  );
}
