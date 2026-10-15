import type { MessageStatus, SessionStatus } from '@wa/shared/constants';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  FileText,
  Inbox,
  Infinity as InfinityIcon,
  KeyRound,
  Minus,
  Plus,
  Send,
  Smartphone,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Wifi,
} from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { api } from '../api';
import { isUnlimitedPlan, planState, useAccount } from '../app/account';
import { type DailyPoint, MessagesChart } from '../app/MessagesChart';
import { useI18n } from '../i18n';
import { qk } from '../queries';
import { Link } from '../router';
import { buttonClass, cx, delay, flip, LoadError, MESSAGE_STATUS, MessageStatusBadge, Progress, SESSION_STATUS, TONES, usePlanName } from '../ui';

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

// --- small pieces --------------------------------------------------------------------------------

function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-lg bg-raised', className)} />;
}

/** Section label: small caps with wide tracking. */
function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx('text-[11px] font-semibold tracking-[0.14em] text-muted uppercase', className)}>{children}</p>;
}

/** Seven tiny bars, the last one (today) in full colour. */
function Sparkline({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(1, ...values);
  return (
    <span className="flex h-5 items-end gap-[3px]" aria-hidden>
      {values.map((v, i) => (
        <span
          key={i}
          className={cx('w-1.5 rounded-full transition-[height] duration-700 ease-out', i === values.length - 1 ? color : cx(color, 'opacity-30'))}
          style={{ height: `${Math.max(12, (v / max) * 100)}%` }}
        />
      ))}
    </span>
  );
}

/** Change against yesterday, as a chip: ▲ 12% · ▼ 8% · —. */
function Delta({ now, before }: { now: number; before: number }) {
  const { t } = useI18n();
  if (before === 0 && now === 0) return <span className="text-[11px] text-faint">{t.dashboard.noChange}</span>;
  const pct = before === 0 ? 100 : Math.round(((now - before) / before) * 100);
  const Icon = pct > 0 ? TrendingUp : pct < 0 ? TrendingDown : Minus;
  const tone = pct > 0 ? 'text-good bg-good/12' : pct < 0 ? 'text-critical bg-critical/12' : 'text-muted bg-raised';
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-faint">
      <span className={cx('ltr inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-semibold tabular-nums', tone)}>
        <Icon className="size-3" />
        {Math.abs(pct)}%
      </span>
      {t.dashboard.vsYesterday}
    </span>
  );
}

/** Circular progress with a gradient stroke; children sit in the middle. */
function Ring({ value, max, size = 112, stroke = 9, children, tone = 'brand' }: { value: number; max: number; size?: number; stroke?: number; children: ReactNode; tone?: 'brand' | 'warn' | 'bad' }) {
  const id = useId();
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = max > 0 ? Math.min(1, value / max) : 0;
  const colors = tone === 'bad' ? ['#f87171', '#dc2626'] : tone === 'warn' ? ['#fbbf24', '#d97706'] : ['var(--color-grad-from)', 'var(--color-grad-to)'];
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={colors[0]} />
            <stop offset="100%" stopColor={colors[1]} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="color-mix(in oklab, var(--color-ink) 8%, transparent)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`url(#${id})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          className="transition-[stroke-dashoffset] duration-1000 ease-out"
        />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</span>
    </span>
  );
}

function Panel({ title, eyebrow, aside, children, className, index = 0 }: { title: string; eyebrow?: string; aside?: ReactNode; children: ReactNode; className?: string; index?: number }) {
  return (
    <section style={delay(index * 80)} className={cx('card-luxury animate-fade-up flex min-w-0 flex-col rounded-2xl border border-line p-6 transition-colors hover:border-line-strong', className)}>
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
          <h2 className="text-lg leading-tight font-bold tracking-tight">{title}</h2>
        </div>
        {aside}
      </header>
      <div className="flex flex-1 flex-col pt-5">{children}</div>
    </section>
  );
}

// --- header --------------------------------------------------------------------------------------

