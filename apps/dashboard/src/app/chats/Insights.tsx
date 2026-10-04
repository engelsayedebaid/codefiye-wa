import { useQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, CheckCheck, Clock, MailWarning, MessageSquareReply, MessagesSquare, Sparkles } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { api } from '../../api';
import { useI18n } from '../../i18n';
import { qk } from '../../queries';
import { Card, cx, delay, LoadError, Loading, Select } from '../../ui';
import { type DailyPoint, MessagesChart } from '../MessagesChart';
import { Avatar, TypeLabel } from './Bubble';
import type { Insights as InsightsData } from './model';

const RANGES = [7, 14, 30, 90] as const;
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function Kpi({ icon: Icon, label, value, sub, index }: { icon: typeof Clock; label: string; value: string; sub?: ReactNode; index: number }) {
  return (
    <div className="lift animate-fade-up rounded-xl border border-line bg-card p-4" style={delay(index * 50)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted">{label}</p>
        <span className="flex size-8 items-center justify-center rounded-lg bg-brand/10 text-brand">
          <Icon className="size-4" />
        </span>
      </div>
      <p className="mt-2 text-2xl font-bold tracking-tight tabular-nums">{value}</p>
      {sub && <p className="mt-1 text-xs text-faint">{sub}</p>}
    </div>
  );
}

/** Every day of the range, so quiet days show as zero rather than vanishing from the line. */
function fillDays(daily: InsightsData['daily'], days: number): DailyPoint[] {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const out: DailyPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const row = byDay.get(key);
    out.push({ day: key, sent: row?.outbound ?? 0, received: row?.inbound ?? 0, failed: 0 });
  }
  return out;
}

