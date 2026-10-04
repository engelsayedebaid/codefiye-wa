import { useQuery } from '@tanstack/react-query';
import { Archive, BellOff, Download, ExternalLink, FileText, MailOpen, Pin, Play, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api';
import { useI18n } from '../../i18n';
import { qk } from '../../queries';
import { CopyField, cx } from '../../ui';
import { Avatar, TypeLabel } from './Bubble';
import { PresenceLine } from './Conversation';
import { type ChatInfo, type ChatSummary, chatTitle, formatBytes, mediaUrl, type MessagesPage, type PresenceState } from './model';

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-raised/60 p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-[11px] text-faint">{sub}</p>}
    </div>
  );
}

function Gallery({ sessionId, jid, kind }: { sessionId: string; jid: string; kind: 'media' | 'documents' }) {
  const { t } = useI18n();
  const p = t.chats.panel;
  const query = useQuery({
    queryKey: qk.chats.gallery(sessionId, jid, kind),
    queryFn: ({ signal }) => api<MessagesPage>(`/api/chats/${sessionId}/messages?${new URLSearchParams({ jid, kind, limit: '30' })}`, { signal }),
  });
  const items = query.data?.messages.filter((m) => m.hasMedia) ?? [];
  if (!query.data) return <div className="grid grid-cols-3 gap-1.5">{Array.from({ length: 6 }, (_, i) => <span key={i} className="aspect-square animate-pulse rounded-md bg-raised" />)}</div>;
  if (items.length === 0) return <p className="py-6 text-center text-sm text-muted">{kind === 'media' ? p.noMedia : p.noDocs}</p>;
  if (kind === 'documents') {
    return (
      <ul className="space-y-1">
        {items.map((m) => (
          <li key={m.id}>
            <a href={mediaUrl(m.id, true)} className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-raised">
              <FileText className="size-8 shrink-0 text-rose-400" />
              <span className="min-w-0 flex-1">
                <span dir="auto" className="block truncate text-sm">
                  {m.content.media?.fileName ?? m.content.fileName ?? t.chats.media.document}
                </span>
                <span className="text-xs text-muted">{formatBytes(m.content.media?.size)}</span>
              </span>
              <Download className="size-4 text-muted" />
            </a>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {items.map((m) => (
        <a key={m.id} href={mediaUrl(m.id)} target="_blank" rel="noreferrer" className="group relative aspect-square overflow-hidden rounded-md bg-raised">
          {m.type === 'image' ? (
            <img src={mediaUrl(m.id)} alt="" loading="lazy" className="size-full object-cover transition-transform duration-300 group-hover:scale-110" />
          ) : (
            <>
              {m.content.media?.thumb && <img src={`data:image/jpeg;base64,${m.content.media.thumb}`} alt="" className="size-full object-cover" />}
              <span className="absolute inset-0 flex items-center justify-center bg-black/30 text-white">
                <Play className="size-6 fill-current" />
              </span>
            </>
          )}
        </a>
      ))}
    </div>
  );
}

export function ContactPanel({
  sessionId,
  chat,
  presence,
  picture,
  about,
  onClose,
  onFlags,
}: {
  sessionId: string;
  chat: ChatSummary;
  presence?: PresenceState;
  picture: string | null;
  about: string | null;
  onClose: () => void;
  onFlags: (flags: { pinned?: boolean; archived?: boolean; unread?: boolean }) => void;
}) {
  const { t, fmt } = useI18n();
  const c = t.chats;
  const p = c.panel;
  const [tab, setTab] = useState<'media' | 'documents'>('media');
  const info = useQuery({
    queryKey: qk.chats.chat(sessionId, chat.jid),
    queryFn: ({ signal }) => api<ChatInfo>(`/api/chats/${sessionId}/chat?${new URLSearchParams({ jid: chat.jid })}`, { signal }),
  });
  const s = info.data?.stats;
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');
  const title = chatTitle(chat);
  const types = Object.entries(s?.byType ?? {})
    .filter(([type]) => type !== 'reaction')
    .sort((a, b) => b[1] - a[1]);
  const maxType = Math.max(1, ...types.map(([, n]) => n));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-16 shrink-0 items-center gap-2 border-b border-line px-4">
        <button type="button" onClick={onClose} className="rounded-full p-1.5 text-muted hover:bg-raised hover:text-ink" aria-label={p.close}>
          <X className="size-5" />
        </button>
        <h2 className="font-semibold">{p.title}</h2>
      </header>
      <div className="code-scroll min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <div className="animate-fade-up flex flex-col items-center text-center">
          <Avatar name={title} id={chat.jid} picture={picture} group={chat.isGroup} size="xl" />
          <h3 dir="auto" className="mt-3 text-lg font-semibold">
            {chat.name ? title : <span className="ltr font-mono">{title}</span>}
          </h3>
          <p className="text-sm text-muted">
            <PresenceLine chat={chat} presence={presence} />
          </p>
          {info.data?.optedOut && (
            <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-start text-xs text-amber-400">
              <BellOff className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="block font-semibold">{p.optedOut}</span>
                {p.optedOutText}
              </span>
            </p>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2">
          {[
            { icon: Pin, label: chat.pinned ? c.actions.unpin : c.actions.pin, run: () => onFlags({ pinned: !chat.pinned }), on: chat.pinned },
            { icon: Archive, label: chat.archived ? c.actions.unarchive : c.actions.archive, run: () => onFlags({ archived: !chat.archived }), on: chat.archived },
            { icon: MailOpen, label: c.actions.markUnread, run: () => onFlags({ unread: true }), on: false },
          ].map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={a.run}
              className={cx('flex flex-col items-center gap-1.5 rounded-lg border border-line px-1 py-2.5 text-xs transition-colors hover:bg-raised', a.on ? 'text-brand' : 'text-ink-2')}
            >
              <a.icon className="size-4" />
              <span className="line-clamp-1">{a.label}</span>
            </button>
          ))}
        </div>

        {(about || chat.phone) && (
          <section className="space-y-3">
            {about && (
              <div>
                <p className="text-xs text-muted">{p.about}</p>
                <p dir="auto" className="mt-1 text-sm break-words">
                  {about}
                </p>
              </div>
            )}
            {chat.phone && (
              <div>
                <p className="mb-1 text-xs text-muted">{p.phone}</p>
                <CopyField value={chat.phone} />
                <a href={`https://wa.me/${chat.phone.slice(1)}`} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1.5 text-xs text-sky-400 hover:underline">
                  <ExternalLink className="size-3.5" /> {c.actions.openWhatsApp}
                </a>
              </div>
            )}
          </section>
        )}

        <section className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Stat label={p.received} value={fmt.number.format(chat.inbound)} />
            <Stat label={p.sent} value={fmt.number.format(chat.outbound)} sub={s && s.campaign > 0 ? `${p.campaign}: ${fmt.number.format(s.campaign)}` : undefined} />
            <Stat label={p.deliveredRate} value={s ? pct(s.delivered, s.outbound - s.failed) : '—'} />
            <Stat label={p.readRate} value={s ? pct(s.read, s.delivered) : '—'} sub={s && s.failed > 0 ? `${p.failed}: ${fmt.number.format(s.failed)}` : undefined} />
          </div>
          {s?.firstAt && (
            <p className="text-xs text-muted">
              {p.firstContact}: <span className="text-ink-2">{fmt.date(s.firstAt)}</span>
            </p>
          )}
        </section>

        {types.length > 0 && (
          <section>
            <h4 className="mb-2 text-xs font-medium text-muted">{p.types}</h4>
            <ul className="space-y-1.5">
              {types.map(([type, n]) => (
                <li key={type} className="grid grid-cols-[6rem_1fr_auto] items-center gap-2 text-xs">
                  <span className="truncate text-ink-2">
                    <TypeLabel type={type} />
                  </span>
                  <span className="h-1.5 overflow-hidden rounded-full bg-raised">
                    <span className="block h-full rounded-full bg-brand transition-[width] duration-700" style={{ width: `${(n / maxType) * 100}%` }} />
                  </span>
                  <span className="text-muted tabular-nums">{fmt.number.format(n)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <div className="mb-3 flex gap-1 rounded-lg bg-raised p-1" role="tablist">
            {(['media', 'documents'] as const).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                type="button"
                onClick={() => setTab(k)}
                className={cx('flex-1 rounded-md py-1.5 text-xs font-medium transition-colors', tab === k ? 'bg-bg text-ink shadow-sm' : 'text-muted hover:text-ink')}
              >
                {k === 'media' ? p.mediaTab : p.docsTab}
              </button>
            ))}
          </div>
          <Gallery key={tab} sessionId={sessionId} jid={chat.jid} kind={tab} />
        </section>
      </div>
    </div>
  );
}
