import {
  applyQuickDiscount,
  clearQuickDiscount,
  CUSTOMER_PLAN_IDS,
  DEFAULT_PLAN_PRICING,
  discountPercent,
  offerProblem,
  offeredPlans,
  preparePlanPricing,
  QUICK_DISCOUNT_PERCENTS,
  type CustomerPlanId,
  type PlanOffer,
  type PlanPricing,
} from '@wa/shared/plan-pricing';
import { PLANS } from '@wa/shared/plans';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BadgePercent, Eye } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, errorMessage } from '../api';
import { usePlanPricing } from '../app/plan-pricing';
import { useI18n } from '../i18n';
import { qk } from '../queries';
import { PlanCard } from '../site/Pricing';
import { Button, buttonClass, cx, ErrorNote, Field, Loading, LoadError, Modal, SuccessNote, usePlanName } from '../ui';

function PercentChoices({ active, onPick, label }: { active: number | null; onPick: (percent: number) => void; label: (percent: number) => string }) {
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {QUICK_DISCOUNT_PERCENTS.map((n) => {
        const on = active === n;
        return (
          <button
            key={n}
            type="button"
            aria-pressed={on}
            onClick={() => onPick(n)}
            className={cx(
              'h-8 rounded-full border px-2.5 text-xs font-bold tabular-nums transition-colors',
              on ? 'border-warning/50 bg-warning/15 text-warning' : 'border-line bg-card text-muted hover:border-line-strong hover:text-ink',
            )}
          >
            {label(n)}
          </button>
        );
      })}
    </div>
  );
}

