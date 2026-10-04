import { type InfiniteData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArrowDown,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  History,
  Info,
  Loader2,
  MailOpen,
  MoreVertical,
  Palette,
  Pin,
  Search,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { useLiveEvents } from '../../events';
import { useI18n } from '../../i18n';
import { qk } from '../../queries';
import { cx, flip, LoadError, Modal } from '../../ui';
import { Avatar, Bubble } from './Bubble';
import { TypingDots } from './ChatList';
import { Composer } from './Composer';
import { type ChatMessage, type ChatSummary, chatTitle, isChat, jidPhone, livePresence, mediaUrl, type MessagesPage, type Person, type PresenceState, type Sender, textOf } from './model';
import { type Draft, discard, enqueue, type Pending, resolveRef, retry, settle, usePending } from './outbox';
import { CHAT_WALLS, setChatWall, useChatWall, wallStyle } from './walls';

type Pages = InfiniteData<MessagesPage, number | undefined>;

/** A message on its way, drawn like a stored one ("queued", or "failed" with retry). */
function pendingMessage(p: Pending, index: number): ChatMessage {
  const { text, file, ptt, seconds, quote } = p.draft;
  const kind = !file ? 'text' : file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'document';
  return {
    id: -1 - index,
    direction: 'out',
    type: kind,
    status: p.state === 'failed' ? 'failed' : 'queued',
    error: p.state === 'failed' ? (p.error ?? null) : null,
    content: {
      ...(kind === 'text' ? { text: text?.trim() } : { caption: text?.trim() || undefined }),
      ...(file && kind === 'document' ? { fileName: file.name, mimetype: file.type } : {}),
      ...(kind === 'audio' ? { ptt, seconds } : {}),
      ...(quote?.waMessageId ? { quote: { id: quote.waMessageId, fromMe: quote.direction === 'out', text: textOf(quote) } } : {}),
    },
    waMessageId: null,
    hasMedia: false,
    broadcastId: null,
    sentAt: null,
    createdAt: p.createdAt,
  };
}

/** The contact's line under the name: typing, online, last seen. */
export function PresenceLine({ chat, presence }: { chat: ChatSummary; presence?: PresenceState }) {
  const { t, fmt } = useI18n();
  const p = t.chats.presence;
  const live = livePresence(presence);
  if (live && (live.presence === 'composing' || live.presence === 'recording')) {
    const who = chat.isGroup ? live.jid.split('@')[0] : null;
    return (
      <span className="flex items-center gap-1.5 font-medium text-brand">
        {who ? p.groupTyping(`+${who}`) : live.presence === 'recording' ? p.recording : p.typing}
        <TypingDots />
      </span>
    );
  }
  if (live?.presence === 'available' && !chat.isGroup) return <span className="font-medium text-brand">{p.online}</span>;
  if (live?.lastSeen) return <span>{p.lastSeen(fmt.timeAgo(new Date(live.lastSeen * 1000).toISOString()))}</span>;
  if (chat.isGroup) return <span>{t.chats.group}</span>;
  return <span className="ltr font-mono">{chat.phone ?? chat.jid}</span>;
}

/** Full-screen viewer for the conversation's images; ←/→ step through them. */
function Lightbox({ items, index, onIndex, onClose }: { items: ChatMessage[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const { t, fmt, dir } = useI18n();
  const m = items[index];
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
      const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
      if (e.key === forward && index < items.length - 1) onIndex(index + 1);
      if (e.key === back && index > 0) onIndex(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, items.length, onIndex, onClose, dir]);
  if (!m) return null;
  const src = m.content.url?.startsWith('http') && !m.content.media ? m.content.url : mediaUrl(m.id);
  const caption = textOf(m);
  return (
    <div className="animate-fade-in fixed inset-0 z-[70] flex flex-col bg-black/90 backdrop-blur-sm" onClick={onClose} role="dialog" aria-modal>
      <div className="flex items-center justify-between gap-3 p-3 text-white" onClick={(e) => e.stopPropagation()}>
        <span className="text-sm text-white/70">{fmt.dateTime(m.createdAt)}</span>
        <div className="flex gap-1">
          <a href={mediaUrl(m.id, true)} className="rounded-full p-2 hover:bg-white/10" aria-label={t.chats.media.download}>
            <Download className="size-5" />
          </a>
          <button type="button" onClick={onClose} className="rounded-full p-2 hover:bg-white/10" aria-label={t.common.close}>
            <X className="size-5" />
          </button>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-14" onClick={(e) => e.stopPropagation()}>
        {index > 0 && (
          <button type="button" onClick={() => onIndex(index - 1)} className="absolute start-3 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" aria-label="‹">
            <ChevronLeft className={cx('size-6', flip)} />
          </button>
        )}
        <img key={m.id} src={src} alt="" referrerPolicy="no-referrer" className="pii animate-scale-in max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
        {index < items.length - 1 && (
          <button type="button" onClick={() => onIndex(index + 1)} className="absolute end-3 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" aria-label="›">
            <ChevronRight className={cx('size-6', flip)} />
          </button>
        )}
      </div>
      {caption && (
        <p dir="auto" className="mx-auto max-w-2xl p-4 text-center text-sm text-white/90" onClick={(e) => e.stopPropagation()}>
          {caption}
        </p>
      )}
    </div>
  );
}

type Item = { kind: 'day'; key: string; label: string } | { kind: 'unread'; key: string; n: number } | { kind: 'msg'; key: string; m: ChatMessage; first: boolean; sender: Sender | null };

type Props = {
  sessionId: string;
  connected: boolean;
  chat: ChatSummary;
  presence?: PresenceState;
  picture: string | null;
  receipts: boolean;
  infoOpen: boolean;
  onBack: () => void;
  onToggleInfo: () => void;
  onFlags: (flags: { pinned?: boolean; archived?: boolean; unread?: boolean }) => void;
  onOpenPhone: (phone: string) => void;
  /** Ask the phone for older messages of this chat. */
  onSync: () => void;
  syncing: boolean;
};

export function Conversation({ sessionId, connected, chat, presence, picture, receipts, infoOpen, onBack, onToggleInfo, onFlags, onOpenPhone, onSync, syncing }: Props) {
  const { t, fmt } = useI18n();
  const c = t.chats;
  const queryClient = useQueryClient();
  const title = chatTitle(chat);
  const wall = useChatWall();
  const [wallOpen, setWallOpen] = useState(false);

  // --- search within the chat ---
  const [searching, setSearching] = useState(false);
  const [rawQuery, setRawQuery] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(rawQuery.trim()), 300);
    return () => clearTimeout(timer);
  }, [rawQuery]);

  const key = qk.chats.messages(sessionId, chat.jid, q);
  const messages = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ jid: chat.jid, limit: '50' });
      if (pageParam) params.set('before', String(pageParam));
      if (q) params.set('q', q);
      return api<MessagesPage>(`/api/chats/${sessionId}/messages?${params}`, { signal });
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => page.nextBefore ?? undefined,
    staleTime: 60_000,
  });

  // Oldest first, reactions folded onto the messages they react to.
  const { list, reactions, images, people } = useMemo(() => {
    const all = (messages.data?.pages.flatMap((p) => p.messages) ?? []).slice().reverse();
    const people: Record<string, Person> = Object.assign({}, ...(messages.data?.pages.map((p) => p.senders ?? {}) ?? []));
    const byTarget = new Map<string, Map<string, string>>();
    for (const m of all) {
      if (m.type !== 'reaction' || !m.content.reactTo) continue;
      const who = m.direction === 'out' ? 'me' : (m.content.from ?? 'them');
      const target = byTarget.get(m.content.reactTo) ?? new Map<string, string>();
      if (m.content.text) target.set(who, m.content.text);
      else target.delete(who);
      byTarget.set(m.content.reactTo, target);
    }
    const shown = all.filter((m) => m.type !== 'reaction');
    const reactions = new Map([...byTarget].map(([id, who]) => [id, [...who.values()]]));
    return { list: shown, reactions, people, images: shown.filter((m) => m.type === 'image' && m.hasMedia && !m.content.viewOnce) };
  }, [messages.data]);

  // The unread divider sits where the chat's unread messages began when it was opened.
  const [unreadAtOpen] = useState(chat.unread);
  const firstUnreadId = useMemo(() => {
    if (!unreadAtOpen || q) return null;
    const inbound = list.filter((m) => m.direction === 'in');
    return inbound[Math.max(0, inbound.length - unreadAtOpen)]?.id ?? null;
  }, [list, unreadAtOpen, q]);

  /**
   * A group sender as shown on their bubbles: the name saved on the phone (or their WhatsApp name),
   * with their number beside it; a member whose number WhatsApp hides (LID) and who has no name is "Member".
   * A sender the store lacks (`?…` keys, see senderKey) is "Unknown sender" until a sync fills it in.
   */
  const senderOf = useCallback(
    (key: string, known: Record<string, Person>, pushName?: string | null, fromPhone?: string | null): Sender => {
      if (key.startsWith('?')) return { key, name: c.unknownSender, phone: null, unknown: true };
      const person = known[key];
      const phone = person?.phone ?? fromPhone ?? jidPhone(key);
      const name = person?.name || pushName || phone || c.member;
      return { key, name, phone: name === phone ? null : phone };
    },
    [c.member, c.unknownSender],
  );
  /** Who a run of bubbles belongs to; each message of an unknown group sender stands alone. */
  const senderKey = useCallback(
    (m: ChatMessage) => (m.direction === 'out' ? 'me' : chat.isGroup && (!m.content.from || m.content.from.endsWith('@g.us')) ? `?${m.id}` : (m.content.from ?? '')),
    [chat.isGroup],
  );

  const items = useMemo(() => {
    const out: Item[] = [];
    let lastDay = '';
    let prev: ChatMessage | null = null;
    for (const m of list) {
      const day = new Date(m.createdAt).toDateString();
      if (day !== lastDay) {
        out.push({ kind: 'day', key: `d-${day}`, label: fmt.day(m.createdAt) });
        lastDay = day;
        prev = null;
      }
      if (m.id === firstUnreadId) {
        out.push({ kind: 'unread', key: 'unread', n: unreadAtOpen });
        prev = null;
      }
      const key = senderKey(m);
      const first = !prev || senderKey(prev) !== key || new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > 5 * 60_000;
      const sender = chat.isGroup && m.direction === 'in' ? senderOf(key, people, m.content.pushName, m.content.fromPhone) : null;
      out.push({ kind: 'msg', key: `m-${m.id}`, m, first, sender });
      prev = m;
    }
    return out;
  }, [list, people, firstUnreadId, unreadAtOpen, chat.isGroup, fmt, senderOf, senderKey]);

  // Each day lives in its own section: the sticky pill then sticks only while its day is on screen
  // (flat list = every pill sticks at once and they pile on top of each other).
  const sections = useMemo(() => {
    const out: { key: string; label: string | null; items: Extract<Item, { kind: 'unread' | 'msg' }>[] }[] = [];
    for (const item of items) {
      if (item.kind === 'day') out.push({ key: item.key, label: item.label, items: [] });
      else {
        if (!out.length) out.push({ key: 'head', label: null, items: [] });
        out[out.length - 1]!.items.push(item);
      }
    }
    return out;
  }, [items]);

  // --- live: new messages are fetched and appended, status changes patched in place ---
  const newestId = messages.data?.pages[0]?.messages[0]?.id ?? 0;
  const newestRef = useRef(newestId);
  newestRef.current = newestId;
  const catchingUp = useRef(false);
  const [unseen, setUnseen] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = () => (scroller.current ? Math.abs(scroller.current.scrollTop) < 120 : true);

  const markRead = useCallback(() => {
    void api(`/api/chats/${sessionId}/read`, { method: 'POST', body: { jid: chat.jid, receipts } }).catch(() => {});
  }, [sessionId, chat.jid, receipts]);

  const catchUp = useCallback(async () => {
    if (catchingUp.current || q) return;
    catchingUp.current = true;
    try {
      const params = new URLSearchParams({ jid: chat.jid, after: String(newestRef.current), limit: '100' });
      const { messages: fresh, senders } = await api<MessagesPage>(`/api/chats/${sessionId}/messages?${params}`);
      if (fresh.length === 0) return;
      queryClient.setQueryData<Pages>(key, (data) => {
        if (!data?.pages[0]) return data;
        const known = new Set(data.pages.flatMap((p) => p.messages.map((m) => m.id)));
        const added = fresh.filter((m) => !known.has(m.id));
        const first = { ...data.pages[0], messages: [...added, ...data.pages[0].messages], senders: { ...data.pages[0].senders, ...senders } };
        return { ...data, pages: [first, ...data.pages.slice(1)] };
      });
      if (fresh.some((m) => m.direction === 'in')) {
        if (document.visibilityState === 'visible') markRead();
        if (!atBottom()) setUnseen((n) => n + fresh.filter((m) => m.direction === 'in').length);
      }
    } catch {
      // the next event (or a reload) catches up
    } finally {
      catchingUp.current = false;
    }
  }, [chat.jid, sessionId, q, key, queryClient, markRead]);

  useLiveEvents((event) => {
    if (event.sessionId !== sessionId) return;
    if ((event.type === 'messages.received' && isChat(chat, event.data.chatJid ?? '')) || (event.type === 'messages.created' && isChat(chat, event.data.chatJid))) {
      if (event.type === 'messages.created' && event.data.ref) resolveRef(sessionId, chat.jid, event.data.ref, event.data.id);
      void catchUp();
    } else if (event.type === 'message.changed') {
      // Edited or deleted for everyone by its sender: reload if it's one of ours here.
      if (isChat(chat, event.data.chatJid)) void queryClient.invalidateQueries({ queryKey: key });
    } else if (event.type === 'chats.synced') {
      const changed = event.data.added > 0 || (event.data.repaired ?? 0) > 0;
      if (changed && (event.data.chatJid === null || isChat(chat, event.data.chatJid))) void queryClient.invalidateQueries({ queryKey: key });
    } else if (event.type === 'messages.update' || event.type === 'poll.vote') {
      let found = false;
      queryClient.setQueryData<Pages>(key, (data) => {
        if (!data) return data;
        return {
          ...data,
          pages: data.pages.map((p) => ({
            ...p,
            messages: p.messages.map((m) => {
              if (m.id !== event.data.id) return m;
              found = true;
              return event.type === 'messages.update' ? { ...m, status: event.data.status, error: event.data.error } : m;
            }),
          })),
        };
      });
      if (found && event.type === 'poll.vote') void queryClient.invalidateQueries({ queryKey: key });
      // A message sent through the API to this chat appears once WhatsApp accepts it.
      if (!found && event.type === 'messages.update' && event.data.status === 'sent') void catchUp();
    }
  });

  // Opening a chat reads it.
  useEffect(() => {
    if (chat.unread > 0) markRead();
    // only when a chat is opened
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.jid]);

  // --- scrolling: older pages load at the top; a button brings you back down ---
  const topSentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = messages;
  useEffect(() => {
    const el = topSentinel.current;
    if (!el || !hasNextPage) return;
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && !isFetchingNextPage && void fetchNextPage(), { root: scroller.current, rootMargin: '400px 0px 0px 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const [showDown, setShowDown] = useState(false);
  const onScroll = () => {
    const bottom = atBottom();
    setShowDown(!bottom);
    if (bottom) setUnseen(0);
  };
  const toBottom = () => scroller.current?.scrollTo({ top: 0, behavior: 'smooth' });
  const jump = useCallback((waMessageId: string) => {
    const el = document.getElementById(`msg-${waMessageId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('flash-msg');
    void el.offsetWidth;
    el.classList.add('flash-msg');
  }, []);

  // --- composer: messages show at once and go out in the order written (outbox.ts) ---
  const [reply, setReply] = useState<ChatMessage | null>(null);
  const pending = usePending(sessionId, chat.jid);
  const onSend = useCallback(
    (draft: Draft) => {
      enqueue(queryClient, sessionId, chat.jid, draft);
      setReply(null);
      requestAnimationFrame(() => scroller.current?.scrollTo({ top: 0, behavior: 'smooth' }));
    },
    [queryClient, sessionId, chat.jid],
  );
  const cancelReply = useCallback(() => setReply(null), []);
  const shownIds = useMemo(() => new Set(list.map((m) => m.id)), [list]);
  // Once the list holds the real message, its "sending" stand-in goes.
  useEffect(() => settle(sessionId, chat.jid, (id) => shownIds.has(id)), [shownIds, pending, sessionId, chat.jid]);
  const outgoing = useMemo(
    () => (q ? [] : pending.filter((p) => p.realId === undefined || !shownIds.has(p.realId)).map((p, i) => ({ p, m: pendingMessage(p, i) }))),
    [pending, shownIds, q],
  );

  const [menu, setMenu] = useState(false);
  const [lightbox, setLightbox] = useState<number | null>(null);
  // Stable callbacks keep the (memoized) bubbles from re-rendering on every change above them.
  const quotedAuthor = useCallback(
    (fromMe: boolean, participant: string | null) => (fromMe ? c.you : chat.isGroup && participant ? senderOf(participant, people).name : title),
    [c.you, chat.isGroup, title, people, senderOf],
  );
  const openMedia = useCallback((m: ChatMessage) => setLightbox(images.findIndex((x) => x.id === m.id)), [images]);

  return (
    <div className="chat-root relative flex h-full min-h-0 flex-col">
      {/* header */}
      <header className="chat-head z-10 flex h-[4.25rem] shrink-0 items-center gap-1.5 border-b border-line/60 bg-card/85 px-2 backdrop-blur-md md:px-4">
        <button type="button" onClick={onBack} className="rounded-full p-2 text-muted hover:bg-raised hover:text-ink lg:hidden" aria-label={c.back}>
          <ArrowLeft className={cx('size-5', flip)} />
        </button>
        <button type="button" onClick={onToggleInfo} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1 text-start transition-colors hover:bg-raised/60">
          <Avatar name={title} id={chat.jid} picture={picture} group={chat.isGroup} online={livePresence(presence)?.presence === 'available'} />
          <span className="pii min-w-0">
            <span className="block truncate text-start font-semibold">
              {chat.name ? <span dir="auto">{title}</span> : <span className="ltr font-mono">{title}</span>}
            </span>
            <span className="block truncate text-xs text-muted">
              <PresenceLine chat={chat} presence={presence} />
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={onSync}
          disabled={!connected || syncing}
          className="rounded-full p-2 text-muted transition-colors hover:bg-raised hover:text-ink disabled:opacity-40"
          aria-label={c.sync.chat}
          title={connected ? c.sync.chat : c.sync.offline}
        >
          <History className={cx('size-5', syncing && 'animate-spin [animation-direction:reverse]')} />
        </button>
        <button
          type="button"
          onClick={() => {
            setSearching((s) => !s);
            setRawQuery('');
          }}
          className={cx('rounded-full p-2 transition-colors hover:bg-raised hover:text-ink', searching ? 'bg-raised text-ink' : 'text-muted')}
          aria-label={c.searchIn}
          title={c.searchIn}
        >
          <Search className="size-5" />
        </button>
        <button
          type="button"
          onClick={onToggleInfo}
          className={cx('hidden rounded-full p-2 transition-colors hover:bg-raised hover:text-ink md:block', infoOpen ? 'bg-raised text-ink' : 'text-muted')}
          aria-label={c.actions.info}
          title={c.actions.info}
        >
          <Info className="size-5" />
        </button>
        <div className="relative">
          <button type="button" onClick={() => setMenu((o) => !o)} className="rounded-full p-2 text-muted transition-colors hover:bg-raised hover:text-ink" aria-label={c.actions.more} aria-expanded={menu}>
            <MoreVertical className="size-5" />
          </button>
          {menu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
              <div role="menu" className="animate-scale-in absolute end-0 top-full z-50 mt-1 w-56 origin-top-right rounded-lg border border-line bg-bg p-1 shadow-xl">
                {[
                  { icon: Pin, label: chat.pinned ? c.actions.unpin : c.actions.pin, run: () => onFlags({ pinned: !chat.pinned }) },
                  { icon: Archive, label: chat.archived ? c.actions.unarchive : c.actions.archive, run: () => onFlags({ archived: !chat.archived }) },
                  { icon: MailOpen, label: c.actions.markUnread, run: () => onFlags({ unread: true }) },
                  { icon: Palette, label: c.actions.wallpaper, run: () => setWallOpen(true) },
                ].map((item) => (
                  <button
                    key={item.label}
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setMenu(false);
                      item.run();
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-raised"
                  >
                    <item.icon className="size-4 text-muted" /> {item.label}
                  </button>
                ))}
                {chat.phone && (
                  <a role="menuitem" href={`https://wa.me/${chat.phone.slice(1)}`} target="_blank" rel="noreferrer" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-raised">
                    <ExternalLink className="size-4 text-muted" /> {c.actions.openWhatsApp}
                  </a>
                )}
              </div>
            </>
          )}
        </div>
        <span aria-hidden className="mx-0.5 hidden h-6 w-px bg-line lg:block" />
        <button type="button" onClick={onBack} className="hidden rounded-full p-2 text-muted transition-colors hover:bg-red-500/10 hover:text-red-400 lg:block" aria-label={c.closeChat} title={c.closeChat}>
          <X className="size-5" />
        </button>
      </header>

      {searching && (
        <div className="animate-fade-in flex items-center gap-2 border-b border-line bg-card px-3 py-2">
          <Search className="size-4 shrink-0 text-muted" />
          <input
            autoFocus
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setSearching(false)}
            dir={rawQuery ? 'auto' : undefined}
            placeholder={c.searchIn}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
          {q && <span className="shrink-0 text-xs text-muted tabular-nums">{messages.isFetching ? <Loader2 className="size-3.5 animate-spin" /> : c.searchResults(list.length)}</span>}
          <button type="button" onClick={() => (setSearching(false), setRawQuery(''))} className="rounded p-1 text-muted hover:text-ink" aria-label={c.closeSearch}>
            <X className="size-4" />
          </button>
        </div>
      )}

      {/* thread */}
      <div className="chat-wall relative min-h-0 flex-1" style={wallStyle(wall)}>
        <div ref={scroller} onScroll={onScroll} className="code-scroll flex h-full flex-col-reverse overflow-y-auto overscroll-contain">
          <div className="chat-thread pt-2 pb-4">
            <div ref={topSentinel} />
            {messages.isError && !messages.data ? (
              <div className="p-4">
                <LoadError error={messages.error} onRetry={() => void messages.refetch()} retrying={messages.isFetching} />
              </div>
            ) : !messages.data ? (
              <div className="flex justify-center py-16">
                <Loader2 className="size-6 animate-spin text-brand" />
              </div>
            ) : (
              <>
                <div className="flex justify-center py-3">
                  {isFetchingNextPage ? (
                    <span className="flex items-center gap-2 rounded-full bg-card/90 px-3 py-1 text-xs text-muted shadow-sm">
                      <Loader2 className="size-3.5 animate-spin" /> {c.loadingOlder}
                    </span>
                  ) : !hasNextPage && list.length > 0 && !q ? (
                    <span className="rounded-full bg-card/90 px-3 py-1 text-xs text-muted shadow-sm">{c.start}</span>
                  ) : null}
                </div>
                {list.length === 0 && <p className="mx-auto mt-10 w-fit rounded-lg bg-card/90 px-4 py-2 text-sm text-muted shadow-sm">{q ? c.searchResults(0) : c.noMessages}</p>}
                {sections.map((section) => (
                  <div key={section.key}>
                    {section.label !== null && (
                      <div className="sticky top-2 z-[5] my-3 flex justify-center">
                        <span className="rounded-lg bg-card/95 px-3 py-1 text-xs font-medium text-muted shadow-sm ring-1 ring-line/60 backdrop-blur">{section.label}</span>
                      </div>
                    )}
                    {section.items.map((item) =>
                      item.kind === 'unread' ? (
                        <div key={item.key} className="my-3 flex justify-center bg-brand/[0.07] py-1.5">
                          <span className="rounded-full bg-card px-3 py-0.5 text-xs font-semibold text-brand shadow-sm">{c.unreadDivider(item.n)}</span>
                        </div>
                      ) : (
                        <div key={item.key} className={cx('animate-fade-in [contain-intrinsic-size:auto_72px] [content-visibility:auto]', reactions.has(item.m.waMessageId ?? '') && 'mb-3')}>
                          <Bubble
                            m={item.m}
                            first={item.first}
                            sender={item.sender}
                            reactions={item.m.waMessageId ? reactions.get(item.m.waMessageId) : undefined}
                            highlight={q || undefined}
                            quotedAuthor={quotedAuthor}
                            onReply={setReply}
                            onOpenMedia={openMedia}
                            onJump={jump}
                            onOpenChat={onOpenPhone}
                          />
                        </div>
                      ),
                    )}
                  </div>
                ))}
                {outgoing.map(({ p, m }, i) => (
                  <div key={p.ref} className="animate-fade-up">
                    <Bubble
                      m={m}
                      first={i === 0 && list.at(-1)?.direction !== 'out'}
                      quotedAuthor={quotedAuthor}
                      localSrc={p.localSrc}
                      pending={{
                        failed: p.state === 'failed',
                        error: p.error,
                        onRetry: () => retry(queryClient, sessionId, chat.jid, p.ref),
                        onDiscard: () => discard(sessionId, chat.jid, p.ref),
                      }}
                      onReply={setReply}
                      onOpenMedia={openMedia}
                    />
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
        {showDown && (
          <button
            type="button"
            onClick={toBottom}
            className="animate-scale-in absolute end-4 bottom-4 flex size-10 items-center justify-center rounded-full border border-line bg-card text-muted shadow-lg transition-colors hover:text-ink"
            aria-label={unseen ? c.newMessages(unseen) : c.back}
          >
            <ArrowDown className="size-5" />
            {unseen > 0 && (
              <span className="absolute -top-1.5 -end-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1 text-[11px] font-bold text-on-brand">{unseen}</span>
            )}
          </button>
        )}
      </div>

      <Composer sessionId={sessionId} jid={chat.jid} connected={connected} title={title} reply={reply} onCancelReply={cancelReply} onSend={onSend} />

      {lightbox !== null && lightbox >= 0 && <Lightbox items={images} index={lightbox} onIndex={setLightbox} onClose={() => setLightbox(null)} />}

      {wallOpen && (
        <Modal title={c.wall.title} description={c.wall.text} onClose={() => setWallOpen(false)}>
          <div className="grid grid-cols-5 gap-2">
            <button
              type="button"
              onClick={() => setChatWall(null)}
              title={c.wall.default}
              aria-pressed={wall === null}
              className={cx(
                'wall-swatch flex aspect-square items-center justify-center rounded-lg text-muted outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring',
                wall === null ? 'ring-2 ring-brand' : 'ring-1 ring-line hover:ring-line-strong',
              )}
              style={{ background: 'var(--chat-wall)' }}
            >
              <Undo2 className="size-4" />
            </button>
            {CHAT_WALLS.map((hex) => (
              <button
                key={hex}
                type="button"
                onClick={() => setChatWall(hex)}
                title={hex}
                aria-pressed={wall === hex}
                className={cx(
                  'wall-swatch aspect-square rounded-lg outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring',
                  wall === hex ? 'ring-2 ring-brand' : 'ring-1 ring-line hover:ring-line-strong',
                )}
                style={{ background: hex }}
              />
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
