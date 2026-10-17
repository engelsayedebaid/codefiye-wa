import { type InfiniteData, type QueryClient, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, X } from 'lucide-react';
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { useLiveEvents } from '../../events';
import { useI18n } from '../../i18n';
import { cx } from '../../ui';
import { Avatar, TypeLabel } from './Bubble';
import type { ChatMessage, ChatPage, MessagesPage } from './model';

/** "Your message was read" notices are on unless turned off in the chats menu. */
export const READ_NOTIFY_KEY = 'wa.chats.readNotify';
export function readNotesOn() {
  try {
    return localStorage.getItem(READ_NOTIFY_KEY) !== '0';
  } catch {
    return true;
  }
}

/** Asks the chats page (when it's open) to show a chat, instead of a navigation that wouldn't reach it. */
export const OPEN_CHAT_EVENT = 'wa:open-chat';
export type OpenChatDetail = { sessionId: string; jid: string };

type Brief = { id: number; sessionId: string; chatJid: string; name: string | null; phone: string | null; isGroup: boolean; type: string; text: string | null; sentFrom: string | null };

export type ReadNote = {
  key: number;
  sessionId: string;
  jid: string;
  title: string;
  isGroup: boolean;
  picture: string | null;
  /** The latest message read, and how many were read in one go. */
  text: string | null;
  type: string;
  count: number;
};

const NOTE_MS = 6_500;
/** Receipts for several messages of a chat arrive together: they become one notice. */
const GATHER_MS = 1_200;
const MAX_NOTES = 3;
/** Read messages not loaded on the page wait this long, then go to the server together (at most this many per request). */
const LOOKUP_WAIT_MS = 800;
const LOOKUP_BATCH = 50;

/** The message and its chat, from what the page already loaded (no request) when possible. */
function fromCache(queryClient: QueryClient, sessionId: string, id: number): Brief | null {
  for (const [key, data] of queryClient.getQueriesData<InfiniteData<MessagesPage>>({ queryKey: ['chats', sessionId, 'messages'] })) {
    const m = data?.pages.flatMap((p) => p.messages).find((x) => x.id === id);
    if (!m) continue;
    const jid = String(key[3]);
    let chat: ChatPage['chats'][number] | undefined;
    for (const [, lists] of queryClient.getQueriesData<InfiniteData<ChatPage>>({ queryKey: ['chats', sessionId, 'list'] })) {
      chat = lists?.pages.flatMap((p) => p.chats).find((c) => c.jid === jid || c.altJid === jid);
      if (chat) break;
    }
    return briefOf(m, sessionId, jid, chat?.name ?? null, chat?.phone ?? null);
  }
  return null;
}

const briefOf = (m: ChatMessage, sessionId: string, jid: string, name: string | null, phone: string | null): Brief => ({
  id: m.id,
  sessionId,
  chatJid: jid,
  name,
  phone,
  isGroup: jid.endsWith('@g.us'),
  type: m.type,
  text: m.content.text ?? m.content.caption ?? null,
  sentFrom: m.content.sentFrom ?? null,
});

function cachedPicture(queryClient: QueryClient, sessionId: string, jid: string) {
  for (const [, data] of queryClient.getQueriesData<Record<string, string | null>>({ queryKey: ['chats', sessionId, 'pictures'] })) if (data?.[jid]) return data[jid];
  return null;
}

/**
 * A gentle notice, on any page, when someone reads a message written on the chats page (not API or
 * campaign sends: those would flood it). Several read together make one notice; the chat already
 * open in front of you shows its blue ticks instead.
 */
