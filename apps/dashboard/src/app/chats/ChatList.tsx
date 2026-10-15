import { CHAT_FILTERS, type ChatFilter } from '@wa/shared/chats';
import { useInfiniteQuery, useQueries, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Copy,
  EllipsisVertical,
  ExternalLink,
  Inbox,
  Loader2,
  MailOpen,
  MessageSquareReply,
  MessageSquareText,
  MessagesSquare,
  Pin,
  PinOff,
  Search,
  Send,
  User,
  Users,
  X,
} from 'lucide-react';
import { forwardRef, useEffect, useEffectEvent, useRef, useState } from 'react';
import { api } from '../../api';
import { useI18n } from '../../i18n';
import { qk } from '../../queries';
import { cx, flip, LoadError } from '../../ui';
import { StatusTick } from '../MessageFeed';
import { Avatar, TypeLabel } from './Bubble';
import { Floating } from './Floating';
import { PeekButton } from './Peek';
import { type ChatPage, type ChatSummary, chatTitle, livePresence, type PresenceState } from './model';

const FILTER_ICONS: Record<ChatFilter, typeof Inbox> = {
  all: MessagesSquare,
  unread: CircleDot,
  contacts: User,
  groups: Users,
  replied: MessageSquareReply,
  noReply: Send,
  pinned: Pin,
  archived: Archive,
};

/** How many chats from the top of the list have their presence (typing…) followed. */
const TOP_WATCHED = 25;

/** "14:05" today, "Tue" this week, else "3 Oct". */
function useStamp() {
  const { fmt, lang } = useI18n();
  const weekday = new Intl.DateTimeFormat(lang === 'ar' ? 'ar' : 'en-US', { weekday: 'short' });
  return (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
    if (days === 0) return fmt.time(d);
    if (days === 1) return fmt.day(d);
    if (days < 7) return weekday.format(d);
    return fmt.dayShort.format(d);
  };
}

export function TypingDots({ className }: { className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-0.5', className)} aria-hidden>
      <span className="typing-dot size-1 rounded-full bg-current" />
      <span className="typing-dot size-1 rounded-full bg-current" />
      <span className="typing-dot size-1 rounded-full bg-current" />
    </span>
  );
}

const ROW_MENU_WIDTH = 224;

/**
 * The ⋮ of a row (shows on hover, always on touch screens): what can be done to a chat without opening
 * it — read/unread, pin, archive, copy the number, WhatsApp. Opens as a fixed menu, so the list's
 * scrolling box can't clip it.
 */
