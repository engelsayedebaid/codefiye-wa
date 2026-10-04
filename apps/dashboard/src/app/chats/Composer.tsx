import { UPLOAD_MAX_BYTES } from '@wa/shared/chats';
import { FileText, Image as ImageIcon, Mic, Paperclip, Reply, SendHorizontal, Smile, WifiOff, X } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { useI18n } from '../../i18n';
import { cx, flip } from '../../ui';
import { TypeLabel } from './Bubble';
import { type ChatMessage, formatBytes, textOf } from './model';
import type { Draft } from './outbox';
import { VoiceRecorder } from './VoiceRecorder';
import { voiceFile } from './voice';

const EmojiPicker = lazy(() => import('./EmojiPicker').then((m) => ({ default: m.EmojiPicker })));
const preloadEmoji = () => void import('./EmojiPicker').then((m) => m.preloadEmoji());

/** Unsent text per chat (per tab), so switching chats or reloading keeps what was being written. */
const drafts = {
  key: (k: string) => `wa.draft.${k}`,
  get(k: string) {
    try {
      return sessionStorage.getItem(this.key(k));
    } catch {
      return null;
    }
  },
  set(k: string, text: string) {
    try {
      if (text) sessionStorage.setItem(this.key(k), text);
      else sessionStorage.removeItem(this.key(k));
    } catch {
      // storage unavailable: the draft lives as long as the component
    }
  },
};

type Props = {
  sessionId: string;
  jid: string;
  connected: boolean;
  /** Name shown on a reply to their message. */
  title: string;
  reply: ChatMessage | null;
  onCancelReply: () => void;
  onSend: (draft: Draft) => void;
};

/**
 * The message field with its attach, emoji, voice-note and send buttons. Its own component so that
 * typing re-renders only this, not the conversation above it.
 */
