import { getPlan } from '@wa/shared/plans';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Hourglass, Info, Infinity as InfinityIcon, Smartphone } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { api, errorMessage } from '../api';
import { isUnlimitedPlan, type PlanRequest, planState, useAccount } from '../app/account';
import { MethodChip, PaymentDetailsRows } from '../app/payments/methods';
import { RequestPlanModal } from '../app/payments/RequestPlan';
import { PhoneVerifyModal } from '../auth/Otp';
import { BRAND } from '../brand';
import { useI18n } from '../i18n';
import { qk } from '../queries';
import { type PricedPlan } from '../site/content';
import { PlanCards } from '../site/Pricing';
import { Badge, Button, buttonClass, Card, delay, ErrorNote, PageHeader, SuccessNote, type Tone, usePlanName } from '../ui';

const REQUEST_TONES: Record<PlanRequest['status'], Tone> = { pending: 'info', approved: 'good', rejected: 'critical', cancelled: 'neutral' };

function Stat({ label, value, index }: { label: string; value: ReactNode; index: number }) {
  return (
    <div className="animate-fade-up rounded-lg bg-raised/40 p-4 transition-colors hover:bg-raised/60" style={delay(150 + index * 60)}>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

/** The workspace's last plan requests and what became of them. */
function RequestHistory() {
  const { t, fmt } = useI18n();
  const planName = usePlanName();
  const history = useQuery({ queryKey: qk.planRequests, queryFn: ({ signal }) => api<PlanRequest[]>('/api/plan-requests', { signal }) });
  const past = history.data?.filter((r) => r.status !== 'pending') ?? [];
  if (past.length === 0) return null;
  return (
    <Card title={t.subscription.history} className="animate-fade-up">
      <ul className="divide-y divide-line">
        {past.slice(0, 5).map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
            <span className="flex flex-wrap items-center gap-2 font-medium">
              {planName(getPlan(r.planId))}
              <span className="text-xs font-normal text-muted">{t.subscription.payment.months(r.months)}</span>
              {r.payment && <MethodChip method={r.payment.method} />}
            </span>
            <span className="flex items-center gap-3 text-muted">
              {fmt.date(r.decidedAt ?? r.createdAt)}
              <Badge tone={REQUEST_TONES[r.status]}>{t.status.request[r.status]}</Badge>
            </span>
            {r.adminNote && <p className="w-full text-xs text-muted">{r.adminNote}</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function SubscriptionPage() {
  const { t, fmt } = useI18n();
  const s = t.subscription;
  const planName = usePlanName();
  const { account, reload } = useAccount();
  const queryClient = useQueryClient();
  const [requesting, setRequesting] = useState<PricedPlan | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [sent, setSent] = useState(false);

  const plan = account?.plan;
  const state = account && planState(account);
  const pending = account?.pendingRequest ?? null;
  const unlimited = plan ? isUnlimitedPlan(plan) : false;
  const inactive = state?.kind === 'expired' || state?.kind === 'trial-expired';
  // Plan requests need a confirmed phone number (admins excepted); the server enforces it too.
  const needsPhone = Boolean(account?.user && !account.user.phoneVerified && !account.user.isAdmin);

  const changed = () => {
    reload();
    void queryClient.invalidateQueries({ queryKey: qk.planRequests });
  };

  const cancel = useMutation({
    mutationFn: (id: string) => api(`/api/plan-requests/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => setSent(false),
    onSettled: changed,
  });

  const description = !state
    ? t.common.loading
    : state.kind === 'trial'
      ? s.trialEnds(fmt.date(state.endsAt))
      : state.kind === 'trial-expired'
        ? s.trialEnded(fmt.date(state.endsAt))
        : state.kind === 'expired'
          ? s.expiredOn(fmt.date(state.endsAt))
          : state.endsAt
            ? s.activeUntil(fmt.date(state.endsAt))
            : s.noExpiry;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader title={s.title} description={s.description} />

      <Card
        className="animate-fade-up"
        style={delay(60)}
        title={plan ? (plan.id === 'trial' ? s.trialTitle : s.planTitle(planName(plan))) : '…'}
        description={description}
        actions={plan && (inactive ? <Badge tone="critical">{s.expired}</Badge> : <Badge tone="good">{s.active}</Badge>)}
      >
        {plan && (
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat index={0} label={s.stats.sessions} value={unlimited ? <InfinityIcon className="size-6 text-brand" /> : fmt.number.format(plan.sessions)} />
            <Stat index={1} label={s.stats.rpm} value={fmt.number.format(plan.rpm)} />
            <Stat index={2} label={s.stats.daily} value={plan.dailyMessages === null ? t.common.unlimited : fmt.number.format(plan.dailyMessages)} />
            <Stat index={3} label={s.stats.retention} value={s.retentionValue(plan.retentionDays)} />
          </dl>
        )}
      </Card>

      <ErrorNote>{cancel.isError ? errorMessage(cancel.error) : null}</ErrorNote>
      <SuccessNote>{sent && !pending && s.sent}</SuccessNote>

      {pending && (
        <div className="animate-fade-up rounded-xl border border-sky-500/25 bg-sky-500/10 p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <Hourglass className="mt-0.5 size-5 shrink-0 animate-pulse text-sky-300" />
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium text-sky-200">
                  {s.pendingTitle(planName(getPlan(pending.planId)))}
                  <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-xs font-medium text-sky-200">{s.payment.months(pending.months)}</span>
                </p>
                <p className="text-sm text-muted">{pending.payment ? s.payment.pendingPaid(fmt.timeAgo(pending.createdAt)) : s.pendingText(fmt.timeAgo(pending.createdAt))}</p>
              </div>
            </div>
            <Button variant="outline" size="sm" loading={cancel.isPending} onClick={() => cancel.mutate(pending.id)}>
              {s.cancelRequest}
            </Button>
          </div>
          {pending.payment && (
            <div className="mt-3 flex flex-wrap items-start gap-x-6 gap-y-2 border-t border-sky-500/15 pt-3 ps-8">
              <MethodChip method={pending.payment.method} />
              <PaymentDetailsRows payment={pending.payment} className="flex-1" />
              {pending.hasProof && (
                <span className="flex items-center gap-1 text-xs text-muted">
                  <CheckCircle2 className="size-3.5 text-brand" /> {s.payment.proofAttached}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {!unlimited && (
        <>
          {needsPhone && (
            <div className="animate-fade-up flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/25 bg-amber-500/10 p-4 text-sm">
              <Smartphone className="size-5 shrink-0 text-amber-300" />
              <p className="min-w-0 flex-1 text-amber-100">{s.phoneRequired}</p>
              <Button size="sm" onClick={() => setVerifying(true)}>
                {s.verifyPhone}
              </Button>
            </div>
          )}

          <div className="animate-fade-up flex items-start gap-3 rounded-lg border border-line bg-raised/20 p-4 text-sm" style={delay(120)}>
            <Info className="mt-0.5 size-4 shrink-0 text-muted" />
            <p className="text-ink-2">
              {s.howItWorks}{' '}
              <a href={`mailto:${BRAND.supportEmail}`} className="ltr font-medium text-ink underline underline-offset-4">
                {BRAND.supportEmail}
              </a>
            </p>
          </div>

          <div className="pt-4">
            <PlanCards
              currentPlanId={plan?.id}
              action={(p) => {
                const isCurrent = p.id === plan?.id;
                if (pending?.planId === p.id) {
                  return <span className={buttonClass('outline', 'lg', 'pointer-events-none w-full border-sky-500/40 text-sky-200')}>{s.requested}</span>;
                }
                if (isCurrent && !inactive && state?.kind !== 'expiring') {
                  return <span className={buttonClass('outline', 'lg', 'pointer-events-none w-full opacity-60')}>{t.plans.current}</span>;
                }
                return (
                  <Button variant={p.popular ? 'brand' : 'outline'} size="lg" className="w-full" onClick={() => (needsPhone ? setVerifying(true) : setRequesting(p))}>
                    {isCurrent ? s.renew : s.request(p.name)}
                  </Button>
                );
              }}
            />
          </div>

          <RequestHistory />
        </>
      )}

      {requesting && (
        <RequestPlanModal
          plan={requesting}
          onClose={() => setRequesting(null)}
          onSent={() => {
            setRequesting(null);
            setSent(true);
            changed();
          }}
          onNeedsPhone={() => {
            setRequesting(null);
            setVerifying(true);
          }}
        />
      )}
      {verifying && <PhoneVerifyModal onClose={() => setVerifying(false)} />}
    </div>
  );
}
