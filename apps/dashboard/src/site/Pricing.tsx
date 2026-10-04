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
    <div className="grid items-start gap-6 md:grid-cols-2 xl:grid-cols-4">
      {PRICED_PLANS.map((plan, i) => {
        const current = plan.id === currentPlanId;
        return (
          <Reveal key={plan.id} delay={i * 90} className="h-full">
            <article
              className={cx(
                'lift relative flex h-full flex-col rounded-3xl border bg-card p-6',
                plan.popular ? 'border-brand/60 shadow-[0_0_60px_-25px_rgba(36,211,102,0.6)] xl:-mt-4' : 'border-line',
              )}
            >
              {(plan.popular || current) && (
                <span
                  className={cx(
                    'absolute -top-3 left-1/2 -translate-x-1/2 rounded-full border px-3 py-0.5 text-xs font-bold whitespace-nowrap',
                    current ? 'border-sky-400/50 bg-sky-500/15 text-sky-300' : 'animate-glow border-brand/60 bg-brand/15 text-brand',
                  )}
                >
                  {current ? t.plans.current : t.plans.popular}
                </span>
              )}
              <h3 className="text-xl font-semibold">{plan.name}</h3>
              <p className="mt-4 flex items-baseline gap-1.5">
                <span className="ltr text-5xl font-bold tracking-tight">${plan.priceUsd}</span>
                <span className="text-muted">{t.plans.perMonth}</span>
              </p>
              <p className="mt-1 text-sm text-faint">{t.plans.billedMonthly}</p>
              <p className="mt-6 min-h-[4.5rem] text-[15px] leading-relaxed text-ink-2">{t.plans.blurbs[plan.id]}</p>
              <hr className="my-6 border-line" />
              <ul className="flex-1 space-y-3.5">
                {t.plans.features(plan).map((f) => (
                  <li key={f} className="flex items-start gap-3 text-[15px]">
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-line-strong">
                      <Check className="size-3 text-ink-2" strokeWidth={3} />
                    </span>
                    {plan.id === 'business' && f === t.plans.chatsFeature ? (
                      <div className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          {f}
                          <span className="rounded-full border border-brand/40 bg-brand/10 px-2 py-px text-[11px] leading-4 font-semibold text-brand">
                            {t.plans.newBadge}
                          </span>
                        </span>
                        <ul className="mt-2 space-y-1.5 border-s border-line ps-3">
                          {t.plans.chatsDetails.map((d) => (
                            <li key={d} className="text-[13px] leading-snug text-muted">
                              {d}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      f
                    )}
                  </li>
                ))}
              </ul>
              <div className="mt-8">
                {action ? (
                  action(plan)
                ) : (
                  <Link href="/register" className={buttonClass(plan.popular ? 'brand' : 'outline', 'lg', 'w-full')}>
                    {plan.popular ? t.plans.startNow : t.plans.choose}
                  </Link>
                )}
                <p className="mt-3 text-center text-sm text-faint">
                  <span className="ltr">${(plan.priceUsd / plan.sessions).toFixed(2)}</span> {t.plans.perSession}
                </p>
              </div>
            </article>
          </Reveal>
        );
      })}
    </div>
  );
}
