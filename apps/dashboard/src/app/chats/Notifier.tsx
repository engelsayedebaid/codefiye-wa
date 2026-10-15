import { type InfiniteData, useQueryClient } from '@tanstack/react-query';
import { ChevronUp, X } from 'lucide-react';
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { useBackgroundLiveEvents, useLiveEvents } from '../../events';
import { useI18n } from '../../i18n';
import { qk } from '../../queries';
import { cx } from '../../ui';
import { Avatar, TypeLabel } from './Bubble';
import type { ChatNumber, ChatPage } from './model';

export const NOTIFY_KEY = 'wa.chats.notify';

/** Message notifications are on unless turned off on the chats page. */
export function notificationsOn() {
  try {
    return localStorage.getItem(NOTIFY_KEY) !== '0';
  } catch {
    return true;
  }
}

export type NoteMessage = {
  id: number;
  /** Who wrote it inside a group. */
  sender: string | null;
  text: string | null;
  type: string;
};

/** One chat's unseen incoming messages, shown as a notification card. */
export type InboxNote = {
  key: number;
  /** Bumped on every new message, so the card's timer restarts. */
  rev: number;
  sessionId: string;
  jid: string;
  title: string;
  picture: string | null;
  isGroup: boolean;
  /** The receiving number's name, when there are several. */
  number: string | null;
  /** The latest few, oldest first. */
  messages: NoteMessage[];
  count: number;
};

export const NOTE_MS = 8_000;
const SHOWN_MESSAGES = 3;

/** Adds a message to its chat's card (moving it to the front), or starts a new card. */
export function pushNote(notes: InboxNote[], note: Omit<InboxNote, 'messages' | 'count'>, message: NoteMessage, max = 5): InboxNote[] {
  const old = notes.find((n) => n.sessionId === note.sessionId && n.jid === note.jid);
  const next: InboxNote = old
    ? { ...old, ...note, key: old.key, picture: note.picture ?? old.picture, messages: [...old.messages, message].slice(-SHOWN_MESSAGES), count: old.count + 1 }
    : { ...note, messages: [message], count: 1 };
  return [next, ...notes.filter((n) => n !== old)].slice(0, max);
}

let audio: AudioContext | null = null;
let lastPing = 0;

/** Browsers start audio only after a user gesture; call from one so a chime can later play in a background tab. */
export function unlockAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
  } catch {
    // unsupported
  }
}

/** A soft two-note chime, synthesized (no asset); at most one every 1.5 s. `volume` 0–1. */
export function playPing(volume = 1) {
  const now = Date.now();
  if (now - lastPing < 1_500) return;
  lastPing = now;
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
    const t0 = audio.currentTime;
    for (const [i, freq] of [880, 1318.5].entries()) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = t0 + i * 0.11;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.12 * volume, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(audio.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    }
  } catch {
    // no audio (autoplay policy before any click, or unsupported): stay silent
  }
}

function ChatGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.6.5-1.8.1-1.8-.8V5.5Z" />
    </svg>
  );
}

