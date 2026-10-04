import type { ChatFilter } from '@wa/shared/chats';
import { planHasFeature } from '@wa/shared/plans';
import { type InfiniteData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Bell,
  BellOff,
  Check,
  CheckCheck,
  ChevronsUpDown,
  CircleCheck,
  CircleX,
  Lock,
  MessageSquarePlus,
  MessagesSquare,
  Phone,
  PhoneCall,
  Plus,
  RefreshCw,
  Search,
  WifiOff,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { useAccount } from '../app/account';
import { ChatList, TypingDots } from '../app/chats/ChatList';
import { ContactPanel } from '../app/chats/ContactPanel';
import { Conversation } from '../app/chats/Conversation';
import { Insights } from '../app/chats/Insights';
import { type InboxNote, type NoteMessage, NoteStack, noteText, playPing, pushNote, unlockAudio } from '../app/chats/Notifier';
import { type ChatInfo, type ChatNumber, type ChatPage, type ChatSummary, gradientFor, initials, isChat, type PresenceState, type Profile } from '../app/chats/model';
import { SyncButton, SyncCard, SyncModal } from '../app/chats/SyncPanel';
import { useBackgroundLiveEvents, useLiveEvents } from '../events';
import { useI18n } from '../i18n';
import { debouncedInvalidate, qk } from '../queries';
import { Link } from '../router';
import { Button, buttonClass, cx, delay, EmptyState, ErrorNote, flip, LoadError, Loading, Modal, PageHeader, SESSION_STATUS, TONES } from '../ui';

const SESSION_KEY = 'wa.chats.session';
const RECEIPTS_KEY = 'wa.chats.receipts';
const NOTIFY_KEY = 'wa.chats.notify';
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
      <span className={cx('relative inline-flex shrink-0', size)}>
        {picture ? (
          <img src={picture} alt="" referrerPolicy="no-referrer" className="size-full rounded-full object-cover ring-1 ring-white/10" />
        ) : (
          <span className={cx('flex size-full items-center justify-center rounded-full bg-gradient-to-br text-sm font-semibold text-white ring-1 ring-white/10', gradientFor(n.id))}>
            {initials(n.name) || n.name.slice(0, 1)}
          </span>
        )}
        <span className={cx('absolute -end-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-card', online ? 'bg-green-500' : TONES[SESSION_STATUS[n.status].tone].dot)} />
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

/** Shown instead of the inbox on plans without `chats`: what it does, and the way to upgrade. */
function ChatsGate() {
  const { t } = useI18n();
  const g = t.chats.gate;
  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <PageHeader title={t.chats.title} description={t.chats.description} />
      <section className="animate-fade-up overflow-hidden rounded-xl border border-line bg-card shadow-sm">
        <div className="relative flex flex-col items-center gap-3 px-6 py-10 text-center">
          <span aria-hidden className="absolute -top-16 size-48 rounded-full bg-brand/15 blur-3xl" />
          <span className="relative flex size-14 items-center justify-center rounded-2xl bg-raised text-muted shadow-lg">
            <MessagesSquare className="size-7" />
            <span className="absolute -bottom-1 -end-1 flex size-6 items-center justify-center rounded-full bg-card ring-1 ring-line">
              <Lock className="size-3.5 text-muted" />
            </span>
          </span>
          <h2 className="relative text-lg font-semibold">{g.title}</h2>
          <p className="relative max-w-md text-sm text-muted">{g.text}</p>
          <Link href="/subscription" className="relative mt-1">
            <Button>{g.upgrade}</Button>
          </Link>
        </div>
        <div className="border-t border-line bg-raised/30 px-6 py-5 text-start">
          <p className="mb-3 text-xs font-medium text-muted">{g.featuresTitle}</p>
          <ul className="grid gap-2.5 sm:grid-cols-2">
            {g.features.map((f) => (
              <li key={f} className="flex items-start gap-2 text-sm text-ink-2">
                <Check className="mt-0.5 size-4 shrink-0 text-brand" />
                {f}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

export function ChatsPage() {
  const { t } = useI18n();
  const c = t.chats;
  const { account } = useAccount();
  const queryClient = useQueryClient();
  // Admins always; customers on plans that bundle `chats` (Business and up). Others get the upgrade gate.
  const allowed = account?.user?.isAdmin === true || (account ? planHasFeature(account.plan.id, 'chats') : false);

  const numbers = useQuery({
    queryKey: qk.chats.numbers,
    queryFn: ({ signal }) => api<ChatNumber[]>('/api/chats/numbers', { signal }),
    enabled: allowed,
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
  const [syncOpen, setSyncOpen] = useState(false);
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

  /** Asks the phone for older messages of one chat (the whole number syncs as a job: see SyncPanel). */
  const startSync = async (jid: string) => {
    if (!activeId || sync) return;
    if (!connected) return showToast(c.sync.offline, 'error');
    synced.current = 0;
    setSync({ scope: jid });
    try {
      const { requested } = await api<{ requested: number }>(`/api/chats/${activeId}/sync`, { method: 'POST', body: { jid } });
      // Nothing to anchor on, or no answer within 25s: say so rather than spin forever.
      settleSync(requested === 0 ? 0 : 25_000);
    } catch (err) {
      setSync(null);
      showToast(`${c.sync.failed}: ${errorMessage(err)}`, 'error');
    }
  };

  // --- notifications for incoming messages: a card + chime in the page, the browser's own when the tab is hidden ---
  const [notifyOn, setNotifyOn] = useState(() => read(NOTIFY_KEY) !== '0');
  const [notes, setNotes] = useState<InboxNote[]>([]);
  useBackgroundLiveEvents(notifyOn);
  const [permission, setPermission] = useState<NotificationPermission>(() => ('Notification' in window ? Notification.permission : 'denied'));
  const askPermission = async () => {
    if (!('Notification' in window)) return 'denied' as const;
    const result = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    setPermission(result);
    return result;
  };
  // Any click on the page unlocks audio, so the chime can play later from a background tab.
  useEffect(() => {
    const unlock = () => unlockAudio();
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
    return () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
  }, []);
  const noteSeq = useRef(0);
  const dismissNote = useCallback((key: number) => setNotes((ns) => ns.filter((n) => n.key !== key)), []);
  const openNote = (note: Pick<InboxNote, 'key' | 'sessionId' | 'jid'>) => {
    dismissNote(note.key);
    if (note.sessionId !== activeId) switchNumber(note.sessionId);
    setView('chats');
    setPendingJid(note.jid);
  };
  const toggleNotify = async () => {
    const next = !notifyOn;
    setNotifyOn(next);
    write(NOTIFY_KEY, next ? '1' : '0');
    if (!next) return showToast(c.notify.disabled);
    playPing(); // also unlocks audio, which browsers allow only after a click
    const permission = await askPermission();
    showToast(permission === 'denied' ? c.notify.blocked : c.notify.enabled, permission === 'denied' ? 'error' : 'ok');
    // A sample right away: if it doesn't appear, the OS (Windows notification settings / Focus) is hiding them.
    if (permission === 'granted') new Notification(c.notify.testTitle, { body: c.notify.testBody, icon: '/favicon.svg', tag: 'wa-test' });
  };
  /** Looks the chat up in what the list already loaded (name, picture) — no request. */
  const cachedChat = (sid: string, jid: string) => {
    for (const [, data] of queryClient.getQueriesData<InfiniteData<ChatPage>>({ queryKey: qk.chats.lists(sid) }))
      for (const page of data?.pages ?? []) {
        const hit = page.chats.find((ch) => ch.jid === jid || ch.altJid === jid);
        if (hit) return hit;
      }
    return null;
  };
  const cachedPicture = (sid: string, jid: string) => {
    for (const [, data] of queryClient.getQueriesData<Record<string, string | null>>({ queryKey: ['chats', sid, 'pictures'] })) if (data?.[jid]) return data[jid];
    return null;
  };
  const announce = (event: Extract<Parameters<Parameters<typeof useLiveEvents>[0]>[0], { type: 'messages.received' }>) => {
    const { chatJid, from, type, text, pushName } = event.data;
    const jid = chatJid ?? from;
    if (!notifyOn || type === 'reaction') return;
    const visible = document.visibilityState === 'visible';
    // Already looking at it: just a quiet chime, no card.
    if (visible && event.sessionId === activeId && view === 'chats' && isChat(selected, jid)) return playPing(0.4);
    const chat = cachedChat(event.sessionId, jid);
    const isGroup = jid.endsWith('@g.us');
    const phone = (j: string) => (j.endsWith('@s.whatsapp.net') ? `+${j.split('@')[0]}` : null);
    const title = chat?.name || (isGroup ? null : pushName) || chat?.phone || phone(jid) || jid.split('@')[0]!;
    const seq = ++noteSeq.current;
    const message: NoteMessage = { id: event.data.id, sender: isGroup ? pushName || phone(from) : null, text, type };
    const note = {
      key: seq,
      rev: seq,
      sessionId: event.sessionId,
      jid: chat?.jid ?? jid,
      title,
      picture: cachedPicture(event.sessionId, chat?.jid ?? jid),
      isGroup,
      number: list.length > 1 ? (list.find((n) => n.id === event.sessionId)?.name ?? null) : null,
    };
    if (!visible) {
      if ('Notification' in window && Notification.permission === 'granted') {
        const n = new Notification(note.number ? `${title} · ${note.number}` : title, { body: noteText(t, message), icon: note.picture ?? '/favicon.svg', tag: `${note.sessionId}:${note.jid}` });
        n.onclick = () => {
          window.focus();
          openNote(note);
          n.close();
        };
      }
    }
    // The chime plays in a background tab too (audio unlocked by an earlier click); the card waits there for the return.
    playPing();
    setNotes((ns) => pushNote(ns, note, message));
  };

  // --- live ---
  const invalidate = useMemo(() => debouncedInvalidate(queryClient, 700), [queryClient]);
  useLiveEvents((event) => {
    if (event.type === 'session.status') {
      invalidate(qk.chats.numbers);
      return;
    }
    if (event.type === 'messages.received') announce(event);
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
  // Presence (online, typing…) of the open chat and the top of the list, renewed every minute while the page shows.
  const [topJids, setTopJids] = useState<string[]>([]);
  const watched = useRef<string[]>([]);
  watched.current = [...new Set([...(watchJid ? [watchJid] : []), ...topJids])].slice(0, 40);
  const hasWatched = watched.current.length > 0;
  useEffect(() => {
    if (!activeId || !hasWatched || !connected) return;
    const watch = () =>
      document.visibilityState === 'visible' && watched.current.length > 0 && void api(`/api/chats/${activeId}/watch`, { method: 'POST', body: { jids: watched.current } }).catch(() => {});
    watch();
    const timer = setInterval(watch, WATCH_EVERY_MS);
    document.addEventListener('visibilitychange', watch);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', watch);
    };
  }, [activeId, watchJid, hasWatched, connected]);

  const profile = useQuery({
    queryKey: qk.chats.profile(activeId ?? '', watchJid ?? ''),
    queryFn: ({ signal }) => api<Profile>(`/api/chats/${activeId}/profile?${new URLSearchParams({ jid: watchJid! })}`, { signal, timeoutMs: 25_000 }),
    enabled: Boolean(activeId && watchJid),
    staleTime: 30 * 60_000,
    retry: false,
  });

  // The chat and number travel with the call: onMutate may close the chat before the request goes out.
  type FlagsBody = { pinned?: boolean; archived?: boolean; unread?: boolean };
  const flags = useMutation({
    mutationFn: ({ sessionId, chat, body }: { sessionId: string; chat: ChatSummary; body: FlagsBody }) =>
      api(`/api/chats/${sessionId}/flags`, { method: 'POST', body: { jid: chat.jid, ...body } }),
    onMutate: ({ body }) => {
      setSelected((s) => s && { ...s, ...(body.pinned !== undefined ? { pinned: body.pinned } : {}), ...(body.archived !== undefined ? { archived: body.archived } : {}) });
      if (body.unread || body.archived) setSelected(null);
    },
    onSuccess: (_, { body }) => {
      if (body.archived !== undefined) showToast(body.archived ? c.actions.archived : c.actions.unarchived);
    },
    onError: (err, { chat }) => {
      setSelected((s) => s ?? chat);
      showToast(`${c.actions.flagsFailed}: ${errorMessage(err)}`, 'error');
    },
    onSettled: (_, __, { sessionId }) => {
      void queryClient.invalidateQueries({ queryKey: qk.chats.lists(sessionId) });
      void queryClient.invalidateQueries({ queryKey: qk.chats.numbers });
    },
  });
  const setFlags = (body: FlagsBody) => activeId && selected && flags.mutate({ sessionId: activeId, chat: selected, body });

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

  if (!account) return <Loading className="py-24" />;
  if (!allowed) return <ChatsGate />;
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
              <SyncButton
                sessionId={current.id}
                onOpen={() => setSyncOpen(true)}
                render={({ onClick, running }) => (
                  <IconAction label={running ? c.syncJob.open : c.syncJob.start} onClick={onClick} active={running}>
                    <RefreshCw className={cx('size-[18px]', running && 'animate-spin [animation-duration:2s]')} />
                  </IconAction>
                )}
              />
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
              <IconAction label={notifyOn ? c.notify.on : c.notify.off} active={notifyOn} onClick={() => void toggleNotify()}>
                {notifyOn ? <Bell className="size-[18px]" /> : <BellOff className="size-[18px]" />}
              </IconAction>
            </div>
          </div>
          <NumberSwitcher numbers={list} value={current.id} onChange={switchNumber} />
          <SyncCard key={current.id} sessionId={current.id} onOpen={() => setSyncOpen(true)} />
          {notifyOn && permission === 'default' && (
            <div className="animate-fade-in flex items-center gap-2.5 rounded-xl border border-brand/20 bg-brand/[0.07] py-2 ps-3 pe-2 text-xs">
              <Bell className="size-4 shrink-0 text-brand" />
              <span className="min-w-0 flex-1 leading-snug text-ink-2">{c.notify.browserTitle}</span>
              <button
                type="button"
                onClick={() => void askPermission().then((r) => r === 'denied' && showToast(c.notify.blocked, 'error'))}
                className="shrink-0 rounded-lg bg-brand px-2.5 py-1 font-semibold text-black transition-opacity hover:opacity-90"
              >
                {c.notify.browserAllow}
              </button>
            </div>
          )}
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
            onTopChats={setTopJids}
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
              onFlags={setFlags}
              onOpenPhone={openPhone}
              onSync={() => void startSync(selected.jid)}
              syncing={sync?.scope === selected.jid}
            />
          </div>
        ) : (
          <div className="chat-wall relative flex flex-1 flex-col items-center justify-center overflow-hidden p-8 text-center">
            <div className="pointer-events-none absolute top-1/2 left-1/2 size-[28rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand/10 blur-3xl" />
            <div className="relative flex max-w-md flex-col items-center">
              {/* A tiny live conversation: incoming, outgoing (read), and someone typing. */}
              <div aria-hidden className="animate-float w-72 rounded-3xl border border-line bg-card/80 p-4 shadow-[0_30px_80px_-30px] shadow-black/80 backdrop-blur">
                <div className="flex items-center gap-2.5 border-b border-line/70 pb-3">
                  <span className="relative size-8 rounded-full bg-gradient-to-br from-sky-500 to-indigo-600">
                    <span className="absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full bg-green-500 ring-2 ring-card" />
                  </span>
                  <span className="space-y-1.5">
                    <span className="block h-2 w-20 rounded-full bg-ink/25" />
                    <span className="block h-1.5 w-12 rounded-full bg-brand/50" />
                  </span>
                </div>
                <div className="space-y-2 pt-3">
                  <div className="animate-fade-up flex" style={delay(150)}>
                    <span className="space-y-1.5 rounded-2xl rounded-ss-md bg-raised px-3 py-2.5">
                      <span className="block h-1.5 w-32 rounded-full bg-ink/20" />
                      <span className="block h-1.5 w-20 rounded-full bg-ink/20" />
                    </span>
                  </div>
                  <div className="animate-fade-up flex justify-end" style={delay(450)}>
                    <span className="flex items-end gap-1.5 rounded-2xl rounded-se-md border border-brand/20 bg-brand/15 px-3 py-2.5">
                      <span className="space-y-1.5">
                        <span className="block h-1.5 w-24 rounded-full bg-brand/40" />
                        <span className="block h-1.5 w-14 rounded-full bg-brand/40" />
                      </span>
                      <CheckCheck className="-mb-0.5 size-3.5 text-sky-400" />
                    </span>
                  </div>
                  <div className="animate-fade-up flex" style={delay(750)}>
                    <span className="rounded-2xl rounded-ss-md bg-raised px-3.5 py-3 text-muted">
                      <TypingDots />
                    </span>
                  </div>
                </div>
              </div>
              <h2 className="animate-fade-up mt-9 text-2xl font-bold tracking-tight" style={delay(200)}>
                {c.pickTitle}
              </h2>
              <p className="animate-fade-up mt-2 text-sm leading-relaxed text-muted" style={delay(300)}>
                {c.pickText}
              </p>
              <div className="animate-fade-up mt-6 flex flex-wrap items-center justify-center gap-2 text-xs text-muted" style={delay(400)}>
                {[
                  { key: '/', label: c.shortcuts.search },
                  { key: 'Esc', label: c.shortcuts.close },
                ].map((s) => (
                  <span key={s.key} className="inline-flex items-center gap-2 rounded-full border border-line bg-card/80 py-1 ps-1 pe-3 backdrop-blur">
                    <kbd className="ltr min-w-6 rounded-full border border-line-strong bg-raised px-1.5 py-0.5 text-center font-mono text-[11px] text-ink">{s.key}</kbd>
                    {s.label}
                  </span>
                ))}
              </div>
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
                onFlags={setFlags}
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

      {syncOpen && <SyncModal sessionId={current.id} connected={connected} onClose={() => setSyncOpen(false)} />}

      <NoteStack notes={notes} onOpen={openNote} onDismiss={dismissNote} />

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
