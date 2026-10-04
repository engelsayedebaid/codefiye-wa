import { ChevronUp, X } from 'lucide-react';
import { type CSSProperties, useState } from 'react';
import { useI18n } from '../../i18n';
import { cx } from '../../ui';
import { Avatar, TypeLabel } from './Bubble';

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
    <div className="group/note relative h-full overflow-hidden rounded-[1.25rem] border border-white/[0.07] bg-gradient-to-b from-raised/95 to-card/95 shadow-[0_24px_60px_-20px] shadow-black/90 backdrop-blur-xl">
      {/* soft brand glow behind the avatar */}
      <span aria-hidden className="pointer-events-none absolute -top-10 -start-10 size-32 rounded-full bg-brand/15 blur-2xl" />
      <div className={cx('relative transition-opacity duration-200', peek && 'opacity-0')}>
        <div className="flex items-center gap-1.5 px-3.5 pt-3 text-[11px] text-faint">
          <span className="flex size-4 items-center justify-center rounded-[5px] bg-brand text-black">
            <ChatGlyph className="size-2.5" />
          </span>
          <span className="truncate font-medium text-muted">{note.number ?? c.newMessage}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0 text-brand">{c.now}</span>
          {note.count > 1 && (
            <span key={note.count} className="animate-scale-in ms-auto shrink-0 rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-semibold text-brand tabular-nums">
              {c.messages(note.count)}
            </span>
          )}
        </div>
        <button type="button" onClick={onOpen} tabIndex={peek ? -1 : 0} className="flex w-full items-start gap-3 px-3.5 pt-2 pb-3.5 text-start outline-none focus-visible:bg-white/[0.03]">
          <Avatar name={note.title} id={note.jid} picture={note.picture} group={note.isGroup} size="lg" />
          <span className="min-w-0 flex-1">
            <span dir="auto" className="block truncate text-[15px] font-semibold text-ink">
              {note.title.startsWith('+') ? <span className="ltr">{note.title}</span> : note.title}
            </span>
            <span className="mt-1 block space-y-0.5">
              {note.messages.map((m, i) => (
                <span
                  key={m.id}
                  dir="auto"
                  className={cx('block truncate text-[13px] leading-snug', i === last ? 'animate-fade-in text-ink-2' : 'text-muted/80')}
                >
                  {m.sender && <span className="font-medium text-muted">{m.sender}: </span>}
                  {m.text || <TypeLabel type={m.type} />}
                </span>
              ))}
            </span>
          </span>
        </button>
      </div>
      {!peek && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t.common.close}
          className="absolute end-2.5 top-2.5 rounded-full bg-card/80 p-1 text-faint opacity-0 transition-opacity group-hover/note:opacity-100 hover:text-ink focus-visible:opacity-100"
        >
          <X className="size-3.5" />
        </button>
      )}
      <span aria-hidden className="absolute inset-x-0 bottom-0 h-[3px] bg-white/[0.04]">
        <span
          key={note.rev}
          onAnimationEnd={onDismiss}
          style={{ '--note-ms': `${NOTE_MS}ms` } as CSSProperties}
          className="note-drain block h-full origin-left bg-gradient-to-r from-brand/60 to-brand rtl:origin-right"
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