function RowMenu({ sessionId, chat, onOpen }: { sessionId: string; chat: ChatSummary; onOpen: () => void }) {
  const { t } = useI18n();
  const c = t.chats;
  const queryClient = useQueryClient();
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const open = at !== null;

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) return setAt(null);
    const rect = button.current!.getBoundingClientRect();
    // Below the button, or above it near the bottom of the window; kept inside the window sideways.
    const height = 260;
    const top = rect.bottom + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : rect.bottom + 4;
    const left = Math.min(Math.max(8, rect.right - ROW_MENU_WIDTH), window.innerWidth - ROW_MENU_WIDTH - 8);
    setAt({ top, left });
  };
  useEffect(() => {
    if (!open) return;
    const close = () => setAt(null);
    const onDown = (e: PointerEvent) => !menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    // The list scrolls under a fixed menu: close rather than float away from its row.
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.chats.lists(sessionId) });
    void queryClient.invalidateQueries({ queryKey: qk.chats.numbers });
  };
  const flags = (body: { pinned?: boolean; archived?: boolean; unread?: boolean }) => void api(`/api/chats/${sessionId}/flags`, { method: 'POST', body: { jid: chat.jid, ...body } }).finally(refresh);
  const read = () => void api(`/api/chats/${sessionId}/read`, { method: 'POST', body: { jid: chat.jid } }).finally(refresh);
  const copy = async () => {
    if (!chat.phone) return;
    await navigator.clipboard.writeText(chat.phone).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1_200);
  };

  const items = [
    { icon: MessageSquareText, label: t.chats.ai.openChat, run: onOpen },
    chat.unread > 0 ? { icon: CheckCheck, label: c.actions.markRead, run: read } : { icon: MailOpen, label: c.actions.markUnread, run: () => flags({ unread: true }) },
    { icon: chat.pinned ? PinOff : Pin, label: chat.pinned ? c.actions.unpin : c.actions.pin, run: () => flags({ pinned: !chat.pinned }) },
    { icon: chat.archived ? ArchiveRestore : Archive, label: chat.archived ? c.actions.unarchive : c.actions.archive, run: () => flags({ archived: !chat.archived }) },
    ...(chat.phone ? [{ icon: copied ? Check : Copy, label: copied ? c.actions.copied : c.actions.copyNumber, run: () => void copy(), keep: true }] : []),
  ];

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-label={c.actions.chatMenu}
        aria-haspopup="menu"
        aria-expanded={open}
        title={c.actions.chatMenu}
        className={cx('grid size-7 cursor-pointer place-items-center rounded-full transition-colors', open ? 'bg-raised text-ink' : 'text-muted hover:bg-raised hover:text-ink')}
      >
        <EllipsisVertical className="size-[15px]" />
      </button>
      {at && (
        <Floating>
        <div
          ref={menu}
          role="menu"
          aria-label={c.actions.chatMenu}
          className="animate-scale-in fixed z-[70] rounded-xl border border-line bg-card p-1 shadow-xl"
          style={{ top: at.top, left: at.left, width: ROW_MENU_WIDTH }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                item.run();
                if (!('keep' in item)) setAt(null);
              }}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-sm transition-colors hover:bg-raised"
            >
              <item.icon className="size-4 shrink-0 text-muted" /> {item.label}
            </button>
          ))}
          {chat.phone && (
            <a
              role="menuitem"
              href={`https://wa.me/${chat.phone.slice(1)}`}
              target="_blank"
              rel="noreferrer"
              onClick={() => setAt(null)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-raised"
            >
              <ExternalLink className="size-4 shrink-0 text-muted" /> {c.actions.openWhatsApp}
            </a>
          )}
        </div>
        </Floating>
      )}
    </>
  );
}