export function useReadNotes({ enabled, isLooking }: { enabled: boolean; isLooking: (sessionId: string, jid: string) => boolean }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState<ReadNote[]>([]);
  const seq = useRef(0);
  const seen = useRef(new Set<number>());
  const gathering = useRef(new Map<string, { briefs: Brief[]; timer: ReturnType<typeof setTimeout> }>());

  useEffect(
    () => () => {
      for (const g of gathering.current.values()) clearTimeout(g.timer);
    },
    [],
  );

  const dismiss = useCallback((key: number) => setNotes((ns) => ns.filter((n) => n.key !== key)), []);

  const show = useCallback(
    (briefs: Brief[]) => {
      const last = briefs[briefs.length - 1]!;
      const title = last.name || last.phone || last.chatJid.split('@')[0]!;
      const note: ReadNote = {
        key: ++seq.current,
        sessionId: last.sessionId,
        jid: last.chatJid,
        title,
        isGroup: last.isGroup,
        picture: cachedPicture(queryClient, last.sessionId, last.chatJid),
        text: last.text,
        type: last.type,
        count: briefs.length,
      };
      if (document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') {
        const r = t.chats.readNote;
        const body = `${note.count > 1 ? r.many(note.count) : r.title}${note.text ? ` · ${note.text}` : ''}`;
        new Notification(title, { body, icon: note.picture ?? '/favicon.svg', tag: `read:${note.sessionId}:${note.jid}` });
      }
      setNotes((ns) => [note, ...ns.filter((n) => !(n.sessionId === note.sessionId && n.jid === note.jid))].slice(0, MAX_NOTES));
    },
    [queryClient, t],
  );

  /** A read message of ours, ready to show: joins its chat's notice if one is gathering. */
  const add = useCallback(
    (brief: Brief) => {
      if (brief.sentFrom !== 'chats' || !readNotesOn()) return;
      if (document.visibilityState === 'visible' && isLooking(brief.sessionId, brief.chatJid)) return;
      const chatKey = `${brief.sessionId}\n${brief.chatJid}`;
      const open = gathering.current.get(chatKey);
      if (open) return void open.briefs.push(brief);
      const entry = {
        briefs: [brief],
        timer: setTimeout(() => {
          gathering.current.delete(chatKey);
          show(entry.briefs.sort((a, b) => a.id - b.id));
        }, GATHER_MS),
      };
      gathering.current.set(chatKey, entry);
    },
    [isLooking, show],
  );

  // Read messages the page hasn't loaded are looked up together: a campaign's receipts arrive by the
  // hundred, and the server answers only for messages written on the chats page.
  const lookup = useRef<{ ids: number[]; timer: ReturnType<typeof setTimeout> | null }>({ ids: [], timer: null });
  const flush = useCallback(() => {
    const ids = lookup.current.ids.splice(0, LOOKUP_BATCH);
    lookup.current.timer = lookup.current.ids.length ? setTimeout(flush, LOOKUP_WAIT_MS) : null;
    if (ids.length === 0) return;
    void api<Omit<Brief, 'sentFrom'>[]>(`/api/chats/messages/briefs?ids=${ids.join(',')}`)
      .then((briefs) => briefs.forEach((b) => add({ ...b, sentFrom: 'chats' })))
      .catch(() => {}); // a notice is a nicety: stay quiet
  }, [add]);
  useEffect(() => () => void (lookup.current.timer && clearTimeout(lookup.current.timer)), []);

  useLiveEvents((event) => {
    if (!enabled || event.type !== 'messages.update' || event.data.status !== 'read' || !readNotesOn()) return;
    const { id } = event.data;
    if (seen.current.has(id)) return;
    seen.current.add(id);
    if (seen.current.size > 2_000) seen.current = new Set([id]);
    const cached = fromCache(queryClient, event.sessionId, id);
    if (cached) return add(cached);
    lookup.current.ids.push(id);
    lookup.current.timer ??= setTimeout(flush, LOOKUP_WAIT_MS);
  });

  return { notes, dismiss };
}

function ReadCard({ note, onOpen, onDismiss }: { note: ReadNote; onOpen: () => void; onDismiss: () => void }) {
  const { t } = useI18n();
  const r = t.chats.readNote;
  return (
    <div className="animate-note-in group/read relative overflow-hidden rounded-2xl border border-white/[0.08] bg-card/95 shadow-[0_18px_50px_-18px] shadow-black/70 ring-1 ring-black/5 backdrop-blur-xl light:border-line light:shadow-black/20">
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 p-3 pe-9 text-start outline-none transition-colors hover:bg-ink/[0.025] focus-visible:bg-ink/[0.04]">
        <span className="relative shrink-0">
          <Avatar name={note.title} id={note.jid} picture={note.picture} group={note.isGroup} />
          <span className="read-pop absolute -end-1 -bottom-1 flex size-5 items-center justify-center rounded-full bg-[#53bdeb] text-white ring-2 ring-card">
            <CheckCheck className="size-3" strokeWidth={2.75} />
          </span>
        </span>
        <span className="pii min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">
              {note.title.startsWith('+') ? <span className="ltr">{note.title}</span> : <span dir="auto">{note.title}</span>}
            </span>
            <span className="shrink-0 text-[11px] text-faint">{t.chats.notify.now}</span>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-xs font-medium text-[#3aa7d8] light:text-[#1f87b8]">
            <CheckCheck className="size-3.5 shrink-0" />
            {note.count > 1 ? r.many(note.count) : r.title}
          </span>
          <span dir="auto" className="mt-0.5 block truncate text-xs text-muted">
            {note.text || <TypeLabel type={note.type} />}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t.common.close}
        className="absolute end-2 top-2 rounded-full p-1 text-faint opacity-0 transition-opacity group-hover/read:opacity-100 hover:bg-raised hover:text-ink focus-visible:opacity-100"
      >
        <X className="size-3.5" />
      </button>
      <span aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] bg-ink/[0.05]">
        <span onAnimationEnd={onDismiss} style={{ '--note-ms': `${NOTE_MS}ms` } as CSSProperties} className="note-drain block h-full origin-left bg-[#53bdeb]/80 rtl:origin-right" />
      </span>
    </div>
  );
}

/** The notices, at the bottom inline-start corner (away from the incoming-message cards at the top). */
export function ReadNoteStack({ notes, onOpen, onDismiss }: { notes: ReadNote[]; onOpen: (note: ReadNote) => void; onDismiss: (key: number) => void }) {
  if (notes.length === 0) return null;
  return (
    <div aria-live="polite" className={cx('note-stack fixed start-4 bottom-4 z-[70] flex w-[21rem] max-w-[calc(100vw-2rem)] flex-col-reverse gap-2')}>
      {notes.map((note) => (
        <ReadCard
          key={note.key}
          note={note}
          onOpen={() => {
            onDismiss(note.key);
            onOpen(note);
          }}
          onDismiss={() => onDismiss(note.key)}
        />
      ))}
    </div>
  );
}
