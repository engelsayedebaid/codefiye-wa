import { AlertTriangle, Loader2, Mic, Pause, Play, RotateCcw, SendHorizontal, Square, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { cx, flip } from '../../ui';
import { formatDuration } from './model';
import { canRecord, recorderType } from './voice';

/** Longest recording; it stops by itself there. */
const MAX_SECONDS = 15 * 60;
const BARS = 44;

type Failure = 'denied' | 'noMic' | 'busy' | 'unsupported' | 'insecure' | 'failed' | 'tooShort';
type Phase =
  | { kind: 'ready' }
  | { kind: 'asking' }
  | { kind: 'recording' }
  | { kind: 'review'; blob: Blob; url: string; seconds: number; peaks: number[] }
  | { kind: 'error'; reason: Failure };

function failureOf(err: unknown): Failure {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'noMic';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'failed';
}

/** `count` bars from the loudness samples taken while recording (0–1). */
function downsample(levels: number[], count: number) {
  if (!levels.length) return Array.from({ length: count }, () => 0.15);
  return Array.from({ length: count }, (_, i) => {
    const from = Math.floor((i * levels.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / count));
    return Math.max(0.12, Math.min(1, Math.max(...levels.slice(from, to))));
  });
}

/**
 * Records a voice note in a small panel above the composer: start → live waveform and timer → stop →
 * listen → send (or record again). The microphone is asked for only on Start, and every track, the
 * recorder and the audio graph are released on stop, cancel, close and unmount.
 */
export function VoiceRecorder({ onSend, onClose, onRecording }: { onSend: (blob: Blob, seconds: number) => void; onClose: () => void; onRecording?: (on: boolean) => void }) {
  const { t } = useI18n();
  const v = t.chats.voice;
  const [phase, setPhase] = useState<Phase>(() => (!window.isSecureContext ? { kind: 'error', reason: 'insecure' } : canRecord() ? { kind: 'ready' } : { kind: 'error', reason: 'unsupported' }));
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const context = useRef<AudioContext | null>(null);
  const frame = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const levels = useRef<number[]>([]);
  const startedAt = useRef(0);
  const discardNext = useRef(false);
  const bars = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const reviewUrl = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  /** Stops everything that holds the microphone. Safe to call twice. */
  const release = useCallback(() => {
    cancelAnimationFrame(frame.current);
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    const r = recorder.current;
    recorder.current = null;
    if (r && r.state !== 'inactive') {
      discardNext.current = true;
      r.stop();
    }
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    void context.current?.close().catch(() => {});
    context.current = null;
  }, []);

  const dropReview = () => {
    if (reviewUrl.current) URL.revokeObjectURL(reviewUrl.current);
    reviewUrl.current = null;
    setPlaying(false);
    setProgress(0);
  };

  useEffect(
    () => () => {
      release();
      if (reviewUrl.current) URL.revokeObjectURL(reviewUrl.current);
    },
    [release],
  );
  useEffect(() => onRecording?.(phase.kind === 'recording'), [phase.kind, onRecording]);

  const start = async () => {
    dropReview();
    setPhase({ kind: 'asking' });
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      return setPhase({ kind: 'error', reason: failureOf(err) });
    }
    // Closed while the permission prompt was up.
    if (!root.current) return media.getTracks().forEach((track) => track.stop());
    stream.current = media;
    const type = recorderType();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(media, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 32_000 });
    } catch {
      release();
      return setPhase({ kind: 'error', reason: 'unsupported' });
    }
    recorder.current = rec;
    discardNext.current = false;
    levels.current = [];
    const chunks: Blob[] = [];
    rec.ondataavailable = (ev) => ev.data.size > 0 && chunks.push(ev.data);
    rec.onerror = () => {
      release();
      setPhase({ kind: 'error', reason: 'failed' });
    };
    rec.onstop = () => {
      if (discardNext.current) return;
      const seconds = Math.round((performance.now() - startedAt.current) / 1000);
      const blob = new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' });
      if (seconds < 1 || blob.size < 600) return setPhase({ kind: 'error', reason: 'tooShort' });
      const url = URL.createObjectURL(blob);
      reviewUrl.current = url;
      setPhase({ kind: 'review', blob, url, seconds, peaks: downsample(levels.current, BARS) });
    };

    // Live loudness → bar heights, written straight to the DOM (no re-render per frame).
    try {
      const ctx = new AudioContext();
      context.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(media).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      let last = 0;
      const draw = (now: number) => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const s of samples) sum += ((s - 128) / 128) ** 2;
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 4.5);
        if (now - last > 70) {
          last = now;
          levels.current.push(level);
          const el = bars.current;
          if (el) {
            const recent = levels.current.slice(-BARS);
            [...el.children].forEach((bar, i) => {
              const value = recent[i - (BARS - recent.length)] ?? 0;
              (bar as HTMLElement).style.transform = `scaleY(${Math.max(0.1, value)})`;
            });
          }
        }
        frame.current = requestAnimationFrame(draw);
      };
      frame.current = requestAnimationFrame(draw);
    } catch {
      // No visualizer; recording still works.
    }

    rec.start(250);
    startedAt.current = performance.now();
    setElapsed(0);
    timer.current = setInterval(() => {
      const s = (performance.now() - startedAt.current) / 1000;
      setElapsed(s);
      if (s >= MAX_SECONDS) stop();
    }, 200);
    setPhase({ kind: 'recording' });
  };

  const stop = () => {
    const r = recorder.current;
    recorder.current = null;
    cancelAnimationFrame(frame.current);
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    if (r && r.state !== 'inactive') r.stop(); // onstop builds the preview
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    void context.current?.close().catch(() => {});
    context.current = null;
  };

  const discard = () => {
    release();
    dropReview();
    setElapsed(0);
    setPhase(canRecord() ? { kind: 'ready' } : { kind: 'error', reason: 'unsupported' });
  };

  const close = () => {
    release();
    onClose();
  };

  const send = () => {
    if (phase.kind !== 'review') return;
    audio.current?.pause();
    onSend(phase.blob, phase.seconds);
  };

  // Escape closes (before the page's own Escape closes the chat); a click outside closes unless a recording would be lost.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();
      close();
    };
    const onDown = (ev: PointerEvent) => {
      const target = ev.target as Element;
      if (root.current?.contains(target) || target.closest?.('[data-voice-toggle]')) return;
      if (phase.kind !== 'recording' && phase.kind !== 'review') close();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown);
    };
  });

  const togglePlay = () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setPlaying(false));
    else el.pause();
  };
  const seek = (fraction: number) => {
    const el = audio.current;
    if (el && phase.kind === 'review') el.currentTime = Math.max(0, Math.min(1, fraction)) * (Number.isFinite(el.duration) ? el.duration : phase.seconds);
  };

  const recording = phase.kind === 'recording';
  const review = phase.kind === 'review' ? phase : null;

  return (
    <div
      ref={root}
      role="dialog"
      aria-label={v.title}
      className="animate-scale-in absolute inset-x-0 bottom-full z-30 mx-auto mb-2 w-full max-w-md origin-bottom overflow-hidden rounded-2xl border border-line bg-card shadow-2xl shadow-black/40 light:shadow-black/15"
    >
      <div className="flex items-center gap-2.5 border-b border-line/70 px-4 py-3">
        <span className={cx('relative flex size-8 items-center justify-center rounded-full', recording ? 'bg-red-500/15 text-red-500' : 'bg-brand/12 text-brand')}>
          {recording && <span className="absolute inset-0 animate-ping rounded-full bg-red-500/25 motion-reduce:hidden" />}
          <Mic className="relative size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{v.title}</p>
          <p className="truncate text-xs text-muted" aria-live="polite">
            {recording ? v.recording : review ? v.preview : phase.kind === 'asking' ? v.asking : phase.kind === 'error' ? '' : v.limit(MAX_SECONDS / 60)}
          </p>
        </div>
        <button type="button" onClick={close} className="rounded-full p-1.5 text-muted transition-colors hover:bg-raised hover:text-ink" aria-label={v.close}>
          <X className="size-4" />
        </button>
      </div>

      <div className="px-4 py-4">
        {phase.kind === 'error' ? (
          <div className="flex flex-col items-center gap-3 py-2 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-amber-500/12 text-amber-400">
              <AlertTriangle className="size-5" />
            </span>
            <p role="alert" className="max-w-xs text-sm text-ink-2">
              {v[phase.reason]}
            </p>
            {phase.reason !== 'unsupported' && phase.reason !== 'insecure' && (
              <button type="button" onClick={() => void start()} className="inline-flex h-9 items-center gap-2 rounded-xl bg-raised px-4 text-sm font-medium transition-colors hover:bg-raised/70">
                <RotateCcw className="size-4" /> {v.retry}
              </button>
            )}
          </div>
        ) : review ? (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={togglePlay}
              aria-label={playing ? v.pause : v.play}
              className="flex size-11 shrink-0 items-center justify-center rounded-full bg-brand text-on-brand shadow-sm transition-transform hover:scale-105 active:scale-95"
            >
              {playing ? <Pause className="size-5 fill-current" /> : <Play className="size-5 translate-x-px fill-current" />}
            </button>
            <div className="min-w-0 flex-1">
              <div
                dir="ltr"
                role="slider"
                tabIndex={0}
                aria-label={v.preview}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress * 100)}
                onClick={(ev) => {
                  const rect = ev.currentTarget.getBoundingClientRect();
                  seek((ev.clientX - rect.left) / rect.width);
                }}
                onKeyDown={(ev) => {
                  if (ev.key === 'ArrowRight') seek(progress + 0.05);
                  if (ev.key === 'ArrowLeft') seek(progress - 0.05);
                }}
                className="flex h-9 cursor-pointer items-center gap-[2px] rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {review.peaks.map((h, i) => (
                  <span key={i} className={cx('flex-1 rounded-full transition-colors', i / review.peaks.length < progress ? 'bg-brand' : 'bg-ink/20')} style={{ height: `${h * 100}%` }} />
                ))}
              </div>
              <p className="mt-0.5 text-xs text-muted tabular-nums">
                {formatDuration(playing || progress > 0 ? progress * review.seconds : review.seconds)}
              </p>
            </div>
            <audio
              ref={audio}
              src={review.url}
              preload="auto"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => {
                setPlaying(false);
                setProgress(0);
              }}
              onTimeUpdate={(ev) => {
                const d = Number.isFinite(ev.currentTarget.duration) ? ev.currentTarget.duration : review.seconds;
                if (d) setProgress(Math.min(1, ev.currentTarget.currentTime / d));
              }}
            />
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className={cx('w-14 shrink-0 text-sm font-semibold tabular-nums', recording ? 'text-ink' : 'text-muted')}>{formatDuration(elapsed)}</span>
            <div ref={bars} dir="ltr" aria-hidden className="flex h-10 min-w-0 flex-1 items-center gap-[2px]">
              {Array.from({ length: BARS }, (_, i) => (
                <span
                  key={i}
                  className={cx('h-full flex-1 origin-center rounded-full transition-transform duration-75', recording ? 'bg-brand' : 'bg-ink/15')}
                  style={{ transform: 'scaleY(0.1)' }}
                />
              ))}
            </div>
            {recording && (
              <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-red-500">
                <span className="size-2 animate-pulse rounded-full bg-red-500" /> REC
              </span>
            )}
          </div>
        )}
        {phase.kind === 'ready' && <p className="mt-3 text-xs text-muted">{v.ready}</p>}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-line/70 bg-raised/40 px-3 py-2.5">
        {recording ? (
          <>
            <button type="button" onClick={discard} className="inline-flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-medium text-red-500 transition-colors hover:bg-red-500/10">
              <Trash2 className="size-4" /> {v.cancel}
            </button>
            <button
              type="button"
              onClick={stop}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-red-500 px-4 text-sm font-semibold text-white shadow-sm transition-transform hover:scale-[1.02] active:scale-95"
            >
              <Square className="size-3.5 fill-current" /> {v.stop}
            </button>
          </>
        ) : review ? (
          <>
            <div className="flex items-center gap-1">
              <button type="button" onClick={discard} className="flex size-10 items-center justify-center rounded-xl text-muted transition-colors hover:bg-red-500/10 hover:text-red-500" aria-label={v.discard} title={v.discard}>
                <Trash2 className="size-4" />
              </button>
              <button type="button" onClick={() => void start()} className="flex size-10 items-center justify-center rounded-xl text-muted transition-colors hover:bg-raised hover:text-ink" aria-label={v.again} title={v.again}>
                <RotateCcw className="size-4" />
              </button>
            </div>
            <button
              type="button"
              onClick={send}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-semibold text-on-brand shadow-[0_8px_24px_-10px] shadow-brand/70 transition-transform hover:-translate-y-0.5 active:translate-y-0"
            >
              {v.send} <SendHorizontal className={cx('size-4', flip)} />
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={close} className="inline-flex h-10 items-center rounded-xl px-3 text-sm font-medium text-muted transition-colors hover:bg-raised hover:text-ink">
              {v.cancel}
            </button>
            {phase.kind !== 'error' && (
              <button
                type="button"
                onClick={() => void start()}
                disabled={phase.kind === 'asking'}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-semibold text-on-brand shadow-sm transition-transform hover:scale-[1.02] active:scale-95 disabled:opacity-60"
              >
                {phase.kind === 'asking' ? <Loader2 className="size-4 animate-spin" /> : <Mic className="size-4" />} {v.start}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
