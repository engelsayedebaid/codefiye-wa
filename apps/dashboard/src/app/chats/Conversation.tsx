import { UPLOAD_MAX_BYTES } from '@wa/shared/chats';
import { type InfiniteData, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArrowDown,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  History,
  Info,
  Loader2,
  MailOpen,
  MoreVertical,
  Palette,
  Paperclip,
  Pin,
  Reply,
  Search,
  SendHorizontal,
  Undo2,
  WifiOff,
  X,
} from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../../api';
import { useLiveEvents } from '../../events';
import { useI18n } from '../../i18n';
import { qk } from '../../queries';
import { cx, flip, LoadError, Modal } from '../../ui';
import { Avatar, Bubble, TypeLabel } from './Bubble';
import { TypingDots } from './ChatList';
import { type ChatMessage, type ChatSummary, chatTitle, formatBytes, isChat, livePresence, mediaUrl, type MessagesPage, type PresenceState, textOf } from './model';
import { CHAT_WALLS, setChatWall, useChatWall, wallStyle } from './walls';

type Pages = InfiniteData<MessagesPage, number | undefined>;

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
        <img key={m.id} src={src} alt="" referrerPolicy="no-referrer" className="animate-scale-in max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
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

type Item = { kind: 'day'; key: string; label: string } | { kind: 'unread'; key: string; n: number } | { kind: 'msg'; key: string; m: ChatMessage; first: boolean; sender: { name: string; key: string } | null };

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
  const { list, reactions, images } = useMemo(() => {
    const all = (messages.data?.pages.flatMap((p) => p.messages) ?? []).slice().reverse();
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
    return { list: shown, reactions, images: shown.filter((m) => m.type === 'image' && m.hasMedia && !m.content.viewOnce) };
  }, [messages.data]);

  // The unread divider sits where the chat's unread messages began when it was opened.
  const [unreadAtOpen] = useState(chat.unread);
  const firstUnreadId = useMemo(() => {
    if (!unreadAtOpen || q) return null;
    const inbound = list.filter((m) => m.direction === 'in');
    return inbound[Math.max(0, inbound.length - unreadAtOpen)]?.id ?? null;
  }, [list, unreadAtOpen, q]);

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
      const senderKey = m.direction === 'in' ? (m.content.from ?? '') : 'me';
      const prevKey = prev ? (prev.direction === 'in' ? (prev.content.from ?? '') : 'me') : null;
      const first = !prev || prevKey !== senderKey || new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > 5 * 60_000;
      const sender = chat.isGroup && m.direction === 'in' ? { name: m.content.pushName || m.content.fromPhone || senderKey.split('@')[0]!, key: senderKey } : null;
      out.push({ kind: 'msg', key: `m-${m.id}`, m, first, sender });
      prev = m;
    }
    return out;
  }, [list, firstUnreadId, unreadAtOpen, chat.isGroup, fmt]);

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
      const { messages: fresh } = await api<MessagesPage>(`/api/chats/${sessionId}/messages?${params}`);
      if (fresh.length === 0) return;
      queryClient.setQueryData<Pages>(key, (data) => {
        if (!data?.pages[0]) return data;
        const known = new Set(data.pages.flatMap((p) => p.messages.map((m) => m.id)));
        const added = fresh.filter((m) => !known.has(m.id));
        return { ...data, pages: [{ ...data.pages[0], messages: [...added, ...data.pages[0].messages] }, ...data.pages.slice(1)] };
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
      void catchUp();
    } else if (event.type === 'message.changed') {
      // Edited or deleted for everyone by its sender: reload if it's one of ours here.
      if (isChat(chat, event.data.chatJid)) void queryClient.invalidateQueries({ queryKey: key });
    } else if (event.type === 'chats.synced') {
      if (event.data.added > 0 && (event.data.chatJid === null || isChat(chat, event.data.chatJid))) void queryClient.invalidateQueries({ queryKey: key });
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
  const jump = (waMessageId: string) => {
    const el = document.getElementById(`msg-${waMessageId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('flash-msg');
    void el.offsetWidth;
    el.classList.add('flash-msg');
  };

  // --- composer ---
  const [text, setText] = useState('');
  const [reply, setReply] = useState<ChatMessage | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [ptt, setPtt] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const preview = useMemo(() => (file && file.type.startsWith('image/') ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  // "typing…" for the contact: at most every 8s while typing, "paused" after 4s idle.
  const typingAt = useRef(0);
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendState = useCallback(
    (state: 'composing' | 'paused') => void api(`/api/chats/${sessionId}/typing`, { method: 'POST', body: { jid: chat.jid, state } }).catch(() => {}),
    [sessionId, chat.jid],
  );
  const onType = (value: string) => {
    setText(value);
    if (!connected) return;
    if (Date.now() - typingAt.current > 8_000 && value.trim()) {
      typingAt.current = Date.now();
      sendState('composing');
    }
    if (pauseTimer.current) clearTimeout(pauseTimer.current);
    pauseTimer.current = setTimeout(() => {
      if (typingAt.current) sendState('paused');
      typingAt.current = 0;
    }, 4_000);
  };
  useEffect(() => () => void (pauseTimer.current && clearTimeout(pauseTimer.current)), []);

  // Grow the textarea with its text, up to ~6 lines.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const send = useMutation({
    mutationFn: async () => {
      let uploadId: string | undefined;
      if (file) {
        const res = await fetch('/api/chats/uploads', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/octet-stream', 'x-mime-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
          body: file,
        });
        const json = (await res.json().catch(() => null)) as { success: boolean; data?: { id: string }; message?: string } | null;
        if (!res.ok || !json?.success || !json.data) throw new ApiRequestError(res.status, json?.message ?? c.errors.upload);
        uploadId = json.data.id;
      }
      return api<ChatMessage>(`/api/chats/${sessionId}/send`, {
        method: 'POST',
        body: { jid: chat.jid, ...(text.trim() ? { text: text.trim() } : {}), ...(uploadId ? { uploadId, ptt } : {}), ...(reply?.waMessageId ? { quoteId: reply.waMessageId } : {}) },
        timeoutMs: 60_000,
      });
    },
    onSuccess: (m) => {
      queryClient.setQueryData<Pages>(key, (data) => {
        if (!data?.pages[0] || data.pages.some((p) => p.messages.some((x) => x.id === m.id))) return data;
        return { ...data, pages: [{ ...data.pages[0], messages: [m, ...data.pages[0].messages] }, ...data.pages.slice(1)] };
      });
      setText('');
      setFile(null);
      setReply(null);
      setPtt(false);
      setSendError(null);
      typingAt.current = 0;
      toBottom();
      input.current?.focus();
    },
    onError: (err) => setSendError(errorMessage(err)),
  });

  const canSend = connected && !send.isPending && (text.trim().length > 0 || file !== null);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (canSend) send.mutate();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape' && reply) setReply(null);
  };
  const pickFile = (f: File | undefined) => {
    if (!f) return;
    if (f.size > UPLOAD_MAX_BYTES) return setSendError(c.composer.tooLarge(UPLOAD_MAX_BYTES / 1024 / 1024));
    setSendError(null);
    setFile(f);
    setPtt(false);
    input.current?.focus();
  };

  // Reply / focus when a chat opens or a reply is picked.
  useEffect(() => {
    input.current?.focus();
  }, [chat.jid, reply]);

  const [menu, setMenu] = useState(false);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const quotedAuthor = (fromMe: boolean, participant: string | null) => (fromMe ? c.you : chat.isGroup && participant ? `+${participant.split('@')[0]}` : title);

  const replyText = reply ? textOf(reply) : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* header */}
      <header className="z-10 flex h-[4.25rem] shrink-0 items-center gap-1.5 border-b border-line/60 bg-card/85 px-2 backdrop-blur-md md:px-4">
        <button type="button" onClick={onBack} className="rounded-full p-2 text-muted hover:bg-raised hover:text-ink lg:hidden" aria-label={c.back}>
          <ArrowLeft className={cx('size-5', flip)} />
        </button>
        <button type="button" onClick={onToggleInfo} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1 text-start transition-colors hover:bg-raised/60">
          <Avatar name={title} id={chat.jid} picture={picture} group={chat.isGroup} online={livePresence(presence)?.presence === 'available'} />
          <span className="min-w-0">
            <span dir="auto" className="block truncate font-semibold">
              {chat.name ? title : <span className="ltr font-mono">{title}</span>}
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
          <div className="pt-2 pb-4">
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
                {items.map((item) =>
                  item.kind === 'day' ? (
                    <div key={item.key} className="sticky top-2 z-[5] my-3 flex justify-center">
                      <span className="rounded-lg bg-card/95 px-3 py-1 text-xs font-medium text-muted shadow-sm ring-1 ring-line/60 backdrop-blur">{item.label}</span>
                    </div>
                  ) : item.kind === 'unread' ? (
                    <div key={item.key} className="my-3 flex justify-center bg-brand/[0.07] py-1.5">
                      <span className="rounded-full bg-card px-3 py-0.5 text-xs font-semibold text-brand shadow-sm">{c.unreadDivider(item.n)}</span>
                    </div>
                  ) : (
                    <div key={item.key} className={cx('animate-fade-in', reactions.has(item.m.waMessageId ?? '') && 'mb-3')}>
                      <Bubble
                        m={item.m}
                        first={item.first}
                        sender={item.sender}
                        reactions={item.m.waMessageId ? reactions.get(item.m.waMessageId) : undefined}
                        highlight={q || undefined}
                        quotedAuthor={quotedAuthor}
                        onReply={setReply}
                        onOpenMedia={(m) => setLightbox(images.findIndex((x) => x.id === m.id))}
                        onJump={jump}
                        onOpenChat={onOpenPhone}
                      />
                    </div>
                  ),
                )}
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

      {/* composer */}
      <form onSubmit={submit} className="shrink-0 border-t border-line/60 bg-card/80 px-2 py-2.5 backdrop-blur md:px-4">
        {!connected && (
          <p className="mb-2 flex items-center gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
            <WifiOff className="size-4 shrink-0" /> {c.composer.disconnected}
          </p>
        )}
        {sendError && (
          <p role="alert" className="mb-2 flex items-start justify-between gap-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400">
            <span>
              {c.errors.send}: {sendError}
            </span>
            <button type="button" onClick={() => setSendError(null)} aria-label={t.common.close}>
              <X className="size-3.5" />
            </button>
          </p>
        )}
        {reply && (
          <div className="animate-fade-up mb-2 flex items-center gap-2 overflow-hidden rounded-lg bg-raised ps-0">
            <span className="w-1 self-stretch bg-brand" />
            <Reply className={cx('size-4 shrink-0 text-brand', flip)} />
            <div className="min-w-0 flex-1 py-1.5">
              <p className="text-xs font-semibold text-brand">
                {c.replyingTo} {reply.direction === 'out' ? c.you : (reply.content.pushName ?? title)}
              </p>
              <p dir="auto" className="truncate text-xs text-muted">
                {replyText || <TypeLabel type={reply.type} />}
              </p>
            </div>
            <button type="button" onClick={() => setReply(null)} className="me-2 rounded p-1 text-muted hover:text-ink" aria-label={c.cancelReply}>
              <X className="size-4" />
            </button>
          </div>
        )}
        {file && (
          <div className="animate-fade-up mb-2 flex items-center gap-3 rounded-lg bg-raised p-2">
            {preview ? (
              <img src={preview} alt="" className="size-14 rounded-md object-cover" />
            ) : (
              <span className="flex size-14 items-center justify-center rounded-md bg-bg text-muted">{file.type.startsWith('image/') ? <ImageIcon className="size-6" /> : <FileText className="size-6" />}</span>
            )}
            <div className="min-w-0 flex-1">
              <p dir="auto" className="truncate text-sm font-medium">
                {file.name}
              </p>
              <p className="text-xs text-muted">{formatBytes(file.size)}</p>
              {file.type.startsWith('audio/') && (
                <label className="mt-1 flex items-center gap-1.5 text-xs text-ink-2">
                  <input type="checkbox" checked={ptt} onChange={(e) => setPtt(e.target.checked)} className="accent-[var(--color-brand)]" />
                  {c.composer.voiceNote}
                </label>
              )}
            </div>
            <button type="button" onClick={() => setFile(null)} className="rounded p-1 text-muted hover:text-ink" aria-label={c.composer.removeFile}>
              <X className="size-4" />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          {/* One rounded field: attach, text, then send beside it. */}
          <div className="flex min-w-0 flex-1 items-end gap-1 rounded-2xl border border-line bg-bg p-1 shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30">
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={!connected}
              className="flex size-9 shrink-0 items-center justify-center rounded-xl text-muted transition-colors hover:bg-raised hover:text-ink disabled:opacity-40"
              aria-label={c.composer.attach}
              title={c.composer.attach}
            >
              <Paperclip className="size-[18px]" />
            </button>
            <input ref={fileInput} type="file" className="hidden" onChange={(e) => (pickFile(e.target.files?.[0]), (e.target.value = ''))} />
            <textarea
              ref={input}
              rows={1}
              value={text}
              onChange={(e) => onType(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const pasted = [...e.clipboardData.files][0];
                if (pasted) {
                  e.preventDefault();
                  pickFile(pasted);
                }
              }}
              dir="auto"
              placeholder={file ? c.composer.caption : c.composer.placeholder}
              aria-label={c.composer.placeholder}
              title={c.composer.hint}
              className="code-scroll max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-5 text-ink outline-none placeholder:text-muted"
            />
          </div>
          <button
            type="submit"
            disabled={!canSend}
            className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-brand text-on-brand shadow-[0_8px_24px_-10px] shadow-brand/70 transition-[transform,opacity] hover:-translate-y-0.5 active:translate-y-0 disabled:translate-y-0 disabled:opacity-40 disabled:shadow-none"
            aria-label={c.composer.send}
          >
            {send.isPending ? <Loader2 className="size-5 animate-spin" /> : <SendHorizontal className={cx('size-5', flip)} />}
          </button>
        </div>
      </form>

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
