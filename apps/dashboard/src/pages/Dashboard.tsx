import type { MessageStatus, SessionStatus } from '@wa/shared/constants';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  Code,
  FileText,
  Infinity as InfinityIcon,
  KeyRound,
  MessagesSquare,
  Plus,
  Send,
  Smartphone,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Wifi,
} from '../icons';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { isUnlimitedPlan, planState, useAccount } from '../app/account';
import { HeroChart, type Metric, smoothPath } from '../app/HeroChart';
import type { DailyPoint } from '../app/MessagesChart';
import { useI18n } from '../i18n';
import { qk } from '../queries';
import { Link } from '../router';
import type { Session } from '../types';
import { Badge, cx, delay, flip, LoadError, MESSAGE_STATUS, MessageStatusBadge, Progress, SESSION_STATUS, TONES, usePlanName } from '../ui';

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
type Range = (typeof RANGES)[number];

// --- small pieces --------------------------------------------------------------------------------

function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-lg bg-ink/[0.06]', className)} />;
}

/** Counts up to the value once it arrives (instantly when the visitor prefers less motion). */
function useCountUp(target: number, ms = 800) {
  const [value, setValue] = useState(target);
  const from = useRef(0);
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setValue(target);
      from.current = target;
      return;
    }
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      const eased = 1 - (1 - p) ** 3;
      setValue(Math.round(origin + (target - origin) * eased));
      if (p < 1) frame = requestAnimationFrame(tick);
      else from.current = target;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}

/**
 * Change against a reference, as a chip: ▲ 12% · ▼ 8% · —, then what it is compared with. Below ten
 * messages a percentage means nothing (one message to 225 would read "22400%"), so the chip shows
 * the difference itself: +224.
 */
function Delta({ now, before, label, flat }: { now: number; before: number; label: string; flat: string }) {
  const { fmt } = useI18n();
  if (before === now) return <span className="text-sm text-faint">{flat}</span>;
  const small = before < 10;
  const pct = small ? 0 : Math.round(((now - before) / before) * 100);
  const up = now > before;
  const Icon = up ? TrendingUp : TrendingDown;
  const value = small ? `${up ? "+" : "−"}${fmt.number.format(Math.abs(now - before))}` : `${Math.abs(pct)}%`;
  const tone = up ? 'bg-good/12 text-good' : 'bg-critical/12 text-critical';
  return (
    <span className="inline-flex items-center gap-2 text-sm text-faint">
      <span className={cx('ltr inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums', tone)}>
        <Icon className="size-3.5" />
        {value}
      </span>
      {label}
    </span>
  );
}

/** A pulsing dot: green while something is live, grey otherwise. */
function LiveDot({ on }: { on: boolean }) {
  return (
    <span className="relative flex size-2 shrink-0">
      {on && <span className="absolute inset-0 animate-ping rounded-full bg-brand/60 motion-reduce:hidden" />}
      <span className={cx('relative size-2 rounded-full', on ? 'bg-brand' : 'bg-line-strong')} />
    </span>
  );
}

/** A tiny smooth line for a stat tile; the last point (today) gets a dot. */
function Spark({ values, color }: { values: number[]; color: string }) {
  const w = 72;
  const h = 28;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i): [number, number] => [2 + (values.length <= 1 ? 0 : (i / (values.length - 1)) * (w - 4)), h - 3 - (v / max) * (h - 6)]);
  const end = pts.at(-1);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="shrink-0 overflow-visible">
      <path d={smoothPath(pts)} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" />
      {end && <circle cx={end[0]} cy={end[1]} r={2.5} fill={color} />}
    </svg>
  );
}

/** A section heading in the main column, with an optional link on the far side. */
function SectionHead({ title, aside }: { title: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="min-w-0 text-lg leading-tight font-semibold">{title}</h2>
      {aside}
    </div>
  );
}

function MoreLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="group inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-muted transition-colors hover:bg-ink/[0.06] hover:text-ink">
      {children}
      <ChevronRight className={cx('size-4 transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5', flip)} />
    </Link>
  );
}

