import type { ChatFilter } from '@wa/shared/chats';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Check,
  CheckCheck,
  ChevronsUpDown,
  CircleCheck,
  CircleX,
  Keyboard,
  MessageSquarePlus,
  MessagesSquare,
  Phone,
  PhoneCall,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Smartphone,
  WifiOff,
  Zap,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { useAccount } from '../app/account';
import { ChatList } from '../app/chats/ChatList';
import { ContactPanel } from '../app/chats/ContactPanel';
import { Conversation } from '../app/chats/Conversation';
import { Insights } from '../app/chats/Insights';
import { type ChatInfo, type ChatNumber, type ChatSummary, gradientFor, isChat, type PresenceState, type Profile } from '../app/chats/model';
import { useLiveEvents } from '../events';
import { useI18n } from '../i18n';
import { debouncedInvalidate, qk } from '../queries';
import { Link, navigate } from '../router';
import { Button, buttonClass, cx, EmptyState, ErrorNote, flip, LoadError, Loading, Modal, SESSION_STATUS, TONES } from '../ui';

const SESSION_KEY = 'wa.chats.session';
const RECEIPTS_KEY = 'wa.chats.receipts';
const WATCH_EVERY_MS = 60_000;

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // per-tab only
  }
};

/** The URL carries the open number and chat, so a link (or a reload) lands on the same conversation. */
function setUrl(sessionId: string | null, jid: string | null) {
  const params = new URLSearchParams();
  if (sessionId) params.set('session', sessionId);
  if (jid) params.set('chat', jid);
  const next = `/chats${params.size ? `?${params}` : ''}`;
  if (location.pathname + location.search !== next) history.replaceState(null, '', next);
}

