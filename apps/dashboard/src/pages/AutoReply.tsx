import { AI_PROVIDERS, type AiProviderId } from '@wa/shared/ai';
import { type AutoReplyRule, type AutoReplySettings, SUMMARY_IDLE_MINUTES } from '@wa/shared/auto-reply';
import type { SessionStatus } from '@wa/shared/constants';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  Building2,
  CalendarCheck,
  Check,
  CheckCircle2,
  ClipboardList,
  Clock,
  Cpu,
  FlaskConical,
  Gauge,
  KeyRound,
  LifeBuoy,
  MessageSquareText,
  MinusCircle,
  PenLine,
  Plug,
  Plus,
  RotateCcw,
  ShoppingBag,
  Sparkles,
  Timer,
  Trash2,
  X,
  XCircle,
  Zap,
} from '../icons';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../api';
import { useI18n } from '../i18n';
import { qk } from '../queries';
import {
  Badge,
  Button,
  Card,
  cx,
  delay,
  EmptyState,
  ErrorNote,
  Field,
  flip,
  inputClass,
  Loading,
  LoadError,
  PageHeader,
  Select,
  SESSION_STATUS,
  SessionStatusBadge,
  StatusIcon,
  SuccessNote,
  TextArea,
  type Tone,
} from '../ui';
import { Kpi } from './AdminActivity';

/**
 * The AI auto-reply agent (admins only): each number gets its own personality, provider and rules;
 * the providers themselves are set up once. The activity and the statistics show what it answered.
 */

type Provider = {
  id: AiProviderId;
  enabled: boolean;
  hasKey: boolean;
  keyHint: string | null;
  keyCount: number;
  activeKeyCount: number;
  baseUrl: string | null;
  model: string | null;
  needsKey: boolean;
  defaultModel: string;
  models: string[];
};

type ProviderKey = {
  id: string;
  providerId: AiProviderId;
  label: string;
  keyHint: string | null;
  enabled: boolean;
  priority: number;
  model: string | null;
  baseUrl: string | null;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  lastError: string | null;
  cooldownUntil: string | null;
  circuitState: 'closed' | 'open' | 'half-open';
  consecutiveFailures: number;
};

type NumberRow = {
  sessionId: string;
  name: string;
  phone: string | null;
  status: string;
  enabled: boolean;
  settings: AutoReplySettings;
};

type LogEntry = {
  id: number;
  sessionId: string;
  sessionName: string | null;
  chatJid: string;
  provider: string;
  model: string;
  language: 'ar' | 'en';
  reply: string;
  status: 'sent' | 'failed' | 'skipped';
  reason: string | null;
  latencyMs: number | null;
  createdAt: string;
};

type Stats = {
  perDay: { day: string; sent: number; failed: number; skipped: number }[];
  byProvider: { provider: string; count: number }[];
  byLanguage: { language: string; count: number }[];
  perNumber: { sessionId: string; name: string; sent: number; failed: number; avgLatencyMs: number | null }[];
  totals: { sent: number; failed: number; skipped: number; avgLatencyMs: number | null };
};

type Tab = 'numbers' | 'providers' | 'activity' | 'stats';
type Section = 'persona' | 'model' | 'timing' | 'rules' | 'business' | 'summary';

type Summary = { id: number; chatJid: string; status: 'pending' | 'sent' | 'failed'; summary: string; createdAt: string };
type Personality = AutoReplySettings['personality'];

const TABS: { id: Tab; icon: typeof Bot }[] = [
  { id: 'numbers', icon: Bot },
  { id: 'providers', icon: Plug },
  { id: 'activity', icon: Activity },
  { id: 'stats', icon: Gauge },
];

const SECTIONS: { id: Section; icon: typeof Bot }[] = [
  { id: 'persona', icon: Sparkles },
  { id: 'model', icon: Cpu },
  { id: 'timing', icon: Clock },
  { id: 'rules', icon: MessageSquareText },
  { id: 'business', icon: Building2 },
  { id: 'summary', icon: ClipboardList },
];

const PERSONAS: { id: Personality; icon: typeof Bot }[] = [
  { id: 'sales', icon: ShoppingBag },
  { id: 'support', icon: LifeBuoy },
  { id: 'booking', icon: CalendarCheck },
  { id: 'custom', icon: PenLine },
];

/** The placeholders a custom prompt may use (filled from the business info). */
const PROMPT_VARIABLES = ['business_name', 'services', 'pricing', 'website', 'phone'];

const TIMEZONES = [
  'Africa/Cairo',
  'Asia/Riyadh',
  'Asia/Dubai',
  'Asia/Kuwait',
  'Asia/Qatar',
  'Asia/Amman',
  'Asia/Baghdad',
  'Africa/Casablanca',
  'Africa/Tunis',
  'Africa/Algiers',
  'Europe/Istanbul',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'UTC',
];

const HOURS = Array.from({ length: 24 }, (_, h) => h);

/** Milliseconds as seconds, at most one decimal ("1.5"). */
const toSeconds = (ms: number) => (ms / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 });

/** A provider that can answer: on, and holding an enabled key when it needs one. */
const providerReady = (p: Provider | undefined) => Boolean(p?.enabled && (!p.needsKey || p.activeKeyCount > 0));

/** The settings compared field by field, ignoring the on/off switch (it saves on its own). */
const sameSettings = (x: AutoReplySettings, y: AutoReplySettings) => JSON.stringify({ ...x, enabled: false }) === JSON.stringify({ ...y, enabled: false });

function useProviders() {
  return useQuery({ queryKey: qk.autoReply.providers, queryFn: ({ signal }) => api<{ providers: Provider[] }>('/api/auto-reply/providers', { signal }) });
}

function useNumbers() {
  return useQuery({ queryKey: qk.autoReply.numbers, queryFn: ({ signal }) => api<{ numbers: NumberRow[] }>('/api/auto-reply/settings', { signal }) });
}

function useStats(days: number) {
  return useQuery({ queryKey: qk.autoReply.stats(days), queryFn: ({ signal }) => api<Stats>(`/api/auto-reply/stats?days=${days}`, { signal }) });
}

/** Turns one number's agent on or off right away (the rest of its settings are left as they are). */
function useToggleNumber() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, enabled }: { sessionId: string; enabled: boolean }) =>
      api(`/api/auto-reply/settings/${sessionId}`, { method: 'PUT', body: { enabled } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.autoReply.numbers }),
  });
}

// --- small pieces ----------------------------------------------------------------------------------

function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-brand' : 'bg-line-strong',
      )}
    >
      <span
        className={cx(
          'inline-block size-5 rounded-full bg-white shadow transition-transform duration-200',
          checked ? 'translate-x-5.5 rtl:-translate-x-5.5' : 'translate-x-0.5 rtl:-translate-x-0.5',
        )}
      />
    </button>
  );
}

function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="code-scroll inline-flex max-w-full gap-0.5 overflow-x-auto rounded-lg border border-line bg-card p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
            value === o.value ? 'bg-raised text-ink shadow-xs' : 'text-muted hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A card title with its icon in a tinted square. */
function Titled({ icon: Icon, children }: { icon: typeof Bot; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/12 text-brand">
        <Icon className="size-4" />
      </span>
      {children}
    </span>
  );
}

/** A label and a hint above any control that isn't a plain input. */
function Labeled({ label, hint, aside, children }: { label: string; hint?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <span className="flex items-center justify-between gap-2 text-sm leading-none font-medium">
        {label}
        {aside}
      </span>
      {children}
      {hint && <span className="text-sm text-muted">{hint}</span>}
    </div>
  );
}

