import type { ChatFilter } from '@wa/shared/chats';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, WifiOff, X } from 'lucide-react';
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
import { useLiveEvents } from '../../events';
import { useI18n } from '../../i18n';
import { debouncedInvalidate, qk } from '../../queries';
import { Link } from '../../router';
import { cx } from '../../ui';
import { ChatList } from './ChatList';
import { ContactPanel } from './ContactPanel';
import { Conversation } from './Conversation';
import { type ChatInfo, type ChatNumber, type ChatSummary, isChat, placeholderChat, type PresenceState, type Profile } from './model';
import { NumberSwitcher } from './NumberSwitcher';

const PANES_KEY = 'wa.chats.accountPanes';
const WATCH_EVERY_MS = 60_000;

/** A chat to open in a column (a notification clicked): the column showing that number, else a new one. */
export type OpenRequest = { sessionId: string; jid: string; seq: number; /** Words to search in it (from the search across all chats). */ q?: string };
/** The chats open in the columns right now, by column — a message there only chimes, as on the page. */
export type OpenChats = Map<number, { sessionId: string; chat: ChatSummary }>;

type Pane = { key: number; sessionId: string; pendingJid: string | null; pendingQ?: string };
type FlagsBody = { pinned?: boolean; archived?: boolean; unread?: boolean };
type Toast = (text: string, tone?: 'ok' | 'error') => void;

