import { useQuery } from '@tanstack/react-query';
import { Eye, EyeOff, Loader2, MessageSquareText, X } from '../../icons';
import { type CSSProperties, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { useLiveEvents } from '../../events';
import { useI18n } from '../../i18n';
import { cx } from '../../ui';
import { Avatar, Bubble } from './Bubble';
import { Floating } from './Floating';
import { type ChatMessage, type ChatSummary, chatTitle, isChat, jidPhone, mediaUrl, type MessagesPage, type Sender } from './model';
import { useChatWalls, wallsFor, wallStyle } from './walls';

const WIDTH = 380;
const HEIGHT = 540;
const SHOWN = 25;

/** Where the window opens: beside the row on the side the list opens onto, else over the list. */
function place(anchor: DOMRect, rtl: boolean) {
  const width = Math.min(WIDTH, window.innerWidth - 16);
  const height = Math.min(HEIGHT, window.innerHeight - 16);
  const side = rtl ? anchor.left - width - 10 : anchor.right + 10;
  const fits = side >= 8 && side + width <= window.innerWidth - 8;
  const left = fits ? side : Math.min(Math.max(8, anchor.left), window.innerWidth - width - 8);
  const top = Math.max(8, Math.min(fits ? anchor.top - 40 : anchor.bottom + 6, window.innerHeight - height - 8));
  // The window grows out of the row it belongs to.
  const origin = `${fits ? (rtl ? 'right' : 'left') : 'center'} ${Math.max(0, Math.min(height, anchor.top + anchor.height / 2 - top))}px`;
  return { top, left, width, height, origin };
}

/**
 * The 👁 of a chat row: a glance at its latest messages without opening it. Nothing here marks the chat
 * read or sends blue ticks — only an opened conversation does — so the contact never learns it was seen,
 * and the unread badge stays. Messages arriving meanwhile show up in it.
 */
export function PeekButton({ sessionId, chat, onOpen }: { sessionId: string; chat: ChatSummary; onOpen: () => void }) {
  const { t, dir } = useI18n();
  const p = t.chats.peek;
  const [at, setAt] = useState<ReturnType<typeof place> | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const open = at !== null;

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) return setAt(null);
    const row = button.current!.closest('li') ?? button.current!;
    setAt(place(row.getBoundingClientRect(), dir === 'rtl'));
  };
  useEffect(() => {
    if (!open) return;
    const close = () => setAt(null);
    const outside = (target: EventTarget | null) => !box.current?.contains(target as Node) && !button.current?.contains(target as Node);
    const onDown = (e: PointerEvent) => outside(e.target) && close();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    // The list scrolling under it moves its row away: close (scrolling inside it is fine).
    const onScroll = (e: Event) => outside(e.target) && close();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-label={p.open}
        aria-expanded={open}
        title={p.open}
        className={cx('grid size-7 cursor-pointer place-items-center rounded-full transition-colors', open ? 'bg-brand/15 text-brand' : 'text-muted hover:bg-raised hover:text-brand')}
      >
        <Eye className="size-[15px]" />
      </button>
      {at && (
        <Floating>
        <div
          ref={box}
          role="dialog"
          aria-label={p.title}
          onClick={(e) => e.stopPropagation()}
          className="animate-scale-in fixed z-[70] flex flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-[0_24px_70px_-20px] shadow-black/60 ring-1 ring-black/5 light:shadow-black/25"
          style={{ top: at.top, left: at.left, width: at.width, height: at.height, transformOrigin: at.origin }}
        >
          <PeekBody
            sessionId={sessionId}
            chat={chat}
            onClose={() => setAt(null)}
            onOpen={() => {
              setAt(null);
              onOpen();
            }}
          />
        </div>
        </Floating>
      )}
    </>
  );
}

type Line = { kind: 'day'; key: string; label: string } | { kind: 'new'; key: string; n: number } | { kind: 'msg'; key: string; m: ChatMessage; first: boolean; sender: Sender | null };