function NoteCard({ note, peek, onOpen, onDismiss }: { note: InboxNote; peek: boolean; onOpen: () => void; onDismiss: () => void }) {
  const { t } = useI18n();
  const c = t.chats.notify;
  const last = note.messages.length - 1;
  return (
    <div className="group/note relative h-full overflow-hidden rounded-2xl border border-white/[0.08] light:border-line bg-card/95 shadow-[0_18px_50px_-18px] shadow-black/80 light:shadow-black/20 ring-1 ring-black/5 backdrop-blur-xl">
      <div className={cx('relative transition-opacity duration-200', peek && 'opacity-0')}>
        <button type="button" onClick={onOpen} tabIndex={peek ? -1 : 0} className="flex w-full items-start gap-3 p-3.5 pb-4 text-start outline-none transition-colors hover:bg-ink/[0.025] focus-visible:bg-ink/[0.04]">
          <span className="relative shrink-0">
            <Avatar name={note.title} id={note.jid} picture={note.picture} group={note.isGroup} size="lg" />
            <span className="absolute -end-0.5 -bottom-0.5 flex size-5 items-center justify-center rounded-full bg-brand text-on-brand ring-2 ring-card">
              <ChatGlyph className="size-2.5" />
            </span>
          </span>
          <span className="pii min-w-0 flex-1">
            <span className="flex items-baseline gap-2 pe-5">
              <span className="min-w-0 flex-1 truncate text-start text-[14.5px] font-semibold text-ink">
                {note.title.startsWith('+') ? <span className="ltr">{note.title}</span> : <span dir="auto">{note.title}</span>}
              </span>
              <span className="shrink-0 text-[11px] font-medium text-brand">{c.now}</span>
            </span>
            {note.number && <span className="mt-0.5 block truncate text-[11.5px] text-faint">{note.number}</span>}
            <span className="mt-2 block space-y-1 rounded-xl rounded-ss-[4px] bg-ink/[0.045] px-3 py-2">
              {note.messages.map((m, i) => (
                <span
                  key={m.id}
                  dir="auto"
                  className={cx('block truncate text-[13px] leading-normal', i === last ? 'animate-fade-in text-ink' : 'text-muted')}
                >
                  {m.sender && <span className="font-medium text-ink-2">{m.sender}: </span>}
                  {m.text || <TypeLabel type={m.type} />}
                </span>
              ))}
            </span>
            {note.count > SHOWN_MESSAGES && (
              <span key={note.count} className="animate-scale-in mt-1.5 block text-[11px] font-medium text-brand tabular-nums">
                {c.messages(note.count)}
              </span>
            )}
          </span>
        </button>
      </div>
      {!peek && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t.common.close}
          className="absolute end-2 top-2 rounded-full p-1 text-faint opacity-0 transition-[opacity,background-color] group-hover/note:opacity-100 hover:bg-raised hover:text-ink focus-visible:opacity-100"
        >
          <X className="size-3.5" />
        </button>
      )}
      <span aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] bg-ink/[0.05]">
        <span
          key={note.rev}
          onAnimationEnd={onDismiss}
          style={{ '--note-ms': `${NOTE_MS}ms` } as CSSProperties}
          className="note-drain block h-full origin-left bg-brand/80 rtl:origin-right"
        />
      </span>
    </div>
  );
}

/**
 * Notification cards at the top inline-end corner. Several stack like a deck (the newest in front);
 * hovering fans them out into a list. Each closes when its bar drains — paused while hovered.
 */
