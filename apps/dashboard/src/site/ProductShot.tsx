import {
  CheckCheck,
  EllipsisVertical,
  FileText,
  KeyRound,
  LayoutDashboard,
  LayoutTemplate,
  Lock,
  Megaphone,
  MessagesSquare,
  Mic,
  Paperclip,
  Search,
  Smartphone,
  Smile,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { cx, LogoMark } from '../ui';

const NAV_ICONS = [LayoutDashboard, Smartphone, MessagesSquare, LayoutTemplate, Megaphone, KeyRound];
const AVATAR_TINTS = [
  'bg-sender-emerald/15 text-sender-emerald',
  'bg-sender-violet/15 text-sender-violet',
  'bg-sender-amber/15 text-sender-amber',
  'bg-sender-sky/15 text-sender-sky',
  'bg-sender-rose/15 text-sender-rose',
];
/** Bars of the floating "messages today" card, oldest first. */
const BARS = [38, 52, 44, 61, 57, 73, 66, 84, 79, 100];

/** First letter of a name, skipping a title like "Dr." / "د.". */
const initialOf = (name: string) => name.replace(/^(dr\.|د\.)\s*/i, '').charAt(0);

function Avatar({ name, index, className }: { name: string; index: number; className?: string }) {
  return (
    <span className={cx('flex size-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold', AVATAR_TINTS[index % AVATAR_TINTS.length], className)}>
      {initialOf(name)}
    </span>
  );
}

function Bubble({ out, time, children, className }: { out?: boolean; time: string; children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        'relative w-fit max-w-[82%] rounded-xl px-3 py-2 text-[12.5px] leading-snug text-ink shadow-[0_1px_1px_rgb(0_0_0/0.08)]',
        out ? 'self-end rounded-se-sm bg-(--chat-out)' : 'self-start rounded-ss-sm bg-(--chat-in)',
        className,
      )}
    >
      {children}
      <span className="mt-1 flex items-center justify-end gap-1 text-[10px] text-muted">
        <span className="ltr">{time}</span>
        {out && <CheckCheck className="size-3.5 text-[#53bdeb]" />}
      </span>
    </div>
  );
}

/**
 * The hero's "screenshot": the dashboard's chats page drawn in HTML, so it follows the theme and
 * the language. Narrow screens keep only the open conversation.
 */
