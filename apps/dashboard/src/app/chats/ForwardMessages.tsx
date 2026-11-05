import { useQuery } from '@tanstack/react-query';
import { CircleCheck, Forward, Loader2, MessageSquareText, Phone, Search, X } from '../../icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiRequestError } from '../../api';
import { useI18n } from '../../i18n';
import { Button, cx } from '../../ui';
import { Avatar } from './Bubble';
import { type ChatMessage, type ChatPage, type ChatSummary, chatTitle, mediaUrl, textOf } from './model';

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);
/** A breath between messages: the number's send queue paces them anyway, this just keeps bursts polite. */
const GAP_MS = 350;

/**
 * Forward the picked messages of one chat to another chat — or a bare number — each on its own,
 * like WhatsApp's forward: media is downloaded and re-uploaded, everything else goes as its own
 * message marked "Forwarded". One Idempotency-Key per message keeps retries safe.
 */
export function ForwardMessages({
  sessionId,
  messages,
  connected,
  onOpen,
  onClose,
  onDone,
}: {
  sessionId: string;
  messages: ChatMessage[];
  connected: boolean;
  onOpen?: (sessionId: string, jid: string) => void;
  onClose: () => void;
  /** The pick is finished (sent): leave selection mode. */
  onDone: () => void;
}) {
  const { t } = useI18n();
  const c = t.chats;
  const x = c.cross;
  const [target, setTarget] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [digits, setDigits] = useState('');
  const [phase, setPhase] = useState<'pick' | 'sending' | 'done'>('pick');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<{ ok: number; fail: number } | null>(null);
  const cancelRef = useRef(false);
  const [key] = useState(() => crypto.randomUUID());

  const chats = useQuery({
    queryKey: ['chats', sessionId, 'forward-targets'],
    queryFn: ({ signal }) => api<ChatPage>(`/api/chats/${sessionId}/list?${new URLSearchParams({ filter: 'all', limit: '100' })}`, { signal }),
    staleTime: 30_000,
  });

  const list = useMemo(() => messages.filter((m) => m.id > 0 && m.type !== 'reaction' && !m.content.revoked), [messages]);

  let phone = digits.replace(/[\s().+-]/g, '');
  if (phone.startsWith('00')) phone = phone.slice(2);
  const validNumber = /^[1-9]\d{7,14}$/.test(phone);
  const numberJid = validNumber ? `${phone}@s.whatsapp.net` : null;

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = (chats.data?.chats ?? []).filter((ch) => !needle || chatTitle(ch).toLowerCase().includes(needle) || (ch.phone ?? '').includes(needle) || ch.jid.includes(needle));
    const numberRow: ChatSummary | null = numberJid ? placeholder(numberJid, `+${phone}`) : null;
    return numberRow ? [numberRow, ...all.filter((ch) => ch.jid !== numberJid)] : all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats.data, q, numberJid, phone]);

  const picked = (chats.data?.chats ?? []).find((r) => r.jid === target) ?? (target && target === numberJid ? placeholder(target, `+${phone}`) : undefined);
  const targetName = picked ? (picked.phone ?? picked.name ?? chatTitle(picked)) : '';

  /** What a message that can't go as itself becomes: a text line naming what it was. */
  const fallbackText = (m: ChatMessage): string => {
    const media = t.chats.media as Record<string, unknown>;
    const name = m.content.media?.ptt || m.content.ptt ? t.chats.media.voice : typeof media[m.type] === 'string' ? (media[m.type] as string) : m.type;
    const label = m.type === 'text' ? '' : `[${name}] `;
    if (m.type === 'location' && m.content.location) {
      const l = m.content.location;
      return `${[l.name, l.address].filter(Boolean).join(' ')} https://www.google.com/maps?q=${l.latitude},${l.longitude}`.trim();
    }
    if (m.type === 'poll' && m.content.poll) return [m.content.poll.name, ...m.content.poll.options].filter(Boolean).join('\n');
    if (m.type === 'contact') {
      const cards = m.content.contacts ?? (m.content.phone ? [{ name: m.content.name ?? '', phone: m.content.phone }] : []);
      return cards.map((card) => [card.name, card.phone].filter(Boolean).join(' ')).filter(Boolean).join('\n');
    }
    return `${label}${textOf(m) ?? m.content.media?.fileName ?? m.content.fileName ?? ''}`.trim();
  };

  /** Media goes through `/uploads` like a composer attachment; the file name and type ride along. */
  const uploadMedia = async (m: ChatMessage): Promise<string> => {
    const res = await fetch(mediaUrl(m.id));
    if (!res.ok) throw new ApiRequestError(res.status, `Media ${res.status}`);
    const blob = await res.blob();
    const mimetype = (m.content.media?.mimetype ?? m.content.mimetype ?? blob.type ?? 'application/octet-stream').toLowerCase();
    const fileName = m.content.media?.fileName ?? m.content.fileName ?? 'file';
    const up = await fetch('/api/chats/uploads', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/octet-stream', 'x-mime-type': mimetype, 'x-file-name': encodeURIComponent(fileName) },
      body: blob,
    });
    const json = (await up.json().catch(() => null)) as { success?: boolean; data?: { id?: string }; message?: string } | null;
    if (!up.ok || !json?.success || !json.data?.id) throw new ApiRequestError(up.status, json?.message ?? 'Upload failed');
    return json.data.id;
  };

  const sendOne = async (m: ChatMessage, index: number) => {
    const idem = `${key}-${index}`;
    const media = m.content.media;
    if (MEDIA_TYPES.has(m.type) && m.hasMedia && !m.content.viewOnce) {
      const uploadId = await uploadMedia(m);
      const ptt = Boolean(media?.ptt ?? m.content.ptt);
      const seconds = media?.seconds ?? m.content.seconds;
      const caption = textOf(m)?.trim() || undefined;
      await api(`/api/chats/${sessionId}/send`, {
        method: 'POST',
        headers: { 'idempotency-key': idem },
        body: { jid: target!, forwarded: true, uploadId, ...(ptt ? { ptt: true } : {}), ...(ptt && seconds ? { seconds } : {}), ...(caption ? { text: caption } : {}) },
        timeoutMs: 60_000,
      });
      return;
    }
    const body = fallbackText(m);
    if (!body) throw new Error('nothing to send');
    await api(`/api/chats/${sessionId}/send`, {
      method: 'POST',
      headers: { 'idempotency-key': idem },
      body: { jid: target!, forwarded: true, text: body },
      timeoutMs: 60_000,
    });
  };

  const start = async () => {
    if (!target || phase !== 'pick') return;
    cancelRef.current = false;
    setPhase('sending');
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < list.length; i++) {
      if (cancelRef.current) break;
      const m = list[i]!;
      try {
        // View-once media can't be forwarded (WhatsApp blocks it too).
        if (m.content.viewOnce) throw new Error('view once');
        await sendOne(m, i);
        ok += 1;
      } catch {
        fail += 1;
      }
      setProgress({ done: i + 1, total: list.length });
      if (i + 1 < list.length && !cancelRef.current) await new Promise((r) => setTimeout(r, GAP_MS));
    }
    setResult({ ok, fail });
    setPhase('done');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const finish = () => {
    onDone();
    onClose();
  };

  return (
    <div className="animate-fade-in fixed inset-0 z-[66] flex items-center justify-center bg-black/55 p-3 backdrop-blur-[2px] sm:p-6" onClick={onClose}>
      <div role="dialog" aria-modal aria-label={c.forwardTitle} onClick={(e) => e.stopPropagation()} className="animate-scale-in flex max-h-[94svh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-2xl">
        <header className="flex items-start gap-3 border-b border-line p-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
            <Forward className="size-[18px]" />
          </span>
          <span className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{c.forwardTitle}</h2>
            <p className="text-xs text-muted">{c.forwardText}</p>
          </span>
          <button type="button" onClick={onClose} className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-muted hover:bg-raised hover:text-ink" aria-label={t.common.close}>
            <X className="size-4" />
          </button>
        </header>

        {phase === 'done' ? (
          <div className="flex flex-col items-center px-6 py-12 text-center">
            <CircleCheck className="size-12 text-brand" />
            <h3 className="mt-3 text-lg font-semibold">{c.forwardDone}</h3>
            <p className="pii mt-1 text-sm text-muted">{c.forwardDoneText(targetName, result?.ok ?? 0)}</p>
            {(result?.fail ?? 0) > 0 && <p className="mt-1 text-xs text-warning">{c.forwardPartial(result!.ok, result!.fail)}</p>}
            <div className="mt-5 flex gap-2">
              <Button variant="outline" onClick={finish}>
                {t.common.close}
              </Button>
              {onOpen && target && (
                <Button variant="brand" icon={<MessageSquareText className="size-4" />} onClick={() => { onDone(); onClose(); onOpen(sessionId, target); }}>
                  {t.chats.ai.openChat}
                </Button>
              )}
            </div>
          </div>
        ) : phase === 'sending' ? (
          <div className="flex flex-col items-center px-6 py-12 text-center">
            <Loader2 className="size-10 animate-spin text-brand" />
            <p className="mt-3 text-sm font-medium">{c.forwardSending(progress.done, progress.total)}</p>
            <p className="mt-1 text-xs text-muted">{c.selected(list.length)}</p>
            <Button variant="outline" className="mt-5" onClick={() => { cancelRef.current = true; }}>
              {t.common.cancel}
            </Button>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-medium text-ink-2">{c.select}</p>
                  <span className="text-[11px] text-muted tabular-nums">{c.selected(list.length)}</span>
                </div>
                <span className="relative block">
                  <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={c.searchChats}
                    className="h-10 w-full rounded-xl border border-line bg-transparent ps-9 pe-3 text-sm text-ink outline-none transition-[border-color,box-shadow] focus:border-ring focus:ring-[3px] focus:ring-ring/30"
                  />
                </span>
                <label className="relative block">
                  <Phone className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
                  <input
                    dir="ltr"
                    inputMode="tel"
                    value={digits}
                    onChange={(e) => setDigits(e.target.value)}
                    placeholder="+201012345678"
                    className="h-10 w-full rounded-xl border border-line bg-transparent ps-9 pe-3 font-mono text-sm text-ink outline-none transition-[border-color,box-shadow] focus:border-ring focus:ring-[3px] focus:ring-ring/30"
                  />
                </label>
                <ul className="max-h-72 divide-y divide-line/60 overflow-y-auto rounded-xl border border-line">
                  {chats.isPending ? (
                    <li className="flex items-center gap-2 px-3 py-4 text-xs text-muted">
                      <Loader2 className="size-4 animate-spin" /> {x.loading}
                    </li>
                  ) : rows.length === 0 ? (
                    <li className="px-3 py-4 text-center text-xs text-muted">{c.noChats}</li>
                  ) : (
                    rows.map((ch) => (
                      <li key={ch.jid}>
                        <button
                          type="button"
                          onClick={() => setTarget(ch.jid)}
                          className={cx('flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-start text-[13px] transition-colors hover:bg-raised/50', target === ch.jid && 'bg-brand/10')}
                        >
                          <Avatar name={chatTitle(ch)} id={ch.jid} picture={null} group={ch.isGroup} size="sm" />
                          <span className="min-w-0 flex-1">
                            <span dir="auto" className="pii block truncate font-medium">{ch.isGroup ? chatTitle(ch) : ch.phone ?? chatTitle(ch)}</span>
                            {ch.name && <span dir="auto" className="pii block truncate text-[11px] text-muted">{chatTitle(ch)}</span>}
                          </span>
                          {target === ch.jid && <CircleCheck className="size-4 shrink-0 text-brand" />}
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              </div>
            </div>
            <footer className="flex items-center justify-end gap-2 border-t border-line p-3">
              <Button variant="outline" onClick={onClose}>
                {t.common.cancel}
              </Button>
              <Button variant="brand" disabled={!target || !connected || list.length === 0} onClick={() => void start()} icon={<Forward className="size-4" />}>
                {c.forwardTo}
              </Button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

/** A bare number typed in (not a chat yet): just enough of ChatSummary to draw a row. */
function placeholder(jid: string, phone: string): ChatSummary {
  return {
    jid,
    altJid: null,
    name: null,
    phone,
    isGroup: false,
    unread: 0,
    pinned: false,
    archived: false,
    inbound: 0,
    outbound: 0,
    lastMessageAt: '',
    lastInboundAt: null,
    last: null,
  };
}
