import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowUpRight,
  CircleCheck,
  CircleX,
  Clock,
  Flame,
  Lightbulb,
  Loader2,
  MessageSquareWarning,
  RefreshCw,
  ShieldAlert,
  Smile,
  Sparkles,
  Tags,
  Users,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../../api';
import { useI18n } from '../../i18n';
import { qk } from '../../queries';
import { Button, cx, flip, Select } from '../../ui';
import { Avatar } from './Bubble';
import { type AnalysisJob, type AnalysisReport, type AnalysisResult, type ChatNumber, type CustomerStatus, type Mood, type NumberStats } from './model';

const PERIODS = [7, 30, 90] as const;
const ALL = '';
const STATUS_ORDER: CustomerStatus[] = ['hot', 'waiting', 'complaint', 'interested', 'done', 'cold'];
const STATUS_TONE: Record<CustomerStatus, string> = {
  hot: 'bg-good/12 text-good ring-good/25',
  interested: 'bg-info/12 text-info ring-info/25',
  waiting: 'bg-warning/12 text-warning ring-warning/25',
  complaint: 'bg-critical/12 text-critical ring-critical/25',
  done: 'bg-ink/8 text-ink-2 ring-line',
  cold: 'bg-ink/5 text-muted ring-line',
};
const MOOD_TONE: Record<Mood, string> = { positive: 'bg-good', neutral: 'bg-ink-3', negative: 'bg-critical' };
const PRIORITY_TONE = { high: 'bg-critical/12 text-critical', medium: 'bg-warning/12 text-warning', low: 'bg-ink/8 text-ink-2' };

/** While true, the AI icon opens a "coming soon" note instead of the report. */
export const AI_REPORT_SOON = true;

export function AiReportSoon({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const a = t.chats.ai;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="animate-fade-in fixed inset-0 z-[65] flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal
        aria-label={a.title}
        onClick={(e) => e.stopPropagation()}
        className="animate-scale-in relative w-full max-w-md overflow-hidden rounded-2xl border border-line bg-card px-6 pt-10 pb-6 text-center shadow-2xl"
      >
        <button type="button" onClick={onClose} className="absolute end-3 top-3 grid size-9 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-raised hover:text-ink" aria-label={t.common.close}>
          <X className="size-5" />
        </button>
        <span className="mx-auto grid size-16 place-items-center rounded-2xl bg-gradient-to-br from-grad-from to-grad-to text-on-brand shadow-lg">
          <Sparkles className="size-8" />
        </span>
        <span className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-brand/12 px-3 py-1 text-xs font-semibold text-brand">
          <Clock className="size-3.5" /> {a.soon}
        </span>
        <h2 className="mt-3 text-lg font-bold tracking-tight">{a.soonTitle}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">{a.soonText}</p>
        <Button className="mt-6 w-full" variant="brand" onClick={onClose}>
          {a.soonOk}
        </Button>
      </div>
    </div>
  );
}

/**
 * The AI analysis of the inbox (admins): pick the numbers and the period, and the server builds the
 * report — exact figures per number at once, then the AI model's reading of the conversations. The last
 * report stays on the server a few hours, so reopening shows it without paying again.
 */