/** Inbound messages by weekday × hour: one hue, darker = more (sequential). */
function Heatmap({ hours }: { hours: InsightsData['hours'] }) {
  const { t, fmt } = useI18n();
  const ins = t.chats.insights;
  const grid = useMemo(() => {
    const g = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    for (const h of hours) g[h.dow - 1]![h.hour] = h.n;
    return g;
  }, [hours]);
  const max = Math.max(1, ...hours.map((h) => h.n));
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null);
  const level = (n: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
  const shades = ['bg-raised/70', 'bg-brand/25', 'bg-brand/45', 'bg-brand/70', 'bg-brand'];

  return (
    <div>
      <div dir="ltr" className="overflow-x-auto">
        <div className="min-w-[560px]">
          <div className="grid grid-cols-[3.5rem_repeat(24,1fr)] gap-[3px]">
            <span />
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="text-center text-[10px] text-faint">
                {h % 3 === 0 ? fmt.hour(h).replace(/\s/g, '') : ''}
              </span>
            ))}
            {grid.map((row, d) => (
              <div key={d} className="contents">
                <span className="truncate pe-2 text-end text-[11px] leading-5 text-muted">{ins.days[d]!.slice(0, 3)}</span>
                {row.map((n, h) => (
                  <span
                    key={h}
                    role="img"
                    aria-label={ins.heatTip(ins.days[d]!, fmt.hour(h), fmt.number.format(n))}
                    onPointerEnter={() => setHover({ d, h })}
                    onPointerLeave={() => setHover(null)}
                    className={cx('h-5 rounded-[4px] transition-[transform,outline] duration-150', shades[level(n)], hover?.d === d && hover.h === h && 'scale-110 outline-2 outline-ink/60')}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span className="min-h-4 tabular-nums">{hover ? ins.heatTip(ins.days[hover.d]!, fmt.hour(hover.h), fmt.number.format(grid[hover.d]![hover.h]!)) : ''}</span>
        <span className="flex items-center gap-1.5">
          {ins.fewer}
          {shades.map((s) => (
            <span key={s} className={cx('size-3 rounded-[3px]', s)} />
          ))}
          {ins.more}
        </span>
      </div>
    </div>
  );
}

export function Insights({ sessionId, onOpenChat }: { sessionId: string; onOpenChat: (jid: string) => void }) {
  const { t, fmt } = useI18n();
  const ins = t.chats.insights;
  const [days, setDays] = useState<number>(14);
  const query = useQuery({
    queryKey: qk.chats.insights(sessionId, days),
    queryFn: ({ signal }) => api<InsightsData>(`/api/chats/${sessionId}/insights?${new URLSearchParams({ days: String(days), tz: timeZone })}`, { signal }),
    placeholderData: (prev) => prev,
  });
  const data = query.data;
  const n = (v: number) => fmt.number.format(v);
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');
  const duration = (sec: number | null) => {
    if (sec === null) return '—';
    if (sec < 60) return ins.seconds(Math.round(sec));
    if (sec < 3600) return ins.minutes(Math.round(sec / 60));
    return ins.hours(Math.round((sec / 3600) * 10) / 10);
  };
  const daily = useMemo(() => (data ? fillDays(data.daily, days) : []), [data, days]);
  const maxType = Math.max(1, ...(data?.types.map((x) => x.n) ?? [1]));

  return (
    <div className="code-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-5 p-4 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-xl font-bold tracking-tight">
              <Sparkles className="size-5 text-brand" /> {ins.title}
            </h2>
          </div>
          <Select<string> aria-label={ins.range} value={String(days)} onChange={(v) => setDays(Number(v))} options={RANGES.map((r) => ({ value: String(r), label: ins.ranges[r] }))} className="w-36" />
        </div>

        {query.isError && !data ? (
          <LoadError error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
        ) : !data ? (
          <Loading className="py-24" />
        ) : (
          <div className={cx('space-y-5 transition-opacity', query.isPlaceholderData && 'opacity-60')}>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi index={0} icon={ArrowDownLeft} label={ins.inbound} value={n(data.totals.inbound)} />
              <Kpi index={1} icon={ArrowUpRight} label={ins.outbound} value={n(data.totals.outbound)} />
              <Kpi index={2} icon={MessagesSquare} label={ins.activeChats} value={n(data.totals.activeChats)} sub={`${ins.newChats}: ${n(data.totals.newChats)}`} />
              <Kpi index={3} icon={MailWarning} label={ins.unread} value={n(data.totals.unread)} />
              <Kpi
                index={4}
                icon={MessageSquareReply}
                label={ins.replyRate}
                value={pct(data.totals.replied, data.totals.contacted)}
                sub={ins.replyRateText(n(data.totals.replied), n(data.totals.contacted))}
              />
              <Kpi index={5} icon={Clock} label={ins.responseTime} value={duration(data.totals.medianResponseSec)} sub={ins.responseTimeText(n(data.totals.responses))} />
              <Kpi index={6} icon={CheckCheck} label={ins.readRate} value={pct(data.totals.read, data.totals.delivered)} sub={ins.readRateText(n(data.totals.read), n(data.totals.delivered))} />
              <Kpi index={7} icon={ArrowUpRight} label={t.chats.panel.deliveredRate} value={pct(data.totals.delivered, data.totals.outbound - data.totals.failed)} sub={`${t.chats.panel.failed}: ${n(data.totals.failed)}`} />
            </div>

            <Card title={ins.volume} className="animate-fade-up" style={delay(120)}>
              <MessagesChart data={daily} loading={query.isFetching} />
            </Card>

            <div className="grid gap-5 lg:grid-cols-5">
              <Card title={ins.heatmap} description={ins.heatmapText} className="animate-fade-up lg:col-span-3" style={delay(160)}>
                <Heatmap hours={data.hours} />
              </Card>
              <Card title={ins.types} className="animate-fade-up lg:col-span-2" style={delay(200)}>
                {data.types.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted">{ins.none}</p>
                ) : (
                  <ul className="space-y-2.5">
                    {data.types.map((row) => (
                      <li key={row.type} className="grid grid-cols-[7rem_1fr_auto] items-center gap-3 text-sm">
                        <span className="truncate text-ink-2">
                          <TypeLabel type={row.type} />
                        </span>
                        <span className="h-2 overflow-hidden rounded-full bg-raised">
                          <span className="block h-full rounded-full bg-[var(--color-series-received)] transition-[width] duration-700" style={{ width: `${(row.n / maxType) * 100}%` }} />
                        </span>
                        <span className="text-muted tabular-nums">{n(row.n)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            <Card title={ins.top} description={ins.topText} className="animate-fade-up" style={delay(240)}>
              {data.top.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted">{ins.none}</p>
              ) : (
                <ul className="divide-y divide-line">
                  {data.top.map((row, i) => {
                    const title = row.name || row.phone || row.jid.split('@')[0]!;
                    return (
                      <li key={row.jid}>
                        <button type="button" onClick={() => onOpenChat(row.jid)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-start transition-colors hover:bg-raised/60">
                          <span className="w-5 text-center text-sm font-semibold text-faint tabular-nums">{i + 1}</span>
                          <Avatar name={title} id={row.jid} group={row.jid.endsWith('@g.us')} size="sm" />
                          <span className="min-w-0 flex-1 pii">
                            <span dir="auto" className="block truncate text-sm font-medium">
                              {title}
                            </span>
                            {row.name && row.phone && <span className="ltr block truncate font-mono text-xs text-muted">{row.phone}</span>}
                          </span>
                          <span className="flex items-center gap-3 text-xs tabular-nums">
                            <span className="flex items-center gap-1 text-ink-2">
                              <ArrowDownLeft className="size-3.5 text-[var(--color-series-received)]" />
                              {n(row.inbound)}
                            </span>
                            <span className="flex items-center gap-1 text-ink-2">
                              <ArrowUpRight className="size-3.5 text-[var(--color-series-sent)]" />
                              {n(row.outbound)}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
