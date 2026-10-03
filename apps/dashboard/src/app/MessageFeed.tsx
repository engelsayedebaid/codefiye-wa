import type { MessageStatus, MessageType } from '@wa/shared/constants';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  Clock,
  Contact,
  FileText,
  Image as ImageIcon,
  ListChecks,
  Loader2,
  MapPin,
  MessageSquare,
  MessagesSquare,
  Mic,
  Smile,
  Sticker,
  Video,
} from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../i18n';
import type { Dict } from '../i18n/ar';
import { WhatsAppText } from '../pages/Templates';
import type { Message } from '../types';
import { Card, cx, delay, ErrorNote, LoadError, Loading } from '../ui';

const TYPE_ICONS: Record<MessageType, typeof Check> = {
  text: MessageSquare,
  image: ImageIcon,
  video: Video,
  audio: Mic,
  document: FileText,
  sticker: Sticker,
  location: MapPin,
  contact: Contact,
  reaction: Smile,
  poll: ListChecks,
  unknown: MessageSquare,
};

/** WhatsApp-style ticks; the states that need attention also show their label. */
const STATUS_TICKS: Record<MessageStatus, { icon: typeof Check; className: string; labelled?: boolean; spin?: boolean }> = {
  queued: { icon: Clock, className: 'text-faint', labelled: true },
  sending: { icon: Loader2, className: 'text-faint', labelled: true, spin: true },
  sent: { icon: Check, className: 'text-muted' },
  delivered: { icon: CheckCheck, className: 'text-muted' },
  read: { icon: CheckCheck, className: 'text-[#53bdeb]' },
  failed: { icon: AlertTriangle, className: 'text-red-400', labelled: true },
  received: { icon: ArrowDownLeft, className: 'text-faint' },
};

/** One tick for this long usually means WhatsApp is holding the message, not a slow network. */
const STUCK_AFTER_MS = 10 * 60_000;

type Filter = 'all' | 'in' | 'out' | 'failed';
const FILTERS: Filter[] = ['all', 'in', 'out', 'failed'];
const matches = (m: Message, filter: Filter) => filter === 'all' || (filter === 'failed' ? m.status === 'failed' : m.direction === filter);

const phoneOf = (jid: string) => {
  const [user, server] = jid.split('@');
  return server === 's.whatsapp.net' && user ? `+${user.split(':')[0]}` : null;
};

/** Who the message is with: the sender's WhatsApp name when we have it, and the number. */
function peerOf(m: Message) {
  const inbound = m.direction === 'in';
  const phone = (inbound ? (m.content.fromPhone as string | null) : null) ?? phoneOf(m.jid) ?? m.jid.split('@')[0]!;
  const name = inbound ? ((m.content.pushName as string | null) ?? null) : null;
  return { name, phone };
}

/** Newest first, split by local day. */
function byDay(messages: Message[]) {
  const groups: { key: string; first: string; items: Message[] }[] = [];
  for (const m of messages) {
    const key = new Date(m.createdAt).toDateString();
    const last = groups.at(-1);
    if (last?.key === key) last.items.push(m);
    else groups.push({ key, first: m.createdAt, items: [m] });
  }
  return groups;
}

/**
 * The worker stores send failures in English (they're also returned by the API); known ones are shown
 * in the reader's language — the patterns follow apps/worker (runner.ts, media.ts) and the queue.
 * Anything unknown is shown as stored.
 */
function errorText(error: string, e: Dict['sessionDetail']['errors']): string {
  if (error.startsWith('WhatsApp refused: this number may not start new chats')) return e.restricted;
  if (error.includes('(stale device session)')) return e.stale;
  const rejected = /^Rejected by WhatsApp(?: \(error (\w+)\))?$/.exec(error);
  if (rejected) return e.rejected(rejected[1] ?? null);
  if (error === 'Recipient is not on WhatsApp') return e.notOnWhatsApp;
  if (error.startsWith('Interrupted while sending')) return e.interrupted;
  if (error.startsWith('WhatsApp did not confirm this message in time')) return e.timeout;
  if (error.includes('link opens a web page')) return e.webPage;
  if (error.includes("which WhatsApp can't show as an image")) return e.badImage;
  if (error.includes('refused the download')) return e.refused;
  return error;
}

function StatusTick({ status }: { status: MessageStatus }) {
  const { t } = useI18n();
  const { icon: Icon, className, labelled, spin } = STATUS_TICKS[status];
  const label = t.status.message[status];
  return (
    <span title={label} className={cx('flex items-center gap-1', className)}>
      <Icon className={cx('size-3.5', spin && 'animate-spin')} aria-hidden />
      <span className={labelled ? undefined : 'sr-only'}>{label}</span>
    </span>
  );
}