export function AiReport({ numbers, onOpenChat, onClose }: { numbers: ChatNumber[]; onOpenChat: (sessionId: string, jid: string) => void; onClose: () => void }) {
  const { t, lang } = useI18n();
  const a = t.chats.ai;
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<string>(ALL);
  const [days, setDays] = useState<number>(30);
  const [jobId, setJobId] = useState<string | null>(null);

  const latest = useQuery({
    queryKey: qk.chats.analysisLatest,
    queryFn: ({ signal }) => api<AnalysisJob | null>('/api/chats/analysis/latest', { signal }),
    staleTime: 0,
  });
  const id = jobId ?? latest.data?.id ?? null;
  const job = useQuery({
    queryKey: qk.chats.analysis(id ?? ''),
    queryFn: ({ signal }) => api<AnalysisJob>(`/api/chats/analysis/${id}`, { signal }),
    enabled: Boolean(id),
    initialData: latest.data && latest.data.id === id ? latest.data : undefined,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2_500 : false),
  });
  const start = useMutation({
    mutationFn: () => api<AnalysisJob>('/api/chats/analysis', { method: 'POST', body: { days, lang, ...(scope ? { sessionIds: [scope] } : {}) } }),
    onSuccess: (next) => {
      queryClient.setQueryData(qk.chats.analysis(next.id), next);
      setJobId(next.id);
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('[role="listbox"]')) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const current = job.data ?? null;
  const running = current?.status === 'running' || start.isPending;
  const unavailable = start.error instanceof ApiRequestError && start.error.code === 'ai_unavailable';

  let body: ReactNode;
  if (unavailable) body = <Notice icon={ShieldAlert} title={a.unavailableTitle} text={a.unavailableText} />;
  else if (latest.isPending && !jobId) body = <Loading />;
  else if (!current && !start.isPending) body = <Intro onRun={() => start.mutate()} />;
  else if (current?.status === 'failed') body = <Notice icon={AlertTriangle} title={a.failed} text={current.error ?? ''} tone="error" />;
  else
    body = (
      <>
        {running && <Progress job={current} />}
        {current?.result && <ResultView result={current.result} numbers={numbers} onOpenChat={onOpenChat} />}
      </>
    );

  return (
    <div className="animate-fade-in fixed inset-0 z-[65] flex items-start justify-center bg-black/55 backdrop-blur-[2px] sm:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal
        aria-label={a.title}
        onClick={(e) => e.stopPropagation()}
        className="animate-scale-in flex h-full w-full max-w-5xl origin-top flex-col overflow-hidden border border-line bg-card shadow-2xl sm:h-[min(92svh,60rem)] sm:rounded-2xl"
      >
        <header className="flex items-start gap-3 border-b border-line p-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-grad-from to-grad-to text-on-brand shadow-sm">
            <Sparkles className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{a.title}</h2>
            <p className="text-xs text-muted">{a.subtitle}</p>
          </span>
          <button type="button" onClick={onClose} className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-raised hover:text-ink" aria-label={t.common.close}>
            <X className="size-5" />
          </button>
        </header>
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface/40 px-4 py-2.5">
          {numbers.length > 1 && (
            <Select
              value={scope}
              onChange={setScope}
              aria-label={a.numbers}
              className="w-48"
              options={[{ value: ALL, label: a.allNumbers }, ...numbers.map((n) => ({ value: n.id, label: <span className="pii">{n.name}</span> }))]}
            />
          )}
          <div role="radiogroup" aria-label={a.period} className="flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5">
            {PERIODS.map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={d === days}
                onClick={() => setDays(d)}
                className={cx('cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium transition-colors', d === days ? 'bg-card text-ink shadow-xs' : 'text-muted hover:text-ink')}
              >
                {a.days(d)}
              </button>
            ))}
          </div>
          <Button className="ms-auto" variant="brand" loading={running} disabled={running} onClick={() => start.mutate()} icon={current ? <RefreshCw className="size-4" /> : <Sparkles className="size-4" />}>
            {current ? a.rerun : a.run}
          </Button>
        </div>
        {start.isError && !unavailable && <p className="border-b border-critical/25 bg-critical/10 px-4 py-2 text-sm text-critical">{errorMessage(start.error)}</p>}
        <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
        <p className="border-t border-line px-4 py-2 text-[11px] text-faint">{a.privacyNote}</p>
      </div>
    </div>
  );
}

function Intro({ onRun }: { onRun: () => void }) {
  const { t } = useI18n();
  const a = t.chats.ai;
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span className="relative grid size-16 place-items-center rounded-2xl bg-gradient-to-br from-grad-from to-grad-to text-on-brand shadow-lg">
        <Sparkles className="size-8" />
      </span>
      <h3 className="mt-5 text-xl font-bold tracking-tight">{a.introTitle}</h3>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">{a.introText}</p>
      <Button className="mt-6" variant="brand" onClick={onRun} icon={<Sparkles className="size-4" />}>
        {a.run}
      </Button>
    </div>
  );
}

function Loading() {
  return (
    <div className="flex justify-center py-20">
      <Loader2 className="size-6 animate-spin text-muted" />
    </div>
  );
}

function Notice({ icon: Icon, title, text, tone }: { icon: typeof Sparkles; title: string; text: string; tone?: 'error' }) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <span className={cx('grid size-12 place-items-center rounded-xl', tone === 'error' ? 'bg-critical/10 text-critical' : 'bg-warning/10 text-warning')}>
        <Icon className="size-6" />
      </span>
      <h3 className="mt-4 font-semibold">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-muted">{text}</p>
    </div>
  );
}