function Header() {
  const { t, fmt, lang } = useI18n();
  const d = t.dashboard;
  const { account } = useAccount();
  const name = account?.user?.name || account?.workspace.name || '';
  const hour = new Date().getHours();
  const greeting = hour < 5 ? d.greeting.night : hour < 12 ? d.greeting.morning : hour < 17 ? d.greeting.afternoon : hour < 22 ? d.greeting.evening : d.greeting.night;
  const actions = [
    { href: '/sessions?new=1', icon: Plus, label: d.quickNewSession, primary: true },
    { href: '/keys', icon: KeyRound, label: d.quickKeys },
    { href: '/templates', icon: FileText, label: d.quickTemplates },
    { href: '/guide', icon: BookOpen, label: d.quickDocs },
  ];
  return (
    <div className="animate-fade-up flex flex-wrap items-end justify-between gap-3">
      <div className="space-y-1">
        <p className="flex items-center gap-2 text-xs text-muted">
          <span className="capitalize">{fmt.dayLong.format(new Date())}</span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1.5 text-brand">
            <span className="relative flex size-2">
              <span className="absolute inset-0 animate-ping rounded-full bg-brand/60 motion-reduce:hidden" />
              <span className="relative size-2 rounded-full bg-brand" />
            </span>
            {d.live}
          </span>
        </p>
        <h1 className="text-2xl font-bold tracking-tight sm:text-[1.75rem]">
          {greeting}
          {name && (
            <>
              {lang === 'ar' ? '، ' : ', '}
              <span className="bg-gradient-to-r from-grad-from to-grad-to bg-clip-text text-transparent">{name}</span>
            </>
          )}
        </h1>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {actions.map((a) => (
          <Link key={a.href} href={a.href} className={a.primary ? buttonClass('brand', 'sm', 'shine rounded-lg bg-gradient-to-r from-brand to-teal text-on-brand') : buttonClass('outline', 'sm', 'rounded-lg bg-card/60 backdrop-blur')}>
            <a.icon className={cx('size-4', !a.primary && 'text-muted')} /> {a.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

// --- hero: KPI rail + chart ----------------------------------------------------------------------

function Hero({ overview, days, onDays, loading }: { overview: Overview | null; days: (typeof RANGES)[number]; onDays: (d: (typeof RANGES)[number]) => void; loading: boolean }) {
  const { t, fmt } = useI18n();
  const d = t.dashboard;
  const daily = overview?.messages.daily ?? [];
  const today = daily.at(-1);
  const yesterday = daily.at(-2);
  const last7 = (key: 'sent' | 'received') => daily.slice(-7).map((p) => p[key]);
  const connected = overview?.sessions.byStatus.connected ?? 0;
  const total = overview?.sessions.total ?? 0;
  const sent = overview?.messages.today.sent ?? 0;
  const received = overview?.messages.today.received ?? 0;
  const failed = overview?.messages.today.failed ?? 0;
  const attempts = sent + failed;
  const health = attempts > 0 ? Math.round((sent / attempts) * 100) : 100;

  const kpis: { label: string; value: string; icon: typeof Wifi; tint: string; foot: ReactNode }[] = [
    {
      label: d.kpiConnected,
      value: `${fmt.number.format(connected)} / ${fmt.number.format(total)}`,
      icon: Wifi,
      tint: 'text-series-sent bg-series-sent/12',
      foot: <span className="text-[11px] text-faint">{d.kpiActiveOfTotal(fmt.number.format(connected), fmt.number.format(total))}</span>,
    },
    {
      label: d.kpiSentToday,
      value: fmt.number.format(sent),
      icon: Send,
      tint: 'text-brand bg-brand/12',
      foot: (
        <span className="flex items-center justify-between gap-3">
          <Delta now={today?.sent ?? sent} before={yesterday?.sent ?? 0} />
          <Sparkline values={last7('sent')} color="bg-[var(--color-series-sent)]" />
        </span>
      ),
    },
    {
      label: d.kpiReceivedToday,
      value: fmt.number.format(received),
      icon: ArrowDownLeft,
      tint: 'text-series-received bg-series-received/12',
      foot: (
        <span className="flex items-center justify-between gap-3">
          <Delta now={today?.received ?? received} before={yesterday?.received ?? 0} />
          <Sparkline values={last7('received')} color="bg-[var(--color-series-received)]" />
        </span>
      ),
    },
    {
      label: d.kpiDeliveryHealth,
      value: `${health}%`,
      icon: CheckCircle2,
      tint: health >= 95 ? 'text-good bg-good/12' : 'text-warning bg-warning/12',
      foot: <span className={cx('text-[11px]', failed > 0 ? 'text-warning' : 'text-faint')}>{failed > 0 ? d.kpiFailedToday(fmt.number.format(failed)) : d.kpiNoFailures}</span>,
    },
  ];

  return (
    <section className="card-premium hero-glow animate-fade-up overflow-hidden rounded-2xl" style={delay(60)}>
      {/* KPI row */}
      <ul className="relative grid grid-cols-2 gap-px border-b border-line/60 bg-line/40 lg:grid-cols-4">
        {kpis.map((k, i) => (
          <li key={k.label} className="animate-fade-up flex flex-col gap-2 bg-card px-4 py-3.5" style={delay(120 + i * 60)}>
            <span className="flex items-center justify-between gap-2">
              <Eyebrow>{k.label}</Eyebrow>
              <span className={cx('flex size-6 items-center justify-center rounded-md', k.tint)}>
                <k.icon className="size-3.5" />
              </span>
            </span>
            {overview ? <span className="ltr block font-mono text-2xl leading-none font-bold tracking-tight tabular-nums">{k.value}</span> : <Skeleton className="h-7 w-24" />}
            {overview ? k.foot : <Skeleton className="h-4 w-32" />}
          </li>
        ))}
      </ul>

      {/* chart */}
      <div className="relative flex min-w-0 flex-col px-5 pt-4 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <Eyebrow>{d.activity}</Eyebrow>
            <span className="text-sm text-muted">{overview ? d.today(fmt.number.format(sent), fmt.number.format(received), fmt.number.format(failed)) : d.daily}</span>
          </div>
          <div className="flex rounded-lg border border-line bg-surface/60 p-0.5" role="group" aria-label={d.range}>
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => onDays(r)}
                aria-pressed={days === r}
                className={cx('cursor-pointer rounded-md px-2.5 py-1 text-xs font-semibold whitespace-nowrap transition-all', days === r ? 'bg-ink text-bg shadow-xs' : 'text-muted hover:text-ink')}
              >
                {d.ranges[r]}
              </button>
            ))}
          </div>
        </div>
        <div className="pt-2">{overview ? <MessagesChart key={daily.length} data={daily} loading={loading} height={210} /> : <Skeleton className="h-[240px]" />}</div>
      </div>
    </section>
  );
}

// --- first-run checklist -------------------------------------------------------------------------

function Setup({ overview }: { overview: Overview }) {
  const { t } = useI18n();
  const s = t.dashboard.setup;
  const everSent = overview.messages.today.sent > 0 || overview.messages.daily.some((p) => p.sent > 0);
  const steps = [
    { id: 'session', done: overview.sessions.total > 0, href: '/sessions?new=1', icon: Smartphone },
    { id: 'connect', done: (overview.sessions.byStatus.connected ?? 0) > 0, href: '/sessions', icon: Wifi },
    { id: 'send', done: everSent, href: '/sessions', icon: Send },
  ] as const;
  const done = steps.filter((x) => x.done).length;
  if (done === steps.length) return null;
  return (
    <section className="card-luxury animate-fade-up flex flex-wrap items-center gap-x-5 gap-y-3 rounded-2xl border border-brand/25 px-5 py-3.5" style={delay(40)}>
      <div className="flex items-center gap-3">
        <span className="flex size-8 items-center justify-center rounded-lg bg-brand/12 text-brand">
          <Sparkles className="size-4" />
        </span>
        <div>
          <h2 className="text-sm leading-tight font-bold">{s.title}</h2>
          <p className="text-xs text-muted">{s.progress(done, steps.length)}</p>
        </div>
      </div>
      <ol className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {steps.map((step, i) => {
          const copy = s.steps[step.id];
          const current = !step.done && steps.slice(0, i).every((x) => x.done);
          return (
            <li key={step.id} className="animate-fade-up" style={delay(120 + i * 60)}>
              <Link
                href={step.href}
                title={copy.text}
                className={cx(
                  'flex items-center gap-2 rounded-full border py-1.5 ps-1.5 pe-3 text-sm transition-colors',
                  step.done ? 'border-line/60 text-muted' : current ? 'border-brand/40 bg-brand/[0.08] font-medium' : 'border-line hover:border-line-strong',
                )}
              >
                <span className={cx('flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold', step.done ? 'bg-brand text-on-brand' : current ? 'bg-brand/15 text-brand' : 'bg-raised text-muted')}>
                  {step.done ? <Check className="size-3.5" /> : i + 1}
                </span>
                <span className={cx(step.done && 'line-through decoration-muted/60')}>{copy.title}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// --- lower row -----------------------------------------------------------------------------------

function SessionsCard({ overview }: { overview: Overview | null }) {
  const { t, fmt } = useI18n();
  const d = t.dashboard;
  const total = overview?.sessions.total ?? 0;
  const connected = overview?.sessions.byStatus.connected ?? 0;
  const statuses = overview ? (Object.entries(overview.sessions.byStatus) as [SessionStatus, number][]).filter(([, n]) => n > 0) : [];
  const footer = (
    <Link href="/sessions" className="group mt-auto inline-flex items-center gap-1 pt-5 text-sm font-semibold text-brand hover:underline">
      {d.manageSessions} <ArrowRight className={cx('size-4 transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5', flip)} />
    </Link>
  );
  return (
    <Panel eyebrow={d.sessions} title={overview ? d.total(fmt.number.format(total)) : '…'} index={2}>
      {!overview ? (
        <Skeleton className="h-28" />
      ) : total === 0 ? (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-line bg-surface/40 px-4 py-8 text-center">
          <p className="text-sm text-muted">{d.noSessions}</p>
          <Link href="/sessions?new=1" className={buttonClass('brand', 'md', 'rounded-xl')}>
            <Plus className="size-4" /> {d.createSession}
          </Link>
        </div>
      ) : (
        <div className="flex items-center gap-5">
          <Ring value={connected} max={total} tone={connected === 0 ? 'bad' : connected < total ? 'warn' : 'brand'}>
            <span className="ltr font-mono text-2xl leading-none font-bold tabular-nums">{fmt.number.format(connected)}</span>
            <span className="mt-1 text-[10px] text-muted">/ {fmt.number.format(total)}</span>
          </Ring>
          <ul className="min-w-0 flex-1 space-y-2">
            {statuses.map(([status, n], i) => (
              <li key={status} className="animate-fade-up flex items-center justify-between gap-2 text-sm" style={delay(200 + i * 50)}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className={cx('size-2 shrink-0 rounded-full', TONES[SESSION_STATUS[status].tone].dot, status === 'connected' && 'animate-pulse')} />
                  <span className="truncate text-ink-2">{t.status.session[status].label}</span>
                </span>
                <span className="ltr font-mono font-semibold tabular-nums">{fmt.number.format(n)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {footer}
    </Panel>
  );
}

function PlanCard({ overview }: { overview: Overview | null }) {
  const { t, fmt } = useI18n();
  const d = t.dashboard;
  const planName = usePlanName();
  const { account } = useAccount();
  const plan = account?.plan;
  const state = account && planState(account);
  const unlimited = plan ? isUnlimitedPlan(plan) : false;
  const expired = state?.kind === 'expired' || state?.kind === 'trial-expired';
  const daysLeft = state?.endsAt ? Math.max(0, Math.ceil((state.endsAt.getTime() - Date.now()) / 86_400_000)) : null;
  const ends =
    !state || state.endsAt === null
      ? d.noExpiry
      : state.kind === 'trial' || state.kind === 'trial-expired'
        ? d.trialEnds(fmt.date(state.endsAt))
        : state.kind === 'expired'
          ? d.expired(fmt.date(state.endsAt))
          : d.expires(fmt.date(state.endsAt));

  const meter = (label: string, used: number, limit: number | null) => {
    const pct = limit && limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
    return (
      <div>
        <div className="mb-1.5 flex items-center justify-between text-sm">
          <span className="text-muted">{label}</span>
          <span className="ltr inline-flex items-center gap-1 font-semibold tabular-nums">
            {fmt.number.format(used)} / {limit === null ? <InfinityIcon className="size-4 text-brand" /> : fmt.number.format(limit)}
          </span>
        </div>
        {limit !== null && <Progress value={pct} className="h-1.5" />}
      </div>
    );
  };

  return (
    <Panel
      eyebrow={d.subscription}
      title={plan ? planName(plan) : '…'}
      index={3}
      aside={daysLeft !== null && !expired && <span className={cx('rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums', daysLeft <= 5 ? 'bg-warning/15 text-warning' : 'bg-brand/12 text-brand')}>{d.daysLeft(daysLeft)}</span>}
    >
      {!plan || !overview ? (
        <div className="space-y-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : (
        <div className="space-y-4">
          {meter(d.sessionsMeter, overview.sessions.total, unlimited ? null : plan.sessions)}
          {plan.dailyMessages !== null && meter(d.todayMeter, overview.messages.today.sent, plan.dailyMessages)}
          <p className={cx('text-xs font-medium', expired ? 'text-critical' : 'text-muted')}>{ends}</p>
        </div>
      )}
      <Link href="/subscription" className="group mt-auto inline-flex items-center gap-1 pt-5 text-sm font-semibold text-brand hover:underline">
        {d.manageSubscription} <ArrowRight className={cx('size-4 transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5', flip)} />
      </Link>
    </Panel>
  );
}

function ActivityCard({ overview }: { overview: Overview | null }) {
  const { t, fmt } = useI18n();
  const d = t.dashboard;
  return (
    <Panel eyebrow={d.recent} title={d.recentText} index={4} className="md:col-span-2 xl:col-span-1">
      {!overview ? (
        <div className="space-y-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex gap-3.5">
              <Skeleton className="size-8 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      ) : overview.recent.length === 0 ? (
        <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-surface/30 p-6 text-center">
          <Inbox className="animate-float size-6 text-muted" />
          <p className="text-sm text-muted">{d.noActivity}</p>
        </div>
      ) : (
        <ol className="relative space-y-5 before:absolute before:inset-y-2 before:start-[15px] before:w-px before:bg-line">
          {overview.recent.slice(0, 6).map((m, i) => {
            const status = (m.status in MESSAGE_STATUS ? m.status : 'sent') as MessageStatus;
            const tone = m.direction === 'in' ? 'info' : MESSAGE_STATUS[status].tone;
            const peer = m.jid.split('@')[0];
            const Icon = m.direction === 'in' ? ArrowDownLeft : ArrowUpRight;
            return (
              <li key={m.id} className="animate-fade-up relative flex gap-3.5" style={delay(220 + i * 45)}>
                <span className={cx('relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full ring-4 ring-card', TONES[tone].chip)}>
                  <Icon className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1 space-y-0.5 pt-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold">{m.direction === 'in' ? d.incoming : d.outgoing}</p>
                    <MessageStatusBadge status={status} />
                  </div>
                  <p className="line-clamp-2 text-xs leading-relaxed text-ink-2">{m.text ?? `[${m.type}]`}</p>
                  <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                    <span className="ltr font-mono">+{peer}</span>
                    <span aria-hidden>·</span>
                    <span className="truncate">{m.sessionName}</span>
                    <span aria-hidden>·</span>
                    <span>{fmt.timeAgo(m.createdAt)}</span>
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

// --- page ----------------------------------------------------------------------------------------

export function DashboardPage() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(14);
  // Each range is cached on its own; switching keeps the previous chart up until the new one lands.
  // Live events refresh it from the app shell.
  const query = useQuery({
    queryKey: qk.overview(days),
    queryFn: ({ signal }) => api<Overview>(`/api/overview?days=${days}`, { signal }),
    placeholderData: keepPreviousData,
  });
  const overview = query.data ?? null;

  return (
    <div className="flex flex-col gap-4">
      {query.isError && <LoadError error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />}
      <Header />
      {overview && <Setup overview={overview} />}
      <Hero overview={overview} days={days} onDays={setDays} loading={query.isFetching} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <SessionsCard overview={overview} />
        <PlanCard overview={overview} />
        <ActivityCard overview={overview} />
      </div>
    </div>
  );
}
