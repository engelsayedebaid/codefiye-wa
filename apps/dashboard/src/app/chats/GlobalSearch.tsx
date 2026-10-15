import { useInfiniteQuery } from '@tanstack/react-query';
import {
  AudioLines,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Film,
  Image as ImageIcon,
  Layers,
  Link2,
  Loader2,
  MessageSquareText,
  Mic,
  Play,
  Search,
  SearchX,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
import { useI18n } from '../../i18n';
import { qk } from '../../queries';
import { cx, flip, Select } from '../../ui';
import { Avatar, TypeLabel } from './Bubble';
import { ChatText } from './ChatText';
import { type ChatNumber, chatTitle, formatBytes, formatDuration, mediaUrl, SEARCH_KINDS, type SearchChat, type SearchHit, type SearchKind, type SearchPage, textOf } from './model';

const KIND_ICONS = { all: Layers, text: MessageSquareText, images: ImageIcon, videos: Film, audio: AudioLines, documents: FileText, links: Link2 } satisfies Record<SearchKind, unknown>;
const KIND_KEY = 'wa.chats.searchKind';
const ALL = '';

const thumbSrc = (thumb?: string) => (thumb ? `data:image/jpeg;base64,${thumb}` : undefined);
/** The file of a message: what the worker stored, or (sent from here) the link it was sent from. */
const srcOf = (m: SearchHit) => (m.content.url?.startsWith('http') && !m.content.media ? m.content.url : mediaUrl(m.id));
const isVoice = (m: SearchHit) => Boolean(m.content.media?.ptt ?? m.content.ptt);

/** The part of a long text around the first hit, so the match shows without opening the message. */
function snippet(text: string, q: string, room = 70) {
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0 || text.length <= room * 2 + q.length) return text;
  const start = Math.max(0, at - room);
  const end = Math.min(text.length, at + q.length + room);
  return `${start > 0 ? '… ' : ''}${text.slice(start, end)}${end < text.length ? ' …' : ''}`;
}

/**
 * Search across every chat of every number (or one): any text in messages, captions, file names and
 * polls, plus chats by name or number — or a whole kind browsed on its own (images and videos as a
 * gallery with a viewer, voice notes playable in place, documents to download). A result opens its chat,
 * already searched for the words.
 */