/** Compact panels for workspace capacity and recent activity. */
function Panel({ title, aside, children, index = 0 }: { title: ReactNode; aside?: ReactNode; children: ReactNode; index?: number }) {
  return (
    <section style={delay(120 + index * 70)} className="workspace-sheet animate-fade-up flex min-w-0 flex-col px-3 pt-5 pb-3">
      <header className="mx-2 mb-3 flex min-h-8 items-center justify-between gap-3 border-b border-line px-1 pb-3">
        <h2 className="text-base leading-tight font-semibold">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

/** The panel's last row: a quiet link out to the full page. */
function PanelLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="group mt-1 flex h-11 items-center justify-between gap-2 rounded-xl px-3 text-sm font-medium text-muted transition-colors hover:bg-ink/[0.04] hover:text-ink">
      {children}
      <ArrowRight className={cx('size-4 transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5', flip)} />
    </Link>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '#';
}

// --- hero ----------------------------------------------------------------------------------------

function OverviewHeader({ live }: { live: boolean }) {
  const { t, fmt, lang } = useI18n();
  const { account } = useAccount();
  const d = t.dashboard;
  const name = account?.user?.name || account?.workspace.name;
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 5 ? d.greeting.night : hour < 12 ? d.greeting.morning : hour < 17 ? d.greeting.afternoon : hour < 22 ? d.greeting.evening : d.greeting.night;
  return (
    <header className="workspace-masthead animate-fade-up relative isolate overflow-hidden rounded-[1.75rem] p-6 sm:p-8">
      <div aria-hidden className="workspace-signal" />
      <div className="relative max-w-3xl">
        <div className="flex flex-wrap items-center gap-3 text-xs font-medium text-white/80">
          <span className="workspace-date capitalize">{fmt.dayLong.format(now)}</span>
          <span className="inline-flex items-center gap-2"><LiveDot on={live} />{d.live}</span>
        </div>
        <h1 className="mt-4 text-[clamp(1.8rem,3.1vw,3rem)] leading-tight font-semibold text-balance">
          {name ? <>{greeting}{lang === 'ar' ? '، ' : ', '}<bdi>{name}</bdi></> : d.overviewTitle}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/80 sm:text-base">{d.overviewSubtitle}</p>
        <Actions />
      </div>
    </header>
  );
}

/**
 * The headline card: a Sent / Received switch (each tab carries its total), the range on the far
 * side, the chosen total as one big number, and the chart drawn for that series. The comparison is
 * the recent half of the range against the half before it, not today against yesterday: today is
 * still filling up, so it would read as a drop every morning. Today gets its own "so far" line.
 */
function Hero({ overview, days, onDays, loading }: { overview: Overview | null; days: Range; onDays: (d: Range) => void; loading: boolean }) {
  const { t, fmt } = useI18n();
  const d = t.dashboard;
  const [metric, setMetric] = useState<Metric>('sent');

  const daily = overview?.messages.daily ?? [];
  const total = (key: Metric) => daily.reduce((sum, p) => sum + p[key], 0);
  const half = Math.floor(daily.length / 2);
  const sum = (from: number, to: number) => daily.slice(from, to).reduce((s, p) => s + p[metric], 0);
  const recent = sum(daily.length - half, daily.length);
  const previous = sum(daily.length - 2 * half, daily.length - half);
  const shown = useCountUp(total(metric));
  const tabs: { key: Metric; dot: string }[] = [
    { key: 'sent', dot: 'bg-series-sent' },
    { key: 'received', dot: 'bg-series-received' },
  ];

  return (
    <section className="workspace-sheet animate-fade-up min-w-0 p-5 sm:p-6">
      <div className="mb-5 flex items-center gap-2 border-b border-line pb-4">
        <TrendingUp aria-hidden className="size-5 text-brand" />
        <h2 className="text-lg font-semibold">{d.activity}</h2>
      </div>
          {/* Series switch on the start side, range on the far side. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div role="tablist" aria-label={d.metric} className="inline-flex rounded-xl bg-ink/[0.05] p-1">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  role="tab"
                  aria-selected={metric === tab.key}
                  onClick={() => setMetric(tab.key)}
                  className={cx(
                    'flex h-8 cursor-pointer items-center gap-2 rounded-lg px-3 text-sm whitespace-nowrap transition-colors',
                    metric === tab.key ? 'bg-card font-semibold text-ink shadow-sm' : 'text-muted hover:text-ink',
                  )}
                >
                  <span className={cx('size-2 rounded-full', tab.dot)} />
                  {t.chart[tab.key]}
                  {overview && <span className={cx('ltr text-xs tabular-nums', metric === tab.key ? 'text-muted' : 'text-faint')}>{fmt.number.format(total(tab.key))}</span>}
                </button>
              ))}
            </div>
            <div className="inline-flex items-center gap-0.5" role="group" aria-label={d.range}>
              {RANGES.map((r) => (
                <button
                  key={r}
                  onClick={() => onDays(r)}
                  aria-pressed={days === r}
                  className={cx('h-8 cursor-pointer rounded-lg px-2.5 text-xs font-semibold whitespace-nowrap transition-colors', days === r ? 'bg-ink/10 text-ink' : 'text-muted hover:bg-ink/[0.06] hover:text-ink')}
                >
                  {d.ranges[r]}
                </button>
              ))}
            </div>
          </div>

          <p className="mt-5 text-sm font-medium text-muted">{d.heroTitle(metric, d.ranges[days] ?? String(days))}</p>
          {overview ? (
            <p className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="ltr inline-block text-[clamp(2.4rem,4vw,3.75rem)] leading-tight font-semibold tracking-[-0.05em] tabular-nums">{fmt.number.format(shown)}</span>
              <span className="text-sm font-medium text-muted">{d.unitMessages}</span>
            </p>
          ) : (
            <Skeleton className="mt-2 h-14 w-48" />
          )}
          <div className="mt-1 flex min-h-6 flex-wrap items-center gap-x-4 gap-y-1">
            {overview && (
              <>
                <Delta now={recent} before={previous} label={d.vsPrevious(half)} flat={d.noChangePrev} />
                <span className="text-sm text-faint">{d.todaySoFar(fmt.number.format(daily.at(-1)?.[metric] ?? 0))}</span>
              </>
            )}
          </div>

          <div className="relative mt-5 -mx-1">{overview ? <HeroChart key={days} data={daily} focus={metric} loading={loading} height={220} /> : <Skeleton className="h-[220px]" />}</div>
    </section>
  );
}

/** Quick actions as one row of pills under the card; the first is the green one. */
function Actions() {
  const { t } = useI18n();
  const d = t.dashboard;
  const actions = [
    { href: '/sessions?new=1', icon: Plus, label: d.quickNewSession, primary: true },
    { href: '/keys', icon: KeyRound, label: d.quickKeys },
    { href: '/templates', icon: FileText, label: d.quickTemplates },
    { href: '/guide', icon: BookOpen, label: d.quickDocs },
  ];
  return (
    <nav aria-label={d.quickNewSession} className="mt-6 flex flex-wrap gap-2">
      {actions.map((a) => (
        <Link
          key={a.href}
          href={a.href}
          className={cx(
            'inline-flex min-h-10 items-center gap-2 rounded-full px-4 py-1 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white',
            a.primary ? 'bg-[#c5f2cb] text-[#123b27] hover:bg-white' : 'border border-white/25 bg-white/[0.06] text-white hover:bg-white/15',
          )}
        >
          <a.icon className="size-4" />
          {a.label}
        </Link>
      ))}
    </nav>
  );
}

/** Today in four tiles, each with its last seven days as a tiny line. */
function TodayStats({ overview }: { overview: Overview | null }) {
  const { t, fmt } = useI18n();
  const d = t.dashboard;
  const daily = overview?.messages.daily ?? [];
  const week = daily.slice(-7);
  const today = overview?.messages.today;
  const sent = today?.sent ?? 0;
  const failed = today?.failed ?? 0;
  const health = sent + failed > 0 ? Math.round((sent / (sent + failed)) * 100) : 100;
  const tiles = [
    { label: d.kpiSentToday, value: fmt.number.format(sent), spark: week.map((p) => p.sent), color: 'var(--color-series-sent)', tone: '' },
    { label: d.kpiReceivedToday, value: fmt.number.format(today?.received ?? 0), spark: week.map((p) => p.received), color: 'var(--color-series-received)', tone: '' },
    { label: d.kpiFailed, value: fmt.number.format(failed), spark: week.map((p) => p.failed), color: 'var(--color-critical)', tone: failed > 0 ? 'text-critical' : '' },
    {
      label: d.kpiDeliveryHealth,
      value: `${health}%`,
      spark: week.map((p) => (p.sent + p.failed > 0 ? (p.sent / (p.sent + p.failed)) * 100 : 100)),
      color: health >= 95 ? 'var(--color-good)' : 'var(--color-warning)',
      tone: health >= 95 ? '' : 'text-warning',
    },
  ];
  return (
    <div className="workspace-ledger animate-fade-up grid grid-cols-2 @min-[720px]:grid-cols-4" style={delay(60)}>
      {tiles.map((s) => (
        <div key={s.label} className="flex min-w-0 flex-col justify-between gap-4 bg-card p-4 sm:p-5">
          <p className="text-xs font-semibold text-muted">{s.label}</p>
          <div className="flex flex-wrap items-end justify-between gap-2">
            {overview ? <span className={cx('ltr inline-block text-[clamp(1.35rem,2.5vw,2.2rem)] leading-none font-semibold tracking-tight tabular-nums', s.tone)}>{s.value}</span> : <Skeleton className="h-6 w-14" />}
            {overview && week.length > 1 && <Spark values={s.spark} color={s.color} />}
          </div>
        </div>
      ))}
    </div>
  );
}

// --- first-run steps -----------------------------------------------------------------------------

/** First-run steps as Whop's "recommended" cards: a raised tile with a 3px ledge that presses in. */
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
    <section className="workspace-sheet animate-fade-up flex w-full flex-col gap-4 p-5 sm:p-6" style={delay(100)}>
      <SectionHead title={s.title} aside={<span className="shrink-0 text-sm text-muted tabular-nums">{s.progress(done, steps.length)}</span>} />
      <div className="h-1 overflow-hidden rounded-full bg-ink/[0.06]">
        <div className="h-full rounded-full bg-brand transition-[width] duration-700" style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>
      <ol className="grid gap-2">
        {steps.map((step, i) => {
          const copy = s.steps[step.id];
          const current = !step.done && steps.slice(0, i).every((x) => x.done);
          return (
            <li key={step.id}>
              <Link
                href={step.href}
                className={cx(
                  'flex w-full items-center gap-3 rounded-2xl border p-3 text-start transition-colors',
                  step.done
                    ? 'border-line text-muted'
                    : current
                      ? 'border-brand/50 bg-card hover:bg-raised'
                      : 'border-line bg-card hover:bg-raised',
                )}
              >
                <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-xl', step.done || current ? 'bg-brand/12 text-brand' : 'bg-ink/[0.05] text-muted')}>
                  {step.done ? <Check className="size-5" /> : <step.icon className="size-5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cx('block text-sm font-semibold', step.done ? 'text-muted line-through decoration-muted/60' : 'text-ink')}>{copy.title}</span>
                  <span className="mt-0.5 line-clamp-1 block text-xs text-muted">{copy.text}</span>
                </span>
                <span className={cx('shrink-0 text-sm font-semibold tabular-nums', step.done ? 'text-brand' : 'text-faint')}>{step.done ? s.done : i + 1}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// --- the account's numbers -----------------------------------------------------------------------

/** Each linked number as a row (Whop's "balances" list): avatar with a status dot, name, phone, state. */
function NumbersList({ overview }: { overview: Overview | null }) {
  const { t, fmt } = useI18n();
  const d = t.dashboard;
  const sessions = useQuery({ queryKey: qk.sessions, queryFn: ({ signal }) => api<Session[]>('/api/whatsapp-sessions', { signal }) });
  const list = sessions.data ?? [];
  const order: SessionStatus[] = ['connected', 'connecting', 'needs_attention'];
  const rows = [...list].sort((a, b) => (order.indexOf(a.status) + 1 || 9) - (order.indexOf(b.status) + 1 || 9)).slice(0, 5);
  const connected = overview?.sessions.byStatus.connected ?? list.filter((s) => s.status === 'connected').length;

  return (
    <section className="workspace-sheet animate-fade-up flex w-full flex-col gap-4 p-5 sm:p-6" style={delay(140)}>
      <SectionHead
        title={
          <span className="flex items-baseline gap-2">
            {d.numbersTitle}
            {list.length > 0 && <span className="text-sm font-medium text-muted tabular-nums">{d.connectedRing(fmt.number.format(connected), fmt.number.format(list.length))}</span>}
          </span>
        }
        aside={list.length > 0 && <MoreLink href="/sessions">{d.viewAll}</MoreLink>}
      />
      {sessions.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-16 rounded-2xl" />
          <Skeleton className="h-16 rounded-2xl" />
        </div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line-strong px-6 py-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-brand/12 text-brand">
            <Smartphone className="size-6" />
          </span>
          <p className="text-sm text-muted">{d.noSessions}</p>
          <Link href="/sessions?new=1" className="inline-flex h-9 items-center gap-2 rounded-[10px] bg-brand px-4 text-sm font-medium text-on-brand transition-colors hover:bg-brand-strong">
            <Plus className="size-4" /> {d.createSession}
          </Link>
        </div>
      ) : (
        <ul className="border-t border-line">
          {rows.map((s, i) => {
            const tone = SESSION_STATUS[s.status].tone;
            const seen = s.status === 'connected' ? null : s.lastSeenAt;
            return (
              <li key={s.id} className={cx(i > 0 && 'border-t border-line')}>
                <Link href={`/sessions/${s.id}`} className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-ink/[0.03]">
                  <span className="relative shrink-0">
                    <span className="flex size-10 items-center justify-center rounded-full bg-ink/[0.08] text-sm font-semibold">{initials(s.name)}</span>
                    <span className={cx('absolute -end-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-bg', TONES[tone].dot)} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{s.name}</span>
                    <span className="block truncate text-sm text-muted">{s.phoneNumber ? <span className="ltr">+{s.phoneNumber}</span> : d.notLinked}</span>
                  </span>
                  <span className="hidden shrink-0 flex-col items-end gap-1 @min-[480px]:flex">
                    <Badge tone={tone}>{t.status.session[s.status].label}</Badge>
                    {seen && <span className="text-xs text-faint">{d.lastActive(fmt.timeAgo(seen))}</span>}
                  </span>
                  <ChevronRight className={cx('size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5', flip)} />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// --- discover ------------------------------------------------------------------------------------

/** Whop's "recommended for you": raised cards, each a tinted glyph tile and one line of copy. */
function Discover() {
  const { t } = useI18n();
  const x = t.dashboard.discover;
  const { account } = useAccount();
  const cards = [
    { href: '/chats', icon: MessagesSquare, tint: 'bg-brand/12 text-brand', ...x.chats },
    ...(account?.user?.isAdmin ? [{ href: '/auto-reply', icon: Sparkles, tint: 'bg-progress/12 text-progress', ...x.autoReply }] : []),
    { href: '/templates', icon: FileText, tint: 'bg-info/12 text-info', ...x.templates },
    { href: '/guide', icon: Code, tint: 'bg-warning/12 text-warning', ...x.api },
  ];
  return (
    <section className="animate-fade-up flex w-full flex-col gap-4" style={delay(180)}>
      <SectionHead title={x.title} />
      <div className="grid gap-3 @min-[620px]:grid-cols-2">
        {cards.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="workspace-sheet group flex items-center gap-3 p-4 transition-colors hover:border-brand/45"
          >
            <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-xl', c.tint)}>
              <c.icon className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{c.title}</span>
              <span className="mt-0.5 line-clamp-1 block text-xs text-muted">{c.text}</span>
            </span>
            <ChevronRight aria-hidden className={cx('size-4 shrink-0 text-faint group-hover:text-brand', flip)} />
          </Link>
        ))}
      </div>
    </section>
  );
}

// --- side column ---------------------------------------------------------------------------------

function PlanPanel({ overview }: { overview: Overview | null }) {
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

  const meter = (label: string, used: number, limit: number | null) => (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-sm">
        <span className="text-muted">{label}</span>
        <span className="ltr inline-flex items-center gap-1 font-semibold tabular-nums">
          {fmt.number.format(used)} / {limit === null ? <InfinityIcon className="size-4 text-brand" /> : fmt.number.format(limit)}
        </span>
      </div>
      {limit !== null && <Progress value={limit > 0 ? Math.min(100, (used / limit) * 100) : 0} className="h-1.5" />}
    </div>
  );

  return (
    <Panel
      title={
        <span className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-muted">{d.subscription}</span>
          <span>{plan ? planName(plan) : '…'}</span>
        </span>
      }
      index={0}
      aside={
        daysLeft !== null &&
        !expired && <span className={cx('rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums', daysLeft <= 5 ? 'bg-warning/15 text-warning' : 'bg-brand/12 text-brand')}>{d.daysLeft(daysLeft)}</span>
      }
    >
      {!plan || !overview ? (
        <div className="space-y-3 px-3 pb-2">
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      ) : (
        <div className="space-y-4 px-3 pb-2">
          {meter(d.sessionsMeter, overview.sessions.total, unlimited ? null : plan.sessions)}
          {plan.dailyMessages !== null && meter(d.todayMeter, overview.messages.today.sent, plan.dailyMessages)}
          <p className={cx('text-xs font-medium', expired ? 'text-critical' : 'text-muted')}>{ends}</p>
        </div>
      )}
      <PanelLink href="/subscription">{d.manageSubscription}</PanelLink>
    </Panel>
  );
}

/** Whop's "Pulse": the latest messages across every number, under a live dot. */
function PulsePanel({ overview }: { overview: Overview | null }) {
  const { t, fmt } = useI18n();
  const d = t.dashboard;
  const live = (overview?.sessions.byStatus.connected ?? 0) > 0;
  return (
    <Panel
      title={
        <span className="flex items-center gap-2.5">
          {d.recent}
          <LiveDot on={live} />
        </span>
      }
      index={1}
    >
      {!overview ? (
        <div className="space-y-3 px-3 pb-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="size-9 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      ) : overview.recent.length === 0 ? (
        <div role="status" className="flex min-h-40 items-center justify-center px-6 py-8 text-center text-sm text-muted">
          {d.noActivity}
        </div>
      ) : (
        <ol className="max-h-[520px] overflow-y-auto py-1 [mask-image:linear-gradient(to_bottom,transparent,black_12px,black_calc(100%-12px),transparent)]">
          {overview.recent.slice(0, 8).map((m, i) => {
            const status = (m.status in MESSAGE_STATUS ? m.status : 'sent') as MessageStatus;
            const tone = m.direction === 'in' ? 'info' : MESSAGE_STATUS[status].tone;
            const Icon = m.direction === 'in' ? ArrowDownLeft : ArrowUpRight;
            return (
              <li key={m.id} className="animate-fade-up flex gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-ink/[0.04]" style={delay(240 + i * 40)}>
                <span className={cx('flex size-9 shrink-0 items-center justify-center rounded-full', TONES[tone].chip)}>
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold">{m.direction === 'in' ? d.incoming : d.outgoing}</p>
                    <MessageStatusBadge status={status} />
                  </div>
                  {/* The message keeps its own direction (an English line inside Arabic stays readable). */}
                  <p dir="auto" className="truncate text-sm text-ink-2 rtl:text-right">
                    {m.text ?? `[${m.type}]`}
                  </p>
                  <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
                    <span className="ltr shrink-0">+{m.jid.split('@')[0]}</span>
                    <span aria-hidden>·</span>
                    <span className="truncate">{m.sessionName}</span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{fmt.timeAgo(m.createdAt)}</span>
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
  const [days, setDays] = useState<Range>(14);
  // Each range is cached on its own; switching keeps the previous chart up until the new one lands.
  // Live events refresh it from the app shell.
  const query = useQuery({
    queryKey: qk.overview(days),
    queryFn: ({ signal }) => api<Overview>(`/api/overview?days=${days}`, { signal }),
    placeholderData: keepPreviousData,
  });
  const overview = query.data ?? null;

  return (
    <div className="@container flex flex-col gap-4 sm:gap-5">
      <OverviewHeader live={(overview?.sessions.byStatus.connected ?? 0) > 0} />
      {query.isError && <LoadError error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />}
      <TodayStats overview={overview} />
      <div className="grid w-full grid-cols-1 items-start gap-5 pb-12 @min-[860px]:grid-cols-[minmax(0,1fr)_minmax(16rem,30%)]">
        <div className="flex min-w-0 flex-col gap-5">
          <Hero overview={overview} days={days} onDays={setDays} loading={query.isFetching} />
          {overview && <Setup overview={overview} />}
          <NumbersList overview={overview} />
          <Discover />
        </div>
        <div className="flex min-w-0 flex-col gap-5 @min-[860px]:sticky @min-[860px]:top-20">
          <PlanPanel overview={overview} />
          <PulsePanel overview={overview} />
        </div>
      </div>
    </div>
  );
}