function Row({ chat, active, presence, picture, onSelect }: { chat: ChatSummary; active: boolean; presence?: PresenceState; picture?: string | null; onSelect: () => void }) {
  const { t } = useI18n();
  const c = t.chats;
  const stamp = useStamp();
  const title = chatTitle(chat);
  const last = chat.last;
  const live = livePresence(presence);
  const typing = live && (live.presence === 'composing' || live.presence === 'recording');

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cx(
        'group relative flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-start transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        active ? 'bg-raised' : 'hover:bg-raised/60',
      )}
    >
      {active && <span aria-hidden className="animate-scale-in absolute inset-y-3 start-0 w-[3px] rounded-e-full bg-brand" />}
      <Avatar name={title} id={chat.jid} picture={picture} group={chat.isGroup} online={live?.presence === 'available' || typing} />
      <div className="min-w-0 flex-1 pii">
        <div className="flex items-baseline gap-2">
          <p className={cx('min-w-0 flex-1 truncate text-start text-[15px]', chat.unread > 0 ? 'font-semibold' : 'font-medium')}>
            {chat.name ? <span dir="auto">{title}</span> : <span className="ltr font-mono text-sm">{title}</span>}
          </p>
          <span className={cx('shrink-0 text-[11px] tabular-nums transition-[margin] group-hover:me-16 [@media(hover:none)]:me-16', chat.unread > 0 ? 'font-semibold text-brand' : 'text-faint')}>
            {stamp(chat.lastMessageAt)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 transition-[padding] group-hover:pe-16 [@media(hover:none)]:pe-16">
          <p className={cx('flex min-w-0 flex-1 items-center gap-1 truncate text-[13px]', chat.unread > 0 ? 'text-ink-2' : 'text-muted')}>
            {typing ? (
              <span className="flex items-center gap-1.5 font-medium text-brand">
                {live!.presence === 'recording' ? c.presence.recording : c.presence.typing}
                <TypingDots />
              </span>
            ) : last ? (
              <>
                {last.direction === 'out' && <StatusTick status={last.status} />}
                {last.sender && <span className="shrink-0 text-ink-2">{last.sender}:</span>}
                <span dir="auto" className="truncate">
                  {last.revoked ? <span className="italic">{c.revoked}</span> : last.text || <TypeLabel type={last.type} />}
                </span>
              </>
            ) : null}
          </p>
          {chat.archived && <Archive className="size-3.5 shrink-0 text-faint" />}
          {chat.pinned && <Pin className="size-3.5 shrink-0 rotate-45 text-faint" />}
          {chat.unread > 0 && (
            <span className="animate-scale-in flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-bold text-on-brand tabular-nums">
              {chat.unread > 99 ? '99+' : chat.unread}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

/** The filter chips: one scrollable strip (wheel scrolls it sideways), with edge arrows when it overflows. */
function FilterBar({ filter, counts, onFilter }: { filter: ChatFilter; counts: Partial<Record<ChatFilter, number>> | null; onFilter: (f: ChatFilter) => void }) {
  const { t, fmt } = useI18n();
  const c = t.chats;
  const strip = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    // RTL scrollLeft runs 0 → -max, LTR 0 → max; the distance from the start is the same either way.
    const measure = () => {
      const pos = Math.abs(el.scrollLeft);
      const max = el.scrollWidth - el.clientWidth;
      setEdges({ start: pos > 2, end: pos < max - 2 });
    };
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollBy({ left: getComputedStyle(el).direction === 'rtl' ? -e.deltaY : e.deltaY });
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      el.removeEventListener('wheel', onWheel);
      resize.disconnect();
    };
  }, []);

  useEffect(() => {
    strip.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [filter]);

  const nudge = (toEnd: boolean) => {
    const el = strip.current;
    if (!el) return;
    const rtl = getComputedStyle(el).direction === 'rtl';
    el.scrollBy({ left: (toEnd !== rtl ? 1 : -1) * el.clientWidth * 0.6, behavior: 'smooth' });
  };

  return (
    <div className="relative rounded-full border border-line bg-card p-1 shadow-xs">
      <div ref={strip} role="group" aria-label={c.title} className="flex gap-1 overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {CHAT_FILTERS.map((f) => {
          const active = filter === f;
          const n = counts?.[f];
          const Icon = FILTER_ICONS[f];
          return (
            <button
              key={f}
              type="button"
              aria-pressed={active}
              title={c.filterHints[f]}
              onClick={() => onFilter(f)}
              className={cx(
                'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                active ? 'bg-brand text-on-brand shadow-sm' : 'text-muted hover:bg-raised hover:text-ink',
              )}
            >
              <Icon className="size-3.5" />
              {c.filters[f]}
              {n !== undefined && n > 0 && (
                <span className={cx('min-w-4 rounded-full px-1 text-center text-[10px] font-semibold tabular-nums', active ? 'bg-on-brand/15 text-on-brand/70' : 'bg-raised text-faint')}>{fmt.number.format(n)}</span>
              )}
            </button>
          );
        })}
      </div>
      {edges.start && (
        <button
          type="button"
          onClick={() => nudge(false)}
          aria-label={c.prevFilters}
          className="animate-scale-in absolute inset-y-1 start-1 flex w-9 items-center justify-start rounded-s-full bg-gradient-to-r from-card via-card/90 to-transparent ps-1 text-muted hover:text-ink rtl:bg-gradient-to-l"
        >
          <ChevronLeft className={cx('size-4', flip)} />
        </button>
      )}
      {edges.end && (
        <button
          type="button"
          onClick={() => nudge(true)}
          aria-label={c.moreFilters}
          className="animate-scale-in absolute inset-y-1 end-1 flex w-9 items-center justify-end rounded-e-full bg-gradient-to-l from-card via-card/90 to-transparent pe-1 text-muted hover:text-ink rtl:bg-gradient-to-r"
        >
          <ChevronRight className={cx('size-4', flip)} />
        </button>
      )}
    </div>
  );
}

type Away = 'up' | 'down';