export function GlobalSearch({ numbers, initialSession, onOpen, onClose }: { numbers: ChatNumber[]; initialSession?: string | null; onOpen: (sessionId: string, jid: string, q: string) => void; onClose: () => void }) {
  const { t, fmt } = useI18n();
  const g = t.chats.globalSearch;
  const [raw, setRaw] = useState('');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<SearchKind>(() => {
    try {
      const stored = localStorage.getItem(KIND_KEY);
      return SEARCH_KINDS.includes(stored as SearchKind) ? (stored as SearchKind) : 'all';
    } catch {
      return 'all';
    }
  });
  const [scope, setScope] = useState<string>(numbers.length > 1 ? ALL : (initialSession ?? ALL));
  const [viewer, setViewer] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQ(raw.trim()), 300);
    return () => clearTimeout(timer);
  }, [raw]);
  const pickKind = (next: SearchKind) => {
    setKind(next);
    setViewer(null);
    try {
      localStorage.setItem(KIND_KEY, next);
    } catch {
      // private mode: just not remembered
    }
  };

  const needsWords = kind === 'all' || kind === 'text';
  const search = useInfiniteQuery({
    queryKey: qk.chats.search(scope, kind, q),
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ kind, limit: kind === 'images' || kind === 'videos' ? '48' : '30' });
      if (q) params.set('q', q);
      if (scope) params.set('sessionId', scope);
      if (pageParam) params.set('before', String(pageParam));
      return api<SearchPage>(`/api/chats/search?${params}`, { signal, timeoutMs: 30_000 });
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => page.nextBefore ?? undefined,
    enabled: !needsWords || q.length > 0,
    staleTime: 30_000,
  });
  const hits = search.data?.pages.flatMap((p) => p.results) ?? [];
  const chats = search.data?.pages[0]?.chats ?? [];
  const media = hits.filter((m) => (m.type === 'image' || m.type === 'video') && m.hasMedia && !m.content.viewOnce);

  // More as the end of the list comes into view.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = search;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const observer = new IntersectionObserver((entries) => entries[0]?.isIntersecting && !isFetchingNextPage && void fetchNextPage(), { rootMargin: '400px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, hits.length]);

  // Esc closes the viewer first, then the search (before the page's own Esc handling).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('[role="listbox"]')) return;
      e.stopPropagation();
      if (viewer !== null) setViewer(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [viewer, onClose]);

  const numberName = (id: string) => (numbers.length > 1 && !scope ? (numbers.find((n) => n.id === id)?.name ?? null) : null);
  const open = (sessionId: string, jid: string) => onOpen(sessionId, jid, kind === 'all' || kind === 'text' || kind === 'links' ? q : '');
  const scopeOptions = [{ value: ALL, label: g.allNumbers }, ...numbers.map((n) => ({ value: n.id, label: <span className="pii">{n.name}</span> }))];
  const loading = search.isPending && search.fetchStatus !== 'idle';

  let body;
  if (needsWords && !q) body = <Hint onKind={pickKind} />;
  else if (loading) body = <Skeleton grid={kind === 'images' || kind === 'videos'} />;
  else if (search.isError) body = <Empty icon={SearchX} title={g.failed} text={errorMessage(search.error)} />;
  else if (hits.length === 0 && chats.length === 0) body = <Empty icon={SearchX} title={g.empty} text={g.emptyText} />;
  else if (kind === 'images' || kind === 'videos') {
    body = (
      <div className="grid grid-cols-3 gap-1.5 p-3 sm:grid-cols-4 md:grid-cols-5">
        {hits.map((m) => {
          const at = media.indexOf(m);
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => (at >= 0 ? setViewer(at) : open(m.sessionId, m.chat.jid))}
              className="group relative aspect-square cursor-pointer overflow-hidden rounded-lg bg-raised text-start"
            >
              {m.type === 'image' && m.hasMedia ? (
                <img src={srcOf(m)} alt="" loading="lazy" referrerPolicy="no-referrer" className="pii size-full object-cover transition-transform duration-300 group-hover:scale-105" />
              ) : thumbSrc(m.content.media?.thumb) ? (
                <img src={thumbSrc(m.content.media?.thumb)} alt="" className="pii size-full object-cover" />
              ) : (
                <span className="flex size-full items-center justify-center text-muted">{m.type === 'video' ? <Film className="size-6" /> : <ImageIcon className="size-6" />}</span>
              )}
              {m.type === 'video' && (
                <span className="absolute inset-0 flex items-center justify-center bg-black/25 text-white">
                  <span className="grid size-10 place-items-center rounded-full bg-black/45 backdrop-blur-sm">
                    <Play className="size-5 fill-current" />
                  </span>
                </span>
              )}
              <span className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-1 bg-gradient-to-t from-black/75 to-transparent px-1.5 pt-5 pb-1 text-[10.5px] text-white">
                <span className="pii min-w-0 truncate font-medium">{chatTitle(m.chat)}</span>
                {m.type === 'video' && m.content.media?.seconds ? <span className="ltr shrink-0 tabular-nums">{formatDuration(m.content.media.seconds)}</span> : null}
              </span>
            </button>
          );
        })}
      </div>
    );
  } else if (kind === 'audio') {
    body = (
      <ul className="divide-y divide-line/70">
        {hits.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className={cx('grid size-10 shrink-0 place-items-center rounded-full', isVoice(m) ? 'bg-brand/15 text-brand' : 'bg-violet-500/15 text-violet-400')}>
              {isVoice(m) ? <Mic className="size-[18px]" /> : <AudioLines className="size-[18px]" />}
            </span>
            <HitTitle m={m} number={numberName(m.sessionId)} onOpen={() => open(m.sessionId, m.chat.jid)} subtitle={<TypeLabel type={m.type} voice={isVoice(m)} />} />
            {m.hasMedia ? (
              <audio controls preload="none" src={srcOf(m)} className="h-9 w-full min-w-0 sm:w-72" />
            ) : (
              <span className="text-xs text-faint">{g.noFile}</span>
            )}
          </li>
        ))}
      </ul>
    );
  } else if (kind === 'documents') {
    body = (
      <ul className="divide-y divide-line/70">
        {hits.map((m) => {
          const name = m.content.media?.fileName ?? m.content.fileName ?? t.chats.media.document;
          return (
            <li key={m.id} className="flex items-center gap-3 px-4 py-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-rose-500/10 text-rose-400">
                <FileText className="size-5" />
              </span>
              <HitTitle
                m={m}
                number={numberName(m.sessionId)}
                onOpen={() => open(m.sessionId, m.chat.jid)}
                subtitle={
                  <>
                    <span dir="auto" className="pii text-ink-2">
                      <ChatText text={name} highlight={q || undefined} />
                    </span>
                    {m.content.media?.size ? <span className="ltr ms-2 text-faint">{formatBytes(m.content.media.size)}</span> : null}
                  </>
                }
              />
              {m.hasMedia && (
                <a href={mediaUrl(m.id, true)} className="grid size-9 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-raised hover:text-ink" aria-label={t.chats.media.download} title={t.chats.media.download}>
                  <Download className="size-4" />
                </a>
              )}
            </li>
          );
        })}
      </ul>
    );
  } else {
    body = (
      <>
        {chats.length > 0 && (
          <section className="border-b border-line/70 pb-1">
            <h3 className="px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-ink-3 uppercase">{g.chats}</h3>
            <ul>
              {chats.map((c) => (
                <ChatRow key={`${c.sessionId}:${c.jid}`} chat={c} q={q} number={numberName(c.sessionId)} onOpen={() => open(c.sessionId, c.jid)} />
              ))}
            </ul>
          </section>
        )}
        {hits.length > 0 && (
          <section>
            {chats.length > 0 && <h3 className="px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-ink-3 uppercase">{g.messages}</h3>}
            <ul className="divide-y divide-line/50">
              {hits.map((m) => (
                <MessageRow key={m.id} m={m} q={q} number={numberName(m.sessionId)} onOpen={() => open(m.sessionId, m.chat.jid)} onView={media.includes(m) ? () => setViewer(media.indexOf(m)) : undefined} />
              ))}
            </ul>
          </section>
        )}
      </>
    );
  }

  return (
    <div className="animate-fade-in fixed inset-0 z-[65] flex items-start justify-center bg-black/55 p-0 backdrop-blur-[2px] sm:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal
        aria-label={g.title}
        onClick={(e) => e.stopPropagation()}
        className="animate-scale-in flex h-full w-full max-w-4xl origin-top flex-col overflow-hidden border border-line bg-card shadow-2xl sm:h-[min(88svh,56rem)] sm:rounded-2xl"
      >
        <div className="flex items-center gap-2 border-b border-line p-3">
          <label className="relative flex min-w-0 flex-1 items-center">
            <Search className="pointer-events-none absolute start-3 size-5 text-muted" />
            <input
              ref={input}
              autoFocus
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={g.placeholder}
              aria-label={g.placeholder}
              dir={raw ? 'auto' : undefined}
              className="h-11 w-full rounded-xl border border-line bg-surface ps-10 pe-9 text-[15px] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-faint focus:border-ring focus:ring-[3px] focus:ring-ring/30"
            />
            {search.isFetching && !loading ? (
              <Loader2 className="absolute end-3 size-4 animate-spin text-muted" />
            ) : (
              raw && (
                <button
                  type="button"
                  onClick={() => {
                    setRaw('');
                    input.current?.focus();
                  }}
                  className="absolute end-2 rounded-md p-1 text-muted hover:text-ink"
                  aria-label={t.common.close}
                >
                  <X className="size-4" />
                </button>
              )
            )}
          </label>
          {numbers.length > 1 && <Select value={scope} onChange={setScope} options={scopeOptions} aria-label={g.scope} className="hidden w-44 sm:block" />}
          <button type="button" onClick={onClose} className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-xl text-muted transition-colors hover:bg-raised hover:text-ink" aria-label={t.common.close}>
            <X className="size-5" />
          </button>
        </div>
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <div role="radiogroup" aria-label={g.title} className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]">
            {SEARCH_KINDS.map((k) => {
              const Icon = KIND_ICONS[k];
              const active = k === kind;
              return (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => pickKind(k)}
                  className={cx(
                    'flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                    active ? 'border-brand/40 bg-brand/10 text-brand' : 'border-line text-muted hover:border-line-strong hover:text-ink',
                  )}
                >
                  <Icon className="size-3.5" />
                  {g.kinds[k]}
                </button>
              );
            })}
          </div>
          {numbers.length > 1 && <Select value={scope} onChange={setScope} options={scopeOptions} aria-label={g.scope} className="w-36 shrink-0 sm:hidden" />}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {body}
          <div ref={sentinel} />
          {isFetchingNextPage && (
            <p className="flex items-center justify-center gap-2 py-4 text-xs text-muted">
              <Loader2 className="size-4 animate-spin" /> {g.loading}
            </p>
          )}
        </div>
      </div>
      {viewer !== null && media[viewer] && (
        <Viewer
          items={media}
          index={viewer}
          onIndex={setViewer}
          onClose={() => setViewer(null)}
          onOpen={(m) => open(m.sessionId, m.chat.jid)}
          number={(m) => numberName(m.sessionId)}
          when={(m) => fmt.dateTime(m.createdAt)}
        />
      )}
    </div>
  );
}