export const Composer = memo(function Composer({ sessionId, jid, connected, title, reply, onCancelReply, onSend }: Props) {
  const { t } = useI18n();
  const c = t.chats;
  const draftKey = `${sessionId}\n${jid}`;
  const [text, setText] = useState(() => drafts.get(draftKey) ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [ptt, setPtt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'emoji' | 'voice' | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** Where the caret was, for emoji picked while the field isn't focused. */
  const caret = useRef<{ start: number; end: number } | null>(null);
  const preview = useMemo(() => (file && file.type.startsWith('image/') ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  useEffect(() => drafts.set(draftKey, text), [draftKey, text]);

  // "typing…" / "recording audio…" for the contact: at most every 8s while active, "paused" after 4s idle.
  const stateAt = useRef(0);
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatState = useCallback(
    (state: 'composing' | 'recording' | 'paused') => void api(`/api/chats/${sessionId}/typing`, { method: 'POST', body: { jid, state } }).catch(() => {}),
    [sessionId, jid],
  );
  const signal = useCallback(
    (state: 'composing' | 'recording', idleMs: number) => {
      if (!connected) return;
      if (Date.now() - stateAt.current > 8_000) {
        stateAt.current = Date.now();
        chatState(state);
      }
      if (pauseTimer.current) clearTimeout(pauseTimer.current);
      pauseTimer.current = setTimeout(() => {
        if (stateAt.current) chatState('paused');
        stateAt.current = 0;
      }, idleMs);
    },
    [connected, chatState],
  );
  useEffect(() => () => void (pauseTimer.current && clearTimeout(pauseTimer.current)), []);
  const recordingTick = useRef<ReturnType<typeof setInterval> | null>(null);
  const onRecording = useCallback(
    (on: boolean) => {
      if (recordingTick.current) clearInterval(recordingTick.current);
      recordingTick.current = null;
      if (!on) {
        // Stopped or cancelled: the contact stops seeing "recording audio…" right away.
        if (pauseTimer.current) clearTimeout(pauseTimer.current);
        if (stateAt.current) chatState('paused');
        stateAt.current = 0;
        return;
      }
      signal('recording', 2_000);
      recordingTick.current = setInterval(() => signal('recording', 9_000), 4_000);
    },
    [signal, chatState],
  );
  useEffect(() => () => void (recordingTick.current && clearInterval(recordingTick.current)), []);

  const onType = (value: string) => {
    setText(value);
    if (value.trim()) signal('composing', 4_000);
  };

  // Grow with the text, up to ~6 lines.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  // Focus when the chat opens or a reply is picked (not on phones: it would pop the keyboard up).
  useEffect(() => {
    if (matchMedia('(pointer: fine)').matches) input.current?.focus();
  }, [jid, reply]);

  const canSend = connected && (text.trim().length > 0 || file !== null);
  const reset = () => {
    setText('');
    setFile(null);
    setPtt(false);
    setError(null);
    stateAt.current = 0;
    if (pauseTimer.current) clearTimeout(pauseTimer.current);
  };
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSend) return;
    onSend({ text, file: file ?? undefined, ptt: file ? ptt : undefined, quote: reply });
    reset();
    setPanel(null);
    input.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape' && !panel && reply) onCancelReply();
  };
  const pickFile = (f: File | undefined) => {
    if (!f) return;
    if (f.size > UPLOAD_MAX_BYTES) return setError(c.composer.tooLarge(UPLOAD_MAX_BYTES / 1024 / 1024));
    setError(null);
    setFile(f);
    setPtt(false);
    input.current?.focus();
  };

  const rememberCaret = () => {
    const el = input.current;
    if (el) caret.current = { start: el.selectionStart, end: el.selectionEnd };
  };
  const insertEmoji = useCallback((emoji: string) => {
    const el = input.current;
    const focused = el && document.activeElement === el;
    const at = focused ? { start: el.selectionStart, end: el.selectionEnd } : (caret.current ?? { start: el?.value.length ?? 0, end: el?.value.length ?? 0 });
    setText((value) => value.slice(0, at.start) + emoji + value.slice(at.end));
    const next = at.start + emoji.length;
    caret.current = { start: next, end: next };
    requestAnimationFrame(() => {
      if (!el) return;
      if (focused) el.focus();
      el.setSelectionRange(next, next);
    });
  }, []);
  const closePanel = useCallback(() => setPanel(null), []);

  const sendVoice = useCallback(
    async (blob: Blob, seconds: number) => {
      setPanel(null);
      const voice = await voiceFile(blob);
      onSend({ file: voice, ptt: true, seconds, quote: reply });
      if (reply) onCancelReply();
    },
    [onSend, reply, onCancelReply],
  );

  const replyText = reply ? textOf(reply) : null;
  const iconButton = 'flex size-9 shrink-0 items-center justify-center rounded-xl text-muted transition-colors hover:bg-raised hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent';

  return (
    <form onSubmit={submit} className="chat-composer relative shrink-0 border-t border-line/60 bg-card/80 px-2 py-2.5 backdrop-blur md:px-4">
      {panel === 'voice' && <VoiceRecorder onSend={(blob, seconds) => void sendVoice(blob, seconds)} onClose={closePanel} onRecording={onRecording} />}
      {!connected && (
        <p className="mb-2 flex items-center gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          <WifiOff className="size-4 shrink-0" /> {c.composer.disconnected}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-2 flex items-start justify-between gap-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label={t.common.close}>
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
          <button type="button" onClick={onCancelReply} className="me-2 rounded p-1 text-muted hover:text-ink" aria-label={c.cancelReply}>
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
      <div className="relative flex items-end gap-2">
        {panel === 'emoji' && (
          <Suspense fallback={null}>
            <EmojiPicker onPick={insertEmoji} onClose={closePanel} />
          </Suspense>
        )}
        {/* One rounded field: emoji, attach, text; then the voice-note or send button beside it. */}
        <div className="flex min-w-0 flex-1 items-end gap-0.5 rounded-2xl border border-line bg-bg p-1 shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30">
          <button
            type="button"
            data-emoji-toggle
            onPointerEnter={preloadEmoji}
            onFocus={preloadEmoji}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              rememberCaret();
              setPanel((p) => (p === 'emoji' ? null : 'emoji'));
            }}
            className={cx(iconButton, panel === 'emoji' && 'bg-raised text-brand')}
            aria-label={c.composer.emoji}
            aria-expanded={panel === 'emoji'}
            title={c.composer.emoji}
          >
            <Smile className="size-[19px]" />
          </button>
          <button type="button" onClick={() => fileInput.current?.click()} disabled={!connected} className={iconButton} aria-label={c.composer.attach} title={c.composer.attach}>
            <Paperclip className="size-[18px]" />
          </button>
          <input ref={fileInput} type="file" className="hidden" onChange={(e) => (pickFile(e.target.files?.[0]), (e.target.value = ''))} />
          <textarea
            ref={input}
            rows={1}
            value={text}
            onChange={(e) => onType(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={rememberCaret}
            onPaste={(e) => {
              const pasted = [...e.clipboardData.files][0];
              if (pasted) {
                e.preventDefault();
                pickFile(pasted);
              }
            }}
            // Empty field: inherit the page direction so the placeholder sits on the right in Arabic;
            // once there's text, auto-detect it (mixed Arabic/Latin input).
            dir={text ? 'auto' : undefined}
            placeholder={file ? c.composer.caption : c.composer.placeholder}
            aria-label={c.composer.placeholder}
            title={c.composer.hint}
            className="code-scroll max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-5 text-ink outline-none placeholder:text-muted"
          />
        </div>
        {/* WhatsApp's pattern: a microphone while the field is empty, Send once there's something to send. */}
        {canSend || !connected ? (
          <button
            type="submit"
            disabled={!canSend}
            className="animate-scale-in flex size-11 shrink-0 items-center justify-center rounded-2xl bg-brand text-on-brand shadow-[0_8px_24px_-10px] shadow-brand/70 transition-[transform,opacity] hover:-translate-y-0.5 active:translate-y-0 disabled:translate-y-0 disabled:opacity-40 disabled:shadow-none"
            aria-label={c.composer.send}
            title={c.composer.send}
          >
            <SendHorizontal className={cx('size-5', flip)} />
          </button>
        ) : (
          <button
            type="button"
            data-voice-toggle
            onClick={() => setPanel((p) => (p === 'voice' ? null : 'voice'))}
            className={cx(
              'animate-scale-in flex size-11 shrink-0 items-center justify-center rounded-2xl shadow-[0_8px_24px_-10px] shadow-brand/70 transition-transform hover:-translate-y-0.5 active:translate-y-0',
              panel === 'voice' ? 'bg-brand-strong text-on-brand ring-4 ring-brand/20' : 'bg-brand text-on-brand',
            )}
            aria-label={c.composer.record}
            aria-expanded={panel === 'voice'}
            title={c.composer.record}
          >
            <Mic className="size-5" />
          </button>
        )}
      </div>
    </form>
  );
});
