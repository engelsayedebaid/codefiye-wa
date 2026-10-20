import { REVOKE_WINDOW_MS } from '@wa/shared/chats';
import { Trash2, Users } from '../../icons';
import { type FormEvent, useState } from 'react';
import { api, errorMessage } from '../../api';
import { useI18n } from '../../i18n';
import { Button, cx, ErrorNote, inputClass, Modal } from '../../ui';
import { type ChatMessage, textOf } from './model';

/** Edits one of our text messages; the bubble updates when the change comes back (message.changed). */
export function EditMessageDialog({ sessionId, message, onClose }: { sessionId: string; message: ChatMessage; onClose: () => void }) {
  const { t } = useI18n();
  const c = t.chats.manage;
  const original = textOf(message) ?? '';
  const [text, setText] = useState(original);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = text.trim() !== '' && text.trim() !== original.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!changed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/chats/${sessionId}/messages/${message.id}/edit`, { method: 'POST', body: { text: text.trim() }, timeoutMs: 45_000 });
      onClose();
    } catch (err) {
      setError(`${c.editFailed}: ${errorMessage(err)}`);
      setBusy(false);
    }
  };

  return (
    <Modal title={c.editTitle} description={c.editHint} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <textarea
          autoFocus
          dir="auto"
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter saves, as in the composer; Shift+Enter breaks the line.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit(e);
            }
          }}
          className={cx(inputClass, 'h-auto resize-y py-2')}
        />
        <ErrorNote>{error}</ErrorNote>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>{t.common.cancel}</Button>
          <Button type="submit" variant="brand" loading={busy} disabled={!changed}>
            {c.save}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Delete for everyone (ours, or another member's in a group, which WhatsApp allows only to its admins)
 * or for us only. The list updates when the change comes back (message.changed).
 */
export function DeleteMessageDialog({
  sessionId,
  message,
  isGroup,
  connected,
  onClose,
  onNotice,
}: {
  sessionId: string;
  message: ChatMessage;
  isGroup: boolean;
  connected: boolean;
  onClose: () => void;
  /** A short note for the conversation once the dialog is gone (deleted here but not on the phone). */
  onNotice: (text: string) => void;
}) {
  const { t } = useI18n();
  const c = t.chats.manage;
  const [busy, setBusy] = useState<'everyone' | 'me' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const out = message.direction === 'out';
  const at = message.content.timestamp ? message.content.timestamp * 1000 : new Date(message.sentAt ?? message.createdAt).getTime();
  const forEveryone = connected && Boolean(message.waMessageId) && !message.content.revoked && (out || isGroup) && Date.now() - at < REVOKE_WINDOW_MS;

  const run = async (scope: 'everyone' | 'me') => {
    setBusy(scope);
    setError(null);
    try {
      const { synced } = await api<{ synced: boolean }>(`/api/chats/${sessionId}/messages/${message.id}/delete`, { method: 'POST', body: { scope }, timeoutMs: 45_000 });
      if (scope === 'me' && !synced && message.waMessageId) onNotice(c.notSynced);
      onClose();
    } catch (err) {
      setError(`${c.deleteFailed}: ${errorMessage(err)}`);
      setBusy(null);
    }
  };

  return (
    <Modal title={c.deleteTitle} onClose={onClose} size="sm">
      <div className="space-y-2">
        {forEveryone && (
          <Choice
            icon={Users}
            label={c.forEveryone}
            hint={out ? c.forEveryoneHint : c.forEveryoneAdmin}
            busy={busy === 'everyone'}
            disabled={busy !== null}
            onClick={() => void run('everyone')}
          />
        )}
        <Choice icon={Trash2} label={c.forMe} hint={c.forMeHint} busy={busy === 'me'} disabled={busy !== null} onClick={() => void run('me')} />
      </div>
      <ErrorNote>{error}</ErrorNote>
      <div className="flex justify-end">
        <Button variant="outline" onClick={onClose}>{t.common.cancel}</Button>
      </div>
    </Modal>
  );
}

function Choice({ icon: Icon, label, hint, busy, disabled, onClick }: { icon: typeof Trash2; label: string; hint: string; busy: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-start gap-3 rounded-lg border border-line px-3 py-2.5 text-start transition-colors hover:border-critical/40 hover:bg-critical/5 disabled:opacity-60"
    >
      <Icon className={cx('mt-0.5 size-4 shrink-0 text-critical', busy && 'animate-pulse')} />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-critical">{label}</span>
        <span className="block text-xs text-muted">{hint}</span>
      </span>
    </button>
  );
}
