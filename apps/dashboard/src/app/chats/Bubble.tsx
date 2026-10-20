import {
  AlertTriangle,
  Ban,
  Check,

  Copy,
  Download,
  Eye,
  FileText,
  Forward,
  ImageOff,
  ListChecks,
  Loader2,
  MapPin,
  Megaphone,
  MessageCircle,
  Mic,
  Music,
  Pause,
  Pencil,
  Play,
  Reply,
  RotateCw,
  Smartphone,
  SmilePlus,
  Trash2,
  User,
  Users,
} from '../../icons';
import { EDIT_WINDOW_MS } from '@wa/shared/chats';
import { memo, type ReactNode, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { cx, flip } from '../../ui';
import { errorText, PollResults, StatusTick } from '../MessageFeed';
import { ChatText } from './ChatText';
import { Floating } from './Floating';
import { type ChatMessage, formatBytes, formatDuration, gradientFor, initials, mediaUrl, type Sender, senderColor, textOf } from './model';

// --- avatar --------------------------------------------------------------------------------------

export function Avatar({
  name,
  id,
  picture,
  group,
  size = 'md',
  online,
}: {
  name: string;
  id: string;
  picture?: string | null;
  group?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  online?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const dims = { sm: 'size-8 text-xs', md: 'size-11 text-sm', lg: 'size-12 text-base', xl: 'size-24 text-2xl' }[size];
  return (
    <span className={cx('pii relative inline-flex shrink-0', dims)}>
      {picture && !failed ? (
        <img src={picture} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="size-full rounded-full object-cover ring-1 ring-white/10" />
      ) : (
        <span className={cx('flex size-full items-center justify-center rounded-full bg-gradient-to-br font-semibold text-white shadow-inner ring-1 ring-white/10', gradientFor(id))}>
          {group ? <Users className="size-[45%]" /> : initials(name) || <User className="size-[45%]" />}
        </span>
      )}
      {online && (
        <span className="absolute end-0 bottom-0 flex size-3.5 items-center justify-center rounded-full bg-bg">
          <span className="size-2.5 animate-pulse rounded-full bg-brand motion-reduce:animate-none" />
        </span>
      )}
    </span>
  );
}

// --- media ---------------------------------------------------------------------------------------

const thumbSrc = (thumb?: string) => (thumb ? `data:image/jpeg;base64,${thumb}` : undefined);

/** Shape of a picture/video in the bubble: its own ratio, within sane limits. */
function frame(width?: number, height?: number) {
  const ratio = width && height ? Math.min(1.8, Math.max(0.56, width / height)) : 4 / 3;
  return { aspectRatio: String(ratio) };
}

function ImageMedia({ m, onOpen, localSrc }: { m: ChatMessage; onOpen: () => void; localSrc?: string }) {
  const { t } = useI18n();
  const media = m.content.media;
  const src = localSrc ?? (m.hasMedia ? (m.content.url?.startsWith('http') && !m.content.media ? m.content.url : mediaUrl(m.id)) : null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>(src ? 'loading' : 'failed');
  const sticker = m.type === 'sticker';
  return (
    <button
      type="button"
      onClick={state === 'ready' ? onOpen : undefined}
      className={cx('group/img relative block overflow-hidden', sticker ? 'size-36 bg-transparent' : 'w-72 max-w-full rounded-[14px] bg-black/30', state === 'ready' && 'cursor-zoom-in')}
      style={sticker ? undefined : frame(media?.width, media?.height)}
      aria-label={t.chats.media[m.type === 'sticker' ? 'sticker' : 'image']}
    >
      {!sticker && media?.thumb && <img src={thumbSrc(media.thumb)} alt="" aria-hidden className="absolute inset-0 size-full scale-110 object-cover blur-md" />}
      {src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={() => setState('ready')}
          onError={() => setState('failed')}
          className={cx(
            'relative size-full transition-[opacity,transform] duration-500',
            sticker ? 'object-contain' : 'object-cover group-hover/img:scale-[1.02]',
            state === 'ready' ? 'opacity-100' : 'opacity-0',
          )}
        />
      )}
      {state === 'loading' && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="size-6 animate-spin text-white/80" />
        </span>
      )}
      {state === 'failed' && (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-xs text-white/80">
          <ImageOff className="size-6" />
          {t.chats.media.unavailable}
        </span>
      )}
    </button>
  );
}

function VideoMedia({ m, localSrc }: { m: ChatMessage; localSrc?: string }) {
  const { t } = useI18n();
  const media = m.content.media;
  const [playing, setPlaying] = useState(false);
  const src = localSrc ?? (m.hasMedia ? mediaUrl(m.id) : null);
  return (
    <div className="relative w-72 max-w-full overflow-hidden rounded-[14px] bg-black/40" style={frame(media?.width, media?.height)}>
      {playing && src ? (
        <video src={src} controls autoPlay playsInline loop={media?.gif} muted={media?.gif} className="absolute inset-0 size-full bg-black object-contain" />
      ) : (
        <>
          {media?.thumb && <img src={thumbSrc(media.thumb)} alt="" className="absolute inset-0 size-full object-cover" />}
          <button
            type="button"
            disabled={!src}
            onClick={() => setPlaying(true)}
            className="absolute inset-0 flex items-center justify-center bg-black/20 transition-colors hover:bg-ink/10 disabled:cursor-not-allowed"
            aria-label={t.chats.media.play}
          >
            <span className="flex size-14 items-center justify-center rounded-full bg-black/55 text-white shadow-lg ring-1 ring-white/20 backdrop-blur transition-transform hover:scale-105">
              <Play className="ms-1 size-6 fill-current" />
            </span>
          </button>
          <span className="pointer-events-none absolute start-2 bottom-2 flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[11px] text-white">
            {media?.gif ? t.chats.media.gif : formatDuration(media?.seconds)}
          </span>
        </>
      )}
    </div>
  );
}

/** Pseudo-waveform: stable per message so it doesn't jump between renders. */
function bars(seed: number, n = 36) {
  let x = seed || 1;
  return Array.from({ length: n }, () => {
    x = (x * 16807) % 2147483647;
    return 0.25 + ((x % 1000) / 1000) * 0.75;
  });
}

function AudioMedia({ m, outbound, localSrc }: { m: ChatMessage; outbound: boolean; localSrc?: string }) {
  const { t } = useI18n();
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(m.content.media?.seconds ?? m.content.seconds ?? 0);
  const [failed, setFailed] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [rate, setRate] = useState(1);
  const voice = Boolean(m.content.media?.ptt ?? m.content.ptt);
  const src = localSrc ?? (m.hasMedia ? mediaUrl(m.id) : null);
  const wave = bars(Math.abs(m.id));

  const toggle = () => {
    const audio = ref.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => setFailed(true));
    else audio.pause();
  };
  const seek = (fraction: number) => {
    const audio = ref.current;
    if (audio && Number.isFinite(audio.duration)) audio.currentTime = fraction * audio.duration;
  };
  const cycleRate = () => {
    const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
    setRate(next);
    if (ref.current) ref.current.playbackRate = next;
  };

  const started = playing || progress > 0;

  return (
    <div className="flex w-72 max-w-full items-center gap-3 py-1">
      {/* One round control; a small badge says whether it's a voice note or an audio file. */}
      <button
        type="button"
        onClick={toggle}
        disabled={!src || failed}
        aria-label={playing ? t.chats.media.pause : t.chats.media.play}
        className="relative grid size-11 shrink-0 cursor-pointer place-items-center rounded-full bg-brand text-on-brand shadow-sm transition-transform hover:brightness-110 active:scale-95 disabled:cursor-default disabled:opacity-40"
      >
        {buffering ? (
          <Loader2 className="size-5 animate-spin" />
        ) : playing ? (
          <Pause className="size-[18px] fill-current" />
        ) : (
          <Play className="size-[18px] translate-x-px fill-current" />
        )}
        <span
          aria-hidden
          className={cx(
            'absolute -end-1 -bottom-1 grid size-5 place-items-center rounded-full ring-2',
            outbound ? 'ring-(--chat-out)' : 'ring-(--chat-in)',
            voice ? 'bg-card text-brand' : 'bg-orange-500 text-white',
          )}
        >
          {voice ? <Mic className="size-3" /> : <Music className="size-3" />}
        </span>
      </button>
      <div className="min-w-0 flex-1">
        <div
          dir="ltr"
          role="slider"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          tabIndex={0}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            seek(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') seek(Math.min(1, progress + 0.05));
            if (e.key === 'ArrowLeft') seek(Math.max(0, progress - 0.05));
          }}
          className="group/wave relative flex h-8 cursor-pointer items-center gap-[2px] rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {wave.map((h, i) => (
            <span
              key={i}
              className={cx('w-[2.5px] flex-1 rounded-full transition-colors duration-150', i / wave.length < progress ? 'bg-brand' : 'bg-ink/25 group-hover/wave:bg-ink/35')}
              style={{ height: `${Math.max(18, h * 100)}%` }}
            />
          ))}
          {/* Where it is: a dot riding the wave once it has started. */}
          <span
            aria-hidden
            className={cx('absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand shadow ring-2 ring-white/80 transition-opacity', started ? 'opacity-100' : 'opacity-0')}
            style={{ left: `${progress * 100}%` }}
          />
        </div>
        <div className="mt-1 flex items-center justify-between text-[11px] text-ink/60">
          <span className="tabular-nums">{failed ? t.chats.media.failed : formatDuration(started ? progress * duration : duration)}</span>
          <button
            type="button"
            onClick={cycleRate}
            disabled={!src || failed}
            className={cx(
              'min-w-8 cursor-pointer rounded-full px-1.5 py-px text-center text-[10px] font-bold tabular-nums transition-colors disabled:opacity-40',
              rate === 1 ? 'bg-ink/10 text-ink/70 hover:bg-ink/20' : 'bg-brand text-on-brand',
            )}
          >
            {rate}×
          </button>
        </div>
      </div>
      {src && (
        <audio
          ref={ref}
          src={src}
          preload="none"
          onPlay={() => {
            setPlaying(true);
            if (ref.current) ref.current.playbackRate = rate;
          }}
          onPause={() => setPlaying(false)}
          onWaiting={() => setBuffering(true)}
          onPlaying={() => setBuffering(false)}
          onCanPlay={() => setBuffering(false)}
          onEnded={() => {
            setPlaying(false);
            setBuffering(false);
            setProgress(0);
          }}
          onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
          onTimeUpdate={(e) => e.currentTarget.duration && setProgress(e.currentTarget.currentTime / e.currentTarget.duration)}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

function DocumentMedia({ m }: { m: ChatMessage }) {
  const { t } = useI18n();
  const media = m.content.media;
  const name = media?.fileName ?? m.content.fileName ?? t.chats.media.document;
  const ext = name.includes('.') ? name.split('.').pop()!.slice(0, 4).toUpperCase() : 'FILE';
  const mimetype = media?.mimetype ?? m.content.mimetype ?? '';
  return (
    <div className="w-72 max-w-full overflow-hidden rounded-lg bg-ink/[0.06]">
      {media?.thumb && <img src={thumbSrc(media.thumb)} alt="" className="max-h-40 w-full object-cover object-top opacity-90" />}
      <div className="flex items-center gap-3 p-3">
        <span className="relative flex h-11 w-9 shrink-0 items-end justify-center rounded-md bg-gradient-to-b from-rose-500 to-red-600 pb-1 text-[9px] font-bold text-white shadow">
          <FileText className="absolute top-1.5 size-4 opacity-80" />
          {ext}
        </span>
        <div className="min-w-0 flex-1">
          <p dir="auto" className="truncate text-sm font-medium">
            {name}
          </p>
          <p className="truncate text-xs text-ink/60">{[formatBytes(media?.size), mimetype.split('/')[1]?.toUpperCase()].filter(Boolean).join(' · ')}</p>
        </div>
        {m.hasMedia && (
          <a href={mediaUrl(m.id, true)} className="flex size-9 shrink-0 items-center justify-center rounded-full border border-line-strong text-ink transition-colors hover:bg-ink/10" aria-label={t.chats.media.download}>
            <Download className="size-4" />
          </a>
        )}
      </div>
    </div>
  );
}

/** OpenStreetMap tiles around the point, with a pin at it. */
function MapPreview({ latitude, longitude }: { latitude: number; longitude: number }) {
  const z = 15;
  const n = 2 ** z;
  const fx = ((longitude + 180) / 360) * n;
  const rad = (latitude * Math.PI) / 180;
  const fy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  const tx = Math.floor(fx);
  const ty = Math.floor(fy);
  const W = 288;
  const H = 150;
  const left = W / 2 - (fx - tx + 1) * 256;
  const top = H / 2 - (fy - ty + 1) * 256;
  return (
    <div dir="ltr" className="relative overflow-hidden rounded-lg bg-[#1d2a30]" style={{ width: W, height: H, maxWidth: '100%' }}>
      <div className="absolute grid grid-cols-3" style={{ left, top, width: 768 }}>
        {[-1, 0, 1].flatMap((dy) =>
          [-1, 0, 1].map((dx) => (
            <img
              key={`${dx},${dy}`}
              src={`https://tile.openstreetmap.org/${z}/${tx + dx}/${ty + dy}.png`}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="size-64 brightness-[0.8] contrast-[1.1] saturate-[0.8]"
            />
          )),
        )}
      </div>
      <MapPin className="absolute top-1/2 left-1/2 size-8 -translate-x-1/2 -translate-y-full fill-red-500 text-red-900 drop-shadow-lg" />
    </div>
  );
}

function LocationCard({ m }: { m: ChatMessage }) {
  const { t } = useI18n();
  const loc = m.content.location ?? (m.content.latitude !== undefined ? { latitude: m.content.latitude, longitude: m.content.longitude!, name: m.content.name, address: m.content.address } : null);
  if (!loc) return null;
  const href = `https://www.google.com/maps?q=${loc.latitude},${loc.longitude}`;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="block w-72 max-w-full overflow-hidden rounded-lg bg-ink/[0.06] transition-opacity hover:opacity-90">
      <MapPreview latitude={loc.latitude} longitude={loc.longitude} />
      <div className="p-2.5">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <MapPin className="size-4 text-sender-rose" />
          {loc.name || ('live' in loc && loc.live ? t.chats.liveLocation : t.chats.location)}
        </p>
        {loc.address && (
          <p dir="auto" className="mt-0.5 line-clamp-2 text-xs text-ink/60">
            {loc.address}
          </p>
        )}
      </div>
    </a>
  );
}

function ContactCards({ m, onOpenChat }: { m: ChatMessage; onOpenChat?: (phone: string) => void }) {
  const { t } = useI18n();
  const cards = m.content.contacts ?? (m.content.phone ? [{ name: m.content.name ?? '', phone: m.content.phone }] : []);
  return (
    <div className="w-72 max-w-full space-y-1.5">
      {cards.map((c, i) => (
        <div key={i} className="overflow-hidden rounded-lg bg-ink/[0.06]">
          <div className="flex items-center gap-3 p-3">
            <Avatar name={c.name || c.phone || '?'} id={c.phone ?? c.name} size="md" />
            <div className="min-w-0">
              <p dir="auto" className="truncate text-sm font-medium">
                {c.name || t.chats.contactCard}
              </p>
              {c.phone && <p className="ltr truncate font-mono text-xs text-ink/60">{c.phone}</p>}
            </div>
          </div>
          {c.phone && onOpenChat && (
            <button type="button" onClick={() => onOpenChat(c.phone!)} className="flex w-full items-center justify-center gap-1.5 border-t border-line py-2 text-xs font-medium text-info transition-colors hover:bg-ink/5">
              <MessageCircle className="size-3.5" /> {t.chats.openChat}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function InboundPoll({ m }: { m: ChatMessage }) {
  const poll = m.content.poll;
  if (!poll) return null;
  return (
    <div className="w-72 max-w-full space-y-1.5">
      <p dir="auto" className="flex items-start gap-1.5 font-medium">
        <ListChecks className="mt-0.5 size-4 shrink-0 text-ink/60" />
        {poll.name}
      </p>
      {poll.options.map((o) => (
        <p key={o} dir="auto" className="rounded-md border border-line px-2.5 py-1.5 text-sm">
          {o}
        </p>
      ))}
    </div>
  );
}

// --- the bubble ----------------------------------------------------------------------------------

/** A quoted message inside a bubble (reply). */
function Quote({ author, text, type, mine, onClick }: { author: string; text: string | null; type: string; mine: boolean; onClick?: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx('mb-1 flex w-full min-w-0 overflow-hidden rounded-md bg-ink/[0.06] text-start transition-colors hover:bg-ink/10', !onClick && 'cursor-default')}
    >
      <span className={cx('w-1 shrink-0', mine ? 'bg-brand' : 'bg-info')} />
      <span className="min-w-0 px-2.5 py-1.5">
        <span className={cx('block truncate text-xs font-semibold', mine ? 'text-brand' : 'text-info')}>{author}</span>
        <span dir="auto" className="line-clamp-2 text-xs text-ink/70">
          {text || t.chats.media[type as 'image'] || type}
        </span>
      </span>
    </button>
  );
}

type BubbleProps = {
  m: ChatMessage;
  /** Group chats: the sender is named on the first bubble of a run. */
  sender?: Sender | null;
  /** First of a run of messages from the same side: draws the tail. */
  first: boolean;
  reactions?: string[];
  highlight?: string;
  quotedAuthor?: (fromMe: boolean, participant: string | null) => string;
  /** Without it (a read-only view such as the peek) there is no reply button. */
  onReply?: (m: ChatMessage) => void;
  /** React with an emoji ('' takes ours back); without it, no reaction button. */
  onReact?: (m: ChatMessage, emoji: string) => void;
  /** Our own reaction on this message, if any. */
  myReaction?: string;
  /** Edit one of our text messages (offered while WhatsApp allows it); without it, no edit button. */
  onEdit?: (m: ChatMessage) => void;
  /** Delete for everyone or for us; without it, no delete button. */
  onDelete?: (m: ChatMessage) => void;
  onOpenMedia: (m: ChatMessage) => void;
  onJump?: (waMessageId: string) => void;
  onOpenChat?: (phone: string) => void;
  /** A message still on its way from this page (see outbox.ts): its file previews locally. */
  localSrc?: string;
  /** On its way from this page: upload progress, waiting between automatic tries, or failed (retry / drop). */
  pending?: { failed: boolean; error?: string; waiting?: 'network' | 'retry'; progress?: number; onRetry: () => void; onDiscard: () => void };
  /** One of our stored messages that failed: send it again (it takes the failed one's place). */
  onResend?: (m: ChatMessage) => void;
  /** A resend of this message is on its way. */
  resending?: boolean;
};

/** Errors where sending again can't help (or makes it worse): no resend button. */
const NO_RESEND = [/^Recipient is not on WhatsApp$/, /^WhatsApp refused: this number may not start new chats/];
/** It may have gone out after all: resending asks for a second click. */
const MAYBE_SENT = [/^Interrupted while sending/, /^WhatsApp did not confirm this message in time/];

/** "Send again" under a failed message; a second click confirms when it may have been delivered. */
function ResendButton({ m, busy, onResend }: { m: ChatMessage; busy?: boolean; onResend: (m: ChatMessage) => void }) {
  const { t } = useI18n();
  const p = t.chats.pending;
  const careful = MAYBE_SENT.some((re) => re.test(m.error ?? ''));
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 5_000);
    return () => clearTimeout(timer);
  }, [confirming]);
  return (
    <div className="mt-1.5 flex items-center justify-end gap-1.5">
      {confirming && <span className="text-[11px] text-ink/60">{p.resendConfirm}</span>}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (careful && !confirming) return setConfirming(true);
          setConfirming(false);
          onResend(m);
        }}
        className="inline-flex items-center gap-1 rounded-md bg-brand px-2 py-1 text-xs font-semibold text-on-brand transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        <RotateCw className={cx('size-3', busy && 'animate-spin')} /> {busy ? p.resending : confirming ? p.resendYes : p.resend}
      </button>
    </div>
  );
}

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const REACT_BAR_WIDTH = 296;

/**
 * The smiley beside a message: a bar of quick reactions, opened on its own layer (the conversation's
 * scroll box would clip it). Picking our current reaction again takes it back.
 */
function ReactButton({ mine, onPick }: { mine?: string; onPick: (emoji: string) => void }) {
  const { t } = useI18n();
  const c = t.chats;
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    const outside = (e: Event) => !bar.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node);
    const onDown = (e: PointerEvent) => outside(e) && close();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', close, true);
    };
  }, [at]);
  const toggle = () => {
    if (at) return setAt(null);
    const rect = button.current!.getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - REACT_BAR_WIDTH / 2), window.innerWidth - REACT_BAR_WIDTH - 8);
    setAt({ top: rect.top - 56 < 8 ? rect.bottom + 8 : rect.top - 56, left });
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-expanded={at !== null}
        aria-label={c.react}
        title={c.react}
        className={cx('rounded-full p-1.5 transition-colors hover:bg-raised hover:text-ink', at ? 'bg-raised text-ink' : 'text-muted')}
      >
        <SmilePlus className="size-4" />
      </button>
      {at && (
        <Floating>
          <div
            ref={bar}
            role="menu"
            aria-label={c.react}
            className="animate-scale-in fixed z-[70] flex items-center justify-between gap-0.5 rounded-full border border-line bg-card p-1.5 shadow-xl"
            style={{ top: at.top, left: at.left, width: REACT_BAR_WIDTH }}
          >
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                role="menuitem"
                onClick={() => {
                  setAt(null);
                  onPick(mine === emoji ? '' : emoji);
                }}
                aria-pressed={mine === emoji}
                className={cx(
                  'grid size-10 cursor-pointer place-items-center rounded-full text-[22px] leading-none transition-transform duration-150 hover:scale-125',
                  mine === emoji && 'bg-brand/15 ring-1 ring-brand/40',
                )}
              >
                {emoji}
              </button>
            ))}
          </div>
        </Floating>
      )}
    </>
  );
}

