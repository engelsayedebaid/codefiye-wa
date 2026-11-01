import { KASHIER_MODES, type KashierMode } from '@wa/shared/kashier';
import type { OnlinePaymentStatus } from '@wa/shared/payments';
import { getPlan } from '@wa/shared/plans';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { FlaskConical, Zap } from '../icons';
import { useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { qk } from '../queries';
import { Badge, cx, Loading, LoadError, type Tone, usePlanName } from '../ui';

type AdminOnlinePayment = {
  id: string;
  provider: string;
  mode: KashierMode;
  status: OnlinePaymentStatus;
  workspace: { id: string; name: string };
  planId: string;
  months: number;
  amountCents: number;
  refundedCents: number;
  currency: string;
  error: string | null;
  createdAt: string;
  paidAt: string | null;
};

const TONES: Record<OnlinePaymentStatus, Tone> = { pending: 'info', paid: 'good', failed: 'neutral', review: 'warning', refunded: 'critical' };
const MODE_ICONS = { test: FlaskConical, live: Zap } as const;

/** The latest online payments of one mode at a time (Test and Live are never listed together), Kashier's and earlier XPay ones. */
export function OnlinePaymentsCard() {
  const { t, fmt } = useI18n();
  const x = t.admin.payments.kashier;
  const pay = x.payments;
  const p = t.subscription.payment;
  const planName = usePlanName();
  const [mode, setMode] = useState<KashierMode>('live');
  const list = useQuery({
    queryKey: qk.admin.onlinePayments(mode),
    queryFn: ({ signal }) => api<AdminOnlinePayment[]>(`/api/admin/payments?mode=${mode}`, { signal }),
    placeholderData: keepPreviousData,
  });

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/60 px-5 py-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{pay.title}</h3>
          <p className="text-xs text-muted">{pay.text}</p>
        </div>
        <div role="tablist" className="flex gap-1 rounded-lg border border-line p-1">
          {KASHIER_MODES.map((m) => {
            const Icon = MODE_ICONS[m];
            return (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={cx('flex h-7 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors', mode === m ? 'bg-raised text-ink' : 'text-muted hover:text-ink')}
              >
                <Icon className="size-3.5" />
                {x.modes[m]}
              </button>
            );
          })}
        </div>
      </div>

      {list.isError ? (
        <div className="p-4">
          <LoadError error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
        </div>
      ) : !list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted">{pay.empty(x.modes[mode])}</p>
      ) : (
        <ul className={cx('divide-y divide-line/60 transition-opacity', list.isPlaceholderData && 'opacity-60')}>
          {list.data.map((row) => (
            <li key={row.id} className="grid gap-2 px-5 py-3 text-sm sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_auto] sm:items-center sm:gap-4">
              <div className="min-w-0">
                <p className="truncate font-medium">{row.workspace.name}</p>
                <p className="text-xs text-muted">
                  {planName(getPlan(row.planId))} · {p.months(row.months)}
                </p>
              </div>
              <div className="text-xs text-muted">
                <span title={fmt.dateTime(row.createdAt)}>{fmt.timeAgo(row.createdAt)}</span>
                {row.error && <span className="ltr block truncate font-mono text-[11px]">{row.error}</span>}
              </div>
              <div className="tabular-nums sm:text-end">
                <p className="font-semibold">{p.egp(row.amountCents / 100)}</p>
                {row.refundedCents > 0 && <p className="text-xs text-critical">{pay.refunded(p.egp(row.refundedCents / 100))}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                <Badge tone="neutral">{row.provider === 'kashier' ? pay.providers.kashier : pay.providers.xpay}</Badge>
                {row.mode === 'test' && <Badge tone="warning">{x.modes.test}</Badge>}
                <Badge tone={TONES[row.status]}>{pay.status[row.status]}</Badge>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
