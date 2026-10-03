import type { MessageStatus, SessionStatus } from '@wa/shared/constants';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, CircleArrowRight, Infinity as InfinityIcon, Inbox, Plus } from 'lucide-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { api } from '../api';
import { isUnlimitedPlan, planState, useAccount } from '../app/account';
import { type DailyPoint, MessagesChart } from '../app/MessagesChart';
import { useI18n } from '../i18n';
import { qk } from '../queries';
import { Link } from '../router';
import { buttonClass, cx, delay, flip, LoadError, MESSAGE_STATUS, MessageStatusBadge, Pill, Progress, SESSION_STATUS, StatusIcon, TONES, usePlanName } from '../ui';

type Overview = {
  sessions: { total: number; byStatus: Record<SessionStatus, number> };
  messages: { today: { sent: number; received: number; failed: number }; daily: DailyPoint[] };
  recent: {
    id: number;
    sessionId: string;
    sessionName: string;
    direction: 'in' | 'out';
    jid: string;
    type: string;
    status: string;
    text: string | null;
    createdAt: string;
  }[];
};

const RANGES = [7, 14, 30] as const;

/** Dashboard card: the reference uses bigger titles and a pill on the far side of the header. */
function Panel({
  title,
  description,
  aside,
  children,
  className,
  index = 0,
}: {
  title: string;
  description?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  index?: number;
}) {
  return (
    <section
      style={delay(index * 90)}
      className={cx('animate-fade-up flex min-w-0 flex-col gap-6 rounded-xl border border-line bg-card py-6 shadow-sm transition-colors hover:border-line-strong', className)}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 px-6">
        <div className="space-y-1.5">
          <h2 className="text-xl leading-tight font-semibold">{title}</h2>
          {description && <p className="text-muted">{description}</p>}
        </div>
        {aside}
      </header>
      <div className="flex flex-1 flex-col px-6">{children}</div>
    </section>
  );
}

function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-md bg-raised', className)} />;
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const { t, fmt } = useI18n();
  if (limit === null) {
    return (
      <div className="flex items-center justify-between">
        <span className="text-muted">{label}</span>
        <span className="inline-flex items-center gap-1.5 font-medium">
          <span className="ltr tabular-nums">{fmt.number.format(used)}</span> / <InfinityIcon className="size-4 text-brand" />
        </span>
      </div>
    );
  }
  const pct = limit > 0 ? (used / limit) * 100 : 0;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-muted">{label}</span>
        <span className="ltr font-medium tabular-nums">
          {fmt.number.format(used)} / {fmt.number.format(limit)}
        </span>
      </div>
      <Progress value={pct} />
      <p className="mt-1 text-end text-xs text-muted">{t.dashboard.used(Math.round(Math.min(100, pct)))}</p>
    </div>
  );
}

function SubscriptionCard({ overview }: { overview: Overview | null }) {
  const { t, fmt } = useI18n();
  const d = t.dashboard;
  const planName = usePlanName();
  const { account } = useAccount();
  const plan = account?.plan;
  const state = account && planState(account);
  const unlimited = plan ? isUnlimitedPlan(plan) : false;
  const ends =
    !state || state.endsAt === null
      ? d.noExpiry
      : state.kind === 'trial' || state.kind === 'trial-expired'
        ? d.trialEnds(fmt.date(state.endsAt))
        : state.kind === 'expired'
          ? d.expired(fmt.date(state.endsAt))
          : d.expires(fmt.date(state.endsAt));
  return (
    <Panel title={d.subscription} index={0} aside={plan && <Pill className={unlimited ? 'bg-brand/15 text-brand' : undefined}>{planName(plan)}</Pill>}>
      {!plan || !overview ? (
        <div className="space-y-3">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-2.5 w-full" />
        </div>
      ) : (
        <div className="space-y-5">
          <Meter label={d.sessionsMeter} used={overview.sessions.total} limit={unlimited ? null : plan.sessions} />
          {plan.dailyMessages !== null && <Meter label={d.todayMeter} used={overview.messages.today.sent} limit={plan.dailyMessages} />}
          <p className={cx('text-sm', state?.kind === 'expired' || state?.kind === 'trial-expired' ? 'text-red-400' : 'text-muted')}>{ends}</p>
        </div>
      )}
      <div className="mt-6">
        <Link href="/subscription" className="group inline-flex items-center gap-2 text-sm font-medium text-ink hover:underline">
          {d.manageSubscription}{' '}
          <CircleArrowRight className={cx('size-4 transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5', flip)} />
        </Link>
      </div>
    </Panel>
  );
}