export function ProductShot() {
  const { t } = useI18n();
  const m = t.landing.mock;
  const open = m.chats[0]!;

  return (
    <div aria-hidden className="relative select-none">
      <div className="pointer-events-none absolute -inset-x-6 -top-8 bottom-12 -z-10 rounded-[3rem] bg-brand/15 blur-3xl sm:-inset-x-16" />

      <div className="overflow-hidden rounded-xl border border-line-strong/60 bg-card shadow-[0_40px_100px_-40px_rgb(0_0_0/0.85)] sm:rounded-2xl light:shadow-[0_40px_90px_-50px_rgb(16_24_20/0.4)]">
        {/* Window bar */}
        <div className="flex h-10 items-center gap-3 border-b border-line bg-surface px-3 sm:px-4">
          <div className="flex w-12 gap-1.5" dir="ltr">
            <span className="size-2.5 rounded-full bg-[#ff5f57]" />
            <span className="size-2.5 rounded-full bg-[#febc2e]" />
            <span className="size-2.5 rounded-full bg-[#28c840]" />
          </div>
          <div className="mx-auto flex min-w-0 items-center gap-1.5 rounded-md border border-line bg-bg/60 px-3 py-1 text-[11px] text-muted">
            <Lock className="size-3 shrink-0" />
            <span className="truncate">{m.address}</span>
          </div>
          <div className="w-12" />
        </div>

        <div className="grid h-[400px] grid-cols-1 sm:h-[460px] md:grid-cols-[minmax(0,230px)_minmax(0,1fr)] lg:h-[500px] lg:grid-cols-[176px_250px_minmax(0,1fr)]">
          {/* Sidebar */}
          <aside className="hidden flex-col border-e border-line bg-surface/60 p-3 lg:flex">
            <div className="flex items-center gap-2 px-1.5 py-1">
              <LogoMark className="size-6" />
              <span className="ltr text-[13px] font-semibold">CodeFiye</span>
            </div>
            <ul className="mt-5 space-y-0.5">
              {m.nav.map((label, i) => {
                const Icon = NAV_ICONS[i]!;
                const active = i === 2;
                return (
                  <li key={label} className={cx('flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[12px]', active ? 'bg-raised font-semibold text-ink' : 'text-muted')}>
                    <Icon className="size-3.5 shrink-0" />
                    <span className="truncate">{label}</span>
                    {active && <span className="ms-auto rounded-full bg-brand px-1.5 text-[10px] leading-4 font-bold text-on-brand">3</span>}
                  </li>
                );
              })}
            </ul>
            <div className="mt-auto rounded-lg border border-line bg-card p-2.5">
              <p className="text-[11px] font-semibold">{m.plan}</p>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-raised">
                <div className="h-full w-3/5 rounded-full bg-brand" />
              </div>
            </div>
          </aside>

          {/* Chat list */}
          <div className="hidden min-w-0 flex-col border-e border-line md:flex">
            <div className="border-b border-line p-3">
              <div className="flex items-center gap-2 rounded-md border border-line bg-bg/60 px-2.5 py-1.5 text-[11px] text-faint">
                <Search className="size-3.5 shrink-0" />
                <span className="truncate">{m.search}</span>
              </div>
              <div className="mt-2.5 flex gap-1.5">
                {m.filters.map((f, i) => (
                  <span key={f} className={cx('rounded-full px-2.5 py-0.5 text-[10px] font-medium', i === 0 ? 'bg-ink text-bg' : 'bg-raised text-muted')}>
                    {f}
                  </span>
                ))}
              </div>
            </div>
            <ul className="min-h-0 flex-1 overflow-hidden">
              {m.chats.map((c, i) => (
                <li key={c.name} className={cx('flex items-center gap-2.5 px-3 py-2.5', i === 0 && 'bg-raised/70')}>
                  <Avatar name={c.name} index={i} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="truncate text-[12px] font-semibold">{c.name}</p>
                      <span className={cx('ltr shrink-0 text-[10px]', c.unread ? 'font-semibold text-brand' : 'text-faint')}>{c.time}</span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <p className="truncate text-[11px] text-muted">{c.text}</p>
                      {c.unread > 0 && (
                        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-brand text-[9px] font-bold text-on-brand">{c.unread}</span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* Conversation */}
          <div className="flex min-w-0 flex-col">
            <div className="flex items-center gap-3 border-b border-line bg-card px-4 py-2.5">
              <Avatar name={open.name} index={0} />
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-[13px] font-semibold">{open.name}</p>
                <p className="mt-0.5 text-[11px] text-good">{m.online}</p>
              </div>
              <Search className="size-4 text-muted" />
              <EllipsisVertical className="size-4 text-muted" />
            </div>
            <div className="chat-wall min-h-0 flex-1 overflow-hidden">
              <div className="relative flex h-full flex-col justify-end gap-2 p-3 sm:p-4">
                <span className="mx-auto mb-1 rounded-md bg-card/90 px-2.5 py-0.5 text-[10px] font-medium text-muted shadow-xs">{m.today}</span>
                <Bubble time="10:21">{m.question}</Bubble>
                <Bubble out time="10:22">
                  <span className="block font-semibold">{m.shipped}</span>
                  <span className="mt-0.5 block text-[11.5px] text-ink-2">{m.eta}</span>
                </Bubble>
                <Bubble out time="10:22" className="p-1.5">
                  <span className="flex items-center gap-2.5 rounded-lg bg-ink/[0.05] p-2">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[#e5484d] text-[9px] font-bold text-white">PDF</span>
                    <span className="min-w-0 leading-tight">
                      <span className="block truncate text-[12px] font-semibold">{m.pdfName}</span>
                      <span className="block text-[10px] text-muted">{m.pdfMeta}</span>
                    </span>
                    <FileText className="ms-2 size-4 shrink-0 text-muted" />
                  </span>
                </Bubble>
                <Bubble time="10:24">{m.thanks}</Bubble>
              </div>
            </div>
            <div className="flex items-center gap-2.5 border-t border-line bg-card px-3 py-2.5 text-muted">
              <Smile className="size-4.5 shrink-0" />
              <Paperclip className="size-4.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate rounded-full bg-raised px-3.5 py-1.5 text-[12px] text-faint">{m.placeholder}</span>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand text-on-brand">
                <Mic className="size-4" />
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Floating cards: today's volume, and a live delivery event */}
      <div className="site-card absolute -start-12 bottom-24 hidden w-56 rounded-xl p-4 shadow-2xl xl:block">
        <p className="text-xs text-muted">{m.statLabel}</p>
        <p className="ltr mt-1 text-2xl font-semibold tabular-nums">12,480</p>
        <p className="mt-0.5 text-[11px] font-medium text-good">{m.statDelta}</p>
        <div className="mt-3 flex h-10 items-end gap-1" dir="ltr">
          {BARS.map((h, i) => (
            <span key={i} className={cx('flex-1 rounded-sm', i === BARS.length - 1 ? 'bg-brand' : 'bg-brand/35')} style={{ height: `${h}%` }} />
          ))}
        </div>
      </div>
      <div className="site-card absolute -end-12 top-28 hidden w-72 items-start gap-3 rounded-xl p-3.5 shadow-2xl xl:flex">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-good/12 text-good">
          <CheckCheck className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[11px] text-muted">
            {m.eventLabel}
            <span className="ltr rounded bg-raised px-1.5 font-mono text-[10px]">messages.update</span>
          </p>
          <p className="mt-1 text-[13px] font-semibold">{m.eventText}</p>
        </div>
        <span className="shrink-0 text-[10px] text-faint">{m.eventTime}</span>
      </div>
    </div>
  );
}