function PeekBody({ sessionId, chat, onClose, onOpen }: { sessionId: string; chat: ChatSummary; onClose: () => void; onOpen: () => void }) {
  const { t, fmt } = useI18n();
  const p = t.chats.peek;
  const title = chatTitle(chat);
  const { wall } = wallsFor(useChatWalls(), chat);
  const scroller = useRef<HTMLDivElement>(null);
  const messages = useQuery({
    // Its own key: the conversation's cache holds pages in another shape.
    queryKey: ['chats', sessionId, 'peek', chat.jid],
    queryFn: ({ signal }) => api<MessagesPage>(`/api/chats/${sessionId}/messages?${new URLSearchParams({ jid: chat.jid, limit: String(SHOWN) })}`, { signal }),
    staleTime: 0,
  });
  useLiveEvents((event) => {
    if (event.sessionId !== sessionId) return;
    if ((event.type === 'messages.received' || event.type === 'messages.created') && isChat(chat, event.data.chatJid ?? '')) void messages.refetch();
    if (event.type === 'message.changed' && isChat(chat, event.data.chatJid)) void messages.refetch();
  });

  // Oldest first, reactions folded onto their messages, day separators, and a divider before the unread ones.
  const { lines, reactions } = useMemo(() => {
    const all = (messages.data?.messages ?? []).slice().reverse();
    const people = messages.data?.senders ?? {};
    const reactions = new Map<string, string[]>();
    for (const m of all) if (m.type === 'reaction' && m.content.reactTo && m.content.text) reactions.set(m.content.reactTo, [...(reactions.get(m.content.reactTo) ?? []), m.content.text]);
    const shown = all.filter((m) => m.type !== 'reaction');
    const unread = Math.min(chat.unread, shown.length);
    const firstUnread = unread > 0 ? shown.length - unread : -1;
    const lines: Line[] = [];
    let day = '';
    shown.forEach((m, i) => {
      const d = new Date(m.createdAt).toDateString();
      if (d !== day) {
        day = d;
        lines.push({ kind: 'day', key: `d${m.id}`, label: fmt.day(m.createdAt) });
      }
      if (i === firstUnread) lines.push({ kind: 'new', key: 'new', n: unread });
      const prev = shown[i - 1];
      const from = m.content.from ?? '';
      const first = !prev || prev.direction !== m.direction || (chat.isGroup && (prev.content.from ?? '') !== from) || new Date(prev.createdAt).toDateString() !== d;
      const person = people[from];
      const sender: Sender | null =
        chat.isGroup && m.direction === 'in' && from ? { key: from, name: person?.name ?? m.content.pushName ?? person?.phone ?? jidPhone(from) ?? from.split('@')[0]!, phone: person?.phone ?? jidPhone(from) } : null;
      lines.push({ kind: 'msg', key: String(m.id), m, first, sender });
    });
    return { lines, reactions };
  }, [messages.data, chat.unread, chat.isGroup, fmt]);

  // Newest in view: at the first unread when there are some, else at the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (!el || lines.length === 0) return;
    const divider = el.querySelector<HTMLElement>('[data-new]');
    if (divider) el.scrollTop = divider.offsetTop - 12;
    else el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const openMedia = useCallback((m: ChatMessage) => window.open(mediaUrl(m.id), '_blank', 'noreferrer'), []);
  const author = useCallback((fromMe: boolean) => (fromMe ? t.chats.you : title), [t.chats.you, title]);

  return (
    <>
      <header className="relative flex items-center gap-3 border-b border-line bg-card px-3.5 py-3">
        <Avatar name={title} id={chat.jid} group={chat.isGroup} />
        <span className="min-w-0 flex-1">
          <span className="pii block truncate text-[15px] leading-tight font-semibold">{title}</span>
          <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-[10.5px] font-medium text-brand">
            <EyeOff className="size-3" /> {p.hint}
          </span>
        </span>
        <button type="button" onClick={onClose} aria-label={t.common.close} className="grid size-8 shrink-0 cursor-pointer place-items-center self-start rounded-full text-muted transition-colors hover:bg-raised hover:text-ink">
          <X className="size-4" />
        </button>
      </header>

      <div ref={scroller} className="chat-wall min-h-0 flex-1 overflow-y-auto px-3 py-2" style={wallStyle(wall) as CSSProperties | undefined}>
        {messages.isPending ? (
          <div className="flex h-full items-center justify-center">
            <span className="flex items-center gap-2 rounded-full bg-card/90 px-3 py-1.5 text-xs text-muted shadow-sm">
              <Loader2 className="size-3.5 animate-spin" /> {p.loading}
            </span>
          </div>
        ) : lines.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <span className="rounded-full bg-card/90 px-3 py-1.5 text-xs text-muted shadow-sm">{p.empty}</span>
          </div>
        ) : (
          <div className="relative space-y-0.5">
            {lines.map((line) => (
              <Fragment key={line.key}>
                {line.kind === 'day' ? (
                  <div className="sticky top-0 z-10 flex justify-center py-1.5">
                    <span className="rounded-lg bg-card/95 px-2.5 py-0.5 text-[11px] font-medium text-ink-2 shadow-sm backdrop-blur">{line.label}</span>
                  </div>
                ) : line.kind === 'new' ? (
                  <div data-new className="my-2 flex items-center gap-2">
                    <span className="h-px flex-1 bg-brand/40" />
                    <span className="rounded-full bg-brand px-2.5 py-0.5 text-[10.5px] font-semibold text-on-brand shadow-sm">{p.newMessages(line.n)}</span>
                    <span className="h-px flex-1 bg-brand/40" />
                  </div>
                ) : (
                  <div className={cx(line.first && 'pt-1.5')}>
                    <Bubble
                      m={line.m}
                      first={line.first}
                      sender={line.first ? line.sender : null}
                      reactions={line.m.waMessageId ? reactions.get(line.m.waMessageId) : undefined}
                      quotedAuthor={author}
                      onOpenMedia={openMedia}
                    />
                  </div>
                )}
              </Fragment>
            ))}
          </div>
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-line bg-card px-3 py-2.5">
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted">{chat.unread > 0 ? p.unreadKept(chat.unread) : p.allRead}</span>
        <button
          type="button"
          onClick={onOpen}
          className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-brand px-3.5 py-1.5 text-xs font-semibold text-on-brand shadow-sm transition-opacity hover:opacity-90"
        >
          <MessageSquareText className="size-3.5" /> {t.chats.ai.openChat}
        </button>
      </footer>
    </>
  );
}