/** While the job runs: what it is doing, and how long it has taken. */
function Progress({ job }: { job: AnalysisJob | null }) {
  const { t } = useI18n();
  const a = t.chats.ai;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const secs = job ? Math.max(0, Math.round((now - new Date(job.startedAt).getTime()) / 1000)) : 0;
  const analyzing = job?.phase === 'analyzing';
  return (
    <div className="m-4 flex items-center gap-4 rounded-xl border border-brand/25 bg-brand/[0.06] p-4">
      <span className="relative grid size-11 shrink-0 place-items-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-brand/20 motion-reduce:animate-none" />
        <Sparkles className="relative size-6 text-brand" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{analyzing ? a.analyzing(job?.result?.meta.chatsAnalyzed ?? 0) : a.collecting}</span>
        <span className="block text-xs text-muted">{a.takes}</span>
      </span>
      <span className="ltr shrink-0 font-mono text-xs text-muted tabular-nums">{a.elapsed(`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`)}</span>
    </div>
  );
}

function useDuration() {
  const { t } = useI18n();
  const d = t.chats.ai.duration;
  return (secs: number | null) => {
    if (secs === null) return '—';
    if (secs < 3600) return d.m(Math.max(1, Math.round(secs / 60)));
    if (secs < 86_400) return d.h(Math.round((secs / 3600) * 10) / 10);
    return d.d(Math.round((secs / 86_400) * 10) / 10);
  };
}