/** The chat (and number) a result belongs to, a line under it, and when; opens the chat. */
function HitTitle({ m, number, subtitle, onOpen }: { m: SearchHit; number: string | null; subtitle: ReactNode; onOpen: () => void }) {
  const { fmt } = useI18n();
  return (
    <button type="button" onClick={onOpen} className="min-w-0 flex-1 cursor-pointer text-start">
      <span className="flex items-center gap-2">
        <span className="pii truncate text-sm font-medium">{chatTitle(m.chat)}</span>
        {number && <span className="pii shrink-0 rounded-full bg-raised px-1.5 py-0.5 text-[10px] text-ink-2">{number}</span>}
        <span className="ms-auto shrink-0 text-[11px] text-faint tabular-nums">{fmt.dateTime(m.createdAt)}</span>
      </span>
      <span className="mt-0.5 block truncate text-xs text-muted">{subtitle}</span>
    </button>
  );
}

function ChatRow({ chat, q, number, onOpen }: { chat: SearchChat; q: string; number: string | null; onOpen: () => void }) {
  const { fmt } = useI18n();
  const title = chatTitle(chat);
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-start transition-colors hover:bg-raised/60">
        <Avatar name={title} id={chat.jid} group={chat.isGroup} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="pii block truncate text-sm font-medium">
            <ChatText text={title} highlight={q} />
          </span>
          {chat.phone && chat.name && (
            <span className="pii ltr block truncate font-mono text-[11px] text-muted">
              <ChatText text={chat.phone} highlight={q.replace(/\D/g, '') || undefined} />
            </span>
          )}
        </span>
        {number && <span className="pii shrink-0 rounded-full bg-raised px-1.5 py-0.5 text-[10px] text-ink-2">{number}</span>}
        <span className="shrink-0 text-[11px] text-faint">{fmt.timeAgo(chat.lastMessageAt)}</span>
      </button>
    </li>
  );
}