function loadPanes(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(PANES_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}
function savePanes(ids: string[]) {
  try {
    localStorage.setItem(PANES_KEY, JSON.stringify(ids));
  } catch {
    // private mode: just not remembered
  }
}

/**
 * Split accounts (focus mode `accounts`): several numbers side by side, as many as wanted, each column
 * a small inbox of its own — number, chats list, the open conversation. Columns share the width and
 * scroll sideways once they no longer fit (one per screen on a phone). The numbers shown are remembered.
 */
export function AccountsSplit({
  numbers,
  initial,
  receipts,
  request,
  openChats,
  onToast,
  onOpenIn,
}: {
  numbers: ChatNumber[];
  initial: string;
  receipts: boolean;
  request: OpenRequest | null;
  openChats: OpenChats;
  onToast: Toast;
  /** Open a chat of a number (sent or forwarded through it): its column, else a new one. */
  onOpenIn: (sessionId: string, jid: string) => void;
}) {
  const { t } = useI18n();
  const f = t.chats.focus;
  const seq = useRef(0);
  const [panes, setPanes] = useState<Pane[]>(() => {
    const known = new Set(numbers.map((n) => n.id));
    const stored = loadPanes().filter((id) => known.has(id));
    // First time: the open number and the next connected one.
    const start = stored.length > 0 ? stored : [initial, ...numbers.filter((n) => n.id !== initial && n.status === 'connected').slice(0, 1).map((n) => n.id)];
    return start.map((sessionId) => ({ key: ++seq.current, sessionId, pendingJid: null }));
  });
  useEffect(() => savePanes(panes.map((p) => p.sessionId)), [panes]);

  // A number removed meanwhile: its column goes (the open number takes over if none is left).
  useEffect(() => {
    const known = new Set(numbers.map((n) => n.id));
    setPanes((ps) => {
      const kept = ps.filter((p) => known.has(p.sessionId));
      if (kept.length === ps.length) return ps;
      return kept.length > 0 ? kept : [{ key: ++seq.current, sessionId: initial, pendingJid: null }];
    });
  }, [numbers, initial]);

  useEffect(() => {
    if (!request) return;
    const key = ++seq.current;
    setPanes((ps) => {
      const at = ps.findIndex((p) => p.sessionId === request.sessionId);
      if (at >= 0) return ps.map((p, i) => (i === at ? { ...p, pendingJid: request.jid, pendingQ: request.q } : p));
      return [...ps, { key, sessionId: request.sessionId, pendingJid: request.jid, pendingQ: request.q }];
    });
  }, [request]);

  const update = (key: number, patch: Partial<Pane>) => setPanes((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const add = () => {
    const shown = new Set(panes.map((p) => p.sessionId));
    const next = numbers.find((n) => !shown.has(n.id) && n.status === 'connected') ?? numbers.find((n) => !shown.has(n.id)) ?? numbers.find((n) => n.id === initial) ?? numbers[0];
    if (next) setPanes((ps) => [...ps, { key: ++seq.current, sessionId: next.id, pendingJid: null }]);
  };

  // A column just added comes into view (it may start past the edge).
  const scroller = useRef<HTMLDivElement>(null);
  const count = useRef(panes.length);
  useEffect(() => {
    const grew = panes.length > count.current;
    count.current = panes.length;
    if (grew) scroller.current?.querySelector('[data-pane]:last-of-type')?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [panes.length]);

  const byId = new Map(numbers.map((n) => [n.id, n]));
  const visible = panes.filter((p) => byId.has(p.sessionId));

  return (
    <div ref={scroller} className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden bg-card md:snap-none">
      {visible.map((p) => (
        <AccountPane
          // A new number in the column starts it afresh (its chat, search and presence belong to the old one).
          key={`${p.key}:${p.sessionId}`}
          paneKey={p.key}
          numbers={numbers}
          number={byId.get(p.sessionId)!}
          pendingJid={p.pendingJid}
          pendingQ={p.pendingQ}
          receipts={receipts}
          openChats={openChats}
          onSession={(sessionId) => update(p.key, { sessionId, pendingJid: null })}
          onPendingDone={() => update(p.key, { pendingJid: null, pendingQ: undefined })}
          onClose={visible.length > 1 ? () => setPanes((ps) => ps.filter((x) => x.key !== p.key)) : undefined}
          onToast={onToast}
          onOpenIn={onOpenIn}
        />
      ))}
      <button
        type="button"
        onClick={add}
        title={f.addAccount}
        className="group flex w-14 shrink-0 snap-end cursor-pointer flex-col items-center gap-2 bg-surface/40 pt-3 text-muted transition-colors hover:bg-raised hover:text-ink"
      >
        <span className="grid size-9 place-items-center rounded-xl border border-dashed border-line-strong transition-colors group-hover:border-brand/50 group-hover:bg-brand/10 group-hover:text-brand">
          <Plus className="size-[18px]" />
        </span>
        <span className="text-[11px] font-medium [writing-mode:vertical-rl]">{f.addAccount}</span>
      </button>
    </div>
  );
}

/** One column: one number's chats list, and the conversation picked from it (the list comes back on close). */
function AccountPane({
  paneKey,
  numbers,
  number,
  pendingJid,
  pendingQ,
  receipts,
  openChats,
  onSession,
  onPendingDone,
  onClose,
  onToast,
  onOpenIn,
}: {
  paneKey: number;
  numbers: ChatNumber[];
  number: ChatNumber;
  pendingJid: string | null;
  pendingQ?: string;
  receipts: boolean;
  openChats: OpenChats;
  onSession: (sessionId: string) => void;
  onPendingDone: () => void;
  onClose?: () => void;
  onToast: Toast;
  onOpenIn: (sessionId: string, jid: string) => void;
}) {
  const { t } = useI18n();
  const c = t.chats;
  const queryClient = useQueryClient();
  const sessionId = number.id;
  const connected = number.status === 'connected';
  const [selected, setSelected] = useState<ChatSummary | null>(null);
  const [filter, setFilter] = useState<ChatFilter>('all');
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  const [infoOpen, setInfoOpen] = useState(false);
  const [presence, setPresence] = useState(() => new Map<string, PresenceState>());
  const [topJids, setTopJids] = useState<string[]>([]);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setTerm(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!selected) return;
    openChats.set(paneKey, { sessionId, chat: selected });
    return () => void openChats.delete(paneKey);
  }, [openChats, paneKey, sessionId, selected]);

  const open = (chat: ChatSummary) => {
    setSelected(chat);
    setInfoOpen(false);
  };
  const close = () => {
    setSelected(null);
    setInfoOpen(false);
  };

  // Opening a chat by JID (notification, contact card): load its row.
  const openJid = useCallback(
    async (jid: string) => {
      try {
        const info = await queryClient.fetchQuery({
          queryKey: qk.chats.chat(sessionId, jid),
          queryFn: ({ signal }) => api<ChatInfo>(`/api/chats/${sessionId}/chat?${new URLSearchParams({ jid })}`, { signal }),
        });
        setSelected(info.chat ?? placeholderChat(jid));
        setInfoOpen(false);
      } catch {
        // not found / offline: stay on the list
      }
    },
    [sessionId, queryClient],
  );
  const [chatSearch, setChatSearch] = useState<{ jid: string; q: string; seq: number } | null>(null);
  const pendingDone = useEffectEvent((jid: string) => {
    setChatSearch(pendingQ ? { jid, q: pendingQ, seq: Date.now() } : null);
    onPendingDone();
  });
  useEffect(() => {
    if (!pendingJid) return;
    pendingDone(pendingJid);
    void openJid(pendingJid);
  }, [pendingJid, openJid]);

  // --- older messages from the phone (the answer arrives in batches) ---
  const [syncing, setSyncing] = useState<string | null>(null);
  const synced = useRef(0);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleSync = (after: number) => {
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      setSyncing(null);
      onToast(synced.current > 0 ? c.sync.done(synced.current) : c.sync.waiting);
    }, after);
  };
  useEffect(() => () => void (syncTimer.current && clearTimeout(syncTimer.current)), []);
  const startSync = async (jid: string) => {
    if (syncing) return;
    if (!connected) return onToast(c.sync.offline, 'error');
    synced.current = 0;
    setSyncing(jid);
    try {
      const { requested } = await api<{ requested: number }>(`/api/chats/${sessionId}/sync`, { method: 'POST', body: { jid } });
      settleSync(requested === 0 ? 0 : 25_000);
    } catch (err) {
      setSyncing(null);
      onToast(`${c.sync.failed}: ${errorMessage(err)}`, 'error');
    }
  };

  // --- live: this number's events only (the page keeps the numbers list fresh) ---
  const invalidate = useMemo(() => debouncedInvalidate(queryClient, 700), [queryClient]);
  useLiveEvents((event) => {
    if (event.sessionId !== sessionId) return;
    switch (event.type) {
      case 'messages.received':
      case 'messages.created':
      case 'messages.update':
        invalidate(qk.chats.lists(sessionId));
        if (event.type === 'messages.received' && event.data.chatJid) {
          const jid = event.data.chatJid;
          if (isChat(selected, jid)) invalidate(qk.chats.chat(sessionId, selected!.jid));
          // A message ends "typing…".
          setPresence((prev) => {
            const p = prev.get(jid);
            if (!p || (p.presence !== 'composing' && p.presence !== 'recording')) return prev;
            return new Map(prev).set(jid, { ...p, presence: 'available', at: Date.now() });
          });
        }
        break;
      case 'chats.synced':
        invalidate(qk.chats.lists(sessionId));
        if (syncing) {
          synced.current += event.data.added;
          settleSync(3_000);
        }
        break;
      case 'message.changed':
        invalidate(qk.chats.lists(sessionId));
        break;
      case 'chat.read':
        invalidate(qk.chats.lists(sessionId));
        if (isChat(selected, event.data.chatJid)) setSelected((s) => s && { ...s, unread: 0 });
        break;
      case 'presence.update': {
        const { chatJid, jid, presence: state, lastSeen } = event.data;
        setPresence((prev) => {
          const old = prev.get(chatJid);
          return new Map(prev).set(chatJid, { presence: state === 'paused' ? 'available' : state, jid, lastSeen: lastSeen ?? old?.lastSeen ?? null, at: Date.now() });
        });
        break;
      }
    }
  });

  // Presence of the open chat and the top of the list, renewed every minute while the page shows.
  const watchJid = selected?.jid ?? null;
  const watched = useRef<string[]>([]);
  watched.current = [...new Set([...(watchJid ? [watchJid] : []), ...topJids])].slice(0, 40);
  const hasWatched = watched.current.length > 0;
  useEffect(() => {
    if (!hasWatched || !connected) return;
    const watch = () =>
      document.visibilityState === 'visible' && watched.current.length > 0 && void api(`/api/chats/${sessionId}/watch`, { method: 'POST', body: { jids: watched.current } }).catch(() => {});
    watch();
    const timer = setInterval(watch, WATCH_EVERY_MS);
    document.addEventListener('visibilitychange', watch);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', watch);
    };
  }, [sessionId, watchJid, hasWatched, connected]);

  const profile = useQuery({
    queryKey: qk.chats.profile(sessionId, watchJid ?? ''),
    queryFn: ({ signal }) => api<Profile>(`/api/chats/${sessionId}/profile?${new URLSearchParams({ jid: watchJid! })}`, { signal, timeoutMs: 25_000 }),
    enabled: Boolean(watchJid),
    staleTime: 30 * 60_000,
    retry: false,
  });

  /** Pin / archive / unread (archiving or marking unread closes the chat, as on the page). */
  const setFlags = async (body: FlagsBody) => {
    const chat = selected;
    if (!chat) return;
    setSelected((s) => s && { ...s, ...(body.pinned !== undefined ? { pinned: body.pinned } : {}), ...(body.archived !== undefined ? { archived: body.archived } : {}) });
    if (body.unread || body.archived) close();
    try {
      await api(`/api/chats/${sessionId}/flags`, { method: 'POST', body: { jid: chat.jid, ...body } });
      if (body.archived !== undefined) onToast(body.archived ? c.actions.archived : c.actions.unarchived);
    } catch (err) {
      setSelected((s) => s ?? chat);
      onToast(`${c.actions.flagsFailed}: ${errorMessage(err)}`, 'error');
    } finally {
      void queryClient.invalidateQueries({ queryKey: qk.chats.lists(sessionId) });
      void queryClient.invalidateQueries({ queryKey: qk.chats.numbers });
    }
  };

  const selectedPresence = selected ? (presence.get(selected.jid) ?? (selected.altJid ? presence.get(selected.altJid) : undefined)) : undefined;

  return (
    <section data-pane className="animate-fade-in relative flex min-w-[min(100%,21rem)] flex-1 basis-0 snap-start flex-col border-e border-line">
      <div className="flex shrink-0 items-center gap-1 border-b border-line bg-surface/40 p-2">
        <div className="min-w-0 flex-1">
          <NumberSwitcher numbers={numbers} value={sessionId} onChange={(id) => id !== sessionId && onSession(id)} compact />
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={c.focus.removeAccount}
            title={c.focus.removeAccount}
            className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-critical/10 hover:text-critical"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      {!connected && (
        <Link href={`/sessions/${sessionId}`} className="flex shrink-0 items-center gap-2 bg-warning/10 px-3 py-1.5 text-xs text-warning transition-colors hover:bg-warning/15">
          <WifiOff className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{c.offlineNumber}</span>
        </Link>
      )}
      <div className="relative flex min-h-0 flex-1">
        {/* The list stays mounted under an open chat: its scroll, pages and presence survive the round trip. */}
        <div className={cx('min-h-0 min-w-0 flex-1 bg-surface/40', selected && 'hidden')}>
          <ChatList
            ref={search}
            sessionId={sessionId}
            selected={selected?.jid ?? null}
            filter={filter}
            query={query}
            term={term}
            presence={presence}
            onFilter={setFilter}
            onQuery={setQuery}
            onTopChats={setTopJids}
            onSelect={open}
          />
        </div>
        {selected && (
          <div className="min-w-0 flex-1">
            <Conversation
              key={selected.jid}
              sessionId={sessionId}
              connected={connected}
              chat={selected}
              presence={selectedPresence}
              picture={profile.data?.pictureUrl ?? null}
              receipts={receipts}
              infoOpen={infoOpen}
              onBack={close}
              onToggleInfo={() => setInfoOpen((o) => !o)}
              onFlags={(body) => void setFlags(body)}
              onOpenPhone={(phone) => void openJid(`${phone.replace(/\D/g, '')}@s.whatsapp.net`)}
              onSync={() => void startSync(selected.jid)}
              syncing={syncing === selected.jid}
              search={chatSearch && isChat(selected, chatSearch.jid) ? chatSearch : undefined}
              onOpenIn={onOpenIn}
            />
          </div>
        )}
        {selected && infoOpen && (
          <>
            <div className="animate-fade-in absolute inset-0 z-20 bg-black/40" onClick={() => setInfoOpen(false)} />
            <aside className="animate-drawer-in absolute inset-y-0 end-0 z-30 w-80 max-w-[90%] border-s border-line bg-card shadow-2xl">
              <ContactPanel
                key={selected.jid}
                sessionId={sessionId}
                chat={selected}
                presence={selectedPresence}
                picture={profile.data?.pictureUrl ?? null}
                about={profile.data?.about ?? null}
                onClose={() => setInfoOpen(false)}
                onFlags={(body) => void setFlags(body)}
              />
            </aside>
          </>
        )}
      </div>
    </section>
  );
}
