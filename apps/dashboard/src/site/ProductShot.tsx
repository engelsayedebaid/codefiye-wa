import {
  CheckCheck,
  EllipsisVertical,
  FileText,
  KeyRound,
  LayoutDashboard,
  LayoutTemplate,
  Megaphone,
  MessagesSquare,
  Mic,
  Paperclip,
  Search,
  Smartphone,
  Smile,
  filledIcon,
} from '../icons';
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
 * The hero's "screenshot": the dashboard's chats page drawn in HTML, the way the app looks (Whop's
 * flat shell: sidebar, a header with the plan pill), so it follows the theme and the language.
 * Narrow screens keep only the open conversation.
 */
export function ProductShot() {
  const { t } = useI18n();
  const m = t.landing.mock;
  const open = m.chats[0]!;

  return (
    <div aria-hidden className="relative select-none">
      {/* A tray around the app, as Whop frames its product shots. */}
      <div className="rounded-[1.25rem] border border-line bg-surface p-1.5 sm:p-2">
        <div className="grid h-[420px] grid-cols-1 overflow-hidden rounded-xl border border-line bg-bg sm:h-[480px] lg:h-[520px] lg:grid-cols-[184px_minmax(0,1fr)]">
          {/* Sidebar */}
          <aside className="hidden min-h-0 flex-col border-e border-line lg:flex">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3.5">
              <LogoMark className="size-6" />
              <span className="ltr inline-flex items-center gap-1.5 text-[13px] font-bold tracking-tight">
                <span><span className="text-ink">Code</span><span className="text-brand">Fiye</span></span>
                <span className="rounded border border-brand/30 bg-brand/10 px-1 text-[8px] leading-3.5 font-bold tracking-wider text-brand">WA</span>
              </span>
            </div>
            <ul className="space-y-0.5 p-2">
              {m.nav.map((label, i) => {
                const active = i === 2;
                const Icon = active ? filledIcon(NAV_ICONS[i]!) : NAV_ICONS[i]!;
                return (
                  <li
                    key={label}
                    className={cx('flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[12px]', active ? 'bg-ink/[0.07] font-medium text-ink' : 'text-muted')}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="truncate">{label}</span>
                    {active && <span className="ms-auto rounded-full bg-brand px-1.5 text-[10px] leading-4 font-semibold text-on-brand">3</span>}
                  </li>
                );
              })}
            </ul>
          </aside>

          <div className="flex min-h-0 min-w-0 flex-col">
            {/* Header: where you are, and the plan pill */}
            <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
              <span className="truncate text-[12px] font-medium text-ink-2">{m.address}</span>
              <span className="ms-auto hidden h-7 items-center gap-2 rounded-full border border-line ps-2.5 pe-3 text-[11px] text-ink-2 sm:inline-flex">
                <span className="size-1.5 rounded-full bg-brand" />
                {m.plan}
                <span className="h-1 w-8 overflow-hidden rounded-full bg-ink/10">
                  <span className="block h-full w-3/5 rounded-full bg-brand" />
                </span>
              </span>
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand text-[11px] font-semibold text-on-brand max-sm:ms-auto">C</span>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
              {/* Chat list */}
              <div className="hidden min-w-0 flex-col border-e border-line md:flex">
                <div className="p-3">
                  <div className="flex h-8 items-center gap-2 rounded-lg border border-line bg-card px-2.5 text-[11px] text-faint">
                    <Search className="size-3.5 shrink-0" />
                    <span className="truncate">{m.search}</span>
                  </div>
                  <div className="mt-2.5 flex gap-1.5">
                    {m.filters.map((f, i) => (
                      <span key={f} className={cx('rounded-full px-2.5 py-0.5 text-[10px] font-medium', i === 0 ? 'bg-ink text-bg' : 'bg-ink/[0.07] text-muted')}>
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
                <ul className="min-h-0 flex-1 space-y-0.5 overflow-hidden px-1.5">
                  {m.chats.map((c, i) => (
                    <li key={c.name} className={cx('flex items-center gap-2.5 rounded-lg px-2 py-2', i === 0 && 'bg-ink/[0.06]')}>
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
              <div className="flex min-h-0 min-w-0 flex-col">
                <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
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
                <div className="flex items-center gap-2.5 border-t border-line px-3 py-2.5 text-muted">
                  <Smile className="size-4.5 shrink-0" />
                  <Paperclip className="size-4.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate rounded-full border border-line bg-card px-3.5 py-1.5 text-[12px] text-faint">{m.placeholder}</span>
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand text-on-brand">
                    <Mic className="size-4" />
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Floating cards: today's volume, and a live delivery event */}
      <div className="site-card absolute -start-12 bottom-24 hidden w-56 rounded-xl p-4 shadow-[0_20px_50px_-24px_rgb(0_0_0/0.7)] xl:block light:shadow-[0_20px_50px_-28px_rgb(0_0_0/0.25)]">
        <p className="text-xs text-muted">{m.statLabel}</p>
        <p className="ltr mt-1 text-2xl font-semibold tabular-nums">12,480</p>
        <p className="mt-0.5 text-[11px] font-medium text-good">{m.statDelta}</p>
        <div className="mt-3 flex h-10 items-end gap-1" dir="ltr">
          {BARS.map((h, i) => (
            <span key={i} className={cx('flex-1 rounded-sm', i === BARS.length - 1 ? 'bg-brand' : 'bg-brand/35')} style={{ height: `${h}%` }} />
          ))}
        </div>
      </div>
      <div className="site-card absolute -end-12 top-28 hidden w-72 items-start gap-3 rounded-xl p-3.5 shadow-[0_20px_50px_-24px_rgb(0_0_0/0.7)] xl:flex light:shadow-[0_20px_50px_-28px_rgb(0_0_0/0.25)]">
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