/** The open number as a card; opens a list of all numbers with their state and unread counts. */
function NumberSwitcher({ numbers, value, onChange }: { numbers: ChatNumber[]; value: string; onChange: (id: string) => void }) {
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
      <span className={cx('inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold', online ? 'bg-green-500/10 text-green-500' : TONES[SESSION_STATUS[n.status].tone].chip)}>
        <span className="relative flex size-1.5">
          {online && <span className="absolute inset-0 animate-ping rounded-full bg-green-500 opacity-60 motion-reduce:animate-none" />}
          <span className={cx('relative size-1.5 rounded-full', online ? 'bg-green-500' : TONES[SESSION_STATUS[n.status].tone].dot)} />
        </span>
        {online ? c.online : t.status.session[n.status].label}
      </span>
    );
  };
  const mark = (n: ChatNumber, size = 'size-10') => (
    <span className={cx('flex shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm', size, gradientFor(n.id))}>
      <Smartphone className="size-[45%]" />
    </span>
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={c.switchNumber}
        className={cx(
          'flex w-full items-center gap-3 rounded-2xl border border-line bg-card p-2.5 text-start shadow-xs transition-[border-color,box-shadow] hover:border-line-strong',
          open && 'border-ring ring-[3px] ring-ring/30',
        )}
      >
        {current && mark(current)}
        {current && (
          <span className="min-w-0 flex-1">
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
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{n.name}</span>
                    {state(n)}
                  </span>
                  <span className="ltr block truncate font-mono text-[11px] text-muted">{n.phone ?? '—'}</span>
                </span>
                {n.unread > 0 ? (
                  <span className="rounded-full bg-brand px-1.5 py-0.5 text-[10px] font-bold text-black tabular-nums">{fmt.number.format(n.unread)}</span>
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

/** Start a chat with any number: checks it's on WhatsApp first (a live lookup through the number). */
function NewChatDialog({ sessionId, onStart, onClose }: { sessionId: string; onStart: (jid: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const n = t.chats.newChat;
  const [phone, setPhone] = useState('');
  const [result, setResult] = useState<{ phone: string; exists: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  let digits = phone.replace(/[\s().+-]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  const valid = /^[1-9]\d{7,14}$/.test(digits);
  const checked = result?.phone === digits ? result : null;

  const check = async (e?: FormEvent) => {
    e?.preventDefault();
    if (checked?.exists) return onStart(`${digits}@s.whatsapp.net`);
    if (!valid) return setError(n.invalid);
    setError(null);
    setChecking(true);
    try {
      const found = await api<{ exists: boolean; jid: string | null }>(`/api/on-whatsapp/${digits}`, { sessionId, timeoutMs: 25_000 });
      setResult({ phone: digits, exists: found.exists });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  };

  return (
    <Modal title={n.title} description={n.text} onClose={onClose}>
      <form onSubmit={check} className="space-y-4">
        <label className="grid gap-2">
          <span className="text-sm font-medium">{n.label}</span>
          <span className="relative">
            <Phone className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <input
              autoFocus
              dir="ltr"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                setError(null);
              }}
              placeholder="+201012345678"
              className="h-11 w-full rounded-xl border border-line bg-transparent ps-9 pe-3 font-mono text-base tracking-wide text-ink shadow-xs outline-none transition-[border-color,box-shadow] focus:border-ring focus:ring-[3px] focus:ring-ring/30"
            />
          </span>
        </label>
        {checked && (
          <p
            className={cx(
              'animate-fade-up flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm',
              checked.exists ? 'bg-green-500/10 text-green-500 ring-1 ring-green-500/20' : 'bg-red-500/10 text-red-400 ring-1 ring-red-500/20',
            )}
          >
            {checked.exists ? <CircleCheck className="size-4 shrink-0" /> : <CircleX className="size-4 shrink-0" />}
            <span className="min-w-0 flex-1">{checked.exists ? n.found : n.notFound}</span>
            <span className="ltr font-mono text-xs opacity-80">+{checked.phone}</span>
          </p>
        )}
        <ErrorNote>{error}</ErrorNote>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" variant={checked?.exists ? 'brand' : 'white'} loading={checking} disabled={!phone.trim()} icon={checked?.exists ? <MessageSquarePlus className="size-4" /> : <Search className="size-4" />}>
            {checking ? n.checking : checked?.exists ? n.start : n.check}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** A square icon action in the column header. */
function IconAction({ label, active, onClick, disabled, children }: { label: string; active?: boolean; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cx(
        'flex size-9 items-center justify-center rounded-xl transition-colors disabled:opacity-40',
        active ? 'bg-brand/15 text-brand' : 'text-muted hover:bg-raised hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

export function ChatsPage() {
  const { t } = useI18n();
  const c = t.chats;
  const { account } = useAccount();
  const queryClient = useQueryClient();
  const isAdmin = account?.user?.isAdmin === true;

  useEffect(() => {
    if (account && !isAdmin) navigate('/dashboard', { replace: true });
  }, [account, isAdmin]);

  const numbers = useQuery({
    queryKey: qk.chats.numbers,
    queryFn: ({ signal }) => api<ChatNumber[]>('/api/chats/numbers', { signal }),
    enabled: isAdmin,
  });

  // --- which number, which chat ---
  const params = new URLSearchParams(location.search);
  const [sessionId, setSessionId] = useState<string | null>(() => params.get('session') ?? read(SESSION_KEY));
  const [selected, setSelected] = useState<ChatSummary | null>(null);
  const [pendingJid, setPendingJid] = useState<string | null>(() => params.get('chat'));
  const [view, setView] = useState<'chats' | 'insights'>('chats');
  const [filter, setFilter] = useState<ChatFilter>('all');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [infoOpen, setInfoOpen] = useState(false);
  const [newChat, setNewChat] = useState(false);
  const [receipts, setReceipts] = useState(() => read(RECEIPTS_KEY) !== '0');
  const [presence, setPresence] = useState(() => new Map<string, PresenceState>());
  const search = useRef<HTMLInputElement>(null);

  // --- sync from WhatsApp: the phone answers asynchronously, in batches ---
  const [sync, setSync] = useState<{ scope: string } | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const synced = useRef(0);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, tone });
    toastTimer.current = setTimeout(() => setToast(null), 4_500);
  }, []);
  /** Ends the sync once batches stop arriving (or none came), and says how it went. */
  const settleSync = useCallback(
    (after: number) => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
      syncTimer.current = setTimeout(() => {
        setSync(null);
        showToast(synced.current > 0 ? c.sync.done(synced.current) : c.sync.waiting);
      }, after);
    },
    [c.sync, showToast],
  );
  useEffect(
    () => () => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  // Default to the remembered number, else the first connected one.
  const list = numbers.data ?? [];
  const current = list.find((n) => n.id === sessionId) ?? list.find((n) => n.status === 'connected') ?? list[0] ?? null;
  const activeId = current?.id ?? null;
  const connected = current?.status === 'connected';
  useEffect(() => {
    if (activeId) write(SESSION_KEY, activeId);
    setUrl(activeId, selected?.jid ?? pendingJid);
  }, [activeId, selected?.jid, pendingJid]);

  const switchNumber = (id: string) => {
    setSessionId(id);
    setSelected(null);
    setPendingJid(null);
    setInfoOpen(false);
    setPresence(new Map());
  };

  // Opening a chat by JID (deep link, insights, contact card): load its row.
  const openJid = useCallback(
    async (jid: string) => {
      if (!activeId) return;
      try {
        const info = await queryClient.fetchQuery({
          queryKey: qk.chats.chat(activeId, jid),
          queryFn: ({ signal }) => api<ChatInfo>(`/api/chats/${activeId}/chat?${new URLSearchParams({ jid })}`, { signal }),
        });
        const isGroup = jid.endsWith('@g.us');
        setSelected(
          info.chat ?? {
            jid,
            altJid: null,
            name: null,
            phone: isGroup ? null : `+${jid.split('@')[0]}`,
            isGroup,
            unread: 0,
            pinned: false,
            archived: false,
            inbound: 0,
            outbound: 0,
            lastMessageAt: new Date().toISOString(),
            lastInboundAt: null,
            last: null,
          },
        );
      } catch {
        // not found / offline: stay on the list
      }
      setPendingJid(null);
    },
    [activeId, queryClient],
  );
  useEffect(() => {
    if (pendingJid && activeId) void openJid(pendingJid);
  }, [pendingJid, activeId, openJid]);

  const openPhone = (phone: string) => void openJid(`${phone.replace(/\D/g, '')}@s.whatsapp.net`);

  /** Asks the phone for older messages: of one chat, or of the most recent chats. */
  const startSync = async (jid?: string) => {
    if (!activeId || sync) return;
    if (!connected) return showToast(c.sync.offline, 'error');
    synced.current = 0;
    setSync({ scope: jid ?? 'all' });
    try {
      const { requested } = await api<{ requested: number }>(`/api/chats/${activeId}/sync`, { method: 'POST', body: jid ? { jid } : {} });
      // Nothing to anchor on, or no answer within 25s: say so rather than spin forever.
      settleSync(requested === 0 ? 0 : 25_000);
    } catch (err) {
      setSync(null);
      showToast(`${c.sync.failed}: ${errorMessage(err)}`, 'error');
    }
  };

  // --- live ---
  const invalidate = useMemo(() => debouncedInvalidate(queryClient, 700), [queryClient]);
  useLiveEvents((event) => {
    if (event.type === 'session.status') {
      invalidate(qk.chats.numbers);
      return;
    }
    if (event.sessionId !== activeId) {
      if (event.type === 'messages.received') invalidate(qk.chats.numbers);
      return;
    }
    switch (event.type) {
      case 'messages.received':
      case 'messages.created':
      case 'messages.update':
        invalidate(qk.chats.lists(event.sessionId));
        if (event.type !== 'messages.update') invalidate(qk.chats.numbers);
        if (event.type === 'messages.received' && isChat(selected, event.data.chatJid ?? '')) invalidate(qk.chats.chat(event.sessionId, selected!.jid));
        // A message ends "typing…".
        if (event.type === 'messages.received' && event.data.chatJid) {
          const jid = event.data.chatJid;
          setPresence((prev) => {
            const p = prev.get(jid);
            if (!p || (p.presence !== 'composing' && p.presence !== 'recording')) return prev;
            return new Map(prev).set(jid, { ...p, presence: 'available', at: Date.now() });
          });
        }
        break;
      case 'chats.synced':
        invalidate(qk.chats.lists(event.sessionId));
        invalidate(qk.chats.numbers);
        if (sync) {
          synced.current += event.data.added;
          // More batches may follow; finish once they stop.
          settleSync(3_000);
        }
        break;
      case 'chat.read':
        invalidate(qk.chats.lists(event.sessionId));
        invalidate(qk.chats.numbers);
        if (isChat(selected, event.data.chatJid)) setSelected((s) => s && { ...s, unread: 0 });
        break;
      case 'presence.update': {
        const { chatJid, jid, presence: state, lastSeen } = event.data;
        setPresence((prev) => {
          const next = new Map(prev);
          const old = prev.get(chatJid);
          next.set(chatJid, { presence: state === 'paused' ? 'available' : state, jid, lastSeen: lastSeen ?? old?.lastSeen ?? null, at: Date.now() });
          return next;
        });
        break;
      }
    }
  });

  // Typing that never got a "paused" fades after a while.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 10_000);
    return () => clearInterval(timer);
  }, []);

  // While a chat is open and visible, follow the contact's presence (the worker keeps us online meanwhile).
  const watchJid = selected?.jid ?? null;
  useEffect(() => {
    if (!activeId || !watchJid || !connected) return;
    const watch = () => document.visibilityState === 'visible' && void api(`/api/chats/${activeId}/watch`, { method: 'POST', body: { jid: watchJid } }).catch(() => {});
    watch();
    const timer = setInterval(watch, WATCH_EVERY_MS);
    document.addEventListener('visibilitychange', watch);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', watch);
    };
  }, [activeId, watchJid, connected]);

  const profile = useQuery({
    queryKey: qk.chats.profile(activeId ?? '', watchJid ?? ''),
    queryFn: ({ signal }) => api<Profile>(`/api/chats/${activeId}/profile?${new URLSearchParams({ jid: watchJid! })}`, { signal, timeoutMs: 25_000 }),
    enabled: Boolean(activeId && watchJid),
    staleTime: 30 * 60_000,
    retry: false,
  });

  const flags = useMutation({
    mutationFn: (body: { pinned?: boolean; archived?: boolean; unread?: boolean }) => api(`/api/chats/${activeId}/flags`, { method: 'POST', body: { jid: selected!.jid, ...body } }),
    onMutate: (body) => {
      setSelected((s) => s && { ...s, ...(body.pinned !== undefined ? { pinned: body.pinned } : {}), ...(body.archived !== undefined ? { archived: body.archived } : {}) });
      if (body.unread || body.archived) setSelected(null);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.chats.lists(activeId!) });
      void queryClient.invalidateQueries({ queryKey: qk.chats.numbers });
    },
  });

  // Unread chats in the tab title, so a background tab still says when someone wrote.
  const unreadTotal = list.reduce((sum, n) => sum + n.unreadChats, 0);
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\)\s/, '');
    document.title = unreadTotal > 0 ? `(${unreadTotal}) ${base}` : base;
    return () => {
      document.title = document.title.replace(/^\(\d+\)\s/, '');
    };
  }, [unreadTotal]);

  // "/" searches, Esc closes the open chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName));
      if (e.key === '/' && !typing) {
        e.preventDefault();
        setView('chats');
        search.current?.focus();
      }
      if (e.key === 'Escape' && !typing && document.querySelector('[role="dialog"]') === null) {
        if (infoOpen) setInfoOpen(false);
        else setSelected(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [infoOpen]);

  if (!isAdmin) return null;
  if (numbers.isError && !numbers.data) return <LoadError error={numbers.error} onRetry={() => void numbers.refetch()} retrying={numbers.isFetching} />;
  if (!numbers.data) return <Loading className="py-24" />;
  if (!current) {
    return (
      <EmptyState
        icon={MessagesSquare}
        title={c.noNumbers}
        text={c.noNumbersText}
        action={
          <Link href="/sessions" className={buttonClass('brand')}>
            <PhoneCall className="size-4" /> {c.addNumber}
          </Link>
        }
      />
    );
  }

  const selectedPresence = selected ? (presence.get(selected.jid) ?? (selected.altJid ? presence.get(selected.altJid) : undefined)) : undefined;
  const showMain = Boolean(selected) || view === 'insights';

  return (
    <div className="relative -m-1 flex h-[calc(100svh-6.5rem)] min-h-[540px] overflow-hidden rounded-2xl border border-line bg-card shadow-sm md:m-0 md:h-[calc(100svh-8rem)]">
      {/* chats column */}
      <aside className={cx('w-full shrink-0 flex-col border-e border-line bg-surface/40 lg:flex lg:w-[23rem]', showMain ? 'hidden' : 'flex')}>
        <div className="space-y-3 px-3 pt-4 pb-1">
          <div className="flex items-center justify-between gap-2 px-1">
            <h1 className="text-2xl font-bold tracking-tight">{c.title}</h1>
            <div className="flex items-center gap-0.5">
              <IconAction label={connected ? c.newChat.open : c.newChat.offline} onClick={() => setNewChat(true)} disabled={!connected}>
                <MessageSquarePlus className="size-[18px]" />
              </IconAction>
              <IconAction label={connected ? c.sync.all : c.sync.offline} onClick={() => void startSync()} disabled={!connected || sync !== null}>
                <RefreshCw className={cx('size-[18px]', sync?.scope === 'all' && 'animate-spin')} />
              </IconAction>
              <IconAction label={c.tabs.insights} active={view === 'insights'} onClick={() => setView((v) => (v === 'insights' ? 'chats' : 'insights'))}>
                <BarChart3 className="size-[18px]" />
              </IconAction>
              <IconAction
                label={c.receipts}
                active={receipts}
                onClick={() =>
                  setReceipts((r) => {
                    write(RECEIPTS_KEY, r ? '0' : '1');
                    return !r;
                  })
                }
              >
                <CheckCheck className="size-[18px]" />
              </IconAction>
            </div>
          </div>
          <NumberSwitcher numbers={list} value={current.id} onChange={switchNumber} />
          {!connected && (
            <Link
              href={`/sessions/${current.id}`}
              className="animate-fade-in flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-400 ring-1 ring-amber-500/20 transition-colors hover:bg-amber-500/15"
            >
              <WifiOff className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{c.offlineNumber}</span>
            </Link>
          )}
        </div>
        <div className="min-h-0 flex-1">
          <ChatList
            ref={search}
            key={current.id}
            sessionId={current.id}
            selected={selected?.jid ?? null}
            filter={filter}
            query={query}
            term={debounced}
            presence={presence}
            onFilter={setFilter}
            onQuery={setQuery}
            onSelect={(chat) => {
              setSelected(chat);
              setPendingJid(null);
              setView('chats');
            }}
          />
        </div>
      </aside>

      {/* main pane */}
      <section className={cx('min-w-0 flex-1', showMain ? 'flex' : 'hidden lg:flex')}>
        {view === 'insights' ? (
          <div className="flex min-w-0 flex-1 flex-col bg-surface/30">
            <div className="flex h-12 shrink-0 items-center border-b border-line/60 px-2 lg:hidden">
              <button type="button" onClick={() => setView('chats')} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted hover:bg-raised hover:text-ink">
                <ArrowLeft className={cx('size-4', flip)} /> {c.backToChats}
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <Insights
                key={current.id}
                sessionId={current.id}
                onOpenChat={(jid) => {
                  setView('chats');
                  void openJid(jid);
                }}
              />
            </div>
          </div>
        ) : selected ? (
          <div className="min-w-0 flex-1">
            <Conversation
              key={`${current.id}:${selected.jid}`}
              sessionId={current.id}
              connected={connected}
              chat={selected}
              presence={selectedPresence}
              picture={profile.data?.pictureUrl ?? null}
              receipts={receipts}
              infoOpen={infoOpen}
              onBack={() => setSelected(null)}
              onToggleInfo={() => setInfoOpen((o) => !o)}
              onFlags={(body) => flags.mutate(body)}
              onOpenPhone={openPhone}
              onSync={() => void startSync(selected.jid)}
              syncing={sync?.scope === selected.jid}
            />
          </div>
        ) : (
          <div className="chat-wall relative flex flex-1 flex-col items-center justify-center overflow-hidden p-8 text-center">
            <div className="pointer-events-none absolute top-1/2 left-1/2 size-[28rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand/10 blur-3xl" />
            <div className="animate-fade-up relative flex max-w-md flex-col items-center">
              <div className="relative">
                <span className="animate-float flex size-24 items-center justify-center rounded-[2rem] bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-[0_24px_60px_-20px] shadow-emerald-500/60">
                  <MessagesSquare className="size-11" />
                </span>
                <span className="absolute -end-3 -bottom-2 flex size-10 items-center justify-center rounded-2xl border border-line bg-card text-brand shadow-lg">
                  <ShieldCheck className="size-5" />
                </span>
              </div>
              <h2 className="mt-8 text-2xl font-bold tracking-tight">{c.pickTitle}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">{c.pickText}</p>
              <div className="mt-6 grid w-full grid-cols-3 gap-2 text-xs">
                {[
                  { icon: Zap, label: c.presence.online },
                  { icon: CheckCheck, label: t.status.message.read },
                  { icon: RefreshCw, label: c.tabs.chats },
                ].map((f) => (
                  <span key={f.label} className="flex flex-col items-center gap-1.5 rounded-xl border border-line bg-card/80 px-2 py-3 text-muted backdrop-blur">
                    <f.icon className="size-4 text-brand" />
                    {f.label}
                  </span>
                ))}
              </div>
              <p className="mt-5 flex items-center gap-1.5 text-xs text-faint">
                <Keyboard className="size-3.5" /> {c.pickHint}
              </p>
            </div>
          </div>
        )}

        {selected && infoOpen && view === 'chats' && (
          <>
            <div className="animate-fade-in fixed inset-0 z-40 bg-black/50 xl:hidden" onClick={() => setInfoOpen(false)} />
            <aside className="animate-fade-in fixed inset-y-0 end-0 z-50 w-[22rem] max-w-[92vw] border-s border-line bg-card shadow-2xl xl:static xl:z-auto xl:w-80 xl:shadow-none">
              <ContactPanel
                key={selected.jid}
                sessionId={current.id}
                chat={selected}
                presence={selectedPresence}
                picture={profile.data?.pictureUrl ?? null}
                about={profile.data?.about ?? null}
                onClose={() => setInfoOpen(false)}
                onFlags={(body) => flags.mutate(body)}
              />
            </aside>
          </>
        )}
      </section>

      {newChat && (
        <NewChatDialog
          sessionId={current.id}
          onClose={() => setNewChat(false)}
          onStart={(jid) => {
            setNewChat(false);
            setView('chats');
            void openJid(jid);
          }}
        />
      )}

      {/* toast */}
      {(sync || toast) && (
        <div role="status" className="animate-fade-up pointer-events-none absolute inset-x-0 bottom-5 z-[60] flex justify-center px-4">
          <span
            className={cx(
              'flex max-w-md items-center gap-2 rounded-2xl border px-4 py-2.5 text-sm shadow-xl backdrop-blur',
              toast?.tone === 'error' ? 'border-red-500/30 bg-red-500/15 text-red-300' : 'border-line bg-card/95 text-ink',
            )}
          >
            {sync ? <RefreshCw className="size-4 shrink-0 animate-spin text-brand" /> : toast?.tone === 'error' ? <AlertTriangle className="size-4 shrink-0" /> : <CircleCheck className="size-4 shrink-0 text-brand" />}
            {sync ? c.sync.syncing : toast?.text}
          </span>
        </div>
      )}
    </div>
  );
}
