import { type KeyboardEvent, type PointerEvent, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { cx } from '../ui';
import type { DailyPoint } from './MessagesChart';

/*
 * The dashboard's headline chart, drawn the way Whop draws a balance: the chosen series as one
 * smooth line with a soft wash under it, the other series faint behind it, no y-axis, three day
 * labels, and a tooltip that follows the pointer or the arrow keys. Today is still filling up, so
 * its piece of the line is dashed instead of plunging like a real drop.
 */

export type Metric = 'sent' | 'received';
const COLOR: Record<Metric, string> = { sent: 'var(--color-series-sent)', received: 'var(--color-series-received)' };
const PAD = { top: 18, right: 10, bottom: 26, left: 10 };

const parseDay = (d: string) => new Date(`${d}T00:00:00Z`);

/**
 * Smooth cubic pieces through the points that never overshoot them (monotone cubic,
 * Fritsch–Carlson): a quiet day stays at zero instead of dipping below the baseline.
 * Returns one "C…" piece per gap, so a caller can style the last one apart.
 */
export function smoothSegments(points: [number, number][]) {
  const n = points.length;
  if (n < 2) return [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) slope.push((points[i + 1]![1] - points[i]![1]) / (points[i + 1]![0] - points[i]![0] || 1));
  const tangent = points.map((_, i) => (i === 0 ? slope[0]! : i === n - 1 ? slope[n - 2]! : slope[i - 1]! * slope[i]! <= 0 ? 0 : (slope[i - 1]! + slope[i]!) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i]! / slope[i]!;
    const b = tangent[i + 1]! / slope[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      tangent[i] = k * a * slope[i]!;
      tangent[i + 1] = k * b * slope[i]!;
    }
  }
  return points.slice(0, -1).map(([x0, y0], i) => {
    const [x1, y1] = points[i + 1]!;
    const third = (x1 - x0) / 3;
    return `C${x0 + third},${y0 + tangent[i]! * third} ${x1 - third},${y1 - tangent[i + 1]! * third} ${x1},${y1}`;
  });
}

export function smoothPath(points: [number, number][]) {
  if (points.length === 0) return '';
  return `M${points[0]![0]},${points[0]![1]}${smoothSegments(points).join('')}`;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  // Measured before the first paint, so the chart never starts wider than its box (a phone would scroll sideways).
  useLayoutEffect(() => {
    if (!ref.current) return;
    setWidth(Math.max(200, ref.current.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(200, entry!.contentRect.width)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

export function HeroChart({ data, focus = 'sent', loading, height = 220 }: { data: DailyPoint[]; focus?: Metric; loading?: boolean; height?: number }) {
  const { t, fmt, dir } = useI18n();
  const [hover, setHover] = useState<number | null>(null);
  const { ref, width } = useWidth<HTMLDivElement>();
  const other: Metric = focus === 'sent' ? 'received' : 'sent';

  const last = data.length - 1;
  const innerW = Math.max(1, width - PAD.left - PAD.right);
  const innerH = height - PAD.top - PAD.bottom;
  // Scaled to the chosen series (with headroom), so it fills the chart even when the other one is far bigger.
  const top = Math.max(1, ...data.map((d) => d[focus])) * 1.12;
  const x = (i: number) => PAD.left + (last <= 0 ? innerW / 2 : (i / last) * innerW);
  // The faint series can be far bigger: it flattens along the top edge instead of leaving the chart.
  const y = (v: number) => PAD.top + innerH - (Math.min(v, top) / top) * innerH;
  const base = y(0);
  const points = (key: Metric) => data.map((d, i): [number, number] => [x(i), y(d[key])]);

  const main = points(focus);
  const pieces = smoothSegments(main);
  const start = main[0] ? `M${main[0][0]},${main[0][1]}` : '';
  const done = start + pieces.slice(0, -1).join('');
  const todayPiece = main.length > 1 ? `M${main[last - 1]![0]},${main[last - 1]![1]}${pieces.at(-1)}` : '';
  const labels = last <= 0 ? [0] : [0, Math.round(last / 2), last];

  const onPointer = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    setHover(Math.min(last, Math.max(0, Math.round(((px - PAD.left) / innerW) * last))));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setHover((h) => Math.min(last, Math.max(0, (h ?? last) + (e.key === 'ArrowRight' ? 1 : -1))));
  };

  const at = hover ?? last;
  const point = data[at];
  const totals = { sent: data.reduce((s, d) => s + d.sent, 0), received: data.reduce((s, d) => s + d.received, 0) };

  return (
    <div ref={ref} dir="ltr" className={cx('relative w-full min-w-0 transition-opacity duration-300', loading && 'opacity-50')}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={t.chart.aria(fmt.number.format(totals.sent), fmt.number.format(totals.received))}
          tabIndex={0}
          className="block touch-none overflow-visible rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onPointerMove={onPointer}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setHover(last)}
          onBlur={() => setHover(null)}
          onKeyDown={onKey}
        >
          <defs>
            <linearGradient id={`hero-wash-${focus}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={COLOR[focus]} stopOpacity="0.28" />
              <stop offset="100%" stopColor={COLOR[focus]} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Three faint guides and the baseline. */}
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={PAD.left} x2={width - PAD.right} y1={PAD.top + innerH * f} y2={PAD.top + innerH * f} stroke="color-mix(in oklab, var(--color-ink) 5%, transparent)" strokeWidth={1} />
          ))}
          <line x1={PAD.left} x2={width - PAD.right} y1={base} y2={base} stroke="color-mix(in oklab, var(--color-ink) 14%, transparent)" strokeWidth={1} />

          {data.length > 1 && <path d={`${smoothPath(main)}L${x(last)},${base}L${x(0)},${base}Z`} fill={`url(#hero-wash-${focus})`} />}
          <path d={smoothPath(points(other))} fill="none" stroke={COLOR[other]} strokeWidth={1.5} strokeLinecap="round" opacity={0.35} />
          <path key={focus} d={done} fill="none" stroke={COLOR[focus]} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" pathLength={1} className="chart-line" />
          {todayPiece && <path d={todayPiece} fill="none" stroke={COLOR[focus]} strokeWidth={2.5} strokeLinecap="round" strokeDasharray="2 6" />}

          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top - 6} y2={base} stroke="color-mix(in oklab, var(--color-ink) 30%, transparent)" strokeWidth={1} strokeDasharray="3 3" />}
          {point && (
            <>
              {hover !== null && <circle cx={x(at)} cy={y(point[other])} r={3} fill={COLOR[other]} stroke="var(--color-card)" strokeWidth={2} />}
              <circle cx={x(at)} cy={y(point[focus])} r={4.5} fill={COLOR[focus]} stroke="var(--color-card)" strokeWidth={2.5} />
            </>
          )}

          {labels.map((i) =>
            data[i] ? (
              <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'} className="fill-faint text-[11px]">
                {fmt.dayShort.format(parseDay(data[i]!.day))}
              </text>
            ) : null,
          )}
        </svg>
      )}

      {hover !== null && point && (
        <div
          role="status"
          dir={dir}
          className="pointer-events-none absolute top-0 z-10 min-w-40 rounded-xl border border-line bg-bg/95 px-3 py-2 text-sm shadow-xl shadow-black/30 backdrop-blur-sm light:shadow-black/10"
          style={x(hover) > width / 2 ? { right: width - x(hover) + 14 } : { left: x(hover) + 14 }}
        >
          <p className="mb-1.5 text-xs text-muted">
            {fmt.dayLong.format(parseDay(point.day))}
            {hover === last && ` · ${t.dashboard.soFar}`}
          </p>
          {([focus, other] as const).map((key) => (
            <p key={key} className={cx('flex items-center gap-2', key === other && 'text-muted')}>
              <span className="size-2 rounded-full" style={{ background: COLOR[key] }} />
              <span className={cx('font-semibold tabular-nums', key === focus && 'text-ink')}>{fmt.number.format(point[key])}</span>
              <span className="text-muted">{t.chart[key]}</span>
            </p>
          ))}
          {point.failed > 0 && <p className="mt-1 text-xs text-critical">{t.chart.failedTip(fmt.number.format(point.failed))}</p>}
        </div>
      )}
    </div>
  );
}
