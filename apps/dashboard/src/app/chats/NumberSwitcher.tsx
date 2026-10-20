import { Check, ChevronsUpDown, Plus } from '../../icons';
import { useEffect, useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { api } from '../../api';
import { useI18n } from '../../i18n';
import { qk } from '../../queries';
import { Link } from '../../router';
import { cx, SESSION_STATUS, TONES } from '../../ui';
import { type ChatNumber, gradientFor, initials } from './model';

/** The open number as a card; opens a list of all numbers with their state and unread counts. */
/** `compact` (focus mode): a slimmer card, so the chat list starts higher. */
export function NumberSwitcher({ numbers, value, onChange, compact = false }: { numbers: ChatNumber[]; value: string; onChange: (id: string) => void; compact?: boolean }) {
  const { t, fmt } = useI18n();
  const c = t.chats;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = numbers.find((n) => n.id === value);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const state = (n: ChatNumber) => {
    const online = n.status === 'connected';
    return (
      <span className={cx('inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold', online ? 'bg-good/12 text-good' : TONES[SESSION_STATUS[n.status].tone].chip)}>
        <span className="relative flex size-1.5">
          {online && <span className="absolute inset-0 animate-ping rounded-full bg-good opacity-60 motion-reduce:animate-none" />}
          <span className={cx('relative size-1.5 rounded-full', online ? 'bg-good' : TONES[SESSION_STATUS[n.status].tone].dot)} />
        </span>
        {online ? c.online : t.status.session[n.status].label}
      </span>
    );
  };
  // Each number's own WhatsApp profile picture (only a connected number can look it up).
  const selfJid = (n: ChatNumber) => (n.phone ? `${n.phone.replace(/\D/g, '')}@s.whatsapp.net` : null);
  const pictureQueries = useQueries({
    queries: numbers.map((n) => {
      const jid = selfJid(n);
      return {
        queryKey: qk.chats.pictures(n.id, jid ?? ''),
        queryFn: ({ signal }: { signal: AbortSignal }) => api<Record<string, string | null>>(`/api/chats/${n.id}/pictures?${new URLSearchParams({ jids: jid! })}`, { signal, timeoutMs: 35_000 }),
        enabled: Boolean(jid) && n.status === 'connected',
        staleTime: 3 * 3_600_000,
        gcTime: 6 * 3_600_000,
        retry: false,
      };
    }),
  });
  const pictureOf = (n: ChatNumber) => {
    const jid = selfJid(n);
    return jid ? (pictureQueries[numbers.indexOf(n)]?.data?.[jid] ?? null) : null;
  };
  const mark = (n: ChatNumber, size = 'size-10') => {
    const picture = pictureOf(n);
    const online = n.status === 'connected';
    return (
      <span className={cx('pii relative inline-flex shrink-0', size)}>
        {picture ? (
          <img src={picture} alt="" referrerPolicy="no-referrer" className="size-full rounded-full object-cover ring-1 ring-white/10" />
        ) : (
          <span className={cx('flex size-full items-center justify-center rounded-full bg-gradient-to-br text-sm font-semibold text-white ring-1 ring-white/10', gradientFor(n.id))}>
            {initials(n.name) || n.name.slice(0, 1)}
          </span>
        )}
        <span className={cx('absolute -end-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-card', online ? 'bg-good' : TONES[SESSION_STATUS[n.status].tone].dot)} />
      </span>
    );
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={c.switchNumber}
        className={cx(
          'flex w-full items-center gap-3 border border-line bg-card text-start shadow-xs transition-[border-color,box-shadow] hover:border-line-strong',
          compact ? 'rounded-xl px-2 py-1.5' : 'rounded-2xl p-2.5',
          open && 'border-ring ring-[3px] ring-ring/30',
        )}
      >
        {current && mark(current, compact ? 'size-8' : undefined)}
        {current && (
          <span className="min-w-0 flex-1 pii">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">{current.name}</span>
              {state(current)}
            </span>
            <span className="ltr mt-0.5 block truncate font-mono text-xs text-muted">{current.phone ?? '—'}</span>
          </span>
        )}
        <ChevronsUpDown className="size-4 shrink-0 text-muted" />
      </button>
      {open && (
        <ul role="listbox" className="animate-scale-in absolute inset-x-0 top-full z-50 mt-2 max-h-80 origin-top overflow-auto rounded-2xl border border-line bg-bg p-1.5 shadow-2xl">
          {numbers.map((n) => (
            <li key={n.id} role="option" aria-selected={n.id === value}>
              <button
                type="button"
                onClick={() => {
                  onChange(n.id);
                  setOpen(false);
                }}
                className={cx('flex w-full items-center gap-3 rounded-xl p-2 text-start transition-colors hover:bg-raised', n.id === value && 'bg-raised')}
              >
                {mark(n, 'size-9')}
                <span className="min-w-0 flex-1 pii">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{n.name}</span>
                    {state(n)}
                  </span>
                  <span className="ltr block truncate font-mono text-[11px] text-muted">{n.phone ?? '—'}</span>
                </span>
                {n.unread > 0 ? (
                  <span className="rounded-full bg-brand px-1.5 py-0.5 text-[10px] font-bold text-on-brand tabular-nums">{fmt.number.format(n.unread)}</span>
                ) : (
                  n.id === value && <Check className="size-4 shrink-0 text-brand" />
                )}
              </button>
            </li>
          ))}
          <li className="mt-1 border-t border-line pt-1">
            <Link href="/sessions" className="flex items-center gap-2 rounded-xl px-2.5 py-2 text-sm text-muted transition-colors hover:bg-raised hover:text-ink">
              <Plus className="size-4" /> {c.addNumber}
            </Link>
          </li>
        </ul>
      )}
    </div>
  );
}
