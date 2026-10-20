import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowUpRight,
  CalendarDays,
  Clock,
  Eye,
  FileText,
  Hourglass,
  KeyRound,
  LogIn,
  LogOut,
  Monitor,
  MousePointerClick,
  Search,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Table2,
  Timer,
  TrendingUp,
  UserPlus,
  Users,
} from '../icons';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { qk } from '../queries';
import { Badge, Button, Card, cx, delay, EmptyState, inputClass, Loading, LoadError, Modal, Pagination, Select, type Tone, TONES } from '../ui';

// --- types (see apps/api/src/routes/admin-activity.ts) -------------------------------------------

type UserRef = { id: string; name: string | null; email: string };

export type ActivitySummary = {
  since: string;
  users: number;
  onlineNow: number;
  online: (UserRef & { lastPath: string | null; startedAt: string; lastSeenAt: string })[];
  activeToday: number;
  active7d: number;
  activePeriod: number;
  visits: number;
  activeSeconds: number;
  avgVisitSeconds: number;
  loginsToday: number;
  loginsPeriod: number;
  failedLogins24h: number;
  newUsers: number;
  daily: { day: string; activeUsers: number; visits: number; activeSeconds: number; logins: number; signups: number }[];
  heatmap: { dow: number; hour: number; visits: number }[];
  topUsers: (UserRef & { activeSeconds: number; visits: number })[];
  topPages: { path: string; views: number }[];
};

type ActivityUser = UserRef & {
  role: 'user' | 'admin';
  status: 'active' | 'suspended';
  createdAt: string;
  lastSeenAt: string | null;
  online: boolean;
  visits: number;
  activeSeconds: number;
  lastLoginAt: string | null;
  lastIp: string | null;
  lastAgent: string | null;
  failedLogins: number;
};

type EventType = 'signup' | 'login' | 'login_failed' | 'logout' | 'password_reset' | 'page' | 'action';
type ActivityEvent = { id: number; type: EventType; createdAt: string; ip: string | null; userAgent: string | null; details: Record<string, unknown>; user: UserRef | null };

type Visit = {
  id: string;
  startedAt: string;
  lastSeenAt: string;
  activeSeconds: number;
  pageViews: number;
  entryPath: string | null;
  lastPath: string | null;
  ip: string | null;
  userAgent: string | null;
  online: boolean;
  user: UserRef;
};

type UserDetail = {
  user: UserRef & { phone: string | null; role: 'user' | 'admin'; status: 'active' | 'suspended'; createdAt: string; planId: string | null; twoFactor: boolean };
  online: boolean;
  lastSeenAt: string | null;
  firstSeenAt: string | null;
  stats: { visits: number; activeSeconds: number; avgVisitSeconds: number; longestVisitSeconds: number; pageViews: number; activeDays: number; logins: number; failedLogins: number; actions: number };
  daily: { day: string; activeSeconds: number; visits: number }[];
  hours: number[];
  devices: { userAgent: string | null; ip: string | null; lastAt: string; visits: number }[];
  logins: { id: string; createdAt: string; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null }[];
};

type Page<T> = { items: T[]; total: number; page: number; pageSize: number };

const PAGE_SIZE = 25;
export const PERIODS = [7, 30, 90] as const;
export type Period = (typeof PERIODS)[number];

/** The admin's own time zone: the API counts days and hours the way they see them. */
const TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

const withTz = (params: Record<string, string | number | undefined>) => {
  const query = new URLSearchParams({ tz: TZ });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') query.set(k, String(v));
  return query;
};

/** Platform activity, kept fresh while an admin has the page open (the online list moves by the minute). */
export function useActivitySummary(days: Period, enabled = true) {
  return useQuery({
    queryKey: qk.admin.activity.summary(days),
    queryFn: ({ signal }) => api<ActivitySummary>(`/api/admin/activity/summary?${withTz({ days })}`, { signal }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    enabled,
  });
}

function useDebounced<T>(value: T, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** A `YYYY-MM-DD` day as local midnight (formatting a UTC midnight would shift it west of Greenwich). */
const parseDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};

// --- small pieces --------------------------------------------------------------------------------

/** Browser and system from a user agent: enough to tell devices apart, nothing more. */
export function parseAgent(ua: string | null) {
  if (!ua) return null;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Android/.test(ua)
        ? 'Android'
        : /CrOS/.test(ua)
          ? 'ChromeOS'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'macOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /SamsungBrowser/.test(ua)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS/.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS/.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : null;
  return { os, browser, mobile: /Mobi|iPhone|Android/.test(ua) };
}

function Device({ ua, ip, compact }: { ua: string | null; ip?: string | null; compact?: boolean }) {
  const { t } = useI18n();
  const d = t.admin.activity.device;
  const agent = parseAgent(ua);
  const Icon = agent?.mobile ? Smartphone : Monitor;
  const label = agent?.browser && agent.os ? d.on(agent.browser, agent.os) : (agent?.browser ?? agent?.os ?? d.unknown);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted" title={ua ?? undefined}>
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
      {ip && !compact && <span className="ltr shrink-0 font-mono text-[11px] text-faint">{ip}</span>}
    </span>
  );
}

const initialsOf = (user: UserRef) => {
  const source = user.name?.trim() || user.email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
};

export function Avatar({ user, online, size = 'md' }: { user: UserRef; online?: boolean; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span
      className={cx(
        'relative flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-raised to-line-strong font-semibold text-ink-2',
        size === 'sm' ? 'size-7 text-[10px]' : size === 'lg' ? 'size-14 text-lg' : 'size-9 text-xs',
      )}
    >
      {initialsOf(user)}
      {online && (
        <span className={cx('absolute end-0 bottom-0 rounded-full bg-good ring-2 ring-card', size === 'lg' ? 'size-3.5' : 'size-2.5')}>
          <span className="absolute inset-0 animate-ping rounded-full bg-good/70 motion-reduce:hidden" />
        </span>
      )}
    </span>
  );
}

