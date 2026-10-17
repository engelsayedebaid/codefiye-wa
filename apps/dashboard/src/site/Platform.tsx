import { Check, CheckCheck, Clock, Plus, SendHorizontal, ShieldCheck, Smartphone } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { cx, Reveal } from '../ui';
import { PLATFORM_ICONS } from './content';
import { SectionHeading } from './SiteChrome';

function Tile({
  icon: Icon,
  title,
  text,
  badge,
  wide,
  className,
  delay = 0,
  children,
}: {
  icon: typeof Check;
  title: string;
  text: string;
  badge?: string;
  /** Text beside the illustration on large screens instead of above it. */
  wide?: boolean;
  className?: string;
  delay?: number;
  children: ReactNode;
}) {
  return (
    <Reveal delay={delay} className={cx('h-full min-w-0', className)}>
      <article className={cx('site-card flex h-full flex-col gap-6 overflow-hidden rounded-2xl p-6 sm:p-7', wide && 'lg:grid lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:items-center lg:gap-8')}>
        <div>
          <div className="flex items-center justify-between gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-brand/10 text-brand ring-1 ring-brand/20">
              <Icon className="size-5" />
            </span>
            {badge && <span className="rounded-full border border-line px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-muted">{badge}</span>}
          </div>
          <h3 className="mt-5 text-lg font-semibold">{title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted">{text}</p>
        </div>
        <div aria-hidden className={cx('mt-auto min-w-0', wide && 'lg:mt-0')}>
          {children}
        </div>
      </article>
    </Reveal>
  );
}

function ApiVisual() {
  const { t } = useI18n();
  const p = t.landing.platform.api;
  return (
    <div className="space-y-4">
      <div dir="ltr" className="overflow-hidden rounded-xl border border-white/10 bg-[#0a0e0d] font-mono text-[12px] leading-6 text-[#d4d4d4] shadow-lg">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2 text-[11px] text-white/55">
          <span className="rounded bg-[#34d399]/15 px-1.5 py-0.5 font-bold text-[#34d399]">POST</span>
          /api/send-message
        </div>
        <pre className="code-scroll overflow-x-auto px-4 py-3">
          <code>
            <span className="text-[#569cd6]">curl</span> -X POST <span className="text-[#ce9178]">$API/send-message</span> \{'\n'}
            {'  '}-H <span className="text-[#ce9178]">"Authorization: Bearer was_…"</span> \{'\n'}
            {'  '}-d <span className="text-[#ce9178]">{`'{"to":"+201012345678","text":"Hello 👋"}'`}</span>
          </code>
        </pre>
        <div className="flex items-center justify-between gap-3 border-t border-white/10 bg-black/30 px-4 py-2 text-[11px]">
          <span className="text-[#34d399]">200 OK · "status": "queued"</span>
          <span className="text-white/40">38 ms</span>
        </div>
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {p.types.map((type) => (
          <li key={type} className="rounded-full border border-line bg-bg/50 px-2.5 py-1 text-[11px] font-medium text-ink-2">
            {type}
          </li>
        ))}
      </ul>
    </div>
  );
}

function NumbersVisual() {
  const { t } = useI18n();
  const p = t.landing.platform.numbers;
  return (
    <ul className="space-y-2">
      {p.rows.map((r, i) => {
        const reconnecting = i === p.rows.length - 1;
        return (
          <li key={r.name} className="flex items-center gap-3 rounded-lg border border-line bg-bg/50 px-3 py-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-raised text-muted">
              <Smartphone className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{r.name}</span>
              <span className="block text-[11px] text-faint">
                <span className="ltr">{r.phone}</span>
              </span>
            </span>
            <span
              className={cx(
                'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium',
                reconnecting ? 'bg-warning/12 text-warning' : 'bg-good/12 text-good',
              )}
            >
              <span className={cx('size-1.5 rounded-full', reconnecting ? 'animate-pulse bg-warning' : 'bg-good')} />
              {r.status}
            </span>
          </li>
        );
      })}
      <li className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-line-strong py-2 text-[12px] font-medium text-muted">
        <Plus className="size-3.5" />
        {p.add}
      </li>
    </ul>
  );
}

function InboxVisual() {
  const { t } = useI18n();
  const chats = t.landing.mock.chats.slice(1, 4);
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-bg/50">
      {chats.map((c, i) => (
        <li key={c.name} className="flex items-center gap-3 px-3 py-2.5">
          <span
            className={cx(
              'flex size-8 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold',
              ['bg-sender-violet/15 text-sender-violet', 'bg-sender-amber/15 text-sender-amber', 'bg-sender-sky/15 text-sender-sky'][i],
            )}
          >
            {c.name.replace(/^(dr\.|د\.)\s*/i, '').charAt(0)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[12px] font-semibold">{c.name}</span>
              <span className={cx('ltr shrink-0 text-[10px]', c.unread ? 'font-semibold text-brand' : 'text-faint')}>{c.time}</span>
            </span>
            <span className="mt-0.5 flex items-center justify-between gap-2">
              <span className="truncate text-[11px] text-muted">{c.text}</span>
              {c.unread > 0 && <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-brand text-[9px] font-bold text-on-brand">{c.unread}</span>}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function CampaignVisual() {
  const { t } = useI18n();
  const p = t.landing.platform.campaigns;
  return (
    <div className="rounded-xl border border-line bg-bg/50 p-4">
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <span className="truncate font-medium">{p.name}</span>
        <span className="ltr shrink-0 text-xs font-semibold text-brand">64%</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-raised">
        <div className="h-full w-[64%] rounded-full bg-gradient-to-r from-grad-from to-grad-to rtl:bg-gradient-to-l" />
      </div>
      <p className="mt-2 text-xs text-muted">{p.progress}</p>
      <ul className="mt-3.5 flex flex-wrap gap-1.5">
        {p.chips.map((chip) => (
          <li key={chip} className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand">
            <ShieldCheck className="size-3" />
            {chip}
          </li>
        ))}
      </ul>
    </div>
  );
}

function OtpVisual() {
  const { t } = useI18n();
  return (
    <div className="chat-wall overflow-hidden rounded-xl border border-line p-4">
      <div className="relative ms-auto w-fit max-w-[92%] rounded-xl rounded-se-sm bg-(--chat-out) px-3 py-2 text-[12.5px] leading-relaxed text-ink shadow-[0_1px_1px_rgb(0_0_0/0.08)]">
        {t.landing.platform.otp.message}
        <span className="mt-1 flex items-center justify-end gap-1 text-[10px] text-muted">
          <span className="ltr">10:42</span>
          <CheckCheck className="size-3.5 text-[#53bdeb]" />
        </span>
      </div>
    </div>
  );
}

const TRACK_TIMES = ['10:42:01', '10:42:01', '10:42:02', '10:42:03', '10:45:17'];
const TRACK_ICONS = [Clock, SendHorizontal, Check, CheckCheck, CheckCheck];

function TrackingVisual() {
  const { t } = useI18n();
  const steps = t.landing.platform.tracking.steps;
  return (
    <ol className="grid grid-cols-5 gap-2">
      {steps.map((step, i) => {
        const Icon = TRACK_ICONS[i]!;
        const read = i === steps.length - 1;
        return (
          <li key={step} className="relative flex flex-col items-center text-center">
            {/* The line from the previous step to this one (logical, so it runs the right way in RTL). */}
            {i > 0 && <span className="absolute end-1/2 top-4 h-px w-[calc(100%+0.5rem)] bg-brand/40" />}
            <span
              className={cx(
                'relative flex size-8 items-center justify-center rounded-full border bg-card',
                read ? 'border-info/50 text-info' : 'border-brand/40 text-brand',
                (i === 1) && 'rtl:-scale-x-100',
              )}
            >
              <Icon className="size-4" />
            </span>
            <span className="mt-2 text-[11px] leading-tight font-medium sm:text-xs">{step}</span>
            <span className="ltr mt-0.5 hidden text-[10px] text-faint sm:block">{TRACK_TIMES[i]}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function Platform() {
  const { t } = useI18n();
  const p = t.landing.platform;
  return (
    <section id="platform" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading kicker={p.kicker} title={p.title} accent={p.accent} text={p.text} breakAccent />
        <div className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-6 lg:gap-5">
          <Tile icon={PLATFORM_ICONS.api} title={p.api.title} text={p.api.text} wide className="md:col-span-2 lg:col-span-4">
            <ApiVisual />
          </Tile>
          <Tile icon={PLATFORM_ICONS.numbers} title={p.numbers.title} text={p.numbers.text} delay={80} className="lg:col-span-2">
            <NumbersVisual />
          </Tile>
          <Tile icon={PLATFORM_ICONS.inbox} title={p.inbox.title} text={p.inbox.text} badge={p.inbox.badge} className="lg:col-span-2">
            <InboxVisual />
          </Tile>
          <Tile icon={PLATFORM_ICONS.campaigns} title={p.campaigns.title} text={p.campaigns.text} badge={p.campaigns.badge} delay={80} className="lg:col-span-2">
            <CampaignVisual />
          </Tile>
          <Tile icon={PLATFORM_ICONS.otp} title={p.otp.title} text={p.otp.text} delay={160} className="md:col-span-2 lg:col-span-2">
            <OtpVisual />
          </Tile>
          <Tile icon={PLATFORM_ICONS.tracking} title={p.tracking.title} text={p.tracking.text} wide className="md:col-span-2 lg:col-span-6">
            <TrackingVisual />
          </Tile>
        </div>
      </div>
    </section>
  );
}