/** Direction of the first strong character, so a poll lays out like its text (e.g. an Arabic poll in the English UI). */
const textDir = (text: string) => (/^[^A-Za-z\u00C0-\u024F\u0590-\u08FF\uFB1D-\uFEFC]*[\u0590-\u08FF\uFB1D-\uFEFC]/.test(text) ? 'rtl' : 'ltr');

/** Answers to a poll we sent: a filled bar per option (the leader ticked), and who chose what. */
function PollResults({ content }: { content: Record<string, unknown> }) {
  const { t, lang } = useI18n();
  const d = t.sessionDetail;
  const options = (content.options as string[] | undefined) ?? [];
  const voters = Object.entries((content.votes as Record<string, string[]> | undefined) ?? {}).filter(([, chosen]) => chosen.length > 0);
  const counts = options.map((option) => voters.filter(([, chosen]) => chosen.includes(option)).length);
  const top = Math.max(0, ...counts);
  const dir = textDir([content.name, ...options].join(' '));
  return (
    <div className="mt-1 space-y-1.5 rounded-lg border border-line bg-raised/20 p-2">
      {options.map((option, i) => {
        const n = counts[i]!;
        const pct = voters.length ? Math.round((n / voters.length) * 100) : 0;
        const leading = n > 0 && n === top;
        return (
          <div key={option} dir={dir} className="relative overflow-hidden rounded-md">
            <div
              className={cx('absolute inset-y-0 start-0 rounded-md transition-[width] duration-700', leading ? 'bg-brand/20' : 'bg-white/[0.06]')}
              style={{ width: `${pct}%` }}
            />
            <div className="relative flex items-center gap-2 px-2.5 py-1.5 text-sm">
              {leading ? <Check className="size-3.5 shrink-0 text-brand" aria-hidden /> : <span className="size-3.5 shrink-0" />}
              <span dir="auto" className={cx('min-w-0 flex-1 truncate', leading && 'font-medium')}>
                {option}
              </span>
              <span className="ltr text-xs text-muted tabular-nums">
                {n} · {pct}%
              </span>
            </div>
          </div>
        );
      })}
      {voters.length === 0 ? (
        <p className="px-1 pt-0.5 text-xs text-muted">{d.noVotes}</p>
      ) : (
        <details className="group px-1 pt-0.5 text-xs">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-muted transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
            {d.votes(voters.length)}
            <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <ul className="mt-1.5 space-y-1">
            {voters.map(([who, chosen]) => (
              <li key={who} className="animate-fade-in flex flex-wrap gap-x-1.5">
                <span className="ltr font-mono text-ink-2">{who}</span>
                <span className="text-muted">{d.chose}:</span>
                <span dir="auto">{chosen.join(lang === 'ar' ? '، ' : ', ')}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** A sent image as a small thumbnail; hidden if it won't load. */
function Thumbnail({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="size-12 shrink-0 rounded-md border border-line object-cover"
    />
  );
}

function MessageRow({ message: m, index }: { message: Message; index: number }) {
  const { t, fmt } = useI18n();
  const d = t.sessionDetail;
  const inbound = m.direction === 'in';
  const { name, phone } = peerOf(m);
  const TypeIcon = TYPE_ICONS[m.type] ?? MessageSquare;
  const typeLabel = d.types[m.type] ?? m.type;
  const text = (m.type === 'poll' ? m.content.name : (m.content.text ?? m.content.caption)) as string | null | undefined;
  const imageUrl = !inbound && m.type === 'image' && typeof m.content.url === 'string' ? m.content.url : null;
  // Groups never report delivery per message, so only 1:1 chats can look stuck.
  const stuck = !inbound && m.status === 'sent' && !m.jid.endsWith('@g.us') && Date.now() - new Date(m.sentAt ?? m.createdAt).getTime() > STUCK_AFTER_MS;

  return (
    <li className="animate-fade-up flex gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-raised/40" style={delay(Math.min(index, 8) * 35)}>
      <span
        className={cx('relative mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full', inbound ? 'bg-blue-500/10 text-blue-400' : 'bg-brand/10 text-brand')}
        title={typeLabel}
        aria-hidden
      >
        <TypeIcon className="size-4" />
        <span className="absolute -end-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full bg-card">
          {inbound ? <ArrowDownLeft className="size-3 text-blue-400" /> : <ArrowUpRight className="size-3 text-brand" />}
        </span>
      </span>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm">
            <span className="sr-only">{inbound ? d.from : d.to}: </span>
            {name ? (
              <>
                <span dir="auto" className="font-medium">
                  {name}
                </span>{' '}
                <span className="ltr font-mono text-xs text-muted">{phone}</span>
              </>
            ) : (
              <span className="ltr font-mono font-medium">{phone}</span>
            )}
          </p>
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-faint">
            <time dateTime={m.createdAt} title={fmt.dateTime(m.createdAt)}>
              {fmt.time(m.createdAt)}
            </time>
            {!inbound && <StatusTick status={m.status} />}
          </span>
        </div>

        {m.type === 'reaction' ? (
          <p className="text-sm text-muted">
            {typeLabel} <span className="text-base">{text}</span>
          </p>
        ) : text ? (
          <p dir="auto" className={cx('text-sm break-words whitespace-pre-line text-ink-2', m.type === 'poll' ? 'font-medium text-ink' : 'line-clamp-3')}>
            {m.type !== 'text' && m.type !== 'poll' && <TypeIcon className="me-1 inline size-3.5 align-[-2px] text-muted" aria-label={typeLabel} />}
            <WhatsAppText text={text} />
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-sm text-muted italic">
            <TypeIcon className="size-3.5" aria-hidden /> {typeLabel}
          </p>
        )}

        {m.type === 'poll' && !inbound && <PollResults content={m.content} />}
        {stuck && (
          <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-400">
            <Clock className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>{d.notDelivered}</span>
          </p>
        )}
        {m.error && (
          <p className="flex items-start gap-1.5 rounded-md bg-red-500/10 px-2.5 py-1.5 text-xs text-red-400">
            <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
            <span dir="auto" className="min-w-0 flex-1" title={m.error}>
              {errorText(m.error, d.errors)}
            </span>
          </p>
        )}
      </div>

      {imageUrl && <Thumbnail url={imageUrl} />}
    </li>
  );
}

/** The session's latest messages: filters, day separators, WhatsApp-style ticks and poll results. Updates live. */
export function MessageFeed({
  messages,
  error,
  onRetry,
  retrying,
}: {
  messages: Message[] | null;
  error: string | null;
  /** Shown with the error, so a failed load is never a dead end. */
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const { t, fmt } = useI18n();
  const d = t.sessionDetail;
  const [filter, setFilter] = useState<Filter>('all');
  const shown = messages?.filter((m) => matches(m, filter)) ?? [];

  return (
    <Card
      title={d.messagesTitle}
      description={d.messagesText}
      className="animate-fade-up"
      style={delay(90)}
      actions={
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs text-muted">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex size-2 rounded-full bg-brand" />
          </span>
          {d.live}
        </span>
      }
    >
      <div className="space-y-3">
        {error && onRetry ? <LoadError error={new Error(error)} onRetry={onRetry} retrying={retrying} /> : <ErrorNote>{error}</ErrorNote>}
        {messages === null ? (
          !error && <Loading />
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-raised text-muted">
              <MessagesSquare className="size-5" />
            </span>
            <p className="max-w-xs text-sm text-muted">{d.noMessages}</p>
          </div>
        ) : (
          <>
            <div role="group" aria-label={d.filterLabel} className="flex flex-wrap gap-1.5">
              {FILTERS.map((f) => {
                const active = filter === f;
                const n = messages.filter((m) => matches(m, f)).length;
                return (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setFilter(f)}
                    className={cx(
                      'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      active ? 'border-brand/60 bg-brand/10 text-ink' : 'border-line text-muted hover:border-line-strong hover:text-ink',
                    )}
                  >
                    {d.filters[f]}
                    <span className={cx('tabular-nums', active ? 'text-brand' : f === 'failed' && n > 0 ? 'text-red-400' : 'text-faint')}>{n}</span>
                  </button>
                );
              })}
            </div>

            {shown.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted">{d.noMatch}</p>
            ) : (
              <div className="code-scroll -mx-2 max-h-[40rem] overflow-y-auto px-2">
                {byDay(shown).map((group) => (
                  <section key={group.key} aria-label={fmt.day(group.first)}>
                    {/* Sticky like WhatsApp's date chips. */}
                    <div className="sticky top-0 z-10 flex justify-center bg-card py-1.5">
                      <span className="rounded-full bg-raised px-2.5 py-0.5 text-[11px] font-medium text-muted">{fmt.day(group.first)}</span>
                    </div>
                    <ul>
                      {group.items.map((m, i) => (
                        <MessageRow key={m.id} message={m} index={i} />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
