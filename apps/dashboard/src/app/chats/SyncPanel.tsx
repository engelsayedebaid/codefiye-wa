import type { SyncLogEntry, SyncLogLevel, SyncProgress } from '@wa/shared/sync';
import { isActiveSync } from '@wa/shared/sync';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, ChevronDown, CircleCheck, CircleX, Info, Loader2, Pause, Play, RefreshCw, RotateCcw, Square, X } from 'lucide-react';
import { type CSSProperties, type ReactNode, type UIEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
import { useLiveEvents } from '../../events';
import { useI18n } from '../../i18n';
import { qk } from '../../queries';
import { Button, cx, ErrorNote, flip, Modal } from '../../ui';

type SyncState = { job: SyncProgress | null; logs: SyncLogEntry[] };

/** Log lines kept in memory (the server keeps the latest 1,000 too). */
const MAX_LOGS = 1_000;
/** The log is windowed: fixed-height rows, only those in view (plus a margin) are in the DOM. */
const ROW_HEIGHT = 24;
const LOG_HEIGHT = 192;
const OVERSCAN = 8;
/** A finished sync stays on the card this long, then the card goes away by itself. */
const SHOW_FINISHED_MS = 30 * 60_000;

/**
 * The number's latest sync job and its log, kept live from `sync.progress` / `sync.log` events
 * (only this workspace's events reach this tab, see the API's SSE route).
 */
export function useSyncJob(sessionId: string) {
  const queryClient = useQueryClient();
  const key = qk.chats.syncJob(sessionId);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<SyncState>(`/api/chats/${sessionId}/sync-job`, { signal }),
  });
  useLiveEvents((event) => {
    if (event.sessionId !== sessionId) return;
    if (event.type === 'sync.progress') {
      queryClient.setQueryData<SyncState>(key, (prev) => {
        // A newer job replaces the old one (and its log); an older event never overwrites a newer state.
        if (!prev?.job || prev.job.jobId !== event.data.jobId) return { job: event.data, logs: [] };
        if (prev.job.updatedAt > event.data.updatedAt) return prev;
        return { ...prev, job: event.data };
      });
    } else if (event.type === 'sync.log') {
      const { jobId, ...entry } = event.data;
      queryClient.setQueryData<SyncState>(key, (prev) => {
        if (!prev?.job || prev.job.jobId !== jobId || prev.logs.some((l) => l.id === entry.id)) return prev;
        const logs = [...prev.logs, entry];
        return { ...prev, logs: logs.length > MAX_LOGS ? logs.slice(-MAX_LOGS) : logs };
      });
    }
  });
  return query;
}

/** Re-renders every `ms` (speed and time left move with the clock, not only with events). */
function useNow(ms: number, enabled: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms, enabled]);
  return now;
}

/**
 * Where each running job stood when this tab first saw it run (reset when it stops running): speed and
 * time left come from what happened since, so time spent queued, paused or offline doesn't skew them.
 */
const baselines = new Map<string, { at: number; processed: number; messages: number }>();
/** Measure this long, and this many conversations, before showing speed / time left. */
const MEASURE_MS = 20_000;
const MEASURE_CHATS = 2;

/** Percentage, speed (messages a minute) and time left — the last two only once there is enough to go on. */
function useStats(job: SyncProgress) {
  const running = job.status === 'running';
  const now = useNow(5_000, running);
  const processed = job.chatsDone + job.chatsFailed;
  const percent = job.status === 'completed' ? 100 : job.chatsTotal > 0 ? Math.min(99, Math.floor((processed / job.chatsTotal) * 100)) : 0;
  if (!running) baselines.delete(job.jobId);
  else if (!baselines.has(job.jobId)) baselines.set(job.jobId, { at: now, processed, messages: job.messagesAdded });
  const base = baselines.get(job.jobId);
  const elapsed = base ? (now - base.at) / 1000 : 0;
  const measured = base !== undefined && elapsed * 1000 >= MEASURE_MS;
  const speed = measured ? Math.round(((job.messagesAdded - base.messages) / elapsed) * 60) : null;
  const doneHere = base ? processed - base.processed : 0;
  const eta = measured && doneHere >= MEASURE_CHATS && job.chatsTotal > processed ? Math.round((elapsed / doneHere) * (job.chatsTotal - processed)) : null;
  return { percent, speed, eta };
}

const TONE: Record<SyncProgress['status'], { bar: string; text: string }> = {
  queued: { bar: 'bg-sky-400', text: 'text-sky-400' },
  running: { bar: 'bg-brand', text: 'text-brand' },
  paused: { bar: 'bg-amber-400', text: 'text-amber-400' },
  completed: { bar: 'bg-brand', text: 'text-brand' },
  cancelled: { bar: 'bg-ink-3', text: 'text-ink-3' },
  failed: { bar: 'bg-red-500', text: 'text-red-400' },
};

