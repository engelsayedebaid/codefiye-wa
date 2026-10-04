import { CHAT_FILTERS, type ChatFilter } from '@wa/shared/chats';
import { useInfiniteQuery, useQueries } from '@tanstack/react-query';
import { Archive, CircleDot, Inbox, Loader2, MessageSquareReply, MessagesSquare, Pin, Search, Send, User, Users, X } from 'lucide-react';
import { forwardRef, useEffect, useRef } from 'react';
import { api } from '../../api';
import { useI18n } from '../../i18n';
import { qk } from '../../queries';
import { cx, LoadError } from '../../ui';
import { StatusTick } from '../MessageFeed';
import { Avatar, TypeLabel } from './Bubble';
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
        active ? 'bg-brand/10 ring-1 ring-brand/25' : 'hover:bg-raised/70',
      )}
    >
      <Avatar name={title} id={chat.jid} picture={picture} group={chat.isGroup} online={live?.presence === 'available' || typing} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p dir="auto" className={cx('min-w-0 flex-1 truncate text-[15px]', chat.unread > 0 ? 'font-semibold' : 'font-medium')}>
            {chat.name ? title : <span className="ltr font-mono text-sm">{title}</span>}
          </p>
          <span className={cx('shrink-0 text-[11px] tabular-nums', chat.unread > 0 ? 'font-semibold text-brand' : 'text-faint')}>{stamp(chat.lastMessageAt)}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
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
                  {last.text || <TypeLabel type={last.type} />}
                </span>
              </>
            ) : null}
          </p>
          {chat.archived && <Archive className="size-3.5 shrink-0 text-faint" />}
          {chat.pinned && <Pin className="size-3.5 shrink-0 rotate-45 text-faint" />}
          {chat.unread > 0 && (
            <span className="animate-scale-in flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-bold text-black tabular-nums">
              {chat.unread > 99 ? '99+' : chat.unread}
            </span>
          )}
        </div>
      </div>
    </button>
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
};

export const ChatList = forwardRef<HTMLInputElement, Props>(function ChatList({ sessionId, selected, filter, query, term, presence, onFilter, onQuery, onSelect }, searchRef) {
  const { t, fmt } = useI18n();
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2.5 px-3 pt-2 pb-2">
        <label className="relative block">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
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
        <div role="group" aria-label={c.title} className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
                  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-xs font-medium transition-colors',
                  active ? 'bg-brand text-black shadow-sm' : 'border border-line bg-card text-muted hover:border-line-strong hover:text-ink',
                )}
              >
                <Icon className="size-3.5" />
                {c.filters[f]}
                {n !== undefined && n > 0 && <span className={cx('tabular-nums', active ? 'text-black/60' : 'text-faint')}>{fmt.number.format(n)}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className={cx('code-scroll min-h-0 flex-1 overflow-y-auto transition-opacity', list.isPlaceholderData && 'opacity-60')}>
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
          <ul className="space-y-0.5 px-2">
            {chats.map((chat) => (
              <li key={chat.jid} className="group">
                <Row chat={chat} active={selected === chat.jid} presence={presence.get(chat.jid)} picture={pictures.get(chat.jid)} onSelect={() => onSelect(chat)} />
              </li>
            ))}
          </ul>
        )}
        <div ref={sentinel} className="flex justify-center py-3">
          {isFetchingNextPage && <Loader2 className="size-4 animate-spin text-muted" />}
        </div>
      </div>
    </div>
  );
});