/** Floating chips for chats that are typing/recording while their row is scrolled out of view. */
function TypingFloat({ chats, side, pictures, onPick }: { chats: { chat: ChatSummary; live: PresenceState }[]; side: Away; pictures: Map<string, string | null>; onPick: (chat: ChatSummary) => void }) {
  const { t } = useI18n();
  const c = t.chats;
  if (chats.length === 0) return null;
  const shown = chats.slice(0, 3);
  return (
    <div className={cx('pointer-events-none absolute inset-x-0 z-10 flex items-center gap-1.5 px-3', side === 'up' ? 'top-2 flex-col' : 'bottom-3 flex-col-reverse')}>
      {shown.map(({ chat, live }) => {
        const title = chatTitle(chat);
        return (
          <button
            key={chat.jid}
            type="button"
            onClick={() => onPick(chat)}
            className="animate-fade-up pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-brand/30 bg-card/95 py-1 ps-1 pe-3 shadow-lg shadow-black/40 light:shadow-black/15 backdrop-blur transition-colors hover:border-brand/60 hover:bg-raised"
          >
            <Avatar name={title} id={chat.jid} picture={pictures.get(chat.jid)} group={chat.isGroup} size="sm" online />
            <span dir="auto" className="pii min-w-0 truncate text-[13px] font-semibold text-ink">
              {chat.name ? title : <span className="ltr font-mono text-xs">{title}</span>}
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-brand">
              {live.presence === 'recording' ? c.presence.recording : c.presence.typing}
              <TypingDots />
            </span>
            <ChevronDown className={cx('size-3.5 shrink-0 text-muted', side === 'up' && 'rotate-180')} />
          </button>
        );
      })}
      {chats.length > shown.length && (
        <span className="pointer-events-auto rounded-full bg-card/95 px-2 py-0.5 text-[11px] font-semibold text-muted tabular-nums shadow-md backdrop-blur">+{chats.length - shown.length}</span>
      )}
    </div>
  );
}

type Props = {
  sessionId: string;
  selected: string | null;
  filter: ChatFilter;
  query: string;
  /** The search actually applied (debounced). */
  term: string;
  presence: Map<string, PresenceState>;
  onFilter: (filter: ChatFilter) => void;
  onQuery: (q: string) => void;
  onSelect: (chat: ChatSummary) => void;
  /** The chats at the top of the list (their presence gets followed). */
  onTopChats?: (jids: string[]) => void;
};