function StatusIcon({ status, className }: { status: SyncProgress['status']; className?: string }) {
  const cls = cx('size-4 shrink-0', TONE[status].text, className);
  if (status === 'running') return <RefreshCw className={cx(cls, 'animate-spin [animation-duration:2s]')} />;
  if (status === 'queued') return <Loader2 className={cx(cls, 'animate-spin')} />;
  if (status === 'paused') return <Pause className={cls} />;
  if (status === 'completed') return <CircleCheck className={cls} />;
  if (status === 'failed') return <CircleX className={cls} />;
  return <Square className={cls} />;
}

/** The animated bar: a moving sheen while the sync runs. */
function ProgressBar({ job, percent }: { job: SyncProgress; percent: number }) {
  return (
    <div className="relative h-2 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <div className={cx('h-full rounded-full transition-[width] duration-700 ease-out', TONE[job.status].bar)} style={{ width: `${Math.max(percent, job.status === 'queued' ? 0 : 2)}%` }} />
      {job.status === 'running' && <div className="sync-sheen absolute inset-y-0 start-0 w-1/3" />}
    </div>
  );
}

/**
 * The sync as a card in the chats column: status, bar, counters, the conversation in progress.
 * Clicking it opens the live log. Hidden when there's no sync, or a finished one is old or dismissed.
 */
export function SyncCard({ sessionId, onOpen }: { sessionId: string; onOpen: () => void }) {
  const { t } = useI18n();
  const s = t.chats.syncJob;
  const { data } = useSyncJob(sessionId);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const job = data?.job ?? null;
  const now = useNow(60_000, Boolean(job && !isActiveSync(job.status)));
  if (!job || dismissed === job.jobId) return null;
  if (!isActiveSync(job.status) && job.finishedAt && now - Date.parse(job.finishedAt) > SHOW_FINISHED_MS) return null;
  return <SyncCardBody job={job} onOpen={onOpen} onDismiss={isActiveSync(job.status) ? null : () => setDismissed(job.jobId)} label={s.open} />;
}

function SyncCardBody({ job, onOpen, onDismiss, label }: { job: SyncProgress; onOpen: () => void; onDismiss: (() => void) | null; label: string }) {
  const { t } = useI18n();
  const s = t.chats.syncJob;
  const { percent, eta } = useStats(job);
  return (
    <div className="animate-fade-in group relative">
      <button
        type="button"
        onClick={onOpen}
        aria-label={label}
        className="w-full cursor-pointer rounded-xl border border-line bg-card/80 px-3 py-2.5 text-start transition-colors hover:border-line-strong hover:bg-raised/50"
      >
        <div className="flex items-center gap-2">
          <StatusIcon status={job.status} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{s.title[job.status]}</span>
          <span className={cx('ltr text-[13px] font-bold tabular-nums', TONE[job.status].text)}>{percent}%</span>
          <ArrowRight className={cx('size-3.5 text-ink-3 transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5', flip)} />
        </div>
        <div className="mt-2">
          <ProgressBar job={job} percent={percent} />
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[11.5px] text-muted">
          <span className="tabular-nums">{s.chats(job.chatsDone + job.chatsFailed, job.chatsTotal)}</span>
          <span className="tabular-nums">{s.messages(job.messagesAdded)}</span>
        </div>
        {job.status === 'running' && job.current && <p className="mt-1 truncate text-[11.5px] text-ink-2">{s.now(job.current.name ?? job.current.jid.split('@')[0]!)}</p>}
        {job.status === 'paused' && job.pauseReason === 'phone_unresponsive' && <p className="mt-1 text-[11.5px] leading-snug text-amber-400">{s.phonePaused}</p>}
        {(job.chatsFailed > 0 || eta !== null) && (
          <div className="mt-1 flex items-center justify-between gap-2 text-[11.5px]">
            {job.chatsFailed > 0 ? (
              <span className="flex items-center gap-1 text-amber-400">
                <AlertTriangle className="size-3" /> {s.failed(job.chatsFailed)}
              </span>
            ) : (
              <span />
            )}
            {eta !== null && <span className="text-muted">{s.eta(s.duration(eta))}</span>}
          </div>
        )}
      </button>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={s.dismiss}
          className="absolute -top-1.5 -end-1.5 hidden size-5 cursor-pointer items-center justify-center rounded-full border border-line bg-card text-ink-3 shadow-sm group-hover:flex hover:text-ink"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

const LEVEL: Record<SyncLogLevel, { icon: typeof Info; cls: string }> = {
  info: { icon: Info, cls: 'text-sky-400' },
  progress: { icon: ArrowRight, cls: 'text-ink-2' },
  success: { icon: CircleCheck, cls: 'text-brand' },
  warning: { icon: AlertTriangle, cls: 'text-amber-400' },
  error: { icon: CircleX, cls: 'text-red-400' },
};

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour12: false });

