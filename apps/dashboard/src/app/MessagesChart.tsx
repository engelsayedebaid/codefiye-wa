import { Table2, TrendingUp } from 'lucide-react';
import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { cx } from '../ui';

export type DailyPoint = { day: string; sent: number; received: number; failed: number };

/**
 * Two categorical series on the card surface. Validated with the dataviz skill's validator against
 * #171717 (lightness band, chroma, CVD ΔE 25.1, contrast). Grid/axis/halo follow --color-ink, so the
 * same chart reads on the dark and the light card.
 */
const SERIES = [
  { key: 'sent', color: 'var(--color-series-sent)' },
  { key: 'received', color: 'var(--color-series-received)' },
] as const;

const SURFACE = 'var(--color-card)';
const GRID = 'color-mix(in oklab, var(--color-ink) 8%, transparent)';
const AXIS = 'color-mix(in oklab, var(--color-ink) 22%, transparent)';
const HOVER = 'color-mix(in oklab, var(--color-ink) 38%, transparent)';
const HEIGHT = 260;
const PAD = { top: 16, right: 44, bottom: 30, left: 40 };

const parseDay = (d: string) => new Date(`${d}T00:00:00Z`);

/** Clean y-axis maximum and step (1, 2, 5 × 10ⁿ). */
function niceScale(max: number, ticks = 4) {
  if (max <= 0) return { max: ticks, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return { max: Math.ceil(max / step) * step, step };
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry!.contentRect.width)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

export function MessagesChart({ data, loading }: { data: DailyPoint[]; loading?: boolean }) {
  const { t, fmt, dir } = useI18n();
  const numberFormat = fmt.number;
  const dayLabel = fmt.dayShort;
  const fullDay = fmt.dayLong;
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [hover, setHover] = useState<number | null>(null);
  const { ref, width } = useWidth<HTMLDivElement>();

  const totals = useMemo(() => ({ sent: data.reduce((s, d) => s + d.sent, 0), received: data.reduce((s, d) => s + d.received, 0) }), [data]);
  const { max, step } = niceScale(Math.max(0, ...data.flatMap((d) => [d.sent, d.received])));
  const innerW = width - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (data.length <= 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.floor(innerW / 70)));
  const last = data.length - 1;

  const onPointer = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const i = Math.round(((px - PAD.left) / innerW) * last);
    setHover(Math.min(last, Math.max(0, i)));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const delta = e.key === 'ArrowRight' ? 1 : -1;
    setHover((h) => Math.min(last, Math.max(0, (h ?? last) + delta)));
  };

  // End labels: nudge apart only when they'd overlap; ordered by value.
  const ends = SERIES.map((s) => ({ ...s, value: data[last]?.[s.key] ?? 0 })).map((s) => ({ ...s, y: y(s.value) }));
  if (ends.length === 2 && Math.abs(ends[0]!.y - ends[1]!.y) < 14) {
    const [hi, lo] = ends[0]!.value >= ends[1]!.value ? [ends[0]!, ends[1]!] : [ends[1]!, ends[0]!];
    hi.y -= 7;
    lo.y += 7;
  }

  const hovered = hover !== null ? data[hover] : null;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ul className="flex flex-wrap items-center gap-x-6 gap-y-2" aria-label={t.chart.legend}>
          {SERIES.map((s) => (
            <li key={s.key} className="flex items-center gap-2 text-sm">
              <span className="h-0.5 w-4 rounded-full" style={{ background: s.color }} />
              <span className="text-ink-2">{t.chart[s.key]}</span>
              <span className="font-semibold text-ink">{numberFormat.format(totals[s.key])}</span>
            </li>
          ))}
        </ul>
        <div className="flex rounded-md border border-line p-0.5" role="group" aria-label={t.chart.view}>
          {(
            [
              ['chart', t.chart.chart, TrendingUp],
              ['table', t.chart.table, Table2],
            ] as const
          ).map(([v, label, Icon]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={cx('flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium', view === v ? 'bg-ink/[0.08] text-ink' : 'text-muted hover:text-ink')}
            >
              <Icon className="size-3.5" /> {label}
            </button>
          ))}
        </div>
      </div>

      {view === 'table' ? (
        <div className="mt-4 max-h-[260px] overflow-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card text-muted">
              <tr>
                <th className="px-3 py-2 text-start font-medium">{t.chart.day}</th>
                <th className="px-3 py-2 text-end font-medium">{t.chart.sent}</th>
                <th className="px-3 py-2 text-end font-medium">{t.chart.received}</th>
                <th className="px-3 py-2 text-end font-medium">{t.chart.failed}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line tabular-nums">
              {[...data].reverse().map((d) => (
                <tr key={d.day}>
                  <td className="px-3 py-2">{dayLabel.format(parseDay(d.day))}</td>
                  <td className="px-3 py-2 text-end">{numberFormat.format(d.sent)}</td>
                  <td className="px-3 py-2 text-end">{numberFormat.format(d.received)}</td>
                  <td className="px-3 py-2 text-end">{numberFormat.format(d.failed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={ref} dir="ltr" className={cx('relative mt-4 w-full min-w-0 overflow-hidden transition-opacity', loading && 'opacity-50')}>
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={t.chart.aria(numberFormat.format(totals.sent), numberFormat.format(totals.received))}
            tabIndex={0}
            className="block touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            onPointerMove={onPointer}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(last)}
            onBlur={() => setHover(null)}
            onKeyDown={onKey}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? AXIS : GRID} strokeWidth={1} />
                <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-faint text-[11px] tabular-nums">
                  {numberFormat.format(t)}
                </text>
              </g>
            ))}
            {data.map((d, i) =>
              (i % labelEvery === 0 && last - i >= labelEvery) || i === last ? (
                <text key={d.day} x={x(i)} y={HEIGHT - 8} textAnchor={i === last ? 'end' : i === 0 ? 'start' : 'middle'} className="fill-faint text-[11px]">
                  {dayLabel.format(parseDay(d.day))}
                </text>
              ) : null,
            )}

            {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} stroke={HOVER} strokeWidth={1} />}

            {SERIES.map((s) => (
              <polyline
                key={s.key}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={data.map((d, i) => `${x(i)},${y(d[s.key])}`).join(' ')}
                pathLength={1}
                className="chart-line"
              />
            ))}

            {SERIES.map((s) => {
              const i = hover ?? last;
              const v = data[i]?.[s.key] ?? 0;
              return <circle key={s.key} cx={x(i)} cy={y(v)} r={4} fill={s.color} stroke={SURFACE} strokeWidth={2} />;
            })}

            {hover === null &&
              ends.map((s) => (
                <text key={s.key} x={x(last) + 9} y={s.y} dy="0.32em" className="fill-ink-2 text-[12px] font-semibold tabular-nums">
                  {numberFormat.format(s.value)}
                </text>
              ))}
          </svg>

          {hovered && hover !== null && (
            <div
              role="status"
              className="pointer-events-none absolute top-2 z-10 min-w-40 rounded-lg border border-line-strong bg-card/95 px-3 py-2 text-sm shadow-xl backdrop-blur-sm"
              style={x(hover) > width / 2 ? { right: width - x(hover) + 12 } : { left: x(hover) + 12 }}
              dir={dir}
            >
              <p className="mb-1.5 text-xs text-muted">{fullDay.format(parseDay(hovered.day))}</p>
              {SERIES.map((s) => (
                <p key={s.key} className="flex items-center gap-2">
                  <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
                  <span className="font-semibold tabular-nums">{numberFormat.format(hovered[s.key])}</span>
                  <span className="text-muted">{t.chart[s.key]}</span>
                </p>
              ))}
              {hovered.failed > 0 && <p className="mt-1 text-xs text-muted">{t.chart.failedTip(numberFormat.format(hovered.failed))}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