/** A message found: its chat, who wrote it, the words around the hit, and a small preview for media. */
function MessageRow({ m, q, number, onOpen, onView }: { m: SearchHit; q: string; number: string | null; onOpen: () => void; onView?: () => void }) {
  const { t, fmt } = useI18n();
  const g = t.chats.globalSearch;
  const title = chatTitle(m.chat);
  const text = textOf(m) ?? m.content.media?.fileName ?? m.content.fileName ?? null;
  const who = m.direction === 'out' ? g.you : m.sender;
  const thumb = m.type === 'image' && m.hasMedia ? srcOf(m) : thumbSrc(m.content.media?.thumb);
  return (
    <li className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-raised/60">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 text-start">
        <Avatar name={title} id={m.chat.jid} group={m.chat.isGroup} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="pii truncate text-sm font-medium">{title}</span>
            {number && <span className="pii shrink-0 rounded-full bg-raised px-1.5 py-0.5 text-[10px] text-ink-2">{number}</span>}
            <span className="ms-auto shrink-0 text-[11px] text-faint tabular-nums">{fmt.dateTime(m.createdAt)}</span>
          </span>
          <span dir="auto" className="pii mt-0.5 line-clamp-2 text-[13px] leading-snug text-ink-2">
            {who && <span className="font-medium text-ink">{who}: </span>}
            {m.type !== 'text' && (
              <span className="me-1 text-muted">
                [<TypeLabel type={m.type} voice={Boolean(m.content.media?.ptt ?? m.content.ptt)} />]
              </span>
            )}
            {text && <ChatText text={snippet(text, q)} highlight={q || undefined} />}
          </span>
        </span>
      </button>
      {thumb && (
        <button type="button" onClick={onView ?? onOpen} className="relative size-12 shrink-0 cursor-pointer overflow-hidden rounded-lg bg-raised">
          <img src={thumb} alt="" loading="lazy" referrerPolicy="no-referrer" className="pii size-full object-cover" />
          {m.type === 'video' && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/30 text-white">
              <Play className="size-4 fill-current" />
            </span>
          )}
        </button>
      )}
    </li>
  );
}