function SessionsCard({ overview }: { overview: Overview | null }) {
  const { t, fmt } = useI18n();
  const d = t.dashboard;
  const statuses = overview ? (Object.entries(overview.sessions.byStatus) as [SessionStatus, number][]).filter(([, n]) => n > 0) : [];
  return (
    <Panel title={d.sessions} index={1} aside={overview && <Pill>{d.total(fmt.number.format(overview.sessions.total))}</Pill>}>
      {!overview ? (
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : overview.sessions.total === 0 ? (
        <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-line px-4 py-8 text-center">
          <p className="text-muted">{d.noSessions}</p>
          <Link href="/sessions?new=1" className={buttonClass('white', 'md')}>
            <Plus className="size-4" /> {d.createSession}
          </Link>
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3">
          {statuses.map(([status, n], i) => (
            <li
              key={status}
              className="animate-fade-up flex items-center gap-2 rounded-md bg-raised/30 p-2 transition-colors hover:bg-raised/50"
              style={delay(200 + i * 60)}
            >
              <span className={cx('size-3 shrink-0 rounded-full', TONES[SESSION_STATUS[status].tone].dot, status === 'connected' && 'animate-pulse')} />
              <span className="truncate text-sm font-medium">
                {t.status.session[status].label}: {fmt.number.format(n)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-6">
        <Link href="/sessions" className="group inline-flex items-center gap-1 text-sm font-medium text-ink hover:underline">
          {d.manageSessions} <ArrowRight className={cx('ms-1 size-4 transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5', flip)} />
        </Link>
      </div>
    </Panel>
  );
}

function RecentActivity({ overview }: { overview: Overview | null }) {
  const { t, fmt } = useI18n();
  const d = t.dashboard;
  return (
    <Panel title={d.recent} description={d.recentText} index={2} className="lg:row-span-2">
      {!overview ? (
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-4">
              <Skeleton className="size-8 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      ) : overview.recent.length === 0 ? (
        <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-md p-6 text-center">
          <Inbox className="animate-float size-6 text-muted" />
          <p className="text-muted">{d.noActivity}</p>
        </div>
      ) : (
        <ul className="space-y-4">
          {overview.recent.map((m, i) => {
            const status = (m.status in MESSAGE_STATUS ? m.status : 'sent') as MessageStatus;
            const tone = m.direction === 'in' ? 'info' : MESSAGE_STATUS[status].tone;
            const peer = m.jid.split('@')[0];
            return (
              <li key={m.id} className="animate-fade-up flex items-start gap-4 border-b border-line pb-4 last:border-0 last:pb-0" style={delay(250 + i * 50)}>
                <StatusIcon tone={tone} icon={m.direction === 'in' ? ArrowDownLeft : ArrowUpRight} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate font-medium">{m.direction === 'in' ? d.incoming : d.outgoing}</p>
                    <MessageStatusBadge status={status} />
                  </div>
                  <p className="line-clamp-2 text-sm text-muted">{m.text ?? `[${m.type}]`}</p>
                  <p className="text-xs text-muted">
                    <span className="ltr">+{peer}</span> · {m.sessionName} · {fmt.timeAgo(m.createdAt)}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export function DashboardPage() {
  const { t, fmt } = useI18n();
  const d = t.dashboard;
  const [days, setDays] = useState<(typeof RANGES)[number]>(14);
  // Each range is cached on its own; switching keeps the previous chart up until the new one lands.
  // Live events refresh it from the app shell.
  const query = useQuery({
    queryKey: qk.overview(days),
    queryFn: ({ signal }) => api<Overview>(`/api/overview?days=${days}`, { signal }),
    placeholderData: keepPreviousData,
  });
  const overview = query.data ?? null;
  const today = overview?.messages.today;

  return (
    <div className="flex flex-col gap-4">
      {query.isError && <LoadError error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />}
      <div className="grid gap-4 lg:grid-cols-3">
        <SubscriptionCard overview={overview} />
        <SessionsCard overview={overview} />
        <RecentActivity overview={overview} />
        <Panel
          title={d.activity}
          index={3}
          description={today ? d.today(fmt.number.format(today.sent), fmt.number.format(today.received), fmt.number.format(today.failed)) : d.daily}
          className="lg:col-span-2"
          aside={
            <div className="flex rounded-md border border-line p-0.5" role="group" aria-label={d.range}>
              {RANGES.map((r) => (
                <button
                  key={r}
                  onClick={() => setDays(r)}
                  aria-pressed={days === r}
                  className={cx('rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors', days === r ? 'bg-raised text-ink' : 'text-muted hover:text-ink')}
                >
                  {d.ranges[r]}
                </button>
              ))}
            </div>
          }
        >
          {overview ? <MessagesChart key={overview.messages.daily.length} data={overview.messages.daily} loading={query.isFetching} /> : <Skeleton className="h-[290px]" />}
        </Panel>
      </div>
    </div>
  );
}