function UserCell({ user, online, onOpen, sub }: { user: UserRef; online?: boolean; onOpen?: () => void; sub?: ReactNode }) {
  const body = (
    <>
      <Avatar user={user} online={online} size="sm" />
      <span className="min-w-0 text-start">
        <span className="block truncate text-sm font-medium">{user.name ?? user.email}</span>
        {sub ? <span className="block truncate text-xs text-muted">{sub}</span> : <span className="ltr block truncate text-xs text-muted">{user.email}</span>}
      </span>
    </>
  );
  return onOpen ? (
    <button type="button" onClick={onOpen} className="flex max-w-full min-w-0 items-center gap-2.5 rounded-md text-start hover:text-brand focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
      {body}
    </button>
  ) : (
    <span className="flex min-w-0 items-center gap-2.5">{body}</span>
  );
}

/** The period the numbers cover: 7, 30 or 90 days ending today. */
export function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const { t } = useI18n();
  return (
    <div role="radiogroup" aria-label={t.admin.period(value)} className="flex gap-0.5 rounded-lg border border-line bg-card p-0.5 shadow-xs">
      {PERIODS.map((p) => (
        <button
          key={p}
          type="button"
          role="radio"
          aria-checked={value === p}
          onClick={() => onChange(p)}
          className={cx('h-7 rounded-md px-3 text-xs font-medium whitespace-nowrap transition-colors', value === p ? 'bg-ink text-bg' : 'text-muted hover:text-ink')}
        >
          {t.admin.period(p)}
        </button>
      ))}
    </div>
  );
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return (
    <div className="flex gap-0.5 rounded-lg border border-line p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cx('flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors', value === o.value ? 'bg-raised text-ink' : 'text-muted hover:text-ink')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Kpi({
  icon: Icon,
  label,
  value,
  hint,
  tone,
  index = 0,
  live,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  hint?: ReactNode;
  tone?: Tone;
  index?: number;
  live?: boolean;
}) {
  return (
    <div className="animate-fade-up lift flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-card p-4 shadow-sm" style={delay(index * 40)}>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-medium text-muted">{label}</p>
        <span className={cx('flex size-7 shrink-0 items-center justify-center rounded-lg', tone ? TONES[tone].chip : 'bg-raised text-muted')}>
          <Icon className="size-3.5" />
        </span>
      </div>
      <p className="flex items-center gap-2 text-2xl leading-none font-semibold tracking-tight whitespace-nowrap tabular-nums">
        {live && (
          <span className="relative flex size-2.5">
            <span className="absolute inset-0 animate-ping rounded-full bg-good/70 motion-reduce:hidden" />
            <span className="relative size-2.5 rounded-full bg-good" />
          </span>
        )}
        {value}
      </p>
      {hint && <p className="truncate text-xs text-faint">{hint}</p>}
    </div>
  );
}

// --- charts --------------------------------------------------------------------------------------