export const ChatList = forwardRef<HTMLInputElement, Props>(function ChatList({ sessionId, selected, filter, query, term, presence, onFilter, onQuery, onSelect, onTopChats }, searchRef) {
  const { t } = useI18n();
  const c = t.chats;
  const q = term.trim();
  const list = useInfiniteQuery({
    queryKey: qk.chats.list(sessionId, filter, q),
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ filter, limit: '40' });
      if (q) params.set('q', q);
      if (pageParam) params.set('cursor', pageParam);
      return api<ChatPage>(`/api/chats/${sessionId}/list?${params}`, { signal });
    },
    initialPageParam: '',
    getNextPageParam: (page) => page.next ?? undefined,
    placeholderData: (prev) => prev,
  });
  const chats = list.data?.pages.flatMap((p) => p.chats) ?? [];
  const counts = list.data?.pages[0]?.counts ?? null;

  // Small profile pictures, one request per loaded page; kept for hours (the API caches them too).
  const pictureQueries = useQueries({
    queries: (list.data?.pages ?? []).map((page) => {
      const jids = page.chats.map((ch) => ch.jid).join(',');
      return {
        queryKey: qk.chats.pictures(sessionId, jids),
        queryFn: ({ signal }: { signal: AbortSignal }) => api<Record<string, string | null>>(`/api/chats/${sessionId}/pictures?${new URLSearchParams({ jids })}`, { signal, timeoutMs: 35_000 }),
        enabled: jids.length > 0,
        staleTime: 3 * 3_600_000,
        gcTime: 6 * 3_600_000,
        retry: false,
      };
    }),
  });
  const pictures = new Map(pictureQueries.flatMap((q) => Object.entries(q.data ?? {})));

  // Load the next page as the end of the list scrolls into view.
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && !isFetchingNextPage && void fetchNextPage(), { rootMargin: '200px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Which rows are scrolled out of view, and on which side — for the floating "typing…" chips.
  const scroller = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState<Map<string, Away>>(new Map());
  const jidKey = chats.map((ch) => ch.jid).join(',');
  const topKey = chats
    .slice(0, TOP_WATCHED)
    .map((ch) => ch.jid)
    .join(',');
  const reportTop = useEffectEvent((jids: string[]) => onTopChats?.(jids));
  useEffect(() => reportTop(topKey ? topKey.split(',') : []), [topKey]);
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) =>
        setAway((prev) => {
          const next = new Map(prev);
          for (const e of entries) {
            const jid = (e.target as HTMLElement).dataset.jid!;
            // A row only counts as seen when (nearly) all of it shows — a half-hidden row hides its "typing…" line.
            if (e.intersectionRatio >= 0.9) next.delete(jid);
            else next.set(jid, e.boundingClientRect.top < (e.rootBounds?.top ?? 0) ? 'up' : 'down');
          }
          return next;
        }),
      { root, threshold: [0, 0.9, 1] },
    );
    root.querySelectorAll<HTMLElement>('[data-jid]').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [jidKey]);

  const typingAway = (side: Away) =>
    chats.flatMap((chat) => {
      const live = livePresence(presence.get(chat.jid));
      return live && (live.presence === 'composing' || live.presence === 'recording') && away.get(chat.jid) === side ? [{ chat, live }] : [];
    });
  const pick = (chat: ChatSummary) => {
    scroller.current?.querySelector(`[data-jid="${CSS.escape(chat.jid)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    onSelect(chat);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2.5 px-3 pt-2 pb-2">
        <label className="relative block">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            dir={query ? 'auto' : undefined}
            placeholder={c.search}
            aria-label={c.search}
            className="h-10 w-full rounded-xl border border-line bg-card ps-9 pe-8 text-sm text-ink shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-muted focus:border-ring focus:ring-[3px] focus:ring-ring/30"
          />
          {query && (
            <button type="button" onClick={() => onQuery('')} className="absolute end-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted hover:text-ink" aria-label={t.common.close}>
              <X className="size-4" />
            </button>
          )}
        </label>
        <FilterBar filter={filter} counts={counts} onFilter={onFilter} />
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <TypingFloat chats={typingAway('up')} side="up" pictures={pictures} onPick={pick} />
        <TypingFloat chats={typingAway('down')} side="down" pictures={pictures} onPick={pick} />
      <div ref={scroller} className={cx('code-scroll min-h-0 flex-1 overflow-y-auto transition-opacity', list.isPlaceholderData && 'opacity-60')}>
        {list.isError && !list.data ? (
          <div className="p-3">
            <LoadError error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
          </div>
        ) : !list.data ? (
          <div className="space-y-1 p-3">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="flex animate-pulse items-center gap-3 py-2" style={{ animationDelay: `${i * 80}ms` }}>
                <span className="size-11 rounded-full bg-raised" />
                <span className="flex-1 space-y-2">
                  <span className="block h-3 w-2/5 rounded bg-raised" />
                  <span className="block h-3 w-4/5 rounded bg-raised/70" />
                </span>
              </div>
            ))}
          </div>
        ) : chats.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center text-sm text-muted">
            <span className="flex size-12 items-center justify-center rounded-full bg-raised">
              <Inbox className="size-5" />
            </span>
            {q ? c.emptySearch : c.emptyList}
          </div>
        ) : (
          <ul className="chat-rows space-y-0.5 px-2">
            {chats.map((chat) => (
              <li key={chat.jid} data-jid={chat.jid} className="group relative">
                <Row chat={chat} active={selected === chat.jid} presence={presence.get(chat.jid)} picture={pictures.get(chat.jid)} onSelect={() => onSelect(chat)} />
                {/* Hover actions: one small toolbar, kept visible while one of its menus is open. */}
                <div className="pointer-events-none absolute inset-y-0 end-2 z-10 flex items-center">
                  <div className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-line bg-card p-0.5 opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 [@media(hover:none)]:opacity-100">
                    <PeekButton sessionId={sessionId} chat={chat} onOpen={() => onSelect(chat)} />
                    <RowMenu sessionId={sessionId} chat={chat} onOpen={() => onSelect(chat)} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div ref={sentinel} className="flex justify-center py-3">
          {isFetchingNextPage && <Loader2 className="size-4 animate-spin text-muted" />}
        </div>
      </div>
      </div>
    </div>
  );
});