function Warning({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div role="alert" className="animate-fade-up flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
      <AlertTriangle className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

/** Words typed one by one (Enter or a comma adds one), shown as removable chips. */
function ChipInput({
  label,
  hint,
  values,
  onChange,
  placeholder,
  dir,
  removeLabel,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  dir?: 'ltr' | 'auto';
  removeLabel: (value: string) => string;
}) {
  const [text, setText] = useState('');
  const add = (raw: string) => {
    const parts = raw.split(/[,،\n]/).map((p) => p.trim()).filter(Boolean);
    const next = [...values];
    for (const part of parts) if (!next.includes(part)) next.push(part);
    if (next.length !== values.length) onChange(next);
    setText('');
  };
  return (
    <Labeled label={label} hint={hint}>
      <div className={cx(inputClass, 'flex h-auto min-h-9 flex-wrap items-center gap-1.5 py-1.5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50')}>
        {values.map((value) => (
          <span key={value} className="animate-fade-up inline-flex items-center gap-1 rounded-md bg-raised py-0.5 ps-2 pe-1 text-sm">
            <bdi dir={dir === 'ltr' ? 'ltr' : undefined}>{value}</bdi>
            <button
              type="button"
              onClick={() => onChange(values.filter((v) => v !== value))}
              aria-label={removeLabel(value)}
              className="rounded-sm p-0.5 text-muted transition-colors hover:bg-line hover:text-ink"
            >
              <X className="size-3.5" />
            </button>
          </span>
        ))}
        <input
          value={text}
          dir={dir}
          placeholder={values.length ? undefined : placeholder}
          onChange={(e) => (/[,،\n]/.test(e.target.value) ? add(e.target.value) : setText(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(text);
            } else if (e.key === 'Backspace' && !text && values.length) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={() => text.trim() && add(text)}
          className="h-6 min-w-28 flex-1 bg-transparent text-base outline-none placeholder:text-muted md:text-sm"
        />
      </div>
    </Labeled>
  );
}

/** The number's initial in a rounded square, with its connection dot. */
function NumberAvatar({ name, status, on, large }: { name: string; status: string; on: boolean; large?: boolean }) {
  const tone: Tone = status in SESSION_STATUS ? SESSION_STATUS[status as SessionStatus].tone : 'neutral';
  return (
    <span
      className={cx(
        'relative flex shrink-0 items-center justify-center rounded-xl font-semibold',
        large ? 'size-12 text-lg' : 'size-9 text-sm',
        on ? 'bg-brand/15 text-brand' : 'bg-raised text-muted',
      )}
    >
      {(name.trim()[0] ?? '#').toUpperCase()}
      <span className={cx('absolute -end-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-card', tone === 'good' ? 'bg-good' : tone === 'critical' ? 'bg-critical' : tone === 'neutral' ? 'bg-muted' : 'bg-warning')} />
    </span>
  );
}

// --- overview --------------------------------------------------------------------------------------

/** What the agent is doing at a glance, and why it may be silent. */
function Overview({ onOpenProviders }: { onOpenProviders: () => void }) {
  const { t, fmt } = useI18n();
  const a = t.autoReply;
  const numbers = useNumbers();
  const providers = useProviders();
  const stats = useStats(7);
  const rows = numbers.data?.numbers ?? [];
  const list = providers.data?.providers ?? [];
  const on = rows.filter((r) => r.enabled);
  const totals = stats.data?.totals;
  const decided = (totals?.sent ?? 0) + (totals?.failed ?? 0);

  // Numbers whose provider can't answer, grouped by provider.
  const broken = new Map<AiProviderId, string[]>();
  if (providers.isSuccess) {
    for (const row of on) {
      if (providerReady(list.find((p) => p.id === row.settings.providerId))) continue;
      broken.set(row.settings.providerId, [...(broken.get(row.settings.providerId) ?? []), row.name]);
    }
  }
  const noneReady = providers.isSuccess && !list.some(providerReady);
  const open = (
    <Button size="sm" variant="outline" onClick={onOpenProviders} icon={<Plug className="size-4" />}>
      {a.overview.openProviders}
    </Button>
  );

  return (
    <div className="space-y-3">
      {noneReady && on.length > 0 ? (
        <Warning action={open}>{a.overview.noProvider}</Warning>
      ) : (
        [...broken].map(([provider, names]) => (
          <Warning key={provider} action={open}>
            {a.overview.providerOff(names.join('، '), a.providers.names[provider])}
          </Warning>
        ))
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={Bot} label={a.overview.activeNumbers} value={numbers.isSuccess ? a.overview.activeOf(on.length, rows.length) : '—'} tone="good" index={0} live={on.length > 0} />
        <Kpi icon={MessageSquareText} label={a.overview.replies} value={totals ? fmt.number.format(totals.sent) : '—'} tone="info" index={1} />
        <Kpi icon={CheckCircle2} label={a.overview.successRate} value={decided ? `${Math.round(((totals?.sent ?? 0) / decided) * 100)}%` : '—'} tone="progress" index={2} />
        <Kpi
          icon={Timer}
          label={a.overview.avgTime}
          value={totals?.avgLatencyMs == null ? '—' : a.activity.seconds(toSeconds(totals.avgLatencyMs))}
          tone="warning"
          index={3}
        />
      </div>
    </div>
  );
}

// --- numbers ---------------------------------------------------------------------------------------

/** The list of numbers on the side (each with its own switch); the settings of the picked one beside it. */
function NumbersTab({ onOpenProviders }: { onOpenProviders: () => void }) {
  const { t } = useI18n();
  const a = t.autoReply;
  const numbers = useNumbers();
  const toggle = useToggleNumber();
  const rows = numbers.data?.numbers ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const current = rows.find((r) => r.sessionId === picked) ?? rows[0] ?? null;

  if (numbers.isError) return <LoadError error={numbers.error} onRetry={() => void numbers.refetch()} retrying={numbers.isFetching} />;
  if (numbers.isLoading) return <Loading />;
  if (rows.length === 0) return <EmptyState icon={Bot} title={a.numbers.empty} text={a.numbers.emptyHint} />;

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="rounded-xl border border-line bg-card p-2 shadow-sm lg:sticky lg:top-4">
        <p className="px-2 pt-1 pb-2 text-xs font-medium text-muted">{a.numbers.title}</p>
        <ul className="space-y-1">
          {rows.map((row, i) => {
            const selected = current?.sessionId === row.sessionId;
            return (
              <li
                key={row.sessionId}
                style={delay(i * 40)}
                className={cx('animate-fade-up flex items-center gap-2 rounded-lg pe-2 transition-colors', selected ? 'bg-brand/10 ring-1 ring-brand/30' : 'hover:bg-raised')}
              >
                <button
                  type="button"
                  onClick={() => setPicked(row.sessionId)}
                  aria-current={selected ? 'true' : undefined}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-2 text-start outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <NumberAvatar name={row.name} status={row.status} on={row.enabled} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{row.name}</span>
                    <span className="ltr block truncate font-mono text-xs text-muted">{row.phone ?? '—'}</span>
                  </span>
                </button>
                <Switch
                  checked={row.enabled}
                  onChange={(enabled) => toggle.mutate({ sessionId: row.sessionId, enabled })}
                  disabled={toggle.isPending && toggle.variables?.sessionId === row.sessionId}
                  label={`${a.numbers.enabled}: ${row.name}`}
                />
              </li>
            );
          })}
        </ul>
        {toggle.isError && <div className="p-2"><ErrorNote>{errorMessage(toggle.error)}</ErrorNote></div>}
      </aside>
      {current && <NumberSettings key={current.sessionId} row={current} onOpenProviders={onOpenProviders} />}
    </div>
  );
}

/** One number's settings, a section at a time; changes are saved together from the bar at the bottom. */
function NumberSettings({ row, onOpenProviders }: { row: NumberRow; onOpenProviders: () => void }) {
  const { t } = useI18n();
  const a = t.autoReply;
  const queryClient = useQueryClient();
  const toggle = useToggleNumber();
  const [section, setSection] = useState<Section>('persona');
  const [base, setBase] = useState<AutoReplySettings>(row.settings);
  const [draft, setDraft] = useState<AutoReplySettings>(row.settings);
  const serverKey = JSON.stringify(row.settings);

  // A refetch (another tab, the switch) must not wipe what is being edited: only an untouched draft follows the server.
  useEffect(() => {
    setDraft((d) => (sameSettings(d, base) ? row.settings : { ...d, enabled: row.settings.enabled }));
    setBase(row.settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);

  const dirty = !sameSettings(draft, base);
  const save = useMutation({
    mutationFn: () => api<{ settings: AutoReplySettings }>(`/api/auto-reply/settings/${row.sessionId}`, { method: 'PUT', body: { ...draft, enabled: row.enabled } }),
    onSuccess: () => {
      setBase(draft);
      void queryClient.invalidateQueries({ queryKey: qk.autoReply.numbers });
    },
  });
  const patch = (part: Partial<AutoReplySettings>) => {
    save.reset();
    setDraft((d) => ({ ...d, ...part }));
  };

  return (
    <div className="min-w-0 space-y-5">
      <section className="card-premium hero-glow relative flex flex-wrap items-center gap-4 overflow-hidden rounded-xl p-5">
        <NumberAvatar name={row.name} status={row.status} on={row.enabled} large />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{row.name}</h2>
            {row.status in SESSION_STATUS && <SessionStatusBadge status={row.status as SessionStatus} />}
          </div>
          <p className="ltr mt-1 font-mono text-sm text-muted">{row.phone ?? '—'}</p>
        </div>
        <div className="flex items-center gap-3 rounded-lg border border-line bg-bg/60 px-3 py-2">
          <span className="text-sm">
            <span className={cx('block font-medium', row.enabled ? 'text-brand' : 'text-ink')}>{row.enabled ? a.numbers.agentOn : a.numbers.agentOff}</span>
            {!row.enabled && <span className="block text-xs text-muted">{a.numbers.agentHint}</span>}
          </span>
          <Switch checked={row.enabled} onChange={(enabled) => toggle.mutate({ sessionId: row.sessionId, enabled })} disabled={toggle.isPending} label={a.numbers.enabled} />
        </div>
      </section>
      {toggle.isError && <ErrorNote>{errorMessage(toggle.error)}</ErrorNote>}

      <Segmented
        label={row.name}
        value={section}
        onChange={setSection}
        options={SECTIONS.map(({ id, icon: Icon }) => ({
          value: id,
          label: (
            <>
              <Icon className="size-4" />
              {a.sections[id]}
            </>
          ),
        }))}
      />

      <div key={section} className="animate-fade-up">
        {section === 'persona' && <PersonaSection draft={draft} patch={patch} />}
        {section === 'model' && <ModelSection draft={draft} patch={patch} onOpenProviders={onOpenProviders} />}
        {section === 'timing' && <TimingSection draft={draft} patch={patch} />}
        {section === 'rules' && <RulesSection rules={draft.rules} onChange={(rules) => patch({ rules })} />}
        {section === 'business' && <BusinessSection draft={draft} patch={patch} />}
        {section === 'summary' && <SummarySection sessionId={row.sessionId} draft={draft} patch={patch} />}
      </div>

      {save.isSuccess && !dirty && <SuccessNote>{a.saved}</SuccessNote>}
      {dirty && (
        <div className="animate-fade-up sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-card/95 px-4 py-3 shadow-lg backdrop-blur">
          <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
            <span className="size-2 shrink-0 animate-pulse rounded-full bg-warning" />
            {a.unsaved}
          </span>
          {save.isError && <span className="w-full text-sm text-critical sm:order-last">{errorMessage(save.error)}</span>}
          <Button variant="ghost" onClick={() => setDraft({ ...base, enabled: row.enabled })} disabled={save.isPending}>
            {a.discard}
          </Button>
          <Button variant="brand" loading={save.isPending} onClick={() => save.mutate()} icon={<Check className="size-4" />}>
            {a.save}
          </Button>
        </div>
      )}
    </div>
  );
}

type SectionProps = { draft: AutoReplySettings; patch: (part: Partial<AutoReplySettings>) => void };

function PersonaSection({ draft, patch }: SectionProps) {
  const { t } = useI18n();
  const a = t.autoReply;
  const insert = (name: string) => {
    const token = `{{${name}}}`;
    const text = draft.systemPrompt;
    patch({ systemPrompt: text && !/\s$/.test(text) ? `${text} ${token}` : `${text}${token}` });
  };
  return (
    <Card title={<Titled icon={Sparkles}>{a.agent.title}</Titled>} description={a.agent.description}>
      <div className="space-y-6">
        <div role="radiogroup" aria-label={a.agent.personality} className="grid gap-3 sm:grid-cols-2">
          {PERSONAS.map(({ id, icon: Icon }, i) => {
            const on = draft.personality === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => patch({ personality: id })}
                style={delay(i * 40)}
                className={cx(
                  'animate-fade-up lift flex items-start gap-3 rounded-xl border p-4 text-start transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  on ? 'border-brand/50 bg-brand/10' : 'border-line hover:bg-raised',
                )}
              >
                <span className={cx('flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors', on ? 'bg-brand text-on-brand' : 'bg-raised text-muted')}>
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{a.personalities[id]}</span>
                  <span className="mt-1 block text-sm text-muted">{a.personalityHints[id]}</span>
                </span>
                {on && <Check className="size-4 shrink-0 text-brand" />}
              </button>
            );
          })}
        </div>

        {draft.personality === 'custom' && (
          <div className="animate-fade-up space-y-2">
            <TextArea label={a.agent.prompt} rows={10} value={draft.systemPrompt} onChange={(e) => patch({ systemPrompt: e.target.value })} placeholder={a.agent.promptPlaceholder} dir="auto" />
            <div className="flex flex-wrap items-center gap-1.5">
              {PROMPT_VARIABLES.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => insert(name)}
                  className="ltr rounded-md border border-line bg-raised/50 px-2 py-0.5 font-mono text-xs text-ink-2 transition-colors hover:border-brand/40 hover:text-ink"
                >
                  {`{{${name}}}`}
                </button>
              ))}
            </div>
            <p className="text-sm text-muted">{a.agent.promptHint}</p>
          </div>
        )}

        <Labeled label={a.agent.language}>
          <Segmented
            label={a.agent.language}
            value={draft.language}
            onChange={(language) => patch({ language })}
            options={[
              { value: 'auto', label: a.agent.languageAuto },
              { value: 'ar', label: 'العربية' },
              { value: 'en', label: 'English' },
            ]}
          />
        </Labeled>
      </div>
    </Card>
  );
}

function ModelSection({ draft, patch, onOpenProviders }: SectionProps & { onOpenProviders: () => void }) {
  const { t } = useI18n();
  const a = t.autoReply;
  const providers = useProviders();
  const list = providers.data?.providers ?? [];
  const ids = list.length ? list.map((p) => p.id) : (Object.keys(AI_PROVIDERS) as AiProviderId[]);

  const providerOptions = ids.map((id) => {
    const p = list.find((x) => x.id === id);
    const ready = providerReady(p);
    return {
      value: id,
      label: (
        <span className="flex items-center gap-2">
          <span className={cx('size-1.5 shrink-0 rounded-full', ready ? 'bg-good' : 'bg-muted')} />
          {a.providers.names[id]}
          {p && <span className="text-xs text-muted">{ready ? a.model.providerReady : p.enabled ? a.model.providerNoKey : a.model.providerOff}</span>}
        </span>
      ),
    };
  });
  const models = (id: AiProviderId | null) => (id ? [...new Set([...AI_PROVIDERS[id].models, ...(list.find((p) => p.id === id)?.models ?? [])])] : []);
  const selected = list.find((p) => p.id === draft.providerId);
  const warn = providers.isSuccess && !providerReady(selected);

  return (
    <Card title={<Titled icon={Cpu}>{a.model.title}</Titled>} description={a.model.description}>
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2">
          <Select label={a.model.provider} value={draft.providerId} onChange={(providerId) => patch({ providerId, model: '' })} options={providerOptions} />
          <Field
            label={a.model.model}
            value={draft.model}
            onChange={(e) => patch({ model: e.target.value })}
            placeholder={selected?.model || AI_PROVIDERS[draft.providerId].defaultModel || 'model-name'}
            list="auto-reply-models"
            hint={a.model.modelHint}
            dir="ltr"
          />
          <datalist id="auto-reply-models">
            {models(draft.providerId).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
        {warn && (
          <Warning
            action={
              <Button size="sm" variant="outline" onClick={onOpenProviders}>
                {a.overview.openProviders}
              </Button>
            }
          >
            {a.model.providerWarning}
          </Warning>
        )}

        <div className="grid gap-4 border-t border-line pt-6 md:grid-cols-2">
          <Select
            label={a.model.fallback}
            value={draft.fallbackProviderId ?? ''}
            onChange={(v) => patch({ fallbackProviderId: v === '' ? null : v, fallbackModel: '' })}
            options={[{ value: '' as const, label: a.model.noFallback }, ...providerOptions.filter((o) => o.value !== draft.providerId)]}
          />
          <Field
            label={a.model.fallbackModel}
            value={draft.fallbackModel}
            onChange={(e) => patch({ fallbackModel: e.target.value })}
            placeholder={a.model.sameModel}
            list="auto-reply-fallback-models"
            dir="ltr"
            disabled={!draft.fallbackProviderId}
          />
          <datalist id="auto-reply-fallback-models">
            {models(draft.fallbackProviderId).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>

        <div className="grid gap-4 border-t border-line pt-6 md:grid-cols-2">
          <Labeled label={a.model.temperature} aside={<span className="ltr font-mono text-sm text-muted tabular-nums">{draft.temperature.toFixed(1)}</span>}>
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={draft.temperature}
              onChange={(e) => patch({ temperature: Number(e.target.value) })}
              aria-label={a.model.temperature}
              className="mt-1 w-full cursor-pointer accent-brand"
            />
            <span className="flex justify-between text-xs text-faint">
              <span>{a.model.precise}</span>
              <span>{a.model.creative}</span>
            </span>
          </Labeled>
          <Field
            label={a.model.maxTokens}
            type="number"
            min={64}
            max={32000}
            step={64}
            value={draft.maxTokens}
            onChange={(e) => patch({ maxTokens: Number(e.target.value) })}
            hint={a.model.maxTokensHint}
            dir="ltr"
          />
        </div>
      </div>
    </Card>
  );
}

function TimingSection({ draft, patch }: SectionProps) {
  const { t, fmt } = useI18n();
  const a = t.autoReply;
  const hours = HOURS.map((h) => ({ value: String(h), label: fmt.hour(h) }));
  const zones = TIMEZONES.includes(draft.timezone) ? TIMEZONES : [draft.timezone, ...TIMEZONES];
  return (
    <Card title={<Titled icon={Clock}>{a.rules.title}</Titled>} description={a.rules.description}>
      <div className="space-y-6">
        <Labeled label={a.rules.delay} hint={a.rules.delayHint}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={a.rules.delayMin}
              type="number"
              min={0}
              max={600}
              step={0.5}
              value={toSeconds(draft.delayMinMs)}
              onChange={(e) => patch({ delayMinMs: Math.round(Number(e.target.value) * 1000) })}
              dir="ltr"
            />
            <Field
              label={a.rules.delayMax}
              type="number"
              min={0}
              max={600}
              step={0.5}
              value={toSeconds(draft.delayMaxMs)}
              onChange={(e) => patch({ delayMaxMs: Math.round(Number(e.target.value) * 1000) })}
              dir="ltr"
            />
          </div>
        </Labeled>

        <div className="space-y-4 rounded-xl border border-line p-4">
          <div className="flex items-center justify-between gap-3">
            <span>
              <span className="block text-sm font-medium">{a.rules.hours}</span>
              <span className="mt-1 block text-sm text-muted">{a.rules.hoursHint}</span>
            </span>
            <Switch checked={draft.businessHoursOnly} onChange={(businessHoursOnly) => patch({ businessHoursOnly })} label={a.rules.hours} />
          </div>
          {draft.businessHoursOnly && (
            <div className="animate-fade-up grid gap-4 sm:grid-cols-3">
              <Select label={a.rules.hoursFrom} value={String(draft.hoursStart)} onChange={(v) => patch({ hoursStart: Number(v) })} options={hours} />
              <Select label={a.rules.hoursTo} value={String(draft.hoursEnd)} onChange={(v) => patch({ hoursEnd: Number(v) })} options={hours} />
              <Select
                label={a.rules.timezone}
                value={draft.timezone}
                onChange={(timezone) => patch({ timezone })}
                options={zones.map((z) => ({ value: z, label: <span className="ltr">{z}</span> }))}
              />
            </div>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Field
            label={a.rules.maxReplies}
            type="number"
            min={0}
            max={100}
            value={draft.maxReplies}
            onChange={(e) => patch({ maxReplies: Number(e.target.value) })}
            hint={a.rules.maxRepliesHint}
            dir="ltr"
          />
          <ChipInput
            label={a.rules.ignore}
            hint={draft.ignoreList.length ? a.rules.ignoreHint : `${a.rules.ignoreEmpty} ${a.rules.ignoreHint}`}
            values={draft.ignoreList}
            onChange={(ignoreList) => patch({ ignoreList })}
            placeholder="+201012345678"
            dir="ltr"
            removeLabel={a.rules.ignoreRemove}
          />
        </div>
      </div>
    </Card>
  );
}

/** The canned answers: a word (or a few) and what the agent says when it sees one. */
function RulesSection({ rules, onChange }: { rules: AutoReplyRule[]; onChange: (rules: AutoReplyRule[]) => void }) {
  const { t } = useI18n();
  const a = t.autoReply;
  const update = (index: number, part: Partial<AutoReplyRule>) => onChange(rules.map((r, i) => (i === index ? { ...r, ...part } : r)));
  const add = (
    <Button size="sm" variant="outline" icon={<Plus className="size-4" />} onClick={() => onChange([...rules, { id: `r${Date.now()}`, keywords: [], reply: '', match: 'contains' }])}>
      {a.rules.keywordAdd}
    </Button>
  );
  return (
    <Card title={<Titled icon={MessageSquareText}>{a.rules.keywords}</Titled>} description={a.rules.keywordsDescription} actions={rules.length > 0 && add}>
      {rules.length === 0 ? (
        <EmptyState icon={Zap} title={a.rules.keywordsEmpty} action={add} />
      ) : (
        <ol className="space-y-3">
          {rules.map((rule, i) => (
            <li key={rule.id} className="animate-fade-up space-y-4 rounded-xl border border-line bg-raised/20 p-4">
              <div className="flex items-start gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/12 text-xs font-semibold text-brand tabular-nums">{i + 1}</span>
                <div className="grid min-w-0 flex-1 gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
                  <ChipInput
                    label={a.rules.keywordWords}
                    hint={a.rules.keywordWordsHint}
                    values={rule.keywords}
                    onChange={(keywords) => update(i, { keywords })}
                    placeholder="price, السعر"
                    dir="auto"
                    removeLabel={a.rules.ignoreRemove}
                  />
                  <Labeled label={a.rules.keywordMatch}>
                    <Segmented
                      label={a.rules.keywordMatch}
                      value={rule.match}
                      onChange={(match) => update(i, { match })}
                      options={[
                        { value: 'contains', label: a.rules.matchContains },
                        { value: 'exact', label: a.rules.matchExact },
                      ]}
                    />
                  </Labeled>
                </div>
                <Button variant="ghost" size="sm" onClick={() => onChange(rules.filter((_, j) => j !== i))} aria-label={a.rules.keywordRemove} title={a.rules.keywordRemove}>
                  <Trash2 className="size-4 text-destructive-ink" />
                </Button>
              </div>
              <div className="ps-9">
                <TextArea label={a.rules.keywordReply} rows={3} value={rule.reply} onChange={(e) => update(i, { reply: e.target.value })} dir="auto" />
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function BusinessSection({ draft, patch }: SectionProps) {
  const { t } = useI18n();
  const a = t.autoReply;
  const set = (part: Partial<AutoReplySettings['variables']>) => patch({ variables: { ...draft.variables, ...part } });
  return (
    <Card title={<Titled icon={Building2}>{a.business.title}</Titled>} description={a.business.description}>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label={a.business.businessName} value={draft.variables.businessName} onChange={(e) => set({ businessName: e.target.value })} />
        <Field label={a.business.website} value={draft.variables.website} onChange={(e) => set({ website: e.target.value })} dir="ltr" />
        <Field label={a.business.phone} value={draft.variables.phone} onChange={(e) => set({ phone: e.target.value })} dir="ltr" />
        <div className="md:col-span-3">
          <TextArea label={a.business.services} rows={4} value={draft.variables.services} onChange={(e) => set({ services: e.target.value })} dir="auto" />
        </div>
        <div className="md:col-span-3">
          <TextArea label={a.business.pricing} rows={3} value={draft.variables.pricing} onChange={(e) => set({ pricing: e.target.value })} dir="auto" />
        </div>
      </div>
    </Card>
  );
}

const SUMMARY_TONES: Record<Summary['status'], Tone> = { pending: 'neutral', sent: 'good', failed: 'critical' };

/** Where the conversation summaries go, after how long, what they look like, and the last ones sent. */
function SummarySection({ sessionId, draft, patch }: SectionProps & { sessionId: string }) {
  const { t, fmt } = useI18n();
  const a = t.autoReply;
  const s = a.summary;
  const summaries = useQuery({
    queryKey: [...qk.autoReply.all, 'summaries', sessionId],
    queryFn: ({ signal }) => api<{ summaries: Summary[] }>(`/api/auto-reply/summaries?sessionId=${sessionId}`, { signal }),
    refetchInterval: 60_000,
  });
  const minutes = [...new Set([...SUMMARY_IDLE_MINUTES, draft.summaryIdleMinutes])].sort((x, y) => x - y);
  const list = summaries.data?.summaries ?? [];

  return (
    <div className="space-y-5">
      <Card title={<Titled icon={ClipboardList}>{s.title}</Titled>} description={s.description}>
        <div className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label={s.phone}
              value={draft.summaryPhone}
              onChange={(e) => patch({ summaryPhone: e.target.value })}
              placeholder="+201012345678"
              hint={s.phoneHint}
              inputMode="tel"
              dir="ltr"
            />
            <Select
              label={s.idle}
              value={String(draft.summaryIdleMinutes)}
              onChange={(v) => patch({ summaryIdleMinutes: Number(v) })}
              options={minutes.map((m) => ({ value: String(m), label: s.minutes(m) }))}
            />
          </div>
          <p className={cx('flex items-center gap-2 text-sm', draft.summaryPhone.trim() ? 'text-good' : 'text-muted')}>
            <span className={cx('size-2 shrink-0 rounded-full', draft.summaryPhone.trim() ? 'bg-good' : 'bg-muted')} />
            {draft.summaryPhone.trim() ? s.on(draft.summaryPhone.trim()) : s.off}
          </p>
          <div className="space-y-2">
            <p className="text-sm font-medium">{s.preview}</p>
            <p dir="auto" className="max-w-md rounded-xl rounded-ss-sm border border-line bg-raised/40 px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
              {s.sample}
            </p>
          </div>
        </div>
      </Card>

      <Card title={s.recent}>
        {summaries.isLoading ? (
          <Loading />
        ) : summaries.isError ? (
          <ErrorNote>{errorMessage(summaries.error)}</ErrorNote>
        ) : list.length === 0 ? (
          <p className="text-sm text-muted">{s.recentEmpty}</p>
        ) : (
          <ul className="space-y-2">
            {list.map((item) => (
              <li key={item.id} className="rounded-xl border border-line">
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm">
                    <Badge tone={SUMMARY_TONES[item.status]}>{s.statuses[item.status]}</Badge>
                    <span dir="auto" className="min-w-0 flex-1 truncate text-muted">
                      {item.summary.split('\n')[1] ?? item.chatJid}
                    </span>
                    <span className="shrink-0 text-xs text-faint" title={fmt.dateTime(item.createdAt)}>
                      {fmt.timeAgo(item.createdAt)}
                    </span>
                  </summary>
                  {item.summary && (
                    <p dir="auto" className="border-t border-line px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
                      {item.summary}
                    </p>
                  )}
                </details>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// --- providers -------------------------------------------------------------------------------------

function ProvidersTab() {
  const { t } = useI18n();
  const a = t.autoReply;
  const queryClient = useQueryClient();
  const providers = useProviders();
  if (providers.isError) return <LoadError error={providers.error} onRetry={() => void providers.refetch()} retrying={providers.isFetching} />;
  if (providers.isLoading) return <Loading />;
  // Working providers first, then the ones half set up, then the rest.
  const rank = (p: Provider) => (providerReady(p) ? 0 : p.enabled || p.keyCount > 0 ? 1 : 2);
  const list = [...(providers.data?.providers ?? [])].sort((x, y) => rank(x) - rank(y));
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted">{a.providers.description}</p>
      <div className="grid items-start gap-4 xl:grid-cols-2">
        {list.map((provider, i) => (
          <ProviderCard key={provider.id} provider={provider} index={i} onSaved={() => void queryClient.invalidateQueries({ queryKey: qk.autoReply.providers })} />
        ))}
      </div>
    </div>
  );
}

function ProviderCard({ provider, index, onSaved }: { provider: Provider; index: number; onSaved: () => void }) {
  const { t } = useI18n();
  const a = t.autoReply;
  const queryClient = useQueryClient();
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '');
  const [model, setModel] = useState(provider.model ?? '');
  const [tested, setTested] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const ready = providerReady(provider);
  const keys = useQuery({
    queryKey: qk.autoReply.providerKeys(provider.id),
    queryFn: ({ signal }) => api<{ keys: ProviderKey[] }>(`/api/auto-reply/providers/${provider.id}/keys`, { signal }),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.autoReply.providerKeys(provider.id) });
    onSaved();
  };

  const changed = model !== (provider.model ?? '') || (provider.id === 'custom' && baseUrl !== (provider.baseUrl ?? ''));
  const enable = useMutation({
    mutationFn: (enabled: boolean) => api(`/api/auto-reply/providers/${provider.id}`, { method: 'PUT', body: { enabled } }),
    onSuccess: onSaved,
  });
  const save = useMutation({
    mutationFn: () =>
      api(`/api/auto-reply/providers/${provider.id}`, {
        method: 'PUT',
        body: { model, ...(provider.id === 'custom' ? { baseUrl: baseUrl || null } : {}) },
      }),
    onSuccess: () => {
      setTested(null);
      onSaved();
    },
  });
  const test = useMutation({
    mutationFn: () => api<{ ok: boolean; model: string; reply: string }>(`/api/auto-reply/providers/${provider.id}/test`, { method: 'POST', body: { model: model || undefined } }),
    onMutate: () => setTested(null),
    onSuccess: (data) => setTested(`${data.reply} · ${data.model}`),
  });

  const name = a.providers.names[provider.id];
  const status: { tone: Tone; label: string } = ready
    ? { tone: 'good', label: a.on }
    : provider.enabled
      ? { tone: 'warning', label: a.providers.needsKey }
      : { tone: 'neutral', label: a.off };

  return (
    <section
      style={delay(index * 50)}
      className={cx('animate-fade-up flex min-w-0 flex-col gap-5 rounded-xl border bg-card p-5 shadow-sm', ready ? 'border-brand/35' : 'border-line')}
    >
      <header className="flex items-center gap-3">
        <span className={cx('flex size-11 shrink-0 items-center justify-center rounded-xl text-lg font-semibold', ready ? 'bg-brand/15 text-brand' : 'bg-raised text-muted')}>
          {name[0]}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{name}</h3>
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted">
            {provider.needsKey
              ? a.providers.keysSummary.replace('{{active}}', String(provider.activeKeyCount)).replace('{{total}}', String(provider.keyCount))
              : a.providers.noKeyNeeded}
          </p>
        </div>
        <Switch checked={provider.enabled} onChange={(v) => enable.mutate(v)} disabled={enable.isPending} label={`${a.providers.enable}: ${name}`} />
      </header>
      {enable.isError && <ErrorNote>{errorMessage(enable.error)}</ErrorNote>}

      <div className="space-y-3">
        <div className={cx('grid gap-3', provider.id === 'custom' && 'sm:grid-cols-2')}>
          {provider.id === 'custom' && (
            <Field label={a.providers.baseUrl} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434/v1" dir="ltr" />
          )}
          <Field
            label={a.providers.model}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={provider.defaultModel || 'model-name'}
            list={`models-${provider.id}`}
            dir="ltr"
          />
          <datalist id={`models-${provider.id}`}>
            {provider.models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {changed && (
            <Button size="sm" variant="brand" loading={save.isPending} onClick={() => save.mutate()}>
              {a.providers.save}
            </Button>
          )}
          <Button size="sm" variant="outline" loading={test.isPending} onClick={() => test.mutate()} icon={<FlaskConical className="size-4" />} disabled={!provider.enabled}>
            {a.providers.test}
          </Button>
          {tested && (
            <span className="flex min-w-0 items-center gap-1.5 text-sm text-good">
              <CheckCircle2 className="size-4 shrink-0" />
              <span className="truncate">
                {a.providers.testOk}: {tested}
              </span>
            </span>
          )}
        </div>
        {test.isError && <ErrorNote>{errorMessage(test.error)}</ErrorNote>}
        {save.isError && <ErrorNote>{errorMessage(save.error)}</ErrorNote>}
      </div>

      {provider.needsKey && (
        <div className="space-y-3 border-t border-line pt-5">
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-brand" />
            <h4 className="text-sm font-semibold">{a.providers.keysTitle}</h4>
            {!adding && (
              <Button size="sm" variant="ghost" className="ms-auto" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
                {a.providers.addKey}
              </Button>
            )}
          </div>
          {adding && (
            <AddKeyForm
              providerId={provider.id}
              onDone={() => {
                setAdding(false);
                refresh();
              }}
              onCancel={() => setAdding(false)}
            />
          )}
          {keys.isLoading && <Loading />}
          {keys.isError && <ErrorNote>{errorMessage(keys.error)}</ErrorNote>}
          {keys.isSuccess && keys.data.keys.length === 0 && !adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-line p-4 text-sm text-muted transition-colors hover:border-brand/40 hover:text-ink"
            >
              <Plus className="size-4" />
              {a.providers.keysEmpty} {a.providers.addKey}
            </button>
          )}
          <ul className="space-y-2">
            {(keys.data?.keys ?? []).map((item) => (
              <KeyRow key={item.id} providerId={provider.id} item={item} onChanged={refresh} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function AddKeyForm({ providerId, onDone, onCancel }: { providerId: AiProviderId; onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const a = t.autoReply;
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [priority, setPriority] = useState('0');
  const [model, setModel] = useState('');
  const add = useMutation({
    mutationFn: () =>
      api<{ keyId: string }>(`/api/auto-reply/providers/${providerId}/keys`, {
        method: 'POST',
        body: { label: label.trim(), apiKey: key.trim(), priority: Number(priority) || 0, model: model.trim() || undefined },
      }),
    onSuccess: onDone,
  });
  return (
    <form
      className="animate-fade-up grid gap-3 rounded-xl border border-dashed border-brand/40 bg-brand/5 p-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <Field label={a.providers.keyLabel} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={a.providers.keyLabelPlaceholder} required autoFocus />
      <Field label={a.providers.key} type="password" value={key} onChange={(e) => setKey(e.target.value)} dir="ltr" autoComplete="off" required minLength={8} />
      <Field label={a.providers.priority} type="number" min="0" value={priority} onChange={(e) => setPriority(e.target.value)} hint={a.providers.priorityHint} dir="ltr" />
      <Field label={a.providers.keyModel} value={model} onChange={(e) => setModel(e.target.value)} dir="ltr" />
      {add.isError && (
        <div className="sm:col-span-2">
          <ErrorNote>{errorMessage(add.error)}</ErrorNote>
        </div>
      )}
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button variant="ghost" onClick={onCancel}>
          {a.providers.cancel}
        </Button>
        <Button type="submit" variant="brand" loading={add.isPending} icon={<Plus className="size-4" />}>
          {a.providers.addKey}
        </Button>
      </div>
    </form>
  );
}

/** One key: whether it is in use, resting or broken, how often it worked, and its controls. */
function KeyRow({ providerId, item, onChanged }: { providerId: AiProviderId; item: ProviderKey; onChanged: () => void }) {
  const { t, fmt } = useI18n();
  const a = t.autoReply;
  const [confirming, setConfirming] = useState(false);
  const [tested, setTested] = useState<string | null>(null);
  const base = `/api/auto-reply/providers/${providerId}/keys/${item.id}`;
  const toggle = useMutation({ mutationFn: (enabled: boolean) => api(base, { method: 'PUT', body: { enabled } }), onSuccess: onChanged });
  const remove = useMutation({ mutationFn: () => api(base, { method: 'DELETE' }), onSuccess: onChanged });
  const reset = useMutation({ mutationFn: () => api(base + '/reset', { method: 'POST' }), onSuccess: onChanged });
  const test = useMutation({
    mutationFn: () => api<{ reply: string; model: string }>(base + '/test', { method: 'POST' }),
    onMutate: () => setTested(null),
    onSuccess: (data) => {
      setTested(`${data.reply} · ${data.model}`);
      onChanged();
    },
  });

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(timer);
  }, [confirming]);

  const resting = Boolean(item.cooldownUntil && new Date(item.cooldownUntil).getTime() > Date.now());
  const state = !item.enabled ? 'disabled' : item.circuitState !== 'closed' ? 'open' : resting ? 'resting' : 'active';
  const tone: Tone = { active: 'good', resting: 'warning', open: 'critical', disabled: 'neutral' }[state] as Tone;
  const total = item.successRequests + item.failedRequests;
  const rate = total ? Math.round((item.successRequests / total) * 100) : null;
  const error = toggle.error ?? remove.error ?? reset.error ?? test.error;

  return (
    <li className={cx('animate-fade-up rounded-xl border p-3', state === 'active' ? 'border-line' : 'border-line bg-raised/20')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate font-medium">{item.label}</span>
        <span className="ltr font-mono text-xs text-muted">{item.keyHint ?? a.providers.encrypted}</span>
        <Badge tone={tone}>{a.providers.keyState[state]}</Badge>
        {state === 'resting' && item.cooldownUntil && <span className="text-xs text-muted">{a.providers.restingUntil(fmt.upcoming(item.cooldownUntil))}</span>}
        <span className="ms-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => test.mutate()} loading={test.isPending} title={a.providers.test} aria-label={a.providers.test}>
            {!test.isPending && <FlaskConical className="size-4" />}
          </Button>
          {(state === 'resting' || state === 'open') && (
            <Button size="sm" variant="ghost" onClick={() => reset.mutate()} loading={reset.isPending} title={a.providers.resetKey} aria-label={a.providers.resetKey}>
              {!reset.isPending && <RotateCcw className="size-4" />}
            </Button>
          )}
          <Button
            size="sm"
            variant={confirming ? 'danger' : 'ghost'}
            onClick={() => (confirming ? remove.mutate() : setConfirming(true))}
            loading={remove.isPending}
            title={confirming ? a.providers.confirmDelete : a.providers.deleteKey}
            aria-label={confirming ? a.providers.confirmDelete : a.providers.deleteKey}
          >
            {!remove.isPending && <Trash2 className={cx('size-4', !confirming && 'text-destructive-ink')} />}
            {confirming && a.providers.confirmDelete}
          </Button>
          <Switch checked={item.enabled} onChange={(v) => toggle.mutate(v)} disabled={toggle.isPending} label={item.enabled ? a.providers.disableKey : a.providers.enableKey} />
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
        <span className="flex min-w-40 flex-1 items-center gap-2">
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised">
            <span
              className={cx('block h-full rounded-full transition-[width] duration-700', rate === null ? '' : rate >= 80 ? 'bg-good' : rate >= 50 ? 'bg-warning' : 'bg-critical')}
              style={{ width: `${rate ?? 0}%` }}
            />
          </span>
          <span className="tabular-nums">{rate === null ? '—' : `${rate}%`}</span>
        </span>
        <span className="tabular-nums">{a.providers.requests(item.successRequests, item.failedRequests)}</span>
        <span className="tabular-nums">
          {a.providers.priority}: {item.priority}
        </span>
        {item.model && <span className="ltr font-mono">{item.model}</span>}
      </div>

      {item.lastError && state !== 'active' && <p className="mt-2 rounded-md bg-critical/8 px-2.5 py-1.5 text-xs break-words text-critical">{item.lastError}</p>}
      {tested && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-good">
          <CheckCircle2 className="size-3.5 shrink-0" />
          {a.providers.testOk}: {tested}
        </p>
      )}
      {error && <p className="mt-2 text-xs break-words text-critical">{errorMessage(error)}</p>}
    </li>
  );
}

// --- activity --------------------------------------------------------------------------------------

const ENTRY_LOOK: Record<LogEntry['status'], { tone: Tone; icon: typeof Bot }> = {
  sent: { tone: 'good', icon: CheckCircle2 },
  failed: { tone: 'critical', icon: XCircle },
  skipped: { tone: 'neutral', icon: MinusCircle },
};

function ActivityTab() {
  const { t, fmt } = useI18n();
  const a = t.autoReply;
  const [sessionId, setSessionId] = useState('');
  const [status, setStatus] = useState<'' | LogEntry['status']>('');
  const numbers = useNumbers();
  const log = useQuery({
    queryKey: qk.autoReply.log({ sessionId, status }),
    queryFn: ({ signal }) => api<{ entries: LogEntry[] }>(`/api/auto-reply/log?days=7&limit=100${sessionId ? `&sessionId=${sessionId}` : ''}${status ? `&status=${status}` : ''}`, { signal }),
    refetchInterval: 30_000,
  });
  const entries = log.data?.entries ?? [];
  const days = useMemo(() => {
    const groups: { day: string; entries: LogEntry[] }[] = [];
    for (const entry of entries) {
      const day = fmt.day(entry.createdAt);
      const last = groups.at(-1);
      if (last?.day === day) last.entries.push(entry);
      else groups.push({ day, entries: [entry] });
    }
    return groups;
  }, [entries, fmt]);
  const reasons = a.activity.reasons as Record<string, string>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Select
          aria-label={a.activity.number}
          className="w-full sm:w-56"
          value={sessionId}
          onChange={setSessionId}
          options={[{ value: '', label: a.activity.allNumbers }, ...(numbers.data?.numbers ?? []).map((n) => ({ value: n.sessionId, label: n.name }))]}
        />
        <Segmented
          label={a.activity.status}
          value={status}
          onChange={setStatus}
          options={[
            { value: '', label: a.activity.allStatuses },
            { value: 'sent', label: a.activity.statuses.sent },
            { value: 'failed', label: a.activity.statuses.failed },
            { value: 'skipped', label: a.activity.statuses.skipped },
          ]}
        />
        <span className="ms-auto flex items-center gap-2 text-xs text-muted">
          <span className="relative flex size-2">
            <span className="absolute inset-0 animate-ping rounded-full bg-good/60 motion-reduce:hidden" />
            <span className="relative size-2 rounded-full bg-good" />
          </span>
          {a.activity.live}
        </span>
      </div>

      {log.isError ? (
        <LoadError error={log.error} onRetry={() => void log.refetch()} retrying={log.isFetching} />
      ) : log.isLoading ? (
        <Loading />
      ) : entries.length === 0 ? (
        <EmptyState icon={Zap} title={a.activity.empty} text={a.activity.emptyHint} />
      ) : (
        days.map((group) => (
          <section key={group.day} className="space-y-2">
            <h3 className="sticky top-0 z-[1] bg-bg/90 py-1 text-xs font-medium text-muted backdrop-blur">{group.day}</h3>
            <ol className="space-y-2">
              {group.entries.map((entry, i) => {
                const look = ENTRY_LOOK[entry.status];
                return (
                  <li key={entry.id} style={delay(Math.min(i, 8) * 30)} className="animate-fade-up flex gap-3 rounded-xl border border-line bg-card p-3 shadow-xs">
                    <StatusIcon tone={look.tone} icon={look.icon} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                        <span className="font-medium">{entry.sessionName ?? '—'}</span>
                        <ArrowRight className={cx('size-3.5 text-faint', flip)} />
                        <span className="ltr font-mono text-muted">{entry.chatJid.split('@')[0]}</span>
                        <span className="ms-auto text-xs text-faint" title={fmt.dateTime(entry.createdAt)}>
                          {fmt.time(entry.createdAt)}
                        </span>
                      </div>
                      {entry.reply ? (
                        <p dir="auto" className="mt-2 max-w-prose rounded-xl rounded-ss-sm bg-brand/10 px-3 py-2 text-sm whitespace-pre-wrap">
                          {entry.reply}
                        </p>
                      ) : (
                        entry.reason && <p className={cx('mt-1.5 text-sm', entry.status === 'failed' ? 'text-critical' : 'text-muted')}>{reasons[entry.reason] ?? entry.reason}</p>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
                        <Badge tone={look.tone}>{a.activity.statuses[entry.status]}</Badge>
                        {entry.provider && (
                          <span className="ltr font-mono">
                            {entry.provider}
                            {entry.model ? ` · ${entry.model}` : ''}
                          </span>
                        )}
                        {entry.latencyMs !== null && (
                          <span className="flex items-center gap-1 tabular-nums">
                            <Timer className="size-3" />
                            {a.activity.seconds(toSeconds(entry.latencyMs))}
                          </span>
                        )}
                        <span>{entry.language === 'ar' ? 'العربية' : 'English'}</span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        ))
      )}
    </div>
  );
}

// --- statistics ------------------------------------------------------------------------------------

/** Horizontal bars with each row's share of the total. */
function Breakdown({ rows, empty }: { rows: { key: string; label: ReactNode; count: number }[]; empty: string }) {
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  if (rows.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="space-y-3">
      {rows.map((row) => {
        const pct = total ? Math.round((row.count / total) * 100) : 0;
        return (
          <li key={row.key} className="space-y-1.5">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span>{row.label}</span>
              <span className="text-muted tabular-nums">
                {row.count} · {pct}%
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-raised">
              <div className="h-full rounded-full bg-brand transition-[width] duration-700" style={{ width: `${pct}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function StatsTab() {
  const { t, fmt } = useI18n();
  const a = t.autoReply;
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const stats = useStats(Number(days));
  const data = stats.data;
  const totals = data?.totals;
  const decided = (totals?.sent ?? 0) + (totals?.failed ?? 0);
  const perDay = data?.perDay ?? [];
  const max = Math.max(1, ...perDay.map((d) => d.sent + d.failed + d.skipped));
  const labelEvery = Math.max(1, Math.ceil(perDay.length / 10));
  const dayLabel = (day: string) => fmt.dayShort.format(new Date(`${day}T12:00:00`));

  return (
    <div className="space-y-6">
      <Segmented
        label={a.tabs.stats}
        value={days}
        onChange={setDays}
        options={(['7', '30', '90'] as const).map((d) => ({ value: d, label: a.stats.period(Number(d)) }))}
      />

      {stats.isError ? (
        <LoadError error={stats.error} onRetry={() => void stats.refetch()} retrying={stats.isFetching} />
      ) : stats.isLoading ? (
        <Loading />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi icon={CheckCircle2} label={a.stats.sent} value={fmt.number.format(totals?.sent ?? 0)} tone="good" index={0} />
            <Kpi icon={XCircle} label={a.stats.failed} value={fmt.number.format(totals?.failed ?? 0)} tone="critical" index={1} hint={`${a.stats.skipped}: ${fmt.number.format(totals?.skipped ?? 0)}`} />
            <Kpi icon={Gauge} label={a.stats.successRate} value={decided ? `${Math.round(((totals?.sent ?? 0) / decided) * 100)}%` : '—'} tone="progress" index={2} />
            <Kpi icon={Timer} label={a.stats.avg} value={totals?.avgLatencyMs == null ? '—' : a.activity.seconds(toSeconds(totals.avgLatencyMs))} tone="warning" index={3} />
          </div>

          <Card
            title={a.stats.perDay}
            actions={
              <span className="flex flex-wrap items-center gap-3 text-xs text-muted">
                {[
                  { label: a.stats.sent, className: 'bg-brand' },
                  { label: a.stats.failed, className: 'bg-critical' },
                  { label: a.stats.skipped, className: 'bg-line-strong' },
                ].map((item) => (
                  <span key={item.label} className="flex items-center gap-1.5">
                    <span className={cx('size-2.5 rounded-sm', item.className)} />
                    {item.label}
                  </span>
                ))}
              </span>
            }
          >
            {perDay.length > 0 ? (
              <div className="code-scroll overflow-x-auto">
                <div className="flex h-52 min-w-full items-end gap-1" style={{ width: `max(100%, ${perDay.length * 1.25}rem)` }}>
                  {perDay.map((day, i) => (
                    <div
                      key={day.day}
                      className="group flex h-full min-w-3 flex-1 flex-col items-center justify-end gap-1.5"
                      title={`${dayLabel(day.day)} · ${a.stats.sent} ${day.sent} · ${a.stats.failed} ${day.failed} · ${a.stats.skipped} ${day.skipped}`}
                    >
                      <div className="flex w-full max-w-8 flex-1 flex-col-reverse overflow-hidden rounded-t-md">
                        <div className="w-full bg-brand transition-opacity group-hover:opacity-80" style={{ height: `${(day.sent / max) * 100}%` }} />
                        <div className="w-full bg-critical transition-opacity group-hover:opacity-80" style={{ height: `${(day.failed / max) * 100}%` }} />
                        <div className="w-full bg-line-strong transition-opacity group-hover:opacity-80" style={{ height: `${(day.skipped / max) * 100}%` }} />
                      </div>
                      <span className={cx('h-3 text-[10px] leading-none whitespace-nowrap text-faint', i % labelEvery !== 0 && 'invisible')}>{dayLabel(day.day)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted">{a.stats.noData}</p>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={a.stats.byProvider}>
              <Breakdown
                empty={a.stats.noData}
                rows={(data?.byProvider ?? []).map((row) => ({
                  key: row.provider,
                  label: row.provider in AI_PROVIDERS ? a.providers.names[row.provider as AiProviderId] : <span className="ltr">{row.provider || '—'}</span>,
                  count: row.count,
                }))}
              />
            </Card>
            <Card title={a.stats.byLanguage}>
              <Breakdown
                empty={a.stats.noData}
                rows={(data?.byLanguage ?? []).map((row) => ({ key: row.language, label: row.language === 'ar' ? 'العربية' : 'English', count: row.count }))}
              />
            </Card>
          </div>

          <Card title={a.stats.perNumber} bodyClassName="px-0">
            {(data?.perNumber ?? []).length === 0 ? (
              <p className="px-6 text-sm text-muted">{a.stats.noData}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-muted">
                      <th className="px-6 py-2 text-start font-medium">{a.stats.numberName}</th>
                      <th className="px-3 py-2 text-start font-medium">{a.stats.sent}</th>
                      <th className="px-3 py-2 text-start font-medium">{a.stats.failed}</th>
                      <th className="px-3 py-2 text-start font-medium">{a.stats.successRate}</th>
                      <th className="px-6 py-2 text-start font-medium">{a.stats.avg}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.perNumber ?? []).map((row) => {
                      const all = row.sent + row.failed;
                      const rate = all ? Math.round((row.sent / all) * 100) : null;
                      return (
                        <tr key={row.sessionId} className="border-b border-line/60 last:border-0 hover:bg-raised/40">
                          <td className="px-6 py-3 font-medium">{row.name || '—'}</td>
                          <td className="px-3 py-3 tabular-nums">{row.sent}</td>
                          <td className="px-3 py-3 tabular-nums">{row.failed}</td>
                          <td className="px-3 py-3">
                            <span className="flex items-center gap-2">
                              <span className="h-1.5 w-16 overflow-hidden rounded-full bg-raised">
                                <span className={cx('block h-full rounded-full', rate !== null && rate < 80 ? 'bg-warning' : 'bg-good')} style={{ width: `${rate ?? 0}%` }} />
                              </span>
                              <span className="text-muted tabular-nums">{rate === null ? '—' : `${rate}%`}</span>
                            </span>
                          </td>
                          <td className="px-6 py-3 text-muted tabular-nums">{row.avgLatencyMs === null ? '—' : a.activity.seconds(toSeconds(row.avgLatencyMs))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

// --- page ------------------------------------------------------------------------------------------

export function AutoReplyPage() {
  const { t } = useI18n();
  const a = t.autoReply;
  const [tab, setTab] = useState<Tab>('numbers');
  const openProviders = () => setTab('providers');

  return (
    <div className="space-y-6">
      <PageHeader title={a.title} description={a.description} />
      <Overview onOpenProviders={openProviders} />
      <nav aria-label={a.title} className="code-scroll -mx-1 flex gap-1 overflow-x-auto border-b border-line px-1">
        {TABS.map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-current={tab === id ? 'page' : undefined}
            className={cx(
              'relative flex h-10 shrink-0 items-center gap-2 px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:transition-colors after:content-['']",
              tab === id ? 'text-ink after:bg-brand' : 'text-muted after:bg-transparent hover:text-ink',
            )}
          >
            <Icon className={cx('size-4', tab === id && 'text-brand')} />
            {a.tabs[id]}
          </button>
        ))}
      </nav>
      <div key={tab} className="animate-fade-up min-w-0">
        {tab === 'numbers' && <NumbersTab onOpenProviders={openProviders} />}
        {tab === 'providers' && <ProvidersTab />}
        {tab === 'activity' && <ActivityTab />}
        {tab === 'stats' && <StatsTab />}
      </div>
    </div>
  );
}