/** One log line: time, level icon, words (also the collapsed log's preview of the newest line). */
function LogLine({ line, className, style }: { line: SyncLogEntry; className?: string; style?: CSSProperties }) {
  const { t } = useI18n();
  const { icon: Icon, cls } = LEVEL[line.level];
  const text = t.chats.syncJob.log[line.code]?.(line.params) ?? line.code;
  return (
    <div className={cx('flex items-center gap-2 px-2.5 font-mono text-[11px]', className)} style={{ height: ROW_HEIGHT, ...style }}>
      <span className="ltr shrink-0 text-ink-3 tabular-nums">{time(line.at)}</span>
      <Icon className={cx('size-3 shrink-0', cls, line.level === 'progress' && flip)} />
      <span className={cx('min-w-0 flex-1 truncate font-sans text-[12px]', line.level === 'error' ? 'text-red-300' : line.level === 'warning' ? 'text-amber-300' : 'text-ink-2')} title={text}>
        {text}
      </span>
    </div>
  );
}

/** Windowed log: stays pinned to the newest line unless the reader scrolled up. */
function LogList({ logs }: { logs: SyncLogEntry[] }) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const pinned = useRef(true);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && pinned.current) {
      el.scrollTop = el.scrollHeight;
      setScrollTop(el.scrollTop);
    }
  }, [logs.length]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_HEIGHT * 2;
    setScrollTop(el.scrollTop);
  };

  if (logs.length === 0) return <p className="border-t border-line px-2.5 py-3 text-center text-xs text-muted">{t.chats.syncJob.logEmpty}</p>;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(logs.length, Math.ceil((scrollTop + LOG_HEIGHT) / ROW_HEIGHT) + OVERSCAN);
  return (
    <div ref={box} onScroll={onScroll} className="animate-fade-in overflow-y-auto border-t border-line" style={{ maxHeight: LOG_HEIGHT }} role="log" aria-live="polite">
      <div className="relative" style={{ height: logs.length * ROW_HEIGHT }}>
        {logs.slice(first, last).map((line, i) => (
          <LogLine key={line.id} line={line} className="absolute inset-x-0" style={{ top: (first + i) * ROW_HEIGHT }} />
        ))}
      </div>
    </div>
  );
}

/** Whether the log is open, remembered per browser (a convenience: it falls back to closed). */
const LOG_OPEN_KEY = 'wa.sync.logOpen';
const readLogOpen = () => {
  try {
    return localStorage.getItem(LOG_OPEN_KEY) === '1';
  } catch {
    return false;
  }
};

