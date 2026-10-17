import { type InfiniteData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArrowDown,
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  ExternalLink,
  Forward,
  History,
  Info,
  Layers,
  Loader2,
  MailOpen,
  MessageCircle,
  MoreVertical,
  Palette,
  Pin,
  RotateCw,
  Search,
  Send,
  Undo2,
  User,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../../api';
import { useLiveEvents } from '../../events';
import { useI18n } from '../../i18n';
import { qk } from '../../queries';
import { cx, flip, LoadError, Modal } from '../../ui';
import { Avatar, Bubble } from './Bubble';
import { TypingDots } from './ChatList';
import { Composer } from './Composer';
import { useAccount } from '../account';
import { useCrossSend } from './crossSend';
import { ForwardChat } from './ForwardChat';
import { DeleteMessageDialog, EditMessageDialog } from './MessageActions';
import { type ChatMessage, type ChatNumber, type ChatSummary, chatTitle, isChat, jidPhone, livePresence, mediaUrl, type MessagesPage, type Person, type PresenceState, type Sender, textOf } from './model';
import { type Draft, discard, enqueue, type Pending, resolveRef, retry, settle, usePending } from './outbox';
import { CHAT_WALLS, setChatWall, useChatWalls, WALL_SCOPES, type WallScope, wallsFor, wallStyle } from './walls';

const WALL_ICONS = { chat: MessageCircle, groups: Users, contacts: User, all: Layers } satisfies Record<WallScope, unknown>;

/** Older than a message, newer than one, or a window around one (a search result opened in its place). */
type PageParam = { before?: number; after?: number; around?: number };
type Pages = InfiniteData<MessagesPage, PageParam>;

/** How far along a message is; a status only replaces one ranked below it. A failure ends a send that hadn't gone out. */
const STATUS_RANK: Record<ChatMessage['status'], number> = { queued: 0, sending: 1, failed: 2, sent: 3, delivered: 4, read: 5, received: 0 };

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

/** The matches of the in-chat search, newest first (a reaction is shown on its message, not by itself). */
const hitIds = (data: InfiniteData<MessagesPage> | undefined) => (data?.pages.flatMap((p) => p.messages) ?? []).filter((m) => m.type !== 'reaction').map((m) => m.id);

type Item = { kind: 'day'; key: string; label: string } | { kind: 'unread'; key: string; n: number } | { kind: 'msg'; key: string; m: ChatMessage; first: boolean; sender: Sender | null };

type Props = {
  sessionId: string;
  connected: boolean;
  /** The number is reconnecting: messages can still be queued (they go out once it's back). */
  reconnecting?: boolean;
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
  /** Open with the in-chat search on these words (a result of the search across all chats), at message `at` if given; a new `seq` searches again. */
  search?: { q: string; seq: number; at?: number };
  /** Open a chat of another number (after sending or forwarding through it). */
  onOpenIn?: (sessionId: string, jid: string) => void;
};

export function Conversation({ sessionId, connected, reconnecting = false, chat, presence, picture, receipts, infoOpen, onBack, onToggleInfo, onFlags, onOpenPhone, onSync, syncing, search, onOpenIn }: Props) {
  const { t, fmt } = useI18n();
  const c = t.chats;
  const queryClient = useQueryClient();
  const title = chatTitle(chat);
  const { own: wallOwn, from: wallFrom, wall } = wallsFor(useChatWalls(), chat);
  const [wallOpen, setWallOpen] = useState(false);
  /** The scope the wallpaper picker sets: the one this chat shows, else its kind (groups / one-to-one chats). */
  const [wallScope, setWallScope] = useState<WallScope>('chat');
  const openWalls = () => {
    setWallScope(wallFrom ?? (chat.isGroup ? 'groups' : 'contacts'));
    setWallOpen(true);
  };

  // --- search within the chat: the conversation stays whole, the search goes from match to match in it ---
  const [searching, setSearching] = useState(Boolean(search?.q));
  const [rawQuery, setRawQuery] = useState(search?.q ?? '');
  const [q, setQ] = useState(search?.q ?? '');
  /** Words asked for from outside (the search across all chats), with the match picked there: gone to once they're searched here. */
  const wantedHit = useRef<{ q: string; id: number | null } | null>(search?.q ? { q: search.q, id: search.at ?? null } : null);
  /** The words whose first match was already brought into view. */
  const jumpedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!search?.q) return;
    setSearching(true);
    setRawQuery(search.q);
    setQ(search.q);
    wantedHit.current = { q: search.q, id: search.at ?? null };
  }, [search]);
  useEffect(() => {
    const timer = setTimeout(() => setQ(rawQuery.trim()), 300);
    return () => clearTimeout(timer);
  }, [rawQuery]);

  /** The conversation is opened at this message (a match further back than what's loaded); null = at the latest. */
  const [anchor, setAnchor] = useState<number | null>(search?.at ?? null);
  const key = anchor === null ? qk.chats.messages(sessionId, chat.jid) : qk.chats.messagesAround(sessionId, chat.jid, anchor);
  const messages = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ jid: chat.jid, limit: '50' });
      for (const [name, id] of Object.entries(pageParam)) params.set(name, String(id));
      return api<MessagesPage>(`/api/chats/${sessionId}/messages?${params}`, { signal });
    },
    initialPageParam: (anchor === null ? {} : { around: anchor }) as PageParam,
    getNextPageParam: (page): PageParam | undefined => (page.nextBefore ? { before: page.nextBefore } : undefined),
    // Opened at a match: newer pages load as you scroll down, up to the latest.
    getPreviousPageParam: (page): PageParam | undefined => (page.nextAfter ? { after: page.nextAfter } : undefined),
    staleTime: 60_000,
  });
  /** Newer messages exist than the loaded ones (opened at a match): live ones wait until the list gets there. */
  const behindLatest = messages.hasPreviousPage;
  const behindRef = useRef(behindLatest);
  behindRef.current = behindLatest;

  const finds = useInfiniteQuery({
    queryKey: qk.chats.find(sessionId, chat.jid, q),
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ jid: chat.jid, q, limit: '100' });
      if (pageParam) params.set('before', String(pageParam));
      return api<MessagesPage>(`/api/chats/${sessionId}/messages?${params}`, { signal });
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => page.nextBefore ?? undefined,
    enabled: searching && q !== '',
    staleTime: 30_000,
  });

  // Oldest first, reactions folded onto the messages they react to.
  /**
   * Status updates that came before their message did: a fast send is "sent" and "delivered" before
   * the page has the row (from the send response or a catch-up). Kept here and applied once it shows.
   */
  const [early, setEarly] = useState(() => new Map<number, Pick<ChatMessage, 'status' | 'error' | 'waMessageId'>>());

  const { list, reactions, mine, images, people } = useMemo(() => {
    const all = (messages.data?.pages.flatMap((p) => p.messages) ?? [])
      .map((m) => {
        const later = early.get(m.id);
        return later && STATUS_RANK[later.status] > STATUS_RANK[m.status] ? { ...m, ...later, waMessageId: m.waMessageId ?? later.waMessageId } : m;
      })
      .reverse();
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
    // Our own reaction per message, so picking it again takes it back.
    const mine = new Map([...byTarget].flatMap(([id, who]) => (who.has('me') ? [[id, who.get('me')!] as const] : [])));
    return { list: shown, reactions, mine, people, images: shown.filter((m) => m.type === 'image' && m.hasMedia && !m.content.viewOnce) };
  }, [messages.data, early]);

  // The unread divider sits where the chat's unread messages began when it was opened.
  const [unreadAtOpen] = useState(chat.unread);
  const firstUnreadId = useMemo(() => {
    if (!unreadAtOpen || anchor !== null) return null;
    const inbound = list.filter((m) => m.direction === 'in');
    return inbound[Math.max(0, inbound.length - unreadAtOpen)]?.id ?? null;
  }, [list, unreadAtOpen, anchor]);

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
    // Opened further back: the newer pages bring these in when the list is scrolled down to them.
    if (catchingUp.current || behindRef.current) return;
    catchingUp.current = true;
    try {
      let after: number | null = newestRef.current;
      // A page at a time, oldest first, up to the latest (a long absence fills in without a gap).
      for (let round = 0; after !== null && round < 5; round++) {
        const params = new URLSearchParams({ jid: chat.jid, after: String(after), limit: '100' });
        const { messages: fresh, senders, nextAfter }: MessagesPage = await api<MessagesPage>(`/api/chats/${sessionId}/messages?${params}`);
        after = nextAfter ?? null;
        if (fresh.length === 0) break;
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
      }
    } catch {
      // the next event (or a reload) catches up
    } finally {
      catchingUp.current = false;
    }
  }, [chat.jid, sessionId, key, queryClient, markRead]);

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
      /** Sent, but the event didn't say its WhatsApp id (an older worker): reload so its buttons show. */
      let idMissing = false;
      queryClient.setQueryData<Pages>(key, (data) => {
        if (!data) return data;
        return {
          ...data,
          pages: data.pages.map((p) => ({
            ...p,
            messages: p.messages.map((m) => {
              if (m.id !== event.data.id) return m;
              found = true;
              if (event.type !== 'messages.update') return m;
              // Reply, react and edit need the WhatsApp id, which a message gets once it's sent.
              const waMessageId = m.waMessageId ?? event.data.waMessageId ?? null;
              if (!waMessageId && event.data.status === 'sent') idMissing = true;
              return { ...m, status: event.data.status, error: event.data.error, waMessageId };
            }),
          })),
        };
      });
      if (found && (event.type === 'poll.vote' || idMissing)) void queryClient.invalidateQueries({ queryKey: key });
      // A message sent through the API to this chat appears once WhatsApp accepts it.
      if (!found && event.type === 'messages.update') {
        // Ours, but not on the page yet (its row is on the way): keep the news for when it lands.
        const { id, status, error, waMessageId } = event.data;
        setEarly((prev) => {
          const had = prev.get(id);
          if (had && STATUS_RANK[had.status] >= STATUS_RANK[status]) return prev;
          return new Map(prev).set(id, { status, error: error ?? null, waMessageId: waMessageId ?? had?.waMessageId ?? null });
        });
        if (status === 'sent') void catchUp();
      }
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

  // Newer pages load at the bottom (opened at a match). The list is anchored at its bottom, so what's
  // on screen is kept in place by where the newest loaded message was when the page came in.
  const bottomSentinel = useRef<HTMLDivElement>(null);
  const lastShownId = useRef<number | null>(null);
  lastShownId.current = list.at(-1)?.id ?? null;
  const keep = useRef<{ id: number; top: number } | null>(null);
  const remember = () => {
    const id = lastShownId.current;
    const el = id === null ? null : scroller.current?.querySelector(`[data-mid="${id}"]`);
    keep.current = id !== null && el ? { id, top: el.getBoundingClientRect().top } : null;
  };
  const { isFetchingPreviousPage, fetchPreviousPage } = messages;
  useEffect(() => {
    const el = bottomSentinel.current;
    if (!el || !behindLatest) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || isFetchingPreviousPage) return;
        remember();
        void fetchPreviousPage();
      },
      { root: scroller.current, rootMargin: '0px 0px 400px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [behindLatest, isFetchingPreviousPage, fetchPreviousPage]);
  useLayoutEffect(() => {
    const box = scroller.current;
    const kept = keep.current;
    if (!kept || isFetchingPreviousPage || !box) return;
    keep.current = null;
    const el = box.querySelector(`[data-mid="${kept.id}"]`);
    const moved = el ? el.getBoundingClientRect().top - kept.top : 0;
    if (Math.abs(moved) > 1) box.scrollTop += moved;
  }, [messages.data, isFetchingPreviousPage]);

  const [showDown, setShowDown] = useState(false);
  const onScroll = () => {
    const bottom = atBottom();
    setShowDown(!bottom);
    if (bottom) setUnseen(0);
    if (keep.current) remember();
  };
  const toBottom = () => {
    // Opened further back: the latest messages are another list.
    if (behindLatest) return setAnchor(null);
    scroller.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };
  // Back at the latest after a while further back: bring in what arrived meanwhile.
  const wasAnchored = useRef(anchor !== null);
  useEffect(() => {
    if (anchor === null && wasAnchored.current) void catchUp();
    wasAnchored.current = anchor !== null;
  }, [anchor, catchUp]);
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

  // --- send between numbers (admins, switched on in the chats menu): answer from another number, forward the chat ---
  const { account } = useAccount();
  const crossOn = useCrossSend() && account?.user?.isAdmin === true;
  const numbers = useQuery({
    queryKey: qk.chats.numbers,
    queryFn: ({ signal }) => api<ChatNumber[]>('/api/chats/numbers', { signal }),
    enabled: crossOn,
    staleTime: 30_000,
  });
  const others = crossOn ? (numbers.data ?? []).filter((n) => n.id !== sessionId) : [];
  /** Another number reaches this contact by phone number (its LID belongs to this number's view of it). */
  const directJid = chat.isGroup ? null : chat.phone ? `${chat.phone.replace(/\D/g, '')}@s.whatsapp.net` : chat.jid.endsWith('@s.whatsapp.net') ? chat.jid : null;
  const [via, setVia] = useState<string | null>(null);
  const viaNumber = directJid ? (others.find((n) => n.id === via) ?? null) : null;
  /** The numbers this chat sent through: each keeps a line with how its messages are doing. */
  const [usedVia, setUsedVia] = useState<string[]>([]);
  const [forwardOpen, setForwardOpen] = useState(false);

  const onSend = useCallback(
    (draft: Draft) => {
      if (viaNumber && directJid) {
        // A quote points at a message of this number: it can't travel with a message from another one.
        enqueue(queryClient, viaNumber.id, directJid, { ...draft, quote: null });
        setUsedVia((u) => (u.includes(viaNumber.id) ? u : [...u, viaNumber.id]));
        setReply(null);
        return;
      }
      enqueue(queryClient, sessionId, chat.jid, draft);
      setReply(null);
      // Sending brings the latest messages back (the new one goes under them).
      setAnchor(null);
      requestAnimationFrame(() => scroller.current?.scrollTo({ top: 0, behavior: 'smooth' }));
    },
    [queryClient, sessionId, chat.jid, viaNumber, directJid],
  );
  const cancelReply = useCallback(() => setReply(null), []);
  // A reaction goes out at once; it shows when its row comes back (the messages.created event).
  const [reactError, setReactError] = useState<string | null>(null);
  const react = useCallback(
    (m: ChatMessage, emoji: string) =>
      void api(`/api/chats/${sessionId}/react`, { method: 'POST', body: { messageId: m.id, emoji } }).catch((err: unknown) => {
        setReactError(`${c.reactFailed}: ${errorMessage(err)}`);
        setTimeout(() => setReactError(null), 4_000);
      }),
    [sessionId, c.reactFailed],
  );
  // Edit / delete open a dialog; the bubble changes when the server says so (message.changed).
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [deleting, setDeleting] = useState<ChatMessage | null>(null);
  const closeEdit = useCallback(() => setEditing(null), []);
  const closeDelete = useCallback(() => setDeleting(null), []);
  const notice = useCallback((text: string) => {
    setReactError(text);
    setTimeout(() => setReactError(null), 4_000);
  }, []);
  // A stored message that failed, sent again: the copy arrives as a new message (messages.created) and
  // the failed one goes (message.changed). The key stays the same for the retries of one click.
  const [resending, setResending] = useState<Set<number>>(() => new Set());
  const resend = useCallback(
    async (m: ChatMessage) => {
      setResending((s) => new Set(s).add(m.id));
      try {
        await api(`/api/chats/${sessionId}/resend`, { method: 'POST', headers: { 'idempotency-key': `resend-${m.id}-${crypto.randomUUID()}` }, body: { messageId: m.id }, timeoutMs: 30_000 });
        void catchUp();
        void queryClient.invalidateQueries({ queryKey: key });
      } catch (err) {
        const expired = err instanceof ApiRequestError && err.status === 422 && Boolean(err.errors?.messageId);
        if (err instanceof ApiRequestError && err.code === 'session_not_connected') void queryClient.invalidateQueries({ queryKey: qk.chats.numbers });
        notice(expired ? c.pending.fileExpired : errorMessage(err));
      } finally {
        setResending((s) => {
          const next = new Set(s);
          next.delete(m.id);
          return next;
        });
      }
    },
    [sessionId, catchUp, queryClient, key, notice, c.pending.fileExpired],
  );
  const canQueue = connected || reconnecting;

  const shownIds = useMemo(() => new Set(list.map((m) => m.id)), [list]);
  // Once the list holds the real message, its "sending" stand-in goes.
  useEffect(() => settle(sessionId, chat.jid, (id) => shownIds.has(id)), [shownIds, pending, sessionId, chat.jid]);
  const outgoing = useMemo(
    () => (behindLatest ? [] : pending.filter((p) => p.realId === undefined || !shownIds.has(p.realId)).map((p, i) => ({ p, m: pendingMessage(p, i) }))),
    [pending, shownIds, behindLatest],
  );

  // --- from match to match (newest = 0): one on the page is scrolled to, another opens the conversation there ---
  const hits = useMemo(() => hitIds(finds.data), [finds.data]);
  const [hitIndex, setHitIndex] = useState(-1);
  /** A message to bring into view and flash once it's on the page (`instant`: the conversation was opened there). */
  const [target, setTarget] = useState<{ id: number; instant: boolean } | null>(search?.at ? { id: search.at, instant: true } : null);
  const shownRef = useRef(shownIds);
  shownRef.current = shownIds;
  const goTo = useCallback((id: number) => {
    const loaded = shownRef.current.has(id);
    if (!loaded) setAnchor(id);
    setTarget({ id, instant: !loaded });
  }, []);
  useEffect(() => {
    if (!target) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-mid="${target.id}"]`);
    if (!el) return; // its page is on the way
    el.scrollIntoView({ behavior: target.instant ? 'instant' : 'smooth', block: 'center' });
    // Bubbles off screen are laid out at a guessed height (content-visibility): once those around it are drawn, center it again.
    if (target.instant) requestAnimationFrame(() => el.scrollIntoView({ behavior: 'instant', block: 'center' }));
    el.classList.remove('flash-msg');
    void el.offsetWidth;
    el.classList.add('flash-msg');
    setTarget(null);
  }, [target, list]);
  // A message picked in the search across all chats without words (a photo, a file): straight to it.
  useEffect(() => {
    if (search?.at && !search.q) goTo(search.at);
  }, [search, goTo]);
  // New words: to their newest match (or the one picked in the search across all chats).
  useEffect(() => {
    if (!q) {
      setHitIndex(-1);
      jumpedFor.current = null;
      return;
    }
    const wanted = wantedHit.current?.q === q ? wantedHit.current : null;
    if (!finds.data || (jumpedFor.current === q && !wanted)) return;
    jumpedFor.current = q;
    wantedHit.current = null;
    const id = wanted?.id ?? hits[0];
    setHitIndex(id === undefined ? -1 : hits.indexOf(id));
    if (id !== undefined) goTo(id);
    // `search`: the same words asked for again
  }, [q, finds.data, hits, goTo, search]);
  const { hasNextPage: moreHits, fetchNextPage: fetchMoreHits } = finds;
  /** +1 = the next older match, -1 = the next newer one. */
  const stepHit = async (by: 1 | -1) => {
    const i = hitIndex + by;
    if (i < 0) return;
    const ids = i < hits.length || !moreHits ? hits : hitIds((await fetchMoreHits()).data);
    const id = ids[i];
    if (id === undefined) return;
    setHitIndex(i);
    goTo(id);
  };
  const closeSearch = () => {
    setSearching(false);
    setRawQuery('');
  };

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
                  { icon: Palette, label: c.actions.wallpaper, run: openWalls },
                  ...(crossOn ? [{ icon: Forward, label: c.cross.forward, run: () => setForwardOpen(true) }] : []),
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
        <button type="button" onClick={onBack} className="hidden rounded-full p-2 text-muted transition-colors hover:bg-critical/10 hover:text-critical lg:block" aria-label={c.closeChat} title={c.closeChat}>
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
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeSearch();
              if (e.key === 'Enter') {
                e.preventDefault();
                void stepHit(e.shiftKey ? -1 : 1);
              }
            }}
            dir={rawQuery ? 'auto' : undefined}
            placeholder={c.searchIn}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
          {q && (
            <span className="shrink-0 text-xs text-muted tabular-nums">
              {finds.isFetching ? <Loader2 className="size-3.5 animate-spin" /> : hits.length === 0 ? c.searchResults(0) : c.searchAt(hitIndex + 1, hits.length, Boolean(moreHits))}
            </span>
          )}
          {q && hits.length > 0 && (
            <span className="flex shrink-0">
              <button
                type="button"
                onClick={() => void stepHit(1)}
                disabled={hitIndex + 1 >= hits.length && !moreHits}
                className="rounded p-1 text-muted hover:text-ink disabled:opacity-40"
                aria-label={c.olderResult}
                title={c.olderResult}
              >
                <ChevronUp className="size-4" />
              </button>
              <button type="button" onClick={() => void stepHit(-1)} disabled={hitIndex <= 0} className="rounded p-1 text-muted hover:text-ink disabled:opacity-40" aria-label={c.newerResult} title={c.newerResult}>
                <ChevronDown className="size-4" />
              </button>
            </span>
          )}
          <button type="button" onClick={closeSearch} className="rounded p-1 text-muted hover:text-ink" aria-label={c.closeSearch}>
            <X className="size-4" />
          </button>
        </div>
      )}

      {/* thread */}
      <div className="chat-wall relative min-h-0 flex-1" style={wallStyle(wall)}>
        {reactError && (
          <p role="status" className="animate-fade-up absolute inset-x-0 top-3 z-20 mx-auto w-fit max-w-[90%] rounded-full bg-critical px-3 py-1.5 text-xs font-medium text-bg shadow-lg">
            {reactError}
          </p>
        )}
        <div ref={scroller} onScroll={onScroll} className="code-scroll flex h-full flex-col-reverse overflow-x-hidden overflow-y-auto overscroll-contain">
          <div className="chat-thread pt-2 pb-5">
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
                  ) : !hasNextPage && list.length > 0 ? (
                    <span className="rounded-full bg-card/90 px-3 py-1 text-xs text-muted shadow-sm">{c.start}</span>
                  ) : null}
                </div>
                {list.length === 0 && <p className="mx-auto mt-10 w-fit rounded-lg bg-card/90 px-4 py-2 text-sm text-muted shadow-sm">{c.noMessages}</p>}
                {sections.map((section) => (
                  <div key={section.key}>
                    {section.label !== null && (
                      <div className="sticky top-3 z-[5] mt-5 mb-2 flex justify-center">
                        <span className="rounded-full bg-card/90 px-3.5 py-1 text-[11.5px] font-medium tracking-wide text-ink-2 shadow-[0_1px_2px_rgb(0_0_0/0.12)] ring-1 ring-line/50 backdrop-blur-md">{section.label}</span>
                      </div>
                    )}
                    {section.items.map((item) =>
                      item.kind === 'unread' ? (
                        <div key={item.key} className="my-4 flex justify-center bg-brand/[0.07] py-1.5">
                          <span className="rounded-full bg-card px-3.5 py-1 text-[11.5px] font-semibold text-brand shadow-sm ring-1 ring-brand/20">{c.unreadDivider(item.n)}</span>
                        </div>
                      ) : (
                        <div key={item.key} data-mid={item.m.id} className="animate-fade-in [contain-intrinsic-size:auto_72px] [content-visibility:auto]">
                          <Bubble
                            m={item.m}
                            first={item.first}
                            sender={item.sender}
                            reactions={item.m.waMessageId ? reactions.get(item.m.waMessageId) : undefined}
                            myReaction={item.m.waMessageId ? mine.get(item.m.waMessageId) : undefined}
                            onReact={connected ? react : undefined}
                            onEdit={connected ? setEditing : undefined}
                            onDelete={setDeleting}
                            onResend={canQueue && !item.m.broadcastId ? resend : undefined}
                            resending={resending.has(item.m.id)}
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
                        waiting: p.waiting,
                        progress: p.progress,
                        onRetry: () => retry(queryClient, sessionId, chat.jid, p.ref),
                        onDiscard: () => discard(sessionId, chat.jid, p.ref),
                      }}
                      onReply={setReply}
                      onOpenMedia={openMedia}
                    />
                  </div>
                ))}
                {isFetchingPreviousPage && (
                  <div className="flex justify-center py-3">
                    <Loader2 className="size-4 animate-spin text-muted" />
                  </div>
                )}
                <div ref={bottomSentinel} />
              </>
            )}
          </div>
        </div>
        {(showDown || behindLatest) && (
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

      {crossOn && others.length > 0 && (
        <div className="border-t border-line bg-surface/60 px-3 py-1.5">
          {usedVia.map((id) => {
            const n = (numbers.data ?? []).find((x) => x.id === id);
            return n && directJid ? <ViaStatus key={id} number={n} jid={directJid} onOpen={onOpenIn ? () => onOpenIn(id, directJid) : undefined} /> : null;
          })}
          {directJid ? (
            <div className="flex items-center gap-1.5 overflow-x-auto text-[11.5px] [scrollbar-width:none]">
              <Send className={cx('size-3.5 shrink-0 text-muted', flip)} />
              <span className="shrink-0 text-muted">{c.cross.sendFrom}</span>
              {[null, ...others].map((n) => {
                const active = (n?.id ?? null) === (viaNumber?.id ?? null);
                const online = n ? n.status === 'connected' : connected;
                return (
                  <button
                    key={n?.id ?? 'self'}
                    type="button"
                    disabled={!online}
                    onClick={() => setVia(n?.id ?? null)}
                    title={n?.phone ?? undefined}
                    className={cx(
                      'flex shrink-0 cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                      active ? (n ? 'border-warning/50 bg-warning/10 text-warning' : 'border-brand/40 bg-brand/10 text-brand') : 'border-line text-ink-2 hover:border-line-strong',
                    )}
                  >
                    <span className={cx('size-1.5 rounded-full', online ? 'bg-good' : 'bg-ink-3')} />
                    <span className="pii max-w-32 truncate">{n ? n.name : c.cross.thisNumber}</span>
                  </button>
                );
              })}
              {viaNumber && <span className="pii shrink-0 text-warning">· {c.cross.via(viaNumber.name)}</span>}
            </div>
          ) : (
            <p className="text-[11.5px] text-muted">{c.cross.onlyDirect}</p>
          )}
        </div>
      )}

      <Composer
        sessionId={sessionId}
        jid={chat.jid}
        connected={viaNumber ? viaNumber.status === 'connected' : connected}
        reconnecting={viaNumber ? viaNumber.status === 'connecting' : reconnecting}
        title={title}
        reply={viaNumber ? null : reply}
        onCancelReply={cancelReply}
        onSend={onSend}
      />

      {forwardOpen && (
        <ForwardChat
          sessionId={sessionId}
          chat={chat}
          numbers={numbers.data ?? []}
          onClose={() => setForwardOpen(false)}
          onOpen={
            onOpenIn
              ? (sid, jid) => {
                  setForwardOpen(false);
                  onOpenIn(sid, jid);
                }
              : undefined
          }
        />
      )}

      {lightbox !== null && lightbox >= 0 && <Lightbox items={images} index={lightbox} onIndex={setLightbox} onClose={() => setLightbox(null)} />}

      {editing && <EditMessageDialog sessionId={sessionId} message={editing} onClose={closeEdit} />}
      {deleting && (
        <DeleteMessageDialog sessionId={sessionId} message={deleting} isGroup={chat.isGroup} connected={connected} onClose={closeDelete} onNotice={notice} />
      )}

      {wallOpen && (
        <Modal title={c.wall.title} description={c.wall.text} onClose={() => setWallOpen(false)}>
          <div role="radiogroup" aria-label={c.wall.scope} className="grid grid-cols-2 gap-1.5">
            {WALL_SCOPES.map((scope) => {
              const Icon = WALL_ICONS[scope];
              const active = scope === wallScope;
              return (
                <button
                  key={scope}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setWallScope(scope)}
                  className={cx(
                    'flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-start text-sm transition-colors',
                    active ? 'border-brand/50 bg-brand/10 text-ink' : 'border-line text-ink-2 hover:border-line-strong hover:text-ink',
                  )}
                >
                  <Icon className={cx('size-4 shrink-0', active ? 'text-brand' : 'text-muted')} />
                  <span className="min-w-0 flex-1 truncate">{c.wall.scopes[scope]}</span>
                  {wallOwn[scope] && <span aria-hidden className="wall-swatch size-3.5 shrink-0 overflow-hidden rounded-full ring-1 ring-line-strong" style={wallStyle(wallOwn[scope])} />}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted">{wallFrom ? c.wall.using(c.wall.scopes[wallFrom]) : c.wall.usingTheme}</p>
          <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-8">
            <button
              type="button"
              onClick={() => setChatWall(wallScope, null, chat.jid)}
              title={wallScope === 'all' ? c.wall.default : c.wall.inherit}
              aria-pressed={wallOwn[wallScope] === null}
              className={cx(
                'wall-swatch flex aspect-square items-center justify-center rounded-lg text-muted outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring',
                wallOwn[wallScope] === null ? 'ring-2 ring-brand' : 'ring-1 ring-line hover:ring-line-strong',
              )}
            >
              <Undo2 className="relative size-4" />
            </button>
            {CHAT_WALLS.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => setChatWall(wallScope, w.id, chat.jid)}
                title={w.id}
                aria-pressed={wallOwn[wallScope] === w.id}
                className={cx(
                  'wall-swatch aspect-square overflow-hidden rounded-lg outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring',
                  wallOwn[wallScope] === w.id ? 'ring-2 ring-brand ring-offset-2 ring-offset-card' : 'ring-1 ring-line hover:ring-line-strong',
                )}
                style={wallStyle(w.id)}
              />
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}


/**
 * Messages written here but sent through another number (send between numbers): their progress, since
 * they land in that number's chat, not in this one. Sent ones can be dismissed or opened there.
 */
function ViaStatus({ number, jid, onOpen }: { number: ChatNumber; jid: string; onOpen?: () => void }) {
  const { t } = useI18n();
  const x = t.chats.cross;
  const queryClient = useQueryClient();
  const items = usePending(number.id, jid);
  const sending = items.filter((p) => p.state === 'sending' && p.realId === undefined).length;
  const failed = items.filter((p) => p.state === 'failed');
  const sent = items.filter((p) => p.realId !== undefined).length;
  // Sent ones fade from here after a while (that chat, when opened, shows them for real).
  useEffect(() => {
    if (sent === 0 || sending > 0) return;
    const timer = setTimeout(() => settle(number.id, jid, () => true), 8_000);
    return () => clearTimeout(timer);
  }, [sent, sending, number.id, jid]);
  if (items.length === 0) return null;
  return (
    <div className="animate-fade-in mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-raised/70 px-2 py-1 text-[11.5px]">
      {sending > 0 ? (
        <span className="pii flex items-center gap-1.5 text-ink-2">
          <Loader2 className="size-3.5 animate-spin" /> {x.sending(number.name)}
        </span>
      ) : failed.length > 0 ? (
        <span className="pii text-critical">{x.failed(number.name)}</span>
      ) : (
        <span className="pii text-good">✓ {x.sent(number.name)}</span>
      )}
      <span className="ms-auto flex items-center gap-1">
        {failed.length > 0 && (
          <button type="button" onClick={() => failed.forEach((p) => retry(queryClient, number.id, jid, p.ref))} className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-brand hover:bg-brand/10">
            <RotateCw className="size-3" /> {x.retry}
          </button>
        )}
        {onOpen && sent > 0 && (
          <button type="button" onClick={onOpen} className="cursor-pointer rounded px-1.5 py-0.5 text-brand hover:bg-brand/10">
            {x.openThere}
          </button>
        )}
        {sending === 0 && (
          <button
            type="button"
            onClick={() => {
              failed.forEach((p) => discard(number.id, jid, p.ref));
              settle(number.id, jid, () => true);
            }}
            className="cursor-pointer rounded px-1.5 py-0.5 text-muted hover:bg-raised hover:text-ink"
          >
            {x.dismiss}
          </button>
        )}
      </span>
    </div>
  );
}
