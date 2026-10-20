import { UPLOAD_MAX_BYTES } from '@wa/shared/chats';
import { FileText, FileUp, Image as ImageIcon, Loader2, Mic, Paperclip, Plus, Reply, SendHorizontal, Smile, WifiOff, X } from '../../icons';
import { type FormEvent, type KeyboardEvent, lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

/** Files sent in one go; each becomes its own message, in the order picked. */
const MAX_FILES = 30;

/**
 * A preview URL for an image file, made and revoked by one effect: made in a memo instead, the
 * effect's cleanup revokes it when React re-runs effects (StrictMode) and the picture breaks.
 */
function useObjectUrl(file: File | null) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!file?.type.startsWith('image/')) return setSrc(null);
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return src;
}

/** A picked file in the strip above the field: its picture (images) or an icon, and a remove button. */
function FileThumb({ file, onRemove, label }: { file: File; onRemove: () => void; label: string }) {
  const src = useObjectUrl(file);
  return (
    <li className="animate-scale-in group relative size-16 shrink-0" title={`${file.name} · ${formatBytes(file.size)}`}>
      {src ? (
        <img src={src} alt="" className="size-full rounded-md object-cover" />
      ) : (
        <span className="flex size-full flex-col items-center justify-center gap-1 rounded-md bg-bg px-1 text-muted">
          <FileText className="size-5 shrink-0" />
          <span dir="auto" className="w-full truncate text-center text-[10px]">
            {file.name}
          </span>
        </span>
      )}
      <button type="button" onClick={onRemove} className="absolute -top-1.5 -end-1.5 flex size-5 items-center justify-center rounded-full bg-ink text-bg shadow" aria-label={`${label}: ${file.name}`}>
        <X className="size-3" />
      </button>
    </li>
  );
}