export function NoteStack({ notes, onOpen, onDismiss }: { notes: InboxNote[]; onOpen: (note: InboxNote) => void; onDismiss: (key: number) => void }) {
  const { t } = useI18n();
  const c = t.chats.notify;
  const [open, setOpen] = useState(false);
  // The last card closing under the pointer fires no mouseleave: start the next stack collapsed.
  if (notes.length === 0 && open) setOpen(false);
  if (notes.length === 0) return null;
  const expanded = open && notes.length > 1;
  return (
    <div
      aria-live="polite"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}
      className="note-stack fixed end-4 top-4 z-[70] w-[23rem] max-w-[calc(100vw-2rem)]"
    >
      {notes.length > 1 && (
        <div className={cx('mb-2 flex items-center justify-between px-1 transition-all duration-300', expanded ? 'opacity-100' : 'pointer-events-none -translate-y-1 opacity-0')}>
          <span className="text-xs font-semibold text-ink">{c.stack(notes.length)}</span>
          <span className="flex items-center gap-1">
            <button type="button" onClick={() => notes.forEach((n) => onDismiss(n.key))} className="rounded-full bg-card/90 px-2.5 py-1 text-[11px] font-medium text-muted backdrop-blur hover:bg-raised hover:text-ink">
              {c.clearAll}
            </button>
            <button type="button" onClick={() => setOpen(false)} aria-label={c.collapse} className="rounded-full bg-card/90 p-1 text-muted backdrop-blur hover:bg-raised hover:text-ink">
              <ChevronUp className="size-3.5" />
            </button>
          </span>
        </div>
      )}
      <div className={cx('relative', expanded && 'flex flex-col gap-2')}>
        {notes.map((note, i) => {
          const depth = Math.min(i, 2);
          const hidden = !expanded && i > 2;
          return (
            <div
              key={note.key}
              className={cx('animate-note-in transition-[transform,opacity] duration-300 ease-out', !expanded && i > 0 ? 'absolute inset-0' : 'relative', hidden && 'pointer-events-none opacity-0')}
              style={
                expanded
                  ? undefined
                  : {
                      zIndex: notes.length - i,
                      transform: `translateY(${depth * 11}px) scale(${1 - depth * 0.05})`,
                      transformOrigin: 'top center',
                      opacity: hidden ? 0 : 1 - depth * 0.2,
                    }
              }
            >
              <NoteCard note={note} peek={!expanded && i > 0} onOpen={() => onOpen(note)} onDismiss={() => onDismiss(note.key)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Plain text for the browser's own notification (no JSX there). */
export function noteText(t: ReturnType<typeof useI18n>['t'], message: NoteMessage) {
  const m = t.chats.media as Record<string, unknown>;
  const label = message.type === 'location' ? t.chats.location : message.type === 'contact' ? t.chats.contactCard : message.type === 'poll' ? t.chats.poll : m[message.type];
  const body = message.text || (typeof label === 'string' ? label : message.type);
  return message.sender ? `${message.sender}: ${body}` : body;
}

/**
 * Incoming messages as notification cards + chime (the browser's own notification when the tab is
 * hidden). `isLooking`: that chat is open on screen, so only a quiet chime. `onOpen`: show the chat.
 */
export function useInboxNotes({
  enabled,
  numbers,
  isLooking = () => false,
  onOpen,
}: {
  enabled: boolean;
  numbers: ChatNumber[];
  isLooking?: (sessionId: string, jid: string) => boolean;
  onOpen: (note: InboxNote) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState<InboxNote[]>([]);
  const seq = useRef(0);
  useBackgroundLiveEvents(enabled);

  // Any click on the page unlocks audio, so the chime can play later from a background tab.
  useEffect(() => {
    const unlock = () => unlockAudio();
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
    return () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
  }, []);

  const dismiss = useCallback((key: number) => setNotes((ns) => ns.filter((n) => n.key !== key)), []);
  const open = (note: InboxNote) => {
    dismiss(note.key);
    onOpen(note);
  };

  /** Name and picture from what the chats page already loaded — no request. */
  const cachedChat = (sid: string, jid: string) => {
    for (const [, data] of queryClient.getQueriesData<InfiniteData<ChatPage>>({ queryKey: qk.chats.lists(sid) }))
      for (const page of data?.pages ?? []) {
        const hit = page.chats.find((ch) => ch.jid === jid || ch.altJid === jid);
        if (hit) return hit;
      }
    return null;
  };
  const cachedPicture = (sid: string, jid: string) => {
    for (const [, data] of queryClient.getQueriesData<Record<string, string | null>>({ queryKey: ['chats', sid, 'pictures'] })) if (data?.[jid]) return data[jid];
    return null;
  };

  useLiveEvents((event) => {
    if (event.type !== 'messages.received' || !enabled) return;
    const { chatJid, from, type, text, pushName, chatName } = event.data;
    if (type === 'reaction') return;
    const jid = chatJid ?? from;
    const visible = document.visibilityState === 'visible';
    if (visible && isLooking(event.sessionId, jid)) return playPing(0.4);
    const chat = cachedChat(event.sessionId, jid);
    const isGroup = jid.endsWith('@g.us');
    const phone = (j: string) => (j.endsWith('@s.whatsapp.net') ? `+${j.split('@')[0]}` : null);
    // The event carries the chat's name (a group's subject) for when the chat list isn't loaded here.
    const title = chat?.name || chatName || (isGroup ? null : pushName) || chat?.phone || phone(jid) || jid.split('@')[0]!;
    const key = ++seq.current;
    const message: NoteMessage = { id: event.data.id, sender: isGroup ? pushName || phone(from) : null, text, type };
    const note = {
      key,
      rev: key,
      sessionId: event.sessionId,
      jid: chat?.jid ?? jid,
      title,
      picture: cachedPicture(event.sessionId, chat?.jid ?? jid),
      isGroup,
      number: numbers.length > 1 ? (numbers.find((n) => n.id === event.sessionId)?.name ?? null) : null,
    };
    if (!visible && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(note.number ? `${title} · ${note.number}` : title, { body: noteText(t, message), icon: note.picture ?? '/favicon.svg', tag: `${note.sessionId}:${note.jid}` });
      n.onclick = () => {
        window.focus();
        open({ ...note, messages: [message], count: 1 });
        n.close();
      };
    }
    // The chime plays in a background tab too (audio unlocked by an earlier click); the card waits there for the return.
    playPing();
    setNotes((ns) => pushNote(ns, note, message));
  });

  return { notes, dismiss, open };
}