/** Prices and the customer card for each package, edited together and previewed before they go live. */
export function PlanPricingSettings() {
  const { t } = useI18n();
  const a = t.admin.pricing;
  const planName = usePlanName();
  const queryClient = useQueryClient();
  const settings = usePlanPricing();
  const [draft, setDraft] = useState<PlanPricing | null>(null);
  const [preview, setPreview] = useState<CustomerPlanId | null>(null);
  const [saved, setSaved] = useState(false);
  const current = draft ?? settings.data ?? DEFAULT_PLAN_PRICING;
  const prepared = preparePlanPricing(current);
  const dirty =
    draft !== null &&
    settings.data != null &&
    (prepared.highlight !== settings.data.highlight ||
      CUSTOMER_PLAN_IDS.some((id) => prepared.plans[id].priceUsd !== settings.data?.plans[id].priceUsd || prepared.plans[id].compareAtUsd !== settings.data?.plans[id].compareAtUsd));
  const invalid = CUSTOMER_PLAN_IDS.some((id) => offerProblem(current.plans[id]) !== null);

  const save = useMutation({
    mutationFn: () => api<PlanPricing>('/api/admin/plan-pricing', { method: 'PUT', body: prepared }),
    onSuccess: (next) => {
      queryClient.setQueryData(qk.planPricing, next);
      setDraft(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  const patch = (id: CustomerPlanId, offer: Partial<PlanOffer>) => setDraft({ ...current, plans: { ...current.plans, [id]: { ...current.plans[id], ...offer } } });

  const applyPercent = (ids: readonly CustomerPlanId[], percent: number) => {
    const on = ids.every((id) => discountPercent(current.plans[id].priceUsd, current.plans[id].compareAtUsd) === percent);
    const plans = { ...current.plans };
    for (const id of ids) {
      plans[id] = on ? clearQuickDiscount(current.plans[id], PLANS[id].priceUsd) : applyQuickDiscount(current.plans[id], percent, PLANS[id].priceUsd);
    }
    setDraft({ ...current, plans });
  };

  if (settings.isError) return <LoadError error={settings.error} onRetry={() => void settings.refetch()} retrying={settings.isFetching} />;
  if (!settings.data) return <Loading />;

  const previewPlan = preview ? offeredPlans({ ...current, highlight: current.highlight }).find((p) => p.id === preview) : null;

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!save.isPending && dirty && !invalid) save.mutate();
      }}
      className="space-y-5"
    >
      <div>
        <h2 className="text-lg font-semibold">{a.title}</h2>
        <p className="max-w-2xl text-sm text-muted">{a.text}</p>
      </div>

      <div className="rounded-xl border border-line bg-card p-4">
        <p className="text-sm font-semibold">{a.quick}</p>
        <p className="mt-1 max-w-2xl text-xs text-muted">{a.quickHint}</p>
        <PercentChoices
          active={QUICK_DISCOUNT_PERCENTS.find((n) => CUSTOMER_PLAN_IDS.every((id) => discountPercent(current.plans[id].priceUsd, current.plans[id].compareAtUsd) === n)) ?? null}
          onPick={(n) => applyPercent(CUSTOMER_PLAN_IDS, n)}
          label={(n) => a.percent(n)}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {CUSTOMER_PLAN_IDS.map((id) => {
          const offer = current.plans[id];
          const plan = PLANS[id];
          const problem = offerProblem(offer);
          const pct = problem === null ? discountPercent(offer.priceUsd, offer.compareAtUsd) : null;
          const highlighted = current.highlight === id;
          return (
            <article key={id} className={cx('flex flex-col rounded-2xl border bg-card p-4', highlighted ? 'border-brand/50' : 'border-line')}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold tracking-tight">{planName(plan)}</h3>
                  <p className="text-xs text-muted">{a.sessions(plan.sessions)}</p>
                  <p className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    {pct !== null && offer.compareAtUsd !== null && (
                      <span className="ltr text-lg font-semibold text-muted line-through decoration-2 decoration-warning/80 tabular-nums">{t.plans.usd(offer.compareAtUsd)}</span>
                    )}
                    <span className="ltr text-3xl font-bold tracking-tight tabular-nums">{problem === 'price' ? '—' : t.plans.usd(offer.priceUsd)}</span>
                    <span className="text-xs font-medium text-muted">{t.plans.perMonth}</span>
                  </p>
                </div>
                {pct !== null && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/40 bg-warning/15 px-2.5 py-1 text-xs font-bold text-warning">
                    <BadgePercent className="size-3.5" />
                    {t.plans.off(pct)}
                  </span>
                )}
              </div>

              <button
                type="button"
                aria-pressed={highlighted}
                onClick={() => setDraft({ ...current, highlight: highlighted ? null : id })}
                className={cx(
                  'mt-3 w-fit rounded-full border px-2.5 py-0.5 text-[11px] font-bold transition-colors',
                  highlighted ? 'border-brand bg-brand text-on-brand' : 'border-line text-muted hover:border-line-strong hover:text-ink',
                )}
              >
                {a.popular}
              </button>

              <div className="mt-4">
                <p className="text-xs font-medium text-muted">{a.quick}</p>
                <PercentChoices active={pct} onPick={(n) => applyPercent([id], n)} label={(n) => a.percent(n)} />
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <Field
                  label={a.price}
                  hint={a.catalog(t.plans.usd(plan.priceUsd))}
                  type="number"
                  min={0}
                  step="0.01"
                  dir="ltr"
                  inputMode="decimal"
                  value={Number.isFinite(offer.priceUsd) ? offer.priceUsd : ''}
                  error={problem === 'price' ? [a.priceInvalid] : undefined}
                  onChange={(e) => patch(id, { priceUsd: e.target.value === '' ? 0 : Number(e.target.value) })}
                />
                <Field
                  label={a.compareAt}
                  hint={a.compareAtHint}
                  type="number"
                  min={0}
                  step="0.01"
                  dir="ltr"
                  inputMode="decimal"
                  value={offer.compareAtUsd ?? ''}
                  placeholder="—"
                  error={problem === 'compare' ? [a.compareInvalid] : undefined}
                  onChange={(e) => patch(id, { compareAtUsd: e.target.value === '' ? null : Number(e.target.value) })}
                />
              </div>

              <Button type="button" variant="outline" className="mt-4 w-full" icon={<Eye className="size-4" />} onClick={() => setPreview(id)}>
                {a.preview}
              </Button>
            </article>
          );
        })}
      </div>

      <ErrorNote>{save.isError ? errorMessage(save.error) : null}</ErrorNote>
      <SuccessNote>{saved && a.saved}</SuccessNote>
      <div className="flex justify-end">
        <Button type="submit" variant="brand" loading={save.isPending} disabled={!dirty || invalid}>
          {a.save}
        </Button>
      </div>

      {preview && previewPlan && (
        <Modal title={a.previewTitle(planName(previewPlan))} description={a.previewText} onClose={() => setPreview(null)} size="lg" tall>
          {discountPercent(previewPlan.priceUsd, previewPlan.compareAtUsd) === null && <p className="text-sm text-muted">{a.noDiscount}</p>}
          <div className="rounded-2xl bg-bg px-4 pt-8 pb-6">
            <div className="mx-auto max-w-sm">
              <PlanCard
                embedded
                plan={previewPlan}
                action={
                  <span
                    className={buttonClass(
                      previewPlan.popular ? 'brand' : 'outline',
                      'lg',
                      cx('pointer-events-none h-12 w-full rounded-xl font-semibold', previewPlan.popular && 'shine bg-gradient-to-r from-brand to-teal text-on-brand'),
                    )}
                  >
                    {previewPlan.popular ? t.plans.startNow : t.plans.choose}
                  </span>
                }
              />
            </div>
          </div>
        </Modal>
      )}
    </form>
  );
}