type Props = {
  sessionId: string;
  jid: string;
  connected: boolean;
  /** The number is reconnecting: messages can be written and queued, and go out once it's back. */
  reconnecting?: boolean;
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
export const Composer = memo(function Composer({ sessionId, jid, connected, reconnecting = false, title, reply, onCancelReply, onSend }: Props) {
  const { t } = useI18n();
  const c = t.chats;
  const draftKey = `${sessionId}\n${jid}`;
  const [text, setText] = useState(() => drafts.get(draftKey) ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const file = files.length === 1 ? files[0]! : null;
  const [ptt, setPtt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'emoji' | 'voice' | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** Where the caret was, for emoji picked while the field isn't focused. */
  const caret = useRef<{ start: number; end: number } | null>(null);
  const preview = useObjectUrl(file);

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

  // Reconnecting: the server queues the message and the number sends it once it's back.
  const canQueue = connected || reconnecting;
  const canSend = canQueue && (text.trim().length > 0 || files.length > 0);
  const reset = () => {
    setText('');
    setFiles([]);
    setPtt(false);
    setError(null);
    stateAt.current = 0;
    if (pauseTimer.current) clearTimeout(pauseTimer.current);
  };
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSend) return;
    if (files.length === 0) onSend({ text, quote: reply });
    // One message per file, in order (the outbox sends them one after another); the text is the
    // first one's caption, as WhatsApp does, and only it answers the quoted message.
    else
      files.forEach((f, i) =>
        onSend({ text: i === 0 ? text : undefined, file: f, ptt: files.length === 1 ? ptt : undefined, quote: i === 0 ? reply : null }),
      );
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
  /** Adds picked, pasted or dropped files: too-large ones are left out (and said so), up to MAX_FILES in all. */
  const addFiles = (picked: File[]) => {
    if (picked.length === 0) return;
    const mb = UPLOAD_MAX_BYTES / 1024 / 1024;
    const fitting = picked.filter((f) => f.size <= UPLOAD_MAX_BYTES);
    const skipped = picked.length - fitting.length;
    const room = MAX_FILES - files.length;
    const taken = fitting.slice(0, Math.max(room, 0));
    setError(
      fitting.length > taken.length
        ? c.composer.tooMany(MAX_FILES)
        : skipped > 0
          ? picked.length === 1
            ? c.composer.tooLarge(mb)
            : c.composer.someTooLarge(skipped, mb)
          : null,
    );
    if (taken.length === 0) return;
    setFiles((list) => [...list, ...taken]);
    setPtt(false);
    input.current?.focus();
  };
  const removeFile = (index: number) => setFiles((list) => list.filter((_, i) => i !== index));

  // Drag files anywhere over the conversation (not only the field) to attach them.
  const [dropRoot, setDropRoot] = useState<HTMLElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  useEffect(() => setDropRoot(form.current?.closest<HTMLElement>('.chat-root') ?? null), []);
  useEffect(() => {
    if (!dropRoot) return;
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes('Files'));
    let depth = 0;
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = canQueue ? 'copy' : 'none';
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // Always: otherwise the browser leaves the dashboard to open the file.
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (canQueue) addFilesRef.current([...(e.dataTransfer?.files ?? [])]);
    };
    dropRoot.addEventListener('dragenter', onEnter);
    dropRoot.addEventListener('dragover', onOver);
    dropRoot.addEventListener('dragleave', onLeave);
    dropRoot.addEventListener('drop', onDrop);
    return () => {
      dropRoot.removeEventListener('dragenter', onEnter);
      dropRoot.removeEventListener('dragover', onOver);
      dropRoot.removeEventListener('dragleave', onLeave);
      dropRoot.removeEventListener('drop', onDrop);
    };
  }, [dropRoot, canQueue]);

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
    <form ref={form} onSubmit={submit} className="chat-composer relative shrink-0 border-t border-line/60 bg-card/80 px-2 py-2.5 backdrop-blur md:px-4">
      {dragging &&
        dropRoot &&
        createPortal(
          <div className="animate-fade-in pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-bg/80 p-4 backdrop-blur-sm">
            <div
              className={cx(
                'flex w-full max-w-sm flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center',
                canQueue ? 'border-brand/60 bg-brand/5 text-brand' : 'border-warning/50 bg-warning/5 text-warning',
              )}
            >
              {canQueue ? <FileUp className="size-9" /> : <WifiOff className="size-9" />}
              <p className="font-semibold">{canQueue ? c.composer.dropTitle : c.composer.disconnected}</p>
              {canQueue && <p className="text-xs text-muted">{c.composer.dropHint(MAX_FILES, UPLOAD_MAX_BYTES / 1024 / 1024)}</p>}
            </div>
          </div>,
          dropRoot,
        )}
      {panel === 'voice' && <VoiceRecorder onSend={(blob, seconds) => void sendVoice(blob, seconds)} onClose={closePanel} onRecording={onRecording} />}
      {!connected &&
        (reconnecting ? (
          <p role="status" className="mb-2 flex items-center gap-2 rounded-md bg-info/10 px-3 py-2 text-xs text-info">
            <Loader2 className="size-4 shrink-0 animate-spin" /> {c.composer.reconnecting}
          </p>
        ) : (
          <p className="mb-2 flex items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
            <WifiOff className="size-4 shrink-0" /> {c.composer.disconnected}
          </p>
        ))}
      {error && (
        <p role="alert" className="mb-2 flex items-start justify-between gap-2 rounded-md bg-critical/10 px-3 py-2 text-xs text-critical">
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
          <button type="button" onClick={() => setFiles([])} className="rounded p-1 text-muted hover:text-ink" aria-label={c.composer.removeFile}>
            <X className="size-4" />
          </button>
        </div>
      )}
      {files.length > 1 && (
        <div className="animate-fade-up mb-2 rounded-lg bg-raised p-2">
          <div className="mb-2 flex items-center justify-between gap-2 px-0.5 text-xs">
            <span className="font-medium text-ink-2">{c.composer.files(files.length)}</span>
            <button type="button" onClick={() => setFiles([])} className="text-muted hover:text-critical">
              {c.composer.removeAll}
            </button>
          </div>
          <ul className="code-scroll flex gap-2.5 overflow-x-auto px-0.5 pt-1.5 pb-1">
            {files.map((f, i) => (
              <FileThumb key={`${f.name}-${f.size}-${f.lastModified}-${i}`} file={f} label={c.composer.removeFile} onRemove={() => removeFile(i)} />
            ))}
            {files.length < MAX_FILES && (
              <li className="shrink-0">
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  className="flex size-16 items-center justify-center rounded-md border-2 border-dashed border-line-strong text-muted transition-colors hover:border-brand hover:text-brand"
                  aria-label={c.composer.addMore}
                  title={c.composer.addMore}
                >
                  <Plus className="size-5" />
                </button>
              </li>
            )}
          </ul>
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
          <button type="button" onClick={() => fileInput.current?.click()} disabled={!canQueue} className={iconButton} aria-label={c.composer.attach} title={c.composer.attach}>
            <Paperclip className="size-[18px]" />
          </button>
          <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => (addFiles([...(e.target.files ?? [])]), (e.target.value = ''))} />
          <textarea
            ref={input}
            rows={1}
            value={text}
            onChange={(e) => onType(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={rememberCaret}
            onPaste={(e) => {
              const pasted = [...e.clipboardData.files];
              if (pasted.length) {
                e.preventDefault();
                addFiles(pasted);
              }
            }}
            // Empty field: inherit the page direction so the placeholder sits on the right in Arabic;
            // once there's text, auto-detect it (mixed Arabic/Latin input).
            dir={text ? 'auto' : undefined}
            placeholder={files.length > 1 ? c.composer.captionFirst : file ? c.composer.caption : c.composer.placeholder}
            aria-label={c.composer.placeholder}
            title={c.composer.hint}
            className="code-scroll max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-5 text-ink outline-none placeholder:text-muted"
          />
        </div>
        {/* WhatsApp's pattern: a microphone while the field is empty, Send once there's something to send. */}
        {canSend || !canQueue ? (
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