/** Clean axis maximum and step (1, 2, 5 × 10ⁿ). */
function niceScale(max: number, ticks = 4) {
  if (max <= 0) return { max: ticks, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return { max: Math.ceil(max / step) * step, step };
}

type Bar = { key: string; label: string; tooltip: string; value: number };

/**
 * One series of bars on a recessive grid, with a hover/focus readout. Plain HTML so it follows the
 * page direction (time runs from the start edge) and stays crisp at any width.
 */
function Bars({ bars, format, height = 'h-52', labelEvery }: { bars: Bar[]; format: (v: number) => string; height?: string; labelEvery?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const { max, step } = niceScale(Math.max(0, ...bars.map((b) => b.value)));
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const every = labelEvery ?? Math.max(1, Math.ceil(bars.length / 8));
  const shown = hover === null ? null : bars[hover];

  return (
    <div className="relative select-none">
      <div className={cx('relative ms-9', height)}>
        {ticks.map((tick) => (
          <div key={tick} className="absolute inset-x-0 border-t border-ink/[0.07]" style={{ bottom: `${(tick / max) * 100}%` }}>
            <span className="absolute -start-9 -top-2 w-7 text-end text-[10px] text-faint tabular-nums">{format(tick)}</span>
          </div>
        ))}
        <div className="absolute inset-0 flex items-end gap-[2px]" onMouseLeave={() => setHover(null)}>
          {bars.map((bar, i) => (
            <button
              key={bar.key}
              type="button"
              aria-label={bar.tooltip}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              className="flex h-full min-w-0 flex-1 items-end rounded-t-[4px] focus-visible:outline-none"
            >
              <span
                className={cx('w-full rounded-t-[4px] transition-[opacity,height] duration-300', hover !== null && hover !== i ? 'opacity-45' : 'opacity-100')}
                style={{ height: `${(bar.value / max) * 100}%`, minHeight: bar.value > 0 ? 2 : 0, background: 'var(--color-series-sent)' }}
              />
            </button>
          ))}
        </div>
        {shown && hover !== null && (
          <div
            className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full rounded-md border border-line bg-card px-2.5 py-1.5 text-xs whitespace-nowrap shadow-lg rtl:translate-x-1/2"
            style={{ insetInlineStart: `${((hover + 0.5) / bars.length) * 100}%` }}
          >
            <p className="text-muted">{shown.label}</p>
            <p className="font-semibold tabular-nums">{shown.tooltip}</p>
          </div>
        )}
      </div>
      <div className="ms-9 mt-1.5 flex gap-[2px]">
        {bars.map((bar, i) => (
          <span key={bar.key} className="min-w-0 flex-1 overflow-visible text-center text-[10px] whitespace-nowrap text-faint">
            {i % every === 0 ? bar.label : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

type Metric = 'activeUsers' | 'minutes' | 'visits' | 'logins';

function DailyActivity({ summary }: { summary: ActivitySummary }) {
  const { t, fmt } = useI18n();
  const a = t.admin.activity;
  const [metric, setMetric] = useState<Metric>('activeUsers');
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const valueOf = (d: ActivitySummary['daily'][number]) =>
    metric === 'activeUsers' ? d.activeUsers : metric === 'minutes' ? Math.round(d.activeSeconds / 60) : metric === 'visits' ? d.visits : d.logins;
  const total = summary.daily.reduce((s, d) => s + valueOf(d), 0);
  const empty = summary.daily.every((d) => d.visits === 0 && d.logins === 0);
  const bars = summary.daily.map((d) => {
    const v = valueOf(d);
    return {
      key: d.day,
      label: fmt.dayShort.format(parseDay(d.day)),
      value: v,
      tooltip: `${a.chart.metrics[metric]}: ${metric === 'minutes' ? a.duration(d.activeSeconds) : fmt.number.format(v)}`,
    };
  });

  return (
    <Card
      title={a.chart.title}
      description={metric === 'activeUsers' ? undefined : `${a.chart.total}: ${metric === 'minutes' ? a.duration(total * 60) : fmt.number.format(total)}`}
      className="animate-fade-up"
      actions={
        <>
          <Select value={metric} onChange={setMetric} className="w-44" aria-label={a.chart.title} options={(Object.keys(a.chart.metrics) as Metric[]).map((m) => ({ value: m, label: a.chart.metrics[m] }))} />
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: 'chart', label: <TrendingUp className="size-3.5" aria-label={a.chart.chart} /> },
              { value: 'table', label: <Table2 className="size-3.5" aria-label={a.chart.table} /> },
            ]}
          />
        </>
      }
    >
      {empty ? (
        <EmptyState icon={Activity} title={a.chart.empty} />
      ) : view === 'chart' ? (
        <div className="pt-6">
          <Bars bars={bars} format={(v) => (metric === 'minutes' && v >= 1000 ? `${Math.round(v / 60)}h` : fmt.number.format(v))} />
        </div>
      ) : (
        <div className="code-scroll max-h-72 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-line text-muted">
                <th className="h-9 px-2 text-start font-medium">{a.chart.day}</th>
                {(Object.keys(a.chart.metrics) as Metric[]).map((m) => (
                  <th key={m} className="h-9 px-2 text-end font-medium">
                    {a.chart.metrics[m]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums [&_tr]:border-b [&_tr]:border-line/60">
              {[...summary.daily].reverse().map((d) => (
                <tr key={d.day}>
                  <td className="px-2 py-1.5">{fmt.dayLong.format(parseDay(d.day))}</td>
                  <td className="px-2 py-1.5 text-end">{fmt.number.format(d.activeUsers)}</td>
                  <td className="px-2 py-1.5 text-end">{a.duration(d.activeSeconds)}</td>
                  <td className="px-2 py-1.5 text-end">{fmt.number.format(d.visits)}</td>
                  <td className="px-2 py-1.5 text-end">{fmt.number.format(d.logins)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** One hue, light → dark: an empty cell is the plain raised surface. */
const heat = (share: number) => (share <= 0 ? 'var(--color-raised)' : `color-mix(in oklab, var(--color-brand) ${Math.round(18 + share * 82)}%, var(--color-raised))`);

function PeakHours({ summary }: { summary: ActivitySummary }) {
  const { t, fmt } = useI18n();
  const h = t.admin.activity.heatmap;
  const weekdays = t.admin.activity.weekdays;
  const grid = useMemo(() => {
    const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    for (const c of summary.heatmap) cells[c.dow]![c.hour] = c.visits;
    return cells;
  }, [summary.heatmap]);
  const max = Math.max(0, ...grid.flat());
  const [hover, setHover] = useState<{ dow: number; hour: number } | null>(null);

  return (
    <Card title={h.title} description={h.text} className="animate-fade-up">
      <div className="code-scroll overflow-x-auto">
        <div className="min-w-[34rem] space-y-[3px]" onMouseLeave={() => setHover(null)}>
          {grid.map((row, dow) => (
            <div key={dow} className="flex items-center gap-[3px]">
              <span className="w-16 shrink-0 truncate text-[11px] text-muted">{weekdays[dow]}</span>
              {row.map((n, hour) => (
                <button
                  key={hour}
                  type="button"
                  aria-label={h.cell(weekdays[dow]!, fmt.hour(hour), n)}
                  onMouseEnter={() => setHover({ dow, hour })}
                  onFocus={() => setHover({ dow, hour })}
                  className={cx('h-5 min-w-0 flex-1 rounded-[3px] transition-[box-shadow]', hover?.dow === dow && hover.hour === hour && 'ring-2 ring-ink/60')}
                  style={{ background: heat(max ? n / max : 0) }}
                />
              ))}
            </div>
          ))}
          <div className="flex gap-[3px] pt-1">
            <span className="w-16 shrink-0" />
            {Array.from({ length: 24 }, (_, hour) => (
              <span key={hour} className="min-w-0 flex-1 text-center text-[10px] whitespace-nowrap text-faint">
                {hour % 3 === 0 ? fmt.hour(hour) : ''}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs">
        <p className="min-h-4 font-medium text-ink-2">{hover ? h.cell(weekdays[hover.dow]!, fmt.hour(hover.hour), grid[hover.dow]![hover.hour]!) : <span className="text-faint">{h.hint}</span>}</p>
        <span className="flex items-center gap-1.5 text-faint">
          {h.less}
          {[0, 0.25, 0.5, 0.75, 1].map((s) => (
            <span key={s} className="size-3 rounded-[3px]" style={{ background: heat(s) }} />
          ))}
          {h.more}
        </span>
      </div>
    </Card>
  );
}

// --- events --------------------------------------------------------------------------------------

const EVENT_LOOK: Record<EventType, { icon: typeof Users; tone: Tone }> = {
  signup: { icon: UserPlus, tone: 'good' },
  login: { icon: LogIn, tone: 'info' },
  login_failed: { icon: ShieldAlert, tone: 'critical' },
  logout: { icon: LogOut, tone: 'neutral' },
  password_reset: { icon: KeyRound, tone: 'warning' },
  page: { icon: FileText, tone: 'neutral' },
  action: { icon: MousePointerClick, tone: 'progress' },
};

/** A page path as the sidebar names it ("/chats" → "Chats"). */
function usePageName() {
  const { t } = useI18n();
  const nav = t.app.nav as Record<string, string>;
  return (path: string | null) => {
    if (!path) return '—';
    const first = path.split('/')[1] ?? '';
    if (first === 'profile') return t.profile.title;
    return nav[first] ?? path;
  };
}

function useDescribeEvent() {
  const { t } = useI18n();
  const l = t.admin.activity.log;
  const pageName = usePageName();
  return (e: ActivityEvent): { title: string; note: string | null } => {
    const d = e.details;
    const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null);
    switch (e.type) {
      case 'login': {
        const method = str('method');
        return { title: l.types.login, note: method ? (l.methods[method] ?? method) : null };
      }
      case 'login_failed': {
        const reason = str('reason');
        return { title: l.types.login_failed, note: [reason ? (l.reasons[reason] ?? reason) : null, str('identifier')].filter(Boolean).join(' · ') || null };
      }
      case 'logout': {
        const since = str('loggedInAt');
        const seconds = since ? Math.max(0, (new Date(e.createdAt).getTime() - new Date(since).getTime()) / 1000) : null;
        return { title: l.types.logout, note: seconds !== null ? l.sessionLength(t.admin.activity.duration(seconds)) : null };
      }
      case 'page':
        return { title: l.opened(pageName(str('path'))), note: null };
      case 'action': {
        const method = str('method') ?? '';
        const route = str('route') ?? '';
        const status = typeof d.status === 'number' ? d.status : 200;
        const known = l.actions[`${method} ${route}`];
        const title = known ?? (route.startsWith('/api/admin') ? l.adminAction : `${method} ${route}`);
        return { title, note: status >= 400 ? l.failedStatus(status) : null };
      }
      default:
        return { title: l.types[e.type], note: null };
    }
  };
}

function EventRow({ event, onUser, showUser = true }: { event: ActivityEvent; onUser?: (id: string) => void; showUser?: boolean }) {
  const { t, fmt } = useI18n();
  const describe = useDescribeEvent();
  const look = EVENT_LOOK[event.type];
  const { title, note } = describe(event);
  const failed = event.type === 'action' && typeof event.details.status === 'number' && event.details.status >= 400;
  return (
    <li className="flex items-start gap-3 py-3">
      <span className={cx('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full', TONES[failed ? 'warning' : look.tone].chip)}>
        <look.icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm">
          <span className="font-medium">{title}</span>
          {note && <span className={cx('text-muted', (event.type === 'login_failed' || failed) && 'text-critical')}> · <bdi>{note}</bdi></span>}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {showUser &&
            (event.user ? (
              <button type="button" onClick={() => onUser?.(event.user!.id)} className="inline-flex min-w-0 items-center gap-1.5 text-xs text-ink-2 hover:text-brand">
                <Avatar user={event.user} size="sm" />
                <span className="truncate">{event.user.name ?? event.user.email}</span>
              </button>
            ) : (
              <span className="text-xs text-faint">{t.admin.activity.log.unknownUser}</span>
            ))}
          <Device ua={event.userAgent} ip={event.ip} />
        </div>
      </div>
      <time dateTime={event.createdAt} title={fmt.dateTime(event.createdAt)} className="shrink-0 pt-0.5 text-xs whitespace-nowrap text-muted">
        {fmt.timeAgo(event.createdAt)}
      </time>
    </li>
  );
}

function EventsList({ userId, onUser, compact }: { userId?: string; onUser?: (id: string) => void; compact?: boolean }) {
  const { t } = useI18n();
  const l = t.admin.activity.log;
  const [type, setType] = useState<EventType | 'all'>('all');
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const filters = `${type}|${q}`;
  const [paging, setPaging] = useState({ filters, page: 1 });
  const page = paging.filters === filters ? paging.page : 1;
  const events = useQuery({
    queryKey: qk.admin.activity.events({ userId, type, q, page }),
    queryFn: ({ signal }) =>
      api<Page<ActivityEvent>>(`/api/admin/activity/events?${withTz({ userId, type: type === 'all' ? undefined : type, q, page, pageSize: PAGE_SIZE })}`, { signal }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const data = events.data;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={type}
          onChange={setType}
          className="w-56"
          aria-label={l.typeLabel}
          options={[{ value: 'all' as const, label: l.allTypes }, ...(Object.keys(l.types) as EventType[]).map((k) => ({ value: k, label: l.types[k] }))]}
        />
        {!compact && (
          <label className="relative block w-64 max-w-full">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={l.search} className={cx(inputClass, 'ps-8')} />
          </label>
        )}
      </div>
      {events.isError && <LoadError error={events.error} onRetry={() => void events.refetch()} retrying={events.isFetching} />}
      {!data ? (
        !events.isError && <Loading />
      ) : data.items.length === 0 ? (
        <EmptyState icon={FileText} title={l.empty} />
      ) : (
        <>
          <ul className={cx('divide-y divide-line/70 transition-opacity', events.isPlaceholderData && 'opacity-60')}>
            {data.items.map((e) => (
              <EventRow key={e.id} event={e} onUser={onUser} showUser={!userId} />
            ))}
          </ul>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => setPaging({ filters, page: p })} busy={events.isFetching} />
        </>
      )}
    </div>
  );
}

function VisitsTable({ userId, onUser }: { userId?: string; onUser?: (id: string) => void }) {
  const { t, fmt, dir } = useI18n();
  const a = t.admin.activity;
  const v = a.visits;
  const pageName = usePageName();
  const [page, setPage] = useState(1);
  const visits = useQuery({
    queryKey: qk.admin.activity.visits({ userId, page }),
    queryFn: ({ signal }) => api<Page<Visit>>(`/api/admin/activity/visits?${withTz({ userId, page, pageSize: PAGE_SIZE })}`, { signal }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const data = visits.data;
  const th = 'h-10 px-2 text-start font-medium whitespace-nowrap text-muted';
  const td = 'px-2 py-2.5 whitespace-nowrap align-middle';

  if (visits.isError) return <LoadError error={visits.error} onRetry={() => void visits.refetch()} retrying={visits.isFetching} />;
  if (!data) return <Loading />;
  if (data.items.length === 0) return <EmptyState icon={CalendarDays} title={v.empty} />;
  return (
    <div className={cx('table-stack overflow-x-auto transition-opacity', visits.isPlaceholderData && 'opacity-60')}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line">
            {!userId && <th className={th}>{v.cols.user}</th>}
            <th className={th}>{v.cols.came}</th>
            <th className={th}>{v.cols.left}</th>
            <th className={th}>{v.cols.duration}</th>
            <th className={th}>{v.cols.pages}</th>
            <th className={th}>{v.cols.path}</th>
            <th className={th}>{v.cols.device}</th>
          </tr>
        </thead>
        <tbody className="[&_tr]:border-b [&_tr]:border-line/60 [&_tr:last-child]:border-0">
          {data.items.map((visit) => (
            <tr key={visit.id} className="transition-colors hover:bg-raised/30">
              {!userId && (
                <td data-label={v.cols.user} className={cx(td, 'max-w-60')}>
                  <UserCell user={visit.user} online={visit.online} onOpen={onUser ? () => onUser(visit.user.id) : undefined} />
                </td>
              )}
              <td data-label={v.cols.came} className={td}>
                <span title={fmt.dateTime(visit.startedAt)}>{fmt.upcoming(visit.startedAt)}</span>
              </td>
              <td data-label={v.cols.left} className={td}>
                {visit.online ? <Badge tone="good">{v.stillHere}</Badge> : <span title={fmt.dateTime(visit.lastSeenAt)}>{fmt.upcoming(visit.lastSeenAt)}</span>}
              </td>
              <td data-label={v.cols.duration} className={cx(td, 'font-medium tabular-nums')}>
                {a.duration(visit.activeSeconds)}
              </td>
              <td data-label={v.cols.pages} className={cx(td, 'tabular-nums')}>
                {fmt.number.format(visit.pageViews)}
              </td>
              <td data-label={v.cols.path} className={cx(td, 'text-xs text-muted')}>
                {pageName(visit.entryPath)}
                {visit.lastPath && visit.lastPath !== visit.entryPath && (
                  <>
                    {dir === 'rtl' ? ' ← ' : ' → '}
                    {pageName(visit.lastPath)}
                  </>
                )}
              </td>
              <td data-label={v.cols.device} className={cx(td, 'max-w-64')}>
                <Device ua={visit.userAgent} ip={visit.ip} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} busy={visits.isFetching} />
    </div>
  );
}

// --- one user ------------------------------------------------------------------------------------

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="rounded-lg border border-line/70 bg-raised/30 px-3 py-2.5">
      <p className="truncate text-[11px] font-medium text-muted">{label}</p>
      <p className={cx('mt-1 text-lg leading-tight font-semibold tabular-nums', tone && TONES[tone].text)}>{value}</p>
    </div>
  );
}

export function UserActivityModal({ userId, days, onClose }: { userId: string; days: Period; onClose: () => void }) {
  const { t, fmt } = useI18n();
  const a = t.admin.activity;
  const d = a.detail;
  const [view, setView] = useState<'visits' | 'events'>('visits');
  const detail = useQuery({
    queryKey: qk.admin.activity.user(userId, days),
    queryFn: ({ signal }) => api<UserDetail>(`/api/admin/activity/users/${userId}?${withTz({ days })}`, { signal }),
    refetchInterval: 30_000,
  });
  const data = detail.data;
  const title = data ? (data.user.name ?? data.user.email) : '…';
  // When the dialog opened: enough to tell an expired login from an active one.
  const [now] = useState(() => Date.now());

  return (
    <Modal title={title} description={t.admin.period(days)} onClose={onClose} size="xl">
      {detail.isError && <LoadError error={detail.error} onRetry={() => void detail.refetch()} retrying={detail.isFetching} />}
      {!data ? (
        !detail.isError && <Loading />
      ) : (
        <div className="space-y-6 pb-6">
          <div className="flex flex-wrap items-center gap-4 rounded-xl border border-line bg-raised/20 p-4">
            <Avatar user={data.user} online={data.online} size="lg" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <p className="ltr truncate text-sm text-muted">{data.user.email}</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {data.online ? <Badge tone="good">{a.kpi.onlineNow}</Badge> : <Badge tone="neutral">{data.lastSeenAt ? d.lastSeen(fmt.timeAgo(data.lastSeenAt)) : a.users.never}</Badge>}
                {data.user.role === 'admin' && <Badge tone="info">{t.app.admin}</Badge>}
                {data.user.status === 'suspended' && <Badge tone="critical">{t.admin.users.statusSuspended}</Badge>}
                <Badge tone={data.user.twoFactor ? 'good' : 'warning'}>
                  <ShieldCheck className="me-1 size-3" />
                  {data.user.twoFactor ? d.twoFactorOn : d.twoFactorOff}
                </Badge>
                {data.user.phone && <span className="ltr font-mono text-xs text-muted">{data.user.phone}</span>}
              </div>
              <p className="text-xs text-faint">
                {d.joined(fmt.date(data.user.createdAt))}
                {data.firstSeenAt && ` · ${d.firstSeen(fmt.date(data.firstSeenAt))}`}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <MiniStat label={d.stats.time} value={a.duration(data.stats.activeSeconds)} />
            <MiniStat label={d.stats.visits} value={fmt.number.format(data.stats.visits)} />
            <MiniStat label={d.stats.avgVisit} value={a.duration(data.stats.avgVisitSeconds)} />
            <MiniStat label={d.stats.longest} value={a.duration(data.stats.longestVisitSeconds)} />
            <MiniStat label={d.stats.activeDays} value={`${fmt.number.format(data.stats.activeDays)} / ${days}`} />
            <MiniStat label={d.stats.pageViews} value={fmt.number.format(data.stats.pageViews)} />
            <MiniStat label={d.stats.logins} value={fmt.number.format(data.stats.logins)} />
            <MiniStat label={d.stats.failed} value={fmt.number.format(data.stats.failedLogins)} tone={data.stats.failedLogins > 0 ? 'critical' : undefined} />
            <MiniStat label={d.stats.actions} value={fmt.number.format(data.stats.actions)} />
          </div>

          <div className="grid gap-4 lg:grid-cols-5">
            <section className="space-y-4 rounded-xl border border-line p-4 lg:col-span-3">
              <h3 className="text-sm font-semibold">{d.daily}</h3>
              <Bars
                height="h-40"
                format={(v) => fmt.number.format(v)}
                bars={data.daily.map((p) => ({
                  key: p.day,
                  label: fmt.dayShort.format(parseDay(p.day)),
                  value: Math.round(p.activeSeconds / 60),
                  tooltip: `${a.duration(p.activeSeconds)} · ${a.visitsCount(p.visits)}`,
                }))}
              />
            </section>
            <section className="space-y-4 rounded-xl border border-line p-4 lg:col-span-2">
              <div>
                <h3 className="text-sm font-semibold">{d.hours}</h3>
                <p className="text-xs text-muted">{d.hoursText}</p>
              </div>
              <Bars
                height="h-32"
                labelEvery={6}
                format={(v) => fmt.number.format(v)}
                bars={data.hours.map((n, hour) => ({ key: String(hour), label: fmt.hour(hour), value: n, tooltip: a.visitsCount(n) }))}
              />
            </section>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="space-y-2 rounded-xl border border-line p-4">
              <h3 className="text-sm font-semibold">{d.devices}</h3>
              {data.devices.length === 0 ? (
                <p className="py-4 text-sm text-faint">{d.noDevices}</p>
              ) : (
                <ul className="divide-y divide-line/60">
                  {data.devices.map((dev, i) => (
                    <li key={i} className="flex items-center justify-between gap-3 py-2">
                      <Device ua={dev.userAgent} ip={dev.ip} />
                      <span className="shrink-0 text-xs text-faint" title={fmt.dateTime(dev.lastAt)}>
                        {a.visitsCount(dev.visits)} · {fmt.timeAgo(dev.lastAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="space-y-2 rounded-xl border border-line p-4">
              <h3 className="text-sm font-semibold">{d.logins}</h3>
              {data.logins.length === 0 ? (
                <p className="py-4 text-sm text-faint">{d.noLogins}</p>
              ) : (
                <ul className="code-scroll max-h-64 divide-y divide-line/60 overflow-y-auto">
                  {data.logins.map((login) => {
                    const state = login.revokedAt ? 'ended' : login.expiresAt && new Date(login.expiresAt).getTime() < now ? 'expired' : 'active';
                    const end = login.revokedAt ?? (state === 'expired' ? login.expiresAt : null);
                    return (
                      <li key={login.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5">
                            <LogIn className="size-3.5 text-muted" />
                            <span title={fmt.dateTime(login.createdAt)}>{fmt.dateTime(login.createdAt)}</span>
                          </span>
                          <span className="block text-xs text-faint">
                            {end ? `→ ${fmt.dateTime(end)}` : login.lastUsedAt ? d.lastUsed(fmt.timeAgo(login.lastUsedAt)) : null}
                          </span>
                        </span>
                        <Badge tone={state === 'active' ? 'good' : 'neutral'}>{d.loginStatus[state]}</Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>

          <section className="space-y-3">
            <Segmented
              value={view}
              onChange={setView}
              options={[
                { value: 'visits', label: d.tabs.visits },
                { value: 'events', label: d.tabs.events },
              ]}
            />
            {view === 'visits' ? <VisitsTable userId={userId} /> : <EventsList userId={userId} compact />}
          </section>
        </div>
      )}
    </Modal>
  );
}

// --- overview ------------------------------------------------------------------------------------

type PlatformStats = { users: number; activePaid: number; sessions: number; connected: number; pendingRequests: number; messagesToday: number; suspended: number };

export function AdminOverview({ days, platform, onTab }: { days: Period; platform: PlatformStats | undefined; onTab: (tab: 'activity' | 'logs' | 'requests') => void }) {
  const { t, fmt } = useI18n();
  const a = t.admin.activity;
  const s = t.admin.stats;
  const summary = useActivitySummary(days);
  const recent = useQuery({
    queryKey: [...qk.admin.activity.all, 'recent'],
    queryFn: ({ signal }) => api<Page<ActivityEvent>>(`/api/admin/activity/events?${withTz({ page: 1, pageSize: 8 })}`, { signal }),
    refetchInterval: 30_000,
  });
  const [openUser, setOpenUser] = useState<string | null>(null);
  const n = (v: number | undefined) => (v === undefined ? '…' : fmt.number.format(v));
  const data = summary.data;
  const pageName = usePageName();
  const maxTop = Math.max(1, ...(data?.topUsers.map((u) => u.activeSeconds) ?? [1]));
  const maxPage = Math.max(1, ...(data?.topPages.map((p) => p.views) ?? [1]));

  return (
    <div className="space-y-6">
      {platform && platform.pendingRequests > 0 && (
        <div className="animate-fade-up flex flex-wrap items-center justify-between gap-3 rounded-xl border border-info/30 bg-info/10 px-4 py-3">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Hourglass className="size-4 text-info" />
            {a.pending(platform.pendingRequests)}
          </p>
          <Button size="sm" variant="outline" onClick={() => onTab('requests')} icon={<ArrowUpRight className="size-4 rtl:-scale-x-100" />}>
            {a.review}
          </Button>
        </div>
      )}

      {summary.isError && <LoadError error={summary.error} onRetry={() => void summary.refetch()} retrying={summary.isFetching} />}

      <section className="space-y-3">
        <h2 className="text-xs font-semibold tracking-wider text-muted uppercase">{a.engagement}</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi index={0} icon={Activity} label={a.kpi.onlineNow} value={n(data?.onlineNow)} tone="good" live={Boolean(data?.onlineNow)} hint={data && a.kpi.ofUsers(data.users)} />
          <Kpi index={1} icon={Users} label={a.kpi.activeToday} value={n(data?.activeToday)} hint={data && a.kpi.week(data.active7d)} />
          <Kpi index={2} icon={CalendarDays} label={a.kpi.activePeriod} value={n(data?.activePeriod)} hint={a.kpi.inPeriod(days)} />
          <Kpi index={3} icon={Timer} label={a.kpi.avgVisit} value={data ? a.duration(data.avgVisitSeconds) : '…'} hint={data && a.visitsCount(data.visits)} />
          <Kpi index={4} icon={Clock} label={a.kpi.totalTime} value={data ? a.duration(data.activeSeconds) : '…'} hint={a.kpi.inPeriod(days)} />
          <Kpi index={5} icon={LogIn} label={a.kpi.loginsToday} value={n(data?.loginsToday)} hint={data && a.kpi.loginsPeriod(data.loginsPeriod)} />
          <Kpi
            index={6}
            icon={ShieldAlert}
            label={a.kpi.failed24h}
            value={n(data?.failedLogins24h)}
            tone={data?.failedLogins24h ? 'critical' : undefined}
            hint={data?.failedLogins24h ? a.kpi.failedHint : undefined}
          />
          <Kpi index={7} icon={UserPlus} label={a.kpi.newUsers} value={n(data?.newUsers)} hint={a.kpi.inPeriod(days)} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold tracking-wider text-muted uppercase">{a.platform}</h2>
        {/* Every tile draws its end and bottom edge; the grid reaches 1px past the box so the outer ones are clipped. */}
        <div className="overflow-hidden rounded-xl border border-line bg-card shadow-sm">
          <div className="-me-px -mb-px grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 [&>*]:border-line/60">
          {[
            { label: s.users, value: n(platform?.users) },
            { label: s.activePaid, value: n(platform?.activePaid) },
            { label: s.sessions, value: platform ? `${n(platform.connected)} / ${n(platform.sessions)}` : '…' },
            { label: s.messagesToday, value: n(platform?.messagesToday) },
            { label: s.pending, value: n(platform?.pendingRequests) },
            { label: s.suspended, value: n(platform?.suspended), critical: Boolean(platform?.suspended) },
          ].map((item, i) => (
            <div key={item.label} className="animate-fade-up border-e border-b px-4 py-3" style={delay(i * 40)}>
              <p className="truncate text-[11px] font-medium text-muted">{item.label}</p>
              <p className={cx('mt-1 text-lg font-semibold tabular-nums', item.critical && 'text-critical')}>{item.value}</p>
            </div>
          ))}
          </div>
        </div>
      </section>

      {!data ? (
        !summary.isError && <Loading />
      ) : (
        <>
          <div className="grid gap-6 xl:grid-cols-3">
            <div className="min-w-0 xl:col-span-2">
              <DailyActivity summary={data} />
            </div>
            <Card title={a.online.title} className="animate-fade-up" actions={<Badge tone={data.onlineNow ? 'good' : 'neutral'}>{fmt.number.format(data.onlineNow)}</Badge>}>
              {data.online.length === 0 ? (
                <EmptyState icon={Users} title={a.online.empty} />
              ) : (
                <ul className="code-scroll -my-2 max-h-80 divide-y divide-line/60 overflow-y-auto">
                  {data.online.map((u) => (
                    <li key={u.id} className="flex items-center justify-between gap-3 py-2.5">
                      <UserCell user={u} online onOpen={() => setOpenUser(u.id)} sub={pageName(u.lastPath)} />
                      <span className="shrink-0 text-xs text-faint" title={fmt.dateTime(u.startedAt)}>
                        {a.online.since(fmt.time(u.startedAt))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="grid gap-6 xl:grid-cols-3">
            <div className="min-w-0 xl:col-span-2">
              <PeakHours summary={data} />
            </div>
            <Card title={a.topUsers.title} className="animate-fade-up">
              {data.topUsers.length === 0 ? (
                <EmptyState icon={Clock} title={a.topUsers.empty} />
              ) : (
                <ol className="space-y-3">
                  {data.topUsers.map((u) => (
                    <li key={u.id} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-3">
                        <UserCell user={u} onOpen={() => setOpenUser(u.id)} sub={a.visitsCount(u.visits)} />
                        <span className="shrink-0 text-sm font-medium tabular-nums">{a.duration(u.activeSeconds)}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-raised">
                        <div className="h-full rounded-full" style={{ width: `${(u.activeSeconds / maxTop) * 100}%`, background: 'var(--color-series-sent)' }} />
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </div>

          <div className="grid gap-6 xl:grid-cols-3">
            <Card
              title={a.recent.title}
              className="animate-fade-up xl:col-span-2"
              actions={
                <Button variant="ghost" size="sm" onClick={() => onTab('logs')} icon={<ArrowUpRight className="size-4 rtl:-scale-x-100" />}>
                  {a.recent.all}
                </Button>
              }
            >
              {recent.isError && <LoadError error={recent.error} onRetry={() => void recent.refetch()} retrying={recent.isFetching} />}
              {!recent.data ? (
                !recent.isError && <Loading />
              ) : recent.data.items.length === 0 ? (
                <EmptyState icon={FileText} title={a.log.empty} />
              ) : (
                <ul className="-my-3 divide-y divide-line/70">
                  {recent.data.items.map((e) => (
                    <EventRow key={e.id} event={e} onUser={setOpenUser} />
                  ))}
                </ul>
              )}
            </Card>
            <Card title={a.topPages.title} className="animate-fade-up">
              {data.topPages.length === 0 ? (
                <EmptyState icon={Eye} title={a.topPages.empty} />
              ) : (
                <ul className="space-y-3">
                  {data.topPages.map((p) => (
                    <li key={p.path} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="truncate">{pageName(p.path)}</span>
                        <span className="shrink-0 text-muted tabular-nums">{fmt.number.format(p.views)}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-raised">
                        <div className="h-full rounded-full" style={{ width: `${(p.views / maxPage) * 100}%`, background: 'var(--color-series-sent)' }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
      {openUser && <UserActivityModal userId={openUser} days={days} onClose={() => setOpenUser(null)} />}
    </div>
  );
}

// --- users ---------------------------------------------------------------------------------------

type Sort = 'recent' | 'time' | 'visits' | 'newest' | 'failed';
type Filter = 'all' | 'online' | 'active' | 'inactive';

export function ActivityUsers({ days }: { days: Period }) {
  const { t, fmt } = useI18n();
  const a = t.admin.activity;
  const u = a.users;
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [filter, setFilter] = useState<Filter>('all');
  const q = useDebounced(search.trim(), 300);
  const filters = `${q}|${sort}|${filter}|${days}`;
  const [paging, setPaging] = useState({ filters, page: 1 });
  const page = paging.filters === filters ? paging.page : 1;
  const [openUser, setOpenUser] = useState<string | null>(null);

  const users = useQuery({
    queryKey: qk.admin.activity.users({ q, sort, filter, days, page }),
    queryFn: ({ signal }) => api<Page<ActivityUser>>(`/api/admin/activity/users?${withTz({ q, sort, filter, days, page, pageSize: PAGE_SIZE })}`, { signal }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const data = users.data;
  const maxTime = Math.max(1, ...(data?.items.map((r) => r.activeSeconds) ?? [1]));
  const th = 'h-10 px-2 text-start font-medium whitespace-nowrap text-muted';
  const td = 'px-2 py-3 whitespace-nowrap align-middle';

  return (
    <Card
      title={u.title}
      description={u.text}
      className="animate-fade-up"
      bodyClassName="px-4"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative block w-60 max-w-full">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={u.search} className={cx(inputClass, 'ps-8')} />
          </label>
          <Select value={filter} onChange={setFilter} className="w-48" aria-label={u.filters.all} options={(Object.keys(u.filters) as Filter[]).map((f) => ({ value: f, label: u.filters[f] }))} />
          <Select value={sort} onChange={setSort} className="w-48" aria-label={u.sortLabel} options={(Object.keys(u.sorts) as Sort[]).map((s) => ({ value: s, label: u.sorts[s] }))} />
        </div>
      }
    >
      {users.isError && <LoadError error={users.error} onRetry={() => void users.refetch()} retrying={users.isFetching} className="mb-4" />}
      {!data ? (
        !users.isError && <Loading />
      ) : data.items.length === 0 ? (
        <EmptyState icon={Users} title={u.empty} />
      ) : (
        <div className={cx('table-stack overflow-x-auto transition-opacity', users.isPlaceholderData && 'opacity-60')}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className={th}>{u.cols.user}</th>
                <th className={th}>{u.cols.lastSeen}</th>
                <th className={th}>{u.cols.time}</th>
                <th className={th}>{u.cols.visits}</th>
                <th className={th}>{u.cols.lastLogin}</th>
                <th className={th}>{u.cols.device}</th>
                <th className={th}>{u.cols.failed}</th>
                <th className={th}>
                  <span className="sr-only">{u.details}</span>
                </th>
              </tr>
            </thead>
            <tbody className="[&_tr]:border-b [&_tr]:border-line/60 [&_tr:last-child]:border-0">
              {data.items.map((row, i) => (
                <tr key={row.id} className="animate-fade-up transition-colors hover:bg-raised/30" style={delay(Math.min(i, 12) * 30)}>
                  <td data-label={u.cols.user} className={cx(td, 'max-w-72')}>
                    <UserCell user={row} online={row.online} onOpen={() => setOpenUser(row.id)} />
                  </td>
                  <td data-label={u.cols.lastSeen} className={td}>
                    {row.online ? (
                      <Badge tone="good">{a.kpi.onlineNow}</Badge>
                    ) : row.lastSeenAt ? (
                      <span title={fmt.dateTime(row.lastSeenAt)}>{fmt.timeAgo(row.lastSeenAt)}</span>
                    ) : (
                      <span className="text-faint">{u.never}</span>
                    )}
                  </td>
                  <td data-label={u.cols.time} className={td}>
                    <div className="flex min-w-28 items-center gap-2">
                      <span className="w-16 font-medium tabular-nums">{row.activeSeconds ? a.duration(row.activeSeconds) : '—'}</span>
                      <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-raised md:block">
                        <span className="block h-full rounded-full" style={{ width: `${(row.activeSeconds / maxTime) * 100}%`, background: 'var(--color-series-sent)' }} />
                      </span>
                    </div>
                  </td>
                  <td data-label={u.cols.visits} className={cx(td, 'tabular-nums')}>
                    {fmt.number.format(row.visits)}
                  </td>
                  <td data-label={u.cols.lastLogin} className={td}>
                    {row.lastLoginAt ? <span title={fmt.dateTime(row.lastLoginAt)}>{fmt.timeAgo(row.lastLoginAt)}</span> : <span className="text-faint">—</span>}
                  </td>
                  <td data-label={u.cols.device} className={cx(td, 'max-w-56')}>
                    {row.lastAgent || row.lastIp ? <Device ua={row.lastAgent} ip={row.lastIp} /> : <span className="text-faint">—</span>}
                  </td>
                  <td data-label={u.cols.failed} className={td}>
                    {row.failedLogins > 0 ? <Badge tone="critical">{fmt.number.format(row.failedLogins)}</Badge> : <span className="text-faint">0</span>}
                  </td>
                  <td className={cx(td, 'text-end')}>
                    <Button variant="outline" size="sm" onClick={() => setOpenUser(row.id)}>
                      {u.details}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => setPaging({ filters, page: p })} busy={users.isFetching} />
        </div>
      )}
      {openUser && <UserActivityModal userId={openUser} days={days} onClose={() => setOpenUser(null)} />}
    </Card>
  );
}

// --- log -----------------------------------------------------------------------------------------

export function ActivityLog({ days }: { days: Period }) {
  const { t } = useI18n();
  const l = t.admin.activity.log;
  const [view, setView] = useState<'events' | 'visits'>('events');
  const [openUser, setOpenUser] = useState<string | null>(null);
  return (
    <Card
      title={l.title}
      description={l.text}
      className="animate-fade-up"
      actions={
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'events', label: l.views.events },
            { value: 'visits', label: l.views.visits },
          ]}
        />
      }
    >
      {view === 'events' ? <EventsList onUser={setOpenUser} /> : <VisitsTable onUser={setOpenUser} />}
      {openUser && <UserActivityModal userId={openUser} days={days} onClose={() => setOpenUser(null)} />}
    </Card>
  );
}