export const Bubble = memo(function Bubble({
  m,
  sender,
  first,
  reactions,
  myReaction,
  highlight,
  quotedAuthor,
  onReply,
  onReact,
  onEdit,
  onDelete,
  onOpenMedia,
  onJump,
  onOpenChat,
  localSrc,
  pending,
  onResend,
  resending,
}: BubbleProps) {
  const { t, fmt } = useI18n();
  const c = t.chats;
  const out = m.direction === 'out';
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);

  const text = textOf(m);
  const isMedia = ['image', 'video', 'audio', 'document', 'sticker'].includes(m.type);
  const bare = m.type === 'sticker';
  const at = m.content.timestamp ? new Date(m.content.timestamp * 1000) : new Date(m.sentAt ?? m.createdAt);
  const quoted = m.content.quoted ?? (m.content.quote ? { id: m.content.quote.id, type: 'text', text: m.content.quote.text ?? null, participant: null, fromMe: m.content.quote.fromMe } : null);
  const quotedFromMe = m.content.quote ? m.content.quote.fromMe : false;

  let body: ReactNode = null;
  const revoked = m.content.revoked === true;
  if (revoked) {
    body = (
      <p className="flex items-center gap-1.5 py-0.5 text-sm text-ink/55 italic">
        <Ban className="size-3.5" /> {out ? c.revokedByYou : c.revoked}
      </p>
    );
  } else if (m.content.viewOnce) {
    body = (
      <p className="flex items-center gap-2 py-1 text-sm text-ink/70 italic">
        <Eye className="size-4" /> {c.media.viewOnce}
      </p>
    );
  } else if (m.type === 'image' || m.type === 'sticker') body = <ImageMedia m={m} onOpen={() => onOpenMedia(m)} localSrc={localSrc} />;
  else if (m.type === 'video') body = <VideoMedia m={m} localSrc={localSrc} />;
  else if (m.type === 'audio') body = <AudioMedia m={m} outbound={out} localSrc={localSrc} />;
  else if (m.type === 'document') body = <DocumentMedia m={m} />;
  else if (m.type === 'location') body = <LocationCard m={m} />;
  else if (m.type === 'contact') body = <ContactCards m={m} onOpenChat={onOpenChat} />;
  else if (m.type === 'poll') body = out ? <PollResults content={m.content as Record<string, unknown>} /> : <InboundPoll m={m} />;
  else if (m.type === 'unknown') body = <p className="py-0.5 text-sm text-ink/60 italic">{c.unsupported}</p>;

  // Checked when drawn: a bubble left open past the window offers it until the next render (the API refuses then).
  const editable = out && m.type === 'text' && !revoked && Boolean(m.waMessageId) && Date.now() - at.getTime() < EDIT_WINDOW_MS;
  const caption = revoked ? null : m.type === 'poll' ? (out ? text : null) : m.type === 'text' || isMedia ? text : null;
  // A picture or video edge to edge, the time laid over it (as WhatsApp does).
  const framed = (m.type === 'image' || m.type === 'video') && !revoked && !m.content.viewOnce;
  // Not over a video: it would cover the player's controls.
  const overlaid = bare || (m.type === 'image' && framed && !caption);
  const time = (
    <span className={cx('inline-flex shrink-0 items-center gap-1 text-[11px] leading-none whitespace-nowrap', overlaid ? 'rounded-full bg-black/50 px-1.5 py-1 text-white backdrop-blur-sm' : 'text-ink/50')}>
      {m.broadcastId && <Megaphone className="size-3" aria-label={c.campaign} />}
      {m.content.sentFrom === 'phone' && <Smartphone className="size-3" aria-label={c.fromPhone} />}
      {m.content.edited && !revoked && <span className="italic">{c.edited}</span>}
      <time dateTime={at.toISOString()} title={fmt.dateTime(at)}>
        {fmt.time(at)}
      </time>
      {out && <StatusTick status={m.status} />}
    </span>
  );

  return (
    <div
      id={m.waMessageId ? `msg-${m.waMessageId}` : undefined}
      // Room under a bubble for its reactions badge, which hangs below it.
      className={cx('group/msg flex w-full px-3 md:px-[6%]', out ? 'justify-end' : 'justify-start', first ? 'mt-3' : 'mt-[3px]', reactions && reactions.length > 0 && 'mb-3.5')}
    >
      <div className="relative flex max-w-[min(85%,36rem)]">
        <div
          className={cx(
            'pii relative min-w-0 text-[14.5px] leading-[1.45] text-ink',
            bare ? '' : cx('rounded-[18px] shadow-[0_1px_2px_rgb(0_0_0/0.13)]', framed ? 'p-1' : 'px-3 pt-1.5 pb-1.5'),
            !bare && (out ? 'bg-(--chat-out) ring-1 ring-(--chat-out-ring)' : 'bg-(--chat-in) ring-1 ring-line/60'),
            !bare && first && (out ? 'rounded-se-[6px]' : 'rounded-ss-[6px]'),
            m.status === 'failed' && 'ring-critical/40',
          )}
        >
          {sender && first && !out && (
            <p className={cx('pii mb-0.5 flex min-w-0 items-baseline gap-2 text-[12.5px]', framed ? 'px-2 pt-1' : '')}>
              <span dir="auto" className={cx('truncate', sender.unknown ? 'text-ink/45 italic' : cx('font-semibold', senderColor(sender.key)))}>
                {sender.name}
              </span>
              {sender.phone && <span className="ltr shrink-0 font-mono text-[11px] text-ink/45">{sender.phone}</span>}
            </p>
          )}
          {m.content.forwarded && (
            <p className={cx('mb-0.5 flex items-center gap-1 text-[11.5px] text-ink/55 italic', framed && 'px-2 pt-1')}>
              <Forward className={cx('size-3', flip)} /> {c.forwarded}
            </p>
          )}
          {quoted && (
            <Quote
              author={quotedAuthor ? quotedAuthor(quotedFromMe, quoted.participant) : c.you}
              text={quoted.text}
              type={quoted.type}
              mine={quotedFromMe}
              onClick={onJump ? () => onJump(quoted.id) : undefined}
            />
          )}
          {body}
          {caption ? (
            // The time sits on the text's last line when it fits: an invisible copy holds its place.
            <div dir="auto" className={cx('relative', framed ? 'px-2 pt-1.5 pb-1' : isMedia && 'pt-1.5')}>
              <p className="break-words whitespace-pre-wrap" style={{ overflowWrap: 'anywhere' }}>
                <ChatText text={caption} highlight={highlight} />
                <span aria-hidden className="invisible ps-3 align-bottom select-none">
                  {time}
                </span>
              </p>
              <span className={cx('absolute', framed ? 'end-2 bottom-1' : 'end-0 bottom-0')}>{time}</span>
            </div>
          ) : overlaid ? (
            <div className={cx('pointer-events-none absolute', bare ? 'end-1 bottom-1' : 'end-2.5 bottom-2.5')}>{time}</div>
          ) : (
            <div className={cx('flex justify-end pt-1', framed && 'px-1.5 pb-0.5')}>{time}</div>
          )}
          {m.error && m.status === 'failed' && (
            <p className="mt-1 flex items-start gap-1.5 rounded-md bg-critical/15 px-2 py-1 text-xs text-critical">
              <AlertTriangle className="mt-px size-3.5 shrink-0" />
              <span dir="auto">{errorText(m.error, t.sessionDetail.errors)}</span>
            </p>
          )}
          {onResend && out && m.status === 'failed' && !pending && !NO_RESEND.some((re) => re.test(m.error ?? '')) && <ResendButton m={m} busy={resending} onResend={onResend} />}
          {pending && !pending.failed && (pending.waiting || pending.progress !== undefined) && (
            <div className="mt-1.5 min-w-40 space-y-1">
              {pending.progress !== undefined && (
                <div className="h-1 overflow-hidden rounded-full bg-ink/10" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pending.progress * 100)}>
                  <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${Math.round(pending.progress * 100)}%` }} />
                </div>
              )}
              <p className="flex items-center justify-between gap-3 text-[11px] text-ink/60">
                <span>
                  {pending.waiting === 'network' ? c.pending.waitingNetwork : pending.waiting === 'retry' ? c.pending.retrying : c.pending.uploading(Math.round((pending.progress ?? 0) * 100))}
                </span>
                {pending.waiting && (
                  <button type="button" onClick={pending.onDiscard} className="rounded px-1 font-medium hover:text-ink">
                    {c.pending.cancel}
                  </button>
                )}
              </p>
            </div>
          )}
          {pending?.failed && (
            <div className="mt-1.5 flex items-center justify-end gap-1">
              <button type="button" onClick={pending.onDiscard} className="rounded-md px-2 py-1 text-xs font-medium text-muted transition-colors hover:bg-ink/10 hover:text-ink">
                {c.pending.discard}
              </button>
              <button type="button" onClick={pending.onRetry} className="inline-flex items-center gap-1 rounded-md bg-brand px-2 py-1 text-xs font-semibold text-on-brand transition-opacity hover:opacity-90">
                <RotateCw className="size-3" /> {c.pending.retry}
              </button>
            </div>
          )}
          {reactions && reactions.length > 0 && (
            <span className={cx('absolute -bottom-3.5 flex items-center gap-0.5 rounded-full border border-line bg-card px-1.5 py-0.5 text-xs shadow-md', out ? 'end-2' : 'start-2')}>
              {[...new Set(reactions)].slice(0, 3).join('')}
              {reactions.length > 1 && <span className="text-[10px] text-muted tabular-nums">{reactions.length}</span>}
            </span>
          )}
        </div>
        {/* Out of the flow: hidden until hover, it must not make the row any taller. */}
        <div
          className={cx(
            'absolute top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100',
            out ? 'end-full me-1 flex-row-reverse' : 'start-full ms-1',
          )}
        >
          {m.waMessageId && onReact && !revoked && <ReactButton mine={myReaction} onPick={(emoji) => onReact(m, emoji)} />}
          {m.waMessageId && onReply && (
            <button type="button" onClick={() => onReply(m)} className="rounded-full p-1.5 text-muted transition-colors hover:bg-raised hover:text-ink" aria-label={c.reply} title={c.reply}>
              <Reply className={cx('size-4', flip)} />
            </button>
          )}
          {text && (
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}
              className="rounded-full p-1.5 text-muted transition-colors hover:bg-raised hover:text-ink"
              aria-label={copied ? c.copied : c.copy}
              title={copied ? c.copied : c.copy}
            >
              {copied ? <Check className="size-4 text-brand" /> : <Copy className="size-4" />}
            </button>
          )}
          {editable && onEdit && (
            <button type="button" onClick={() => onEdit(m)} className="rounded-full p-1.5 text-muted transition-colors hover:bg-raised hover:text-ink" aria-label={c.manage.edit} title={c.manage.edit}>
              <Pencil className="size-4" />
            </button>
          )}
          {onDelete && m.id > 0 && (
            <button
              type="button"
              onClick={() => onDelete(m)}
              className="rounded-full p-1.5 text-muted transition-colors hover:bg-critical/10 hover:text-critical"
              aria-label={c.manage.delete}
              title={c.manage.delete}
            >
              <Trash2 className="size-4" />
            </button>
          )}
        </div>
      </div>
      {reactions && reactions.length > 0 && <span className="sr-only">{reactions.join(' ')}</span>}
    </div>
  );
});

/** Inline icon + label for a message type in previews (chat list, reply bar). */
export function TypeLabel({ type, voice }: { type: string; voice?: boolean }) {
  const { t } = useI18n();
  const m = t.chats.media;
  const label = voice ? m.voice : type === 'location' ? t.chats.location : type === 'contact' ? t.chats.contactCard : type === 'poll' ? t.chats.poll : (m[type as keyof typeof m] as string | undefined);
  return <>{typeof label === 'string' ? label : type}</>;
}