/** Images and videos found, one at a time; ←/→ step through them. */
function Viewer({
  items,
  index,
  onIndex,
  onClose,
  onOpen,
  number,
  when,
}: {
  items: SearchHit[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onOpen: (m: SearchHit) => void;
  number: (m: SearchHit) => string | null;
  when: (m: SearchHit) => string;
}) {
  const { t, dir } = useI18n();
  const g = t.chats.globalSearch;
  const m = items[index]!;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
      const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
      if (e.key === forward && index < items.length - 1) onIndex(index + 1);
      if (e.key === back && index > 0) onIndex(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, items.length, onIndex, dir]);
  const caption = textOf(m);
  const tag = number(m);
  return (
    <div
      className="animate-fade-in fixed inset-0 z-[75] flex flex-col bg-black/90 backdrop-blur-sm"
      role="dialog"
      aria-modal
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="flex items-center justify-between gap-3 p-3 text-white" onClick={(e) => e.stopPropagation()}>
        <span className="min-w-0">
          <span className="pii block truncate text-sm font-medium">
            {chatTitle(m.chat)}
            {tag && <span className="ms-2 text-white/60">· {tag}</span>}
          </span>
          <span className="block text-xs text-white/60">{when(m)}</span>
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => onOpen(m)} className="flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-sm hover:bg-white/10">
            <MessageSquareText className="size-4" /> <span className="hidden sm:inline">{g.openChat}</span>
          </button>
          <a href={mediaUrl(m.id, true)} className="rounded-full p-2 hover:bg-white/10" aria-label={t.chats.media.download}>
            <Download className="size-5" />
          </a>
          <button type="button" onClick={onClose} className="cursor-pointer rounded-full p-2 hover:bg-white/10" aria-label={t.common.close}>
            <X className="size-5" />
          </button>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-14" onClick={(e) => e.stopPropagation()}>
        {index > 0 && (
          <button type="button" onClick={() => onIndex(index - 1)} className="absolute start-3 cursor-pointer rounded-full bg-white/10 p-2 text-white hover:bg-white/20" aria-label={g.previous}>
            <ChevronLeft className={cx('size-6', flip)} />
          </button>
        )}
        {m.type === 'video' ? (
          <video key={m.id} src={srcOf(m)} controls autoPlay playsInline poster={thumbSrc(m.content.media?.thumb)} className="pii max-h-full max-w-full rounded-lg bg-black shadow-2xl" />
        ) : (
          <img key={m.id} src={srcOf(m)} alt="" referrerPolicy="no-referrer" className="pii animate-scale-in max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
        )}
        {index < items.length - 1 && (
          <button type="button" onClick={() => onIndex(index + 1)} className="absolute end-3 cursor-pointer rounded-full bg-white/10 p-2 text-white hover:bg-white/20" aria-label={g.next}>
            <ChevronRight className={cx('size-6', flip)} />
          </button>
        )}
      </div>
      {caption && (
        <p dir="auto" className="pii mx-auto max-w-2xl p-4 text-center text-sm text-white/90" onClick={(e) => e.stopPropagation()}>
          {caption}
        </p>
      )}
    </div>
  );
}

/** Before any words: what this searches, and the kinds to browse right away. */
function Hint({ onKind }: { onKind: (kind: SearchKind) => void }) {
  const { t } = useI18n();
  const g = t.chats.globalSearch;
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span className="grid size-14 place-items-center rounded-2xl bg-brand/10 text-brand">
        <Search className="size-7" />
      </span>
      <h3 className="mt-4 text-lg font-semibold">{g.hintTitle}</h3>
      <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted">{g.hintText}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {(['images', 'videos', 'audio', 'documents', 'links'] as const).map((k) => {
          const Icon = KIND_ICONS[k];
          return (
            <button
              key={k}
              type="button"
              onClick={() => onKind(k)}
              className="lift flex cursor-pointer items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink-2 transition-colors hover:border-brand/40 hover:text-ink"
            >
              <Icon className="size-4 text-brand" />
              {g.browse} · {g.kinds[k]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Empty({ icon: Icon, title, text }: { icon: typeof Search; title: string; text: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <Icon className="size-10 text-faint" />
      <h3 className="mt-3 font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted">{text}</p>
    </div>
  );
}

function Skeleton({ grid }: { grid: boolean }) {
  if (grid)
    return (
      <div className="grid grid-cols-3 gap-1.5 p-3 sm:grid-cols-4 md:grid-cols-5">
        {Array.from({ length: 15 }, (_, i) => (
          <span key={i} className="aspect-square animate-pulse rounded-lg bg-raised" />
        ))}
      </div>
    );
  return (
    <ul className="divide-y divide-line/50">
      {Array.from({ length: 7 }, (_, i) => (
        <li key={i} className="flex items-center gap-3 px-4 py-3">
          <span className="size-8 shrink-0 animate-pulse rounded-full bg-raised" />
          <span className="flex-1 space-y-2">
            <span className="block h-2.5 w-1/3 animate-pulse rounded-full bg-raised" />
            <span className="block h-2 w-2/3 animate-pulse rounded-full bg-raised" />
          </span>
        </li>
      ))}
    </ul>
  );
}