function Section({ icon: Icon, title, count, children }: { icon: typeof Sparkles; title: string; count?: number; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="size-4 text-brand" />
        {title}
        {count !== undefined && <span className="rounded-full bg-raised px-1.5 py-0.5 text-[10px] font-medium text-ink-2 tabular-nums">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

function ResultView({ result, numbers, onOpenChat }: { result: AnalysisResult; numbers: ChatNumber[]; onOpenChat: (sessionId: string, jid: string) => void }) {
  const { t, fmt } = useI18n();
  const a = t.chats.ai;
  const r = result.report;
  const nameOf = (sessionId: string) => numbers.find((n) => n.id === sessionId)?.name ?? result.stats.find((s) => s.sessionId === sessionId)?.name ?? '';
  const multi = result.stats.length > 1;
  return (
    <div className="space-y-7 p-4 sm:p-5">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span>{a.days(result.meta.days)}</span>
        <span>·</span>
        <span>{a.meta(result.meta.chatsAnalyzed, result.meta.messagesAnalyzed)}</span>
        {result.meta.generatedAt && (
          <>
            <span>·</span>
            <span>{a.generated(fmt.timeAgo(result.meta.generatedAt))}</span>
            <span>·</span>
            <span className="ltr">{result.meta.model}</span>
          </>
        )}
      </p>

      {r && (
        <section className="rounded-xl border border-brand/20 bg-gradient-to-br from-brand/[0.07] to-transparent p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="size-4 text-brand" /> {a.sections.summary}
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">{r.summary}</p>
          {r.highlights.length > 0 && (
            <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
              {r.highlights.map((h) => (
                <li key={h} className="flex items-start gap-2 text-[13px] text-ink-2">
                  <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-brand" /> {h}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {!r && result.meta.chatsAnalyzed === 0 && <p className="rounded-xl bg-raised/60 p-4 text-sm text-muted">{a.noData}</p>}

      <Section icon={Users} title={a.sections.numbers}>
        <div className="grid gap-3 md:grid-cols-2">
          {result.stats.map((s) => (
            <StatsCard key={s.sessionId} stats={s} employee={r?.employees.find((e) => result.numbers[e.ref] === s.sessionId)} />
          ))}
        </div>
      </Section>

      {r && r.customers.length > 0 && <Customers report={r} result={result} nameOf={multi ? nameOf : () => null} onOpenChat={onOpenChat} />}

      <Section icon={Clock} title={a.sections.unanswered} count={result.unanswered.length}>
        {result.unanswered.length === 0 ? (
          <p className="text-sm text-muted">{a.none}</p>
        ) : (
          <ul className="divide-y divide-line/60 overflow-hidden rounded-xl border border-line">
            {result.unanswered.map((u) => (
              <li key={`${u.sessionId}:${u.jid}`} className="flex items-center gap-3 px-3 py-2.5">
                <Avatar name={u.name ?? u.phone ?? ''} id={u.jid} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="pii truncate text-sm font-medium">{u.name ?? u.phone}</span>
                    {multi && <span className="pii shrink-0 rounded-full bg-raised px-1.5 py-0.5 text-[10px] text-ink-2">{nameOf(u.sessionId)}</span>}
                  </span>
                  <span dir="auto" className="pii block truncate text-xs text-muted">
                    {u.lastText ?? `[${u.lastType}]`}
                  </span>
                </span>
                <span className="shrink-0 text-[11px] text-warning">{a.waitingSince(fmt.timeAgo(u.since))}</span>
                <OpenButton onClick={() => onOpenChat(u.sessionId, u.jid)} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {r && (
        <div className="grid gap-7 md:grid-cols-2">
          <Section icon={Smile} title={a.sections.sentiment}>
            <Sentiment value={r.sentiment} />
          </Section>
          <Section icon={Tags} title={a.sections.topics}>
            <Topics topics={r.topics} />
          </Section>
        </div>
      )}

      {r && r.risks.length > 0 && (
        <Section icon={MessageSquareWarning} title={a.sections.risks}>
          <ul className="space-y-1.5">
            {r.risks.map((x) => (
              <li key={x} className="flex items-start gap-2 rounded-lg bg-critical/[0.06] px-3 py-2 text-[13px] text-ink-2 ring-1 ring-critical/20">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-critical" /> {x}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {r && r.recommendations.length > 0 && (
        <Section icon={Lightbulb} title={a.sections.recommendations}>
          <ol className="space-y-2">
            {[...r.recommendations]
              .sort((x, y) => ['high', 'medium', 'low'].indexOf(x.priority) - ['high', 'medium', 'low'].indexOf(y.priority))
              .map((x) => (
                <li key={x.title} className="rounded-xl border border-line p-3">
                  <span className="flex items-center gap-2">
                    <span className={cx('rounded-full px-2 py-0.5 text-[10px] font-semibold', PRIORITY_TONE[x.priority])}>{a.priority[x.priority]}</span>
                    <span className="text-sm font-medium">{x.title}</span>
                  </span>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted">{x.detail}</p>
                </li>
              ))}
          </ol>
        </Section>
      )}
    </div>
  );
}

/** One number: its exact figures, and the AI's review of the employee behind it. */
function StatsCard({ stats: s, employee }: { stats: NumberStats; employee?: AnalysisReport['employees'][number] }) {
  const { t, fmt } = useI18n();
  const a = t.chats.ai;
  const st = a.stats;
  const duration = useDuration();
  const rate = s.turns > 0 ? Math.round((s.answered / s.turns) * 100) : null;
  const sent = s.fromPhone + s.fromDashboard + s.fromApi;
  const score = employee ? Math.max(0, Math.min(100, Math.round(employee.score))) : null;
  const scoreTone = score === null ? '' : score >= 75 ? 'text-good' : score >= 50 ? 'text-warning' : 'text-critical';
  const tiles = [
    { label: st.customers, value: fmt.number.format(s.customers), sub: s.newCustomers ? `+${fmt.number.format(s.newCustomers)} ${st.newCustomers}` : undefined },
    { label: st.reply, value: duration(s.medianReplySeconds) },
    { label: st.answered, value: rate === null ? '—' : `${rate}%` },
    { label: st.waiting, value: fmt.number.format(s.waiting), warn: s.waiting > 0 },
    { label: st.inbound, value: fmt.number.format(s.inbound) },
    { label: st.outbound, value: fmt.number.format(s.outbound) },
  ];
  return (
    <article className="rounded-xl border border-line bg-surface/40 p-3.5">
      <header className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="pii block truncate text-sm font-semibold">{s.name}</span>
          <span className="pii ltr block truncate font-mono text-[11px] text-muted">{s.phone ?? '—'}</span>
        </span>
        {score !== null && (
          <span className="relative grid size-12 shrink-0 place-items-center">
            <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90">
              <circle cx="18" cy="18" r="15.5" fill="none" className="stroke-line" strokeWidth="3" />
              <circle cx="18" cy="18" r="15.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${(score / 100) * 97.4} 97.4`} className={scoreTone} />
            </svg>
            <span className={cx('text-sm font-bold tabular-nums', scoreTone)}>{score}</span>
          </span>
        )}
      </header>
      {employee && <p className="mt-2 text-[13px] font-medium text-ink">{employee.verdict}</p>}
      <dl className="mt-3 grid grid-cols-3 gap-1.5">
        {tiles.map((x) => (
          <div key={x.label} className="rounded-lg bg-raised/60 px-2 py-1.5">
            <dt className="truncate text-[10.5px] text-muted">{x.label}</dt>
            <dd className={cx('text-sm font-semibold tabular-nums', x.warn && 'text-warning')}>{x.value}</dd>
            {x.sub && <dd className="text-[10px] text-good">{x.sub}</dd>}
          </div>
        ))}
      </dl>
      {sent > 0 && (
        <div className="mt-3">
          <div className="flex h-1.5 overflow-hidden rounded-full bg-raised">
            <span className="bg-brand" style={{ width: `${(s.fromPhone / sent) * 100}%` }} />
            <span className="bg-info" style={{ width: `${(s.fromDashboard / sent) * 100}%` }} />
            <span className="bg-progress" style={{ width: `${(s.fromApi / sent) * 100}%` }} />
          </div>
          <p className="mt-1.5 flex flex-wrap gap-x-3 text-[10.5px] text-muted">
            <Legend tone="bg-brand" label={`${st.fromPhone} ${fmt.number.format(s.fromPhone)}`} />
            <Legend tone="bg-info" label={`${st.fromDashboard} ${fmt.number.format(s.fromDashboard)}`} />
            <Legend tone="bg-progress" label={`${st.fromApi} ${fmt.number.format(s.fromApi)}`} />
            {s.campaign > 0 && <span>{`${st.campaign} ${fmt.number.format(s.campaign)}`}</span>}
            {s.groups > 0 && <span>{`${st.groups} ${fmt.number.format(s.groups)}`}</span>}
          </p>
        </div>
      )}
      {employee && (
        <div className="mt-3 space-y-2 border-t border-line/70 pt-3 text-[12.5px]">
          {employee.strengths.length > 0 && <Points icon={CircleCheck} tone="text-good" title={a.strengths} items={employee.strengths} />}
          {employee.weaknesses.length > 0 && <Points icon={CircleX} tone="text-critical" title={a.weaknesses} items={employee.weaknesses} />}
          {employee.tone && (
            <p className="text-muted">
              <span className="font-medium text-ink-2">{a.tone}: </span>
              {employee.tone}
            </p>
          )}
          {employee.examples.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer text-xs font-medium text-brand">{a.examples}</summary>
              <ul className="mt-1.5 list-disc space-y-1 ps-5 text-muted">
                {employee.examples.map((x) => (
                  <li key={x} className="pii">
                    {x}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </article>
  );
}

function Legend({ tone, label }: { tone: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={cx('size-2 rounded-full', tone)} /> {label}
    </span>
  );
}

function Points({ icon: Icon, tone, title, items }: { icon: typeof Sparkles; tone: string; title: string; items: string[] }) {
  return (
    <div>
      <p className="font-medium text-ink-2">{title}</p>
      <ul className="mt-1 space-y-0.5">
        {items.map((x) => (
          <li key={x} className="flex items-start gap-1.5 text-muted">
            <Icon className={cx('mt-0.5 size-3.5 shrink-0', tone)} /> {x}
          </li>
        ))}
      </ul>
    </div>
  );
}

function OpenButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-brand transition-colors hover:bg-brand/10"
      title={t.chats.ai.openChat}
    >
      <span className="hidden sm:inline">{t.chats.ai.openChat}</span>
      <ArrowUpRight className={cx('size-3.5', flip)} />
    </button>
  );
}

/** The customers the AI read, by status: the hottest and the waiting first. */
function Customers({ report, result, nameOf, onOpenChat }: { report: AnalysisReport; result: AnalysisResult; nameOf: (sessionId: string) => string | null; onOpenChat: (sessionId: string, jid: string) => void }) {
  const { t } = useI18n();
  const a = t.chats.ai;
  const [filter, setFilter] = useState<CustomerStatus | 'all'>('all');
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, report.customers.filter((c) => c.status === s).length])) as Record<CustomerStatus, number>;
  const shown = report.customers
    .filter((c) => filter === 'all' || c.status === filter)
    .sort((x, y) => STATUS_ORDER.indexOf(x.status) - STATUS_ORDER.indexOf(y.status));
  return (
    <Section icon={Flame} title={a.sections.customers} count={report.customers.length}>
      <div className="flex flex-wrap gap-1.5">
        {(['all', ...STATUS_ORDER] as const).map((s) =>
          s !== 'all' && counts[s] === 0 ? null : (
            <button
              key={s}
              type="button"
              onClick={() => setFilter(s)}
              className={cx(
                'cursor-pointer rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                filter === s ? 'border-brand/40 bg-brand/10 text-brand' : 'border-line text-muted hover:text-ink',
              )}
            >
              {s === 'all' ? a.all : a.status[s]} <span className="tabular-nums opacity-70">{s === 'all' ? report.customers.length : counts[s]}</span>
            </button>
          ),
        )}
      </div>
      <ul className="grid gap-2 lg:grid-cols-2">
        {shown.map((c) => {
          const chat = result.chats[c.ref]!;
          const title = chat.name ?? chat.phone ?? chat.jid.split('@')[0]!;
          const number = nameOf(chat.sessionId);
          return (
            <li key={c.ref} className="flex flex-col rounded-xl border border-line p-3">
              <div className="flex items-center gap-2.5">
                <Avatar name={title} id={chat.jid} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className={cx('size-2 shrink-0 rounded-full', MOOD_TONE[c.mood])} title={a.mood[c.mood]} />
                    <span className="pii truncate text-sm font-medium">{title}</span>
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] text-muted">
                    {chat.phone && chat.name && <span className="pii ltr font-mono">{chat.phone}</span>}
                    {number && <span className="pii rounded-full bg-raised px-1.5 py-0.5 text-[10px] text-ink-2">{number}</span>}
                  </span>
                </span>
                <span className={cx('shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ring-1', STATUS_TONE[c.status])}>{a.status[c.status]}</span>
              </div>
              <p className="pii mt-2 text-[13px] leading-relaxed text-ink-2">{c.summary}</p>
              <dl className="mt-2 space-y-1 text-[12.5px]">
                <div className="flex gap-1.5">
                  <dt className="shrink-0 font-medium text-ink-2">{a.need}:</dt>
                  <dd className="pii text-muted">{c.need}</dd>
                </div>
                <div className="flex gap-1.5 rounded-lg bg-brand/[0.06] px-2 py-1">
                  <dt className="shrink-0 font-medium text-brand">{a.next}:</dt>
                  <dd className="pii text-ink-2">{c.nextAction}</dd>
                </div>
              </dl>
              <div className="mt-auto flex justify-end pt-2">
                <OpenButton onClick={() => onOpenChat(chat.sessionId, chat.jid)} />
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function Sentiment({ value }: { value: Record<Mood, number> }) {
  const { t } = useI18n();
  const a = t.chats.ai;
  const total = value.positive + value.neutral + value.negative || 1;
  const moods: Mood[] = ['positive', 'neutral', 'negative'];
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-raised">
        {moods.map((m) => (
          <span key={m} className={MOOD_TONE[m]} style={{ width: `${(value[m] / total) * 100}%` }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 text-xs text-muted">
        {moods.map((m) => (
          <Legend key={m} tone={MOOD_TONE[m]} label={`${a.mood[m]} ${Math.round((value[m] / total) * 100)}%`} />
        ))}
      </div>
    </div>
  );
}

function Topics({ topics }: { topics: AnalysisReport['topics'] }) {
  const max = Math.max(1, ...topics.map((x) => x.count));
  return (
    <ul className="space-y-2">
      {[...topics]
        .sort((x, y) => y.count - x.count)
        .slice(0, 8)
        .map((x) => (
          <li key={x.topic} title={x.note}>
            <div className="flex items-center justify-between gap-2 text-[13px]">
              <span className="truncate text-ink-2">{x.topic}</span>
              <span className="shrink-0 text-xs text-muted tabular-nums">{x.count}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised">
              <span className="block h-full rounded-full bg-brand/70" style={{ width: `${(x.count / max) * 100}%` }} />
            </div>
          </li>
        ))}
    </ul>
  );
}