/** The sync in full: counters, controls, and the live log (collapsible). Also where a sync is started from. */
export function SyncModal({ sessionId, connected, onClose }: { sessionId: string; connected: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const s = t.chats.syncJob;
  const queryClient = useQueryClient();
  const { data } = useSyncJob(sessionId);
  const job = data?.job ?? null;
  const logs = data?.logs ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(readLogOpen);
  const toggleLog = () =>
    setLogOpen((open) => {
      try {
        localStorage.setItem(LOG_OPEN_KEY, open ? '0' : '1');
      } catch {
        // private mode: just not remembered
      }
      return !open;
    });

  const act = useCallback(
    async (name: string, path: string) => {
      setBusy(name);
      setError(null);
      try {
        await api(path, { method: 'POST', body: {} });
        // Events bring the new state; this catches up if the stream was down.
        await queryClient.invalidateQueries({ queryKey: qk.chats.syncJob(sessionId) });
      } catch (err) {
        setError(`${s.failedAction}: ${errorMessage(err)}`);
      } finally {
        setBusy(null);
      }
    },
    [queryClient, sessionId, s.failedAction],
  );
  const control = (action: 'pause' | 'resume' | 'cancel' | 'retry') => job && void act(action, `/api/chats/${sessionId}/sync-job/${job.jobId}/${action}`);
  const start = () => void act('start', `/api/chats/${sessionId}/sync-job`);
  const latest = logs.at(-1);

  return (
    <Modal title={job ? s.title[job.status] : s.start} onClose={onClose} size="sm">
      {job && <SyncStats job={job} />}
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex flex-wrap items-center gap-1.5">
        {(!job || !isActiveSync(job.status)) && (
          <Button variant="brand" size="sm" className="h-7 px-2.5 text-xs" onClick={start} loading={busy === 'start'} disabled={!connected} icon={<RefreshCw className="size-3.5" />}>
            {job ? s.again : s.start}
          </Button>
        )}
        {job && (job.status === 'running' || job.status === 'queued') && (
          <Button variant="secondary" size="sm" className="h-7 px-2.5 text-xs" onClick={() => control('pause')} loading={busy === 'pause'} icon={<Pause className="size-3.5" />}>
            {s.pause}
          </Button>
        )}
        {job?.status === 'paused' && (
          <Button variant="brand" size="sm" className="h-7 px-2.5 text-xs" onClick={() => control('resume')} loading={busy === 'resume'} icon={<Play className={cx('size-3.5', flip)} />}>
            {s.resume}
          </Button>
        )}
        {job && job.chatsFailed > 0 && job.status !== 'cancelled' && (
          <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={() => control('retry')} loading={busy === 'retry'} icon={<RotateCcw className="size-3.5" />}>
            {s.retry(job.chatsFailed)}
          </Button>
        )}
        {job && isActiveSync(job.status) && (
          <Button variant="ghost" size="sm" className="ms-auto h-7 px-2 text-xs text-red-400 hover:text-red-300" onClick={() => control('cancel')} loading={busy === 'cancel'} icon={<Square className="size-3" />}>
            {s.cancel}
          </Button>
        )}
      </div>
      {job && (
        <section className="overflow-hidden rounded-lg border border-line bg-surface/50">
          <button
            type="button"
            onClick={toggleLog}
            aria-expanded={logOpen}
            className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-start text-xs font-semibold transition-colors hover:bg-raised/50"
          >
            {s.logTitle}
            <span className="font-normal text-ink-3 tabular-nums">{logs.length}</span>
            {isActiveSync(job.status) && (
              <span className="flex items-center gap-1 rounded-full bg-brand/10 px-1.5 py-px text-[10px] font-medium text-brand">
                <span className="size-1.5 animate-pulse rounded-full bg-brand" /> {s.live}
              </span>
            )}
            <ChevronDown className={cx('ms-auto size-3.5 text-ink-3 transition-transform', logOpen && 'rotate-180')} />
          </button>
          {logOpen ? <LogList logs={logs} /> : latest && <LogLine line={latest} className="border-t border-line" />}
        </section>
      )}
      <p className="line-clamp-2 text-[11px] leading-snug text-ink-3" title={s.note}>
        {s.note}
      </p>
    </Modal>
  );
}

function SyncStats({ job }: { job: SyncProgress }) {
  const { t } = useI18n();
  const s = t.chats.syncJob;
  const { percent, speed, eta } = useStats(job);
  return (
    <div className="space-y-2 rounded-lg border border-line bg-surface/50 p-3">
      <div className="flex items-center gap-2">
        <StatusIcon status={job.status} className="size-3.5" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">
          {job.status === 'running' && job.current ? s.now(job.current.name ?? job.current.jid.split('@')[0]!) : s.chats(job.chatsDone + job.chatsFailed, job.chatsTotal)}
        </span>
        <span className={cx('ltr text-lg leading-none font-bold tabular-nums', TONE[job.status].text)}>{percent}%</span>
      </div>
      <ProgressBar job={job} percent={percent} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] tabular-nums">
        {job.status === 'running' && job.current && <span className="text-muted">{s.chats(job.chatsDone + job.chatsFailed, job.chatsTotal)}</span>}
        <span className="text-muted">{s.messages(job.messagesAdded)}</span>
        <span className="flex items-center gap-1 text-brand">
          <CircleCheck className="size-3" /> {s.synced(job.chatsDone)}
        </span>
        <span className={cx('flex items-center gap-1', job.chatsFailed > 0 ? 'text-amber-400' : 'text-muted')}>
          <AlertTriangle className="size-3" /> {s.failed(job.chatsFailed)}
        </span>
        {speed !== null && <span className="text-muted">{s.speed(speed)}</span>}
        {eta !== null && <span className="text-muted">{s.eta(s.duration(eta))}</span>}
      </div>
      {job.status === 'paused' && job.pauseReason === 'phone_unresponsive' && <p className="text-[11.5px] leading-snug text-amber-400">{s.phonePaused}</p>}
    </div>
  );
}

/** The header button: opens the sync (where it's started or followed); spins while one runs. */
export function SyncButton({ sessionId, onOpen, render }: { sessionId: string; onOpen: () => void; render: (props: { onClick: () => void; running: boolean }) => ReactNode }) {
  const { data } = useSyncJob(sessionId);
  const status = data?.job?.status;
  return render({ onClick: onOpen, running: status === 'running' || status === 'queued' });
}
