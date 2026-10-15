import { useMutation, useQuery } from '@tanstack/react-query';
import { CircleCheck, Forward, Loader2, MessageSquareText, Phone, RefreshCw, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../../api';
import { useI18n } from '../../i18n';
import { Button, cx, ErrorNote } from '../../ui';
import { type ChatMessage, type ChatNumber, type ChatSummary, chatTitle, jidPhone, type MessagesPage, textOf } from './model';

/** WhatsApp's own ceiling for one text message (the send route allows 65,536). */
const MAX_TEXT = 65_000;
const LOAD = 100;

/**
 * Forward a conversation through any number (admins, "send between numbers"): the messages picked
 * here, as one ordered text, from the number picked, to any WhatsApp number. The text can be edited
 * before it goes; it is sent once (one Idempotency-Key per dialog).
 */
export function ForwardChat({
  sessionId,
  chat,
  numbers,
  onOpen,
  onClose,
}: {
  sessionId: string;
  chat: ChatSummary;
  numbers: ChatNumber[];
  onOpen?: (sessionId: string, jid: string) => void;
  onClose: () => void;
}) {
  const { t, fmt } = useI18n();
  const x = t.chats.cross;
  const title = chatTitle(chat);
  const usable = numbers.filter((n) => n.status === 'connected');
  const [from, setFrom] = useState(() => (usable.find((n) => n.id !== sessionId) ?? usable[0] ?? numbers[0])?.id ?? sessionId);
  const [to, setTo] = useState('');
  const [withTimes, setWithTimes] = useState(true);
  const [withHeader, setWithHeader] = useState(true);
  const [picked, setPicked] = useState<Set<number> | null>(null);
  const [manual, setManual] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());

  const messages = useQuery({
    queryKey: ['chats', sessionId, 'forward', chat.jid],
    queryFn: ({ signal }) => api<MessagesPage>(`/api/chats/${sessionId}/messages?${new URLSearchParams({ jid: chat.jid, limit: String(LOAD) })}`, { signal }),
    staleTime: 0,
  });
  // Oldest first; reactions and deleted messages carry nothing to forward.
  const list = useMemo(() => (messages.data?.messages ?? []).filter((m) => m.type !== 'reaction' && !m.content.revoked).reverse(), [messages.data]);
  useEffect(() => {
    if (picked === null && messages.data) setPicked(new Set(list.map((m) => m.id)));
  }, [messages.data, list, picked]);
  const selected = picked ?? new Set<number>();

  const label = (m: ChatMessage) => {
    const media = t.chats.media as Record<string, unknown>;
    const name = m.content.media?.ptt || m.content.ptt ? t.chats.media.voice : typeof media[m.type] === 'string' ? (media[m.type] as string) : m.type;
    return m.type === 'text' ? '' : `[${name}] `;
  };
  const who = (m: ChatMessage) =>
    m.direction === 'out' ? x.us : chat.isGroup ? (m.content.pushName ?? m.content.fromPhone ?? x.customer) : title;
  const built = useMemo(() => {
    const phone = chat.phone ?? jidPhone(chat.jid);
    const lines = list
      .filter((m) => selected.has(m.id))
      .map((m) => `${withTimes ? `[${fmt.dateTime(m.createdAt)}] ` : ''}${who(m)}: ${label(m)}${textOf(m) ?? m.content.media?.fileName ?? m.content.fileName ?? ''}`.trimEnd());
    const head = withHeader ? [`${x.header(title)}${phone && chat.name ? ` (${phone})` : ''}`, ''] : [];
    return [...head, ...lines].join('\n');
  }, [list, selected, withTimes, withHeader, title, chat, x, fmt]);
  const text = manual ?? built;

  let digits = to.replace(/[\s().+-]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  const valid = /^[1-9]\d{7,14}$/.test(digits);
  const fromNumber = numbers.find((n) => n.id === from);

  const send = useMutation({
    mutationFn: () =>
      api<ChatMessage>(`/api/chats/${from}/send`, {
        method: 'POST',
        headers: { 'idempotency-key': key },
        body: { jid: `${digits}@s.whatsapp.net`, text: text.trim() },
        timeoutMs: 60_000,
      }),
  });

  const toggle = (id: number) =>
    setPicked((p) => {
      const next = new Set(p ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const tooLong = text.length > MAX_TEXT;
  const canSend = valid && text.trim().length > 0 && !tooLong && fromNumber?.status === 'connected';

  return (
    <div className="animate-fade-in fixed inset-0 z-[66] flex items-center justify-center bg-black/55 p-3 backdrop-blur-[2px] sm:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal
        aria-label={x.forwardTitle}
        onClick={(e) => e.stopPropagation()}
        className="animate-scale-in flex max-h-[94svh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-2xl"
      >
        <header className="flex items-start gap-3 border-b border-line p-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
            <Forward className="size-[18px]" />
          </span>
          <span className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{x.forwardTitle}</h2>
            <p className="text-xs text-muted">{x.forwardText}</p>
          </span>
          <button type="button" onClick={onClose} className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-muted hover:bg-raised hover:text-ink" aria-label={t.common.close}>
            <X className="size-4" />
          </button>
        </header>

        {send.isSuccess ? (
          <div className="flex flex-col items-center px-6 py-12 text-center">
            <CircleCheck className="size-12 text-brand" />
            <h3 className="mt-3 text-lg font-semibold">{x.done}</h3>
            <p className="pii mt-1 text-sm text-muted">{x.doneText(fromNumber?.name ?? '')}</p>
            <div className="mt-5 flex gap-2">
              <Button variant="outline" onClick={onClose}>
                {t.common.close}
              </Button>
              {onOpen && (
                <Button variant="brand" icon={<MessageSquareText className="size-4" />} onClick={() => onOpen(from, `${digits}@s.whatsapp.net`)}>
                  {t.chats.ai.openChat}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-ink-2">{x.from}</p>
                  <div role="radiogroup" aria-label={x.from} className="flex flex-wrap gap-1.5">
                    {numbers.map((n) => {
                      const online = n.status === 'connected';
                      return (
                        <button
                          key={n.id}
                          type="button"
                          role="radio"
                          aria-checked={n.id === from}
                          disabled={!online}
                          onClick={() => setFrom(n.id)}
                          title={online ? (n.phone ?? n.name) : x.offline}
                          className={cx(
                            'flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                            n.id === from ? 'border-brand/50 bg-brand/10 text-ink' : 'border-line text-ink-2 hover:border-line-strong',
                          )}
                        >
                          <span className={cx('size-1.5 rounded-full', online ? 'bg-green-500' : 'bg-ink-3')} />
                          <span className="pii max-w-36 truncate">{n.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <label className="space-y-1.5">
                  <span className="block text-xs font-medium text-ink-2">{x.to}</span>
                  <span className="relative block">
                    <Phone className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
                    <input
                      dir="ltr"
                      inputMode="tel"
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                      placeholder="+201012345678"
                      className="h-10 w-full rounded-xl border border-line bg-transparent ps-9 pe-3 font-mono text-sm text-ink outline-none transition-[border-color,box-shadow] focus:border-ring focus:ring-[3px] focus:ring-ring/30"
                    />
                  </span>
                  {to && !valid && <span className="block text-[11px] text-red-400">{x.invalid}</span>}
                </label>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-medium text-ink-2">{x.messages}</p>
                  <span className="text-[11px] text-muted tabular-nums">{x.selected(selected.size, list.length)}</span>
                  <span className="ms-auto flex gap-1">
                    <button type="button" onClick={() => setPicked(new Set(list.map((m) => m.id)))} className="cursor-pointer rounded-md px-2 py-0.5 text-[11px] text-brand hover:bg-brand/10">
                      {x.selectAll}
                    </button>
                    <button type="button" onClick={() => setPicked(new Set())} className="cursor-pointer rounded-md px-2 py-0.5 text-[11px] text-muted hover:bg-raised hover:text-ink">
                      {x.selectNone}
                    </button>
                  </span>
                </div>
                <ul className="max-h-52 divide-y divide-line/60 overflow-y-auto rounded-xl border border-line">
                  {messages.isPending ? (
                    <li className="flex items-center gap-2 px-3 py-4 text-xs text-muted">
                      <Loader2 className="size-4 animate-spin" /> {x.loading}
                    </li>
                  ) : (
                    list.map((m) => (
                      <li key={m.id}>
                        <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2 text-[13px] hover:bg-raised/50">
                          <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} className="mt-0.5 size-4 shrink-0 accent-(--color-brand)" />
                          <span className="min-w-0 flex-1">
                            <span className={cx('text-[11px] font-medium', m.direction === 'out' ? 'text-brand' : 'text-ink-2')}>
                              {who(m)} · <span className="font-normal text-faint">{fmt.dateTime(m.createdAt)}</span>
                            </span>
                            <span dir="auto" className="pii line-clamp-2 block text-ink-2">
                              {label(m)}
                              {textOf(m) ?? m.content.media?.fileName ?? m.content.fileName ?? ''}
                            </span>
                          </span>
                        </label>
                      </li>
                    ))
                  )}
                </ul>
                <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs text-ink-2">
                  <label className="flex cursor-pointer items-center gap-1.5">
                    <input type="checkbox" checked={withTimes} onChange={(e) => setWithTimes(e.target.checked)} className="size-4 accent-(--color-brand)" />
                    {x.withTimes}
                  </label>
                  <label className="flex cursor-pointer items-center gap-1.5">
                    <input type="checkbox" checked={withHeader} onChange={(e) => setWithHeader(e.target.checked)} className="size-4 accent-(--color-brand)" />
                    {x.withHeader}
                  </label>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-medium text-ink-2">{x.preview}</p>
                  {manual !== null && (
                    <button type="button" onClick={() => setManual(null)} className="flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-brand hover:bg-brand/10">
                      <RefreshCw className="size-3" /> {x.rebuild}
                    </button>
                  )}
                  <span className={cx('ms-auto text-[11px] tabular-nums', tooLong ? 'text-red-400' : 'text-faint')}>{x.chars(text.length)}</span>
                </div>
                <textarea
                  dir="auto"
                  value={text}
                  onChange={(e) => setManual(e.target.value)}
                  rows={8}
                  className="pii w-full resize-y rounded-xl border border-line bg-surface px-3 py-2 text-[13px] leading-relaxed text-ink outline-none transition-[border-color,box-shadow] focus:border-ring focus:ring-[3px] focus:ring-ring/30"
                />
                {tooLong && <p className="text-xs text-red-400">{x.tooLong}</p>}
              </div>
              <ErrorNote>{send.isError ? errorMessage(send.error) : null}</ErrorNote>
            </div>
            <footer className="flex items-center justify-end gap-2 border-t border-line p-3">
              <Button variant="outline" onClick={onClose}>
                {t.common.cancel}
              </Button>
              <Button variant="brand" loading={send.isPending} disabled={!canSend} onClick={() => send.mutate()} icon={<Forward className="size-4" />}>
                {x.send}
              </Button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
