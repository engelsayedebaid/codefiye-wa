import { AI_PROVIDERS, type AiProviderId } from '@wa/shared/ai';
import { DEFAULT_AUTO_REPLY_SETTINGS, type AutoReplyRule, type AutoReplySettings } from '@wa/shared/auto-reply';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Bot, Plug, Sparkles, Trash2, Zap } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../api';
import { useI18n } from '../i18n';
import { qk } from '../queries';
import { Badge, Button, Card, cx, EmptyState, ErrorNote, Field, Loading, LoadError, PageHeader, Select, SuccessNote, TextArea } from '../ui';

/**
 * The AI auto-reply agent (admins only): each number gets its own personality, provider and rules;
 * the providers themselves are set up once. The activity and the statistics show what it answered.
 */

type Provider = {
  id: AiProviderId;
  enabled: boolean;
  hasKey: boolean;
  keyHint: string | null;
  baseUrl: string | null;
  model: string | null;
  needsKey: boolean;
  defaultModel: string;
  models: string[];
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

const TABS: { id: Tab; icon: typeof Bot }[] = [
  { id: 'numbers', icon: Bot },
  { id: 'providers', icon: Plug },
  { id: 'activity', icon: Activity },
  { id: 'stats', icon: Sparkles },
];

/** A small switch, like the one on the ads page. */
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

// --- numbers ---------------------------------------------------------------------------------------

/** The list of numbers on the side; the settings of the picked one on the other. */
function NumbersTab() {
  const { t } = useI18n();
  const a = t.autoReply;
  const queryClient = useQueryClient();
  const numbers = useQuery({ queryKey: qk.autoReply.numbers, queryFn: ({ signal }) => api<{ numbers: NumberRow[] }>('/api/auto-reply/settings', { signal }) });
  const rows = numbers.data?.numbers ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const current = rows.find((r) => r.sessionId === picked) ?? rows[0] ?? null;

  if (numbers.isError) return <LoadError error={numbers.error} onRetry={() => void numbers.refetch()} retrying={numbers.isFetching} />;
  if (numbers.isLoading) return <Loading />;
  if (rows.length === 0) return <EmptyState icon={Bot} title={a.numbers.empty} />;

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="space-y-2">
        {rows.map((row, i) => (
          <button
            key={row.sessionId}
            type="button"
            onClick={() => setPicked(row.sessionId)}
            style={{ animationDelay: `${i * 40}ms` }}
            className={cx(
              'animate-fade-up flex w-full items-center gap-3 rounded-xl border p-3 text-start transition-colors',
              current?.sessionId === row.sessionId ? 'border-brand/40 bg-brand/10' : 'border-line bg-card hover:bg-raised',
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{row.name}</span>
              <span className="ltr block truncate font-mono text-xs text-muted">{row.phone ?? '—'}</span>
            </span>
            {row.enabled && <span className="size-2 shrink-0 rounded-full bg-brand" />}
          </button>
        ))}
      </aside>
      {current && <NumberSettings key={current.sessionId} row={current} onSaved={() => void queryClient.invalidateQueries({ queryKey: qk.autoReply.numbers })} />}
    </div>
  );
}

/** One number's settings; everything is saved at once. */
function NumberSettings({ row, onSaved }: { row: NumberRow; onSaved: () => void }) {
  const { t } = useI18n();
  const a = t.autoReply;
  const [draft, setDraft] = useState<AutoReplySettings>(row.settings);
  const queryClient = useQueryClient();
  const providers = useQuery({ queryKey: qk.autoReply.providers, queryFn: ({ signal }) => api<{ providers: Provider[] }>('/api/auto-reply/providers', { signal }) });
  const list = providers.data?.providers ?? [];

  useEffect(() => setDraft(row.settings), [row]);

  const save = useMutation({
    mutationFn: () => api<{ settings: AutoReplySettings }>(`/api/auto-reply/settings/${row.sessionId}`, { method: 'PUT', body: draft }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.autoReply.numbers });
      onSaved();
    },
  });
  const patch = (part: Partial<AutoReplySettings>) => setDraft((d) => ({ ...d, ...part }));

  const providerOptions = list.map((p) => ({ value: p.id, label: p.id }));
  const modelOptions = useMemo(() => {
    const info = AI_PROVIDERS[draft.providerId];
    const models = info.models.length ? info.models : list.find((p) => p.id === draft.providerId)?.models ?? [];
    return [...new Set([...(draft.model ? [draft.model] : []), ...models])].map((m) => ({ value: m, label: m }));
  }, [draft.providerId, draft.model, list]);

  return (
    <form
      className="min-w-0 space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Card
        title={a.agent.title}
        description={a.agent.description}
        actions={
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted">{draft.enabled ? a.on : a.off}</span>
            <Switch checked={draft.enabled} onChange={(v) => patch({ enabled: v })} label={a.numbers.enabled} />
          </div>
        }
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Select
            label={a.agent.personality}
            value={draft.personality}
            onChange={(v) => patch({ personality: v })}
            options={[
              { value: 'sales', label: a.personalities.sales },
              { value: 'support', label: a.personalities.support },
              { value: 'booking', label: a.personalities.booking },
              { value: 'custom', label: a.personalities.custom },
            ]}
          />
          <Select
            label={a.agent.language}
            value={draft.language}
            onChange={(v) => patch({ language: v })}
            options={[
              { value: 'auto', label: a.agent.languageAuto },
              { value: 'ar', label: 'العربية' },
              { value: 'en', label: 'English' },
            ]}
          />
        </div>
        {draft.personality === 'custom' && (
          <div className="mt-4">
            <TextArea
              label={a.agent.prompt}
              rows={10}
              value={draft.systemPrompt}
              onChange={(e) => patch({ systemPrompt: e.target.value })}
              placeholder={a.agent.promptPlaceholder}
              dir="auto"
            />
            <p className="mt-1.5 text-sm text-muted">{a.agent.promptHint}</p>
          </div>
        )}
      </Card>

      <Card title={a.model.title} description={a.model.description}>
        <div className="grid gap-4 md:grid-cols-2">
          <Select
            label={a.model.provider}
            value={draft.providerId}
            onChange={(v) => patch({ providerId: v })}
            options={providerOptions.length ? providerOptions : [{ value: 'anthropic' as AiProviderId, label: 'anthropic' }]}
          />
          <Field
            label={a.model.model}
            value={draft.model}
            onChange={(e) => patch({ model: e.target.value })}
            placeholder={AI_PROVIDERS[draft.providerId].defaultModel || 'model-name'}
            dir="ltr"
            list={modelOptions.length ? undefined : undefined}
          />
          <Select
            label={a.model.fallback}
            value={draft.fallbackProviderId ?? ''}
            onChange={(v) => patch({ fallbackProviderId: v === '' ? null : v })}
            options={[{ value: '', label: a.model.noFallback }, ...providerOptions]}
          />
          <Field
            label={a.model.fallbackModel}
            value={draft.fallbackModel}
            onChange={(e) => patch({ fallbackModel: e.target.value })}
            placeholder={a.model.sameModel}
            dir="ltr"
            disabled={!draft.fallbackProviderId}
          />
          <Field
            label={a.model.temperature}
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={draft.temperature}
            onChange={(e) => patch({ temperature: Number(e.target.value) })}
            dir="ltr"
          />
          <Field
            label={a.model.maxTokens}
            type="number"
            min={64}
            max={32000}
            step={64}
            value={draft.maxTokens}
            onChange={(e) => patch({ maxTokens: Number(e.target.value) })}
            dir="ltr"
          />
        </div>
      </Card>

      <Card title={a.rules.title} description={a.rules.description}>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex items-center justify-between gap-3 rounded-md border border-line p-3 md:col-span-2">
            <span className="text-sm font-medium">{a.rules.hours}</span>
            <Switch checked={draft.businessHoursOnly} onChange={(v) => patch({ businessHoursOnly: v })} label={a.rules.hours} />
          </div>
          <Field
            label={a.rules.hoursFrom}
            type="number"
            min={0}
            max={23}
            value={draft.hoursStart}
            onChange={(e) => patch({ hoursStart: Number(e.target.value) })}
            dir="ltr"
            disabled={!draft.businessHoursOnly}
          />
          <Field
            label={a.rules.hoursTo}
            type="number"
            min={0}
            max={23}
            value={draft.hoursEnd}
            onChange={(e) => patch({ hoursEnd: Number(e.target.value) })}
            dir="ltr"
            disabled={!draft.businessHoursOnly}
          />
          <Field
            label={a.rules.timezone}
            value={draft.timezone}
            onChange={(e) => patch({ timezone: e.target.value })}
            placeholder="Africa/Cairo"
            dir="ltr"
            disabled={!draft.businessHoursOnly}
          />
          <Field
            label={a.rules.maxReplies}
            type="number"
            min={0}
            max={100}
            value={draft.maxReplies}
            onChange={(e) => patch({ maxReplies: Number(e.target.value) })}
            dir="ltr"
            hint={a.rules.maxRepliesHint}
          />
          <Field
            label={a.rules.delayMin}
            type="number"
            min={0}
            max={600000}
            step={500}
            value={draft.delayMinMs}
            onChange={(e) => patch({ delayMinMs: Number(e.target.value) })}
            dir="ltr"
          />
          <Field
            label={a.rules.delayMax}
            type="number"
            min={0}
            max={600000}
            step={500}
            value={draft.delayMaxMs}
            onChange={(e) => patch({ delayMaxMs: Number(e.target.value) })}
            dir="ltr"
          />
        </div>
        <div className="mt-4">
          <TextArea
            label={a.rules.ignore}
            rows={3}
            value={draft.ignoreList.join('\n')}
            onChange={(e) => patch({ ignoreList: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean) })}
            placeholder="+201012345678"
            dir="ltr"
          />
          <p className="mt-1.5 text-sm text-muted">{a.rules.ignoreHint}</p>
        </div>
        <RulesEditor rules={draft.rules} onChange={(rules) => patch({ rules })} />
      </Card>

      <Card title={a.business.title} description={a.business.description}>
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            label={a.business.businessName}
            value={draft.variables.businessName}
            onChange={(e) => patch({ variables: { ...draft.variables, businessName: e.target.value } })}
          />
          <Field
            label={a.business.website}
            value={draft.variables.website}
            onChange={(e) => patch({ variables: { ...draft.variables, website: e.target.value } })}
            dir="ltr"
          />
          <Field
            label={a.business.phone}
            value={draft.variables.phone}
            onChange={(e) => patch({ variables: { ...draft.variables, phone: e.target.value } })}
            dir="ltr"
          />
          <div className="md:col-span-2">
            <TextArea
              label={a.business.services}
              rows={3}
              value={draft.variables.services}
              onChange={(e) => patch({ variables: { ...draft.variables, services: e.target.value } })}
            />
          </div>
          <div className="md:col-span-2">
            <TextArea
              label={a.business.pricing}
              rows={2}
              value={draft.variables.pricing}
              onChange={(e) => patch({ variables: { ...draft.variables, pricing: e.target.value } })}
            />
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="brand" loading={save.isPending}>
          {a.save}
        </Button>
        {save.isSuccess && <SuccessNote>{a.saved}</SuccessNote>}
        {save.isError && <ErrorNote>{errorMessage(save.error)}</ErrorNote>}
      </div>
    </form>
  );
}

/** The canned answers: a word (or two) and what the agent says when it sees it. */
function RulesEditor({ rules, onChange }: { rules: AutoReplyRule[]; onChange: (rules: AutoReplyRule[]) => void }) {
  const { t } = useI18n();
  const a = t.autoReply;
  const update = (index: number, part: Partial<AutoReplyRule>) => onChange(rules.map((r, i) => (i === index ? { ...r, ...part } : r)));
  return (
    <div className="mt-6 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{a.rules.keywords}</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onChange([...rules, { id: `r${Date.now()}`, keywords: [], reply: '', match: 'contains' }])}
        >
          {a.rules.keywordAdd}
        </Button>
      </div>
      {rules.length === 0 && <p className="text-sm text-muted">{a.rules.keywordsEmpty}</p>}
      {rules.map((rule, i) => (
        <div key={rule.id} className="rounded-lg border border-line p-3">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_12rem_auto]">
            <Field
              label={a.rules.keywordWords}
              value={rule.keywords.join(', ')}
              onChange={(e) => update(i, { keywords: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) })}
              placeholder="price, عرض"
              dir="auto"
            />
            <Select
              label={a.rules.keywordMatch}
              value={rule.match}
              onChange={(v) => update(i, { match: v })}
              options={[
                { value: 'contains', label: a.rules.matchContains },
                { value: 'exact', label: a.rules.matchExact },
              ]}
            />
            <span className="flex items-end pb-1">
              <Button variant="ghost" size="sm" onClick={() => onChange(rules.filter((_, j) => j !== i))} aria-label={a.rules.keywordRemove}>
                <Trash2 className="size-4 text-destructive-ink" />
              </Button>
            </span>
          </div>
          <div className="mt-3">
            <TextArea label={a.rules.keywordReply} rows={2} value={rule.reply} onChange={(e) => update(i, { reply: e.target.value })} />
          </div>
        </div>
      ))}
    </div>
  );
}

// --- providers -------------------------------------------------------------------------------------

function ProvidersTab() {
  const { t } = useI18n();
  const a = t.autoReply;
  const queryClient = useQueryClient();
  const providers = useQuery({ queryKey: qk.autoReply.providers, queryFn: ({ signal }) => api<{ providers: Provider[] }>('/api/auto-reply/providers', { signal }) });
  if (providers.isError) return <LoadError error={providers.error} onRetry={() => void providers.refetch()} retrying={providers.isFetching} />;
  if (providers.isLoading) return <Loading />;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {(providers.data?.providers ?? []).map((provider, i) => (
        <ProviderCard key={provider.id} provider={provider} index={i} onSaved={() => void queryClient.invalidateQueries({ queryKey: qk.autoReply.providers })} />
      ))}
    </div>
  );
}

function ProviderCard({ provider, index, onSaved }: { provider: Provider; index: number; onSaved: () => void }) {
  const { t } = useI18n();
  const a = t.autoReply;
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '');
  const [model, setModel] = useState(provider.model ?? '');
  const [enabled, setEnabled] = useState(provider.enabled);
  const [tested, setTested] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api<{ saved: boolean }>(`/api/auto-reply/providers/${provider.id}`, {
        method: 'PUT',
        body: { enabled, baseUrl: baseUrl || null, model: model || undefined, ...(key.trim() ? { apiKey: key.trim() } : {}) },
      }),
    onSuccess: () => {
      setKey('');
      setTested(null);
      onSaved();
    },
  });
  const test = useMutation({
    mutationFn: () => api<{ ok: boolean; model: string; reply: string }>(`/api/auto-reply/providers/${provider.id}/test`, { method: 'POST', body: { model: model || undefined } }),
    onSuccess: (data) => setTested(data.reply),
    onError: () => setTested(null),
  });

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {provider.id}
          {provider.enabled && <Badge tone="good">{a.on}</Badge>}
        </span>
      }
      description={provider.needsKey ? a.providers.needsKey : a.providers.noKeyNeeded}
      className="animate-fade-up"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field
          label={a.providers.key}
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={provider.keyHint ?? 'sk-…'}
          dir="ltr"
          autoComplete="off"
          hint={provider.hasKey ? a.providers.keyStored : a.providers.keyHintText}
        />
        {provider.id === 'custom' && (
          <Field label={a.providers.baseUrl} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434/v1" dir="ltr" />
        )}
        <Field
          label={a.providers.model}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={provider.defaultModel || 'model-name'}
          dir="ltr"
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">{a.providers.enable}</span>
          <Switch checked={enabled} onChange={setEnabled} label={a.providers.enable} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="brand" loading={save.isPending}>
            {a.providers.save}
          </Button>
          <Button type="button" variant="outline" loading={test.isPending} onClick={() => test.mutate()}>
            {a.providers.test}
          </Button>
          {tested && <span className="text-sm text-good">{a.providers.testOk}: {tested}</span>}
        </div>
        {test.isError && <ErrorNote>{errorMessage(test.error)}</ErrorNote>}
        {save.isError && <ErrorNote>{errorMessage(save.error)}</ErrorNote>}
        {save.isSuccess && <SuccessNote>{a.providers.saved}</SuccessNote>}
      </form>
    </Card>
  );
}

// --- activity --------------------------------------------------------------------------------------

function ActivityTab() {
  const { t, fmt } = useI18n();
  const a = t.autoReply;
  const [sessionId, setSessionId] = useState('');
  const [status, setStatus] = useState('');
  const numbers = useQuery({ queryKey: qk.autoReply.numbers, queryFn: ({ signal }) => api<{ numbers: NumberRow[] }>('/api/auto-reply/settings', { signal }) });
  const log = useQuery({
    queryKey: qk.autoReply.log({ sessionId, status }),
    queryFn: ({ signal }) => api<{ entries: LogEntry[] }>(`/api/auto-reply/log?days=7&limit=100${sessionId ? `&sessionId=${sessionId}` : ''}${status ? `&status=${status}` : ''}`, { signal }),
    refetchInterval: 30_000,
  });

  if (log.isError) return <LoadError error={log.error} onRetry={() => void log.refetch()} retrying={log.isFetching} />;
  const entries = log.data?.entries ?? [];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:max-w-2xl">
        <Select
          label={a.activity.number}
          value={sessionId}
          onChange={setSessionId}
          options={[{ value: '', label: a.activity.allNumbers }, ...(numbers.data?.numbers ?? []).map((n) => ({ value: n.sessionId, label: n.name }))]}
        />
        <Select
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
      </div>
      {log.isLoading ? (
        <Loading />
      ) : entries.length === 0 ? (
        <EmptyState icon={Zap} title={a.activity.empty} />
      ) : (
        <ul className="space-y-2">
          {entries.map((entry, i) => (
            <li key={entry.id} className="animate-fade-up rounded-lg border border-line bg-card p-3" style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={entry.status === 'sent' ? 'good' : entry.status === 'failed' ? 'critical' : 'neutral'}>
                  {a.activity.statuses[entry.status]}
                </Badge>
                <span className="font-medium">{entry.sessionName ?? '—'}</span>
                <span className="ltr text-muted">{entry.chatJid.split('@')[0]}</span>
                {entry.provider && <span className="text-muted">{entry.provider}</span>}
                {entry.latencyMs !== null && <span className="text-muted">{entry.latencyMs}ms</span>}
                <span className="ms-auto text-xs text-faint">{fmt.timeAgo(entry.createdAt)}</span>
              </div>
              {entry.reply ? <p className="mt-2 text-sm whitespace-pre-wrap">{entry.reply}</p> : entry.reason && <p className="mt-2 text-sm text-muted">{a.activity.reasons[entry.reason as keyof typeof a.activity.reasons] ?? entry.reason}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- statistics ------------------------------------------------------------------------------------

function StatsTab() {
  const { t } = useI18n();
  const a = t.autoReply;
  const [days, setDays] = useState(30);
  const stats = useQuery({ queryKey: qk.autoReply.stats(days), queryFn: ({ signal }) => api<Stats>(`/api/auto-reply/stats?days=${days}`, { signal }) });
  if (stats.isError) return <LoadError error={stats.error} onRetry={() => void stats.refetch()} retrying={stats.isFetching} />;
  if (stats.isLoading) return <Loading />;
  const data = stats.data;
  const max = Math.max(1, ...(data?.perDay ?? []).map((d) => d.sent + d.failed));

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: a.stats.sent, value: data?.totals.sent ?? 0, tone: 'text-good' },
          { label: a.stats.failed, value: data?.totals.failed ?? 0, tone: 'text-critical' },
          { label: a.stats.skipped, value: data?.totals.skipped ?? 0, tone: 'text-muted' },
          { label: a.stats.avg, value: data?.totals.avgLatencyMs === null || data?.totals.avgLatencyMs === undefined ? '—' : `${data.totals.avgLatencyMs}ms`, tone: 'text-ink' },
        ].map((card) => (
          <div key={card.label} className="rounded-xl border border-line bg-card p-4 shadow-sm">
            <p className="text-sm text-muted">{card.label}</p>
            <p className={cx('mt-1 text-2xl font-bold tabular-nums', card.tone)}>{card.value}</p>
          </div>
        ))}
      </div>

      <Card title={a.stats.perDay}>
        {data && data.perDay.length > 0 ? (
          <div className="flex h-40 items-end gap-1.5 overflow-x-auto">
            {data.perDay.map((day) => (
              <div key={day.day} className="group relative flex min-w-8 flex-1 flex-col items-center gap-1">
                <div className="flex w-full flex-1 items-end gap-0.5">
                  <div className="w-1/2 rounded-t bg-brand/80" style={{ height: `${(day.sent / max) * 100}%` }} title={`${day.sent}`} />
                  <div className="w-1/2 rounded-t bg-critical/70" style={{ height: `${(day.failed / max) * 100}%` }} title={`${day.failed}`} />
                </div>
                <span className="text-[10px] text-faint">{day.day.slice(5)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">{a.stats.noData}</p>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={a.stats.byProvider}>
          <ul className="space-y-2 text-sm">
            {(data?.byProvider ?? []).map((row) => (
              <li key={row.provider} className="flex items-center justify-between gap-3">
                <span className="ltr">{row.provider}</span>
                <span className="tabular-nums text-muted">{row.count}</span>
              </li>
            ))}
            {(data?.byProvider ?? []).length === 0 && <li className="text-muted">{a.stats.noData}</li>}
          </ul>
        </Card>
        <Card title={a.stats.byLanguage}>
          <ul className="space-y-2 text-sm">
            {(data?.byLanguage ?? []).map((row) => (
              <li key={row.language} className="flex items-center justify-between gap-3">
                <span>{row.language === 'ar' ? 'العربية' : 'English'}</span>
                <span className="tabular-nums text-muted">{row.count}</span>
              </li>
            ))}
            {(data?.byLanguage ?? []).length === 0 && <li className="text-muted">{a.stats.noData}</li>}
          </ul>
        </Card>
      </div>

      <Card title={a.stats.perNumber}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-start text-muted">
                <th className="p-2 text-start font-medium">{a.stats.numberName}</th>
                <th className="p-2 text-start font-medium">{a.stats.sent}</th>
                <th className="p-2 text-start font-medium">{a.stats.failed}</th>
                <th className="p-2 text-start font-medium">{a.stats.avg}</th>
              </tr>
            </thead>
            <tbody>
              {(data?.perNumber ?? []).map((row) => (
                <tr key={row.sessionId} className="border-t border-line/60">
                  <td className="p-2">{row.name || '—'}</td>
                  <td className="p-2 tabular-nums">{row.sent}</td>
                  <td className="p-2 tabular-nums">{row.failed}</td>
                  <td className="p-2 tabular-nums">{row.avgLatencyMs === null ? '—' : `${row.avgLatencyMs}ms`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// --- page ------------------------------------------------------------------------------------------

export function AutoReplyPage() {
  const { t } = useI18n();
  const a = t.autoReply;
  const [tab, setTab] = useState<Tab>('numbers');

  return (
    <div className="space-y-6">
      <PageHeader title={a.title} description={a.description} />
      <nav aria-label={a.title} className="code-scroll -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {TABS.map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-current={tab === id ? 'page' : undefined}
            className={cx(
              'flex h-9 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors',
              tab === id ? 'border-brand/40 bg-brand/10 text-brand' : 'border-line bg-card text-muted hover:text-ink',
            )}
          >
            <Icon className="size-4" />
            {a.tabs[id]}
          </button>
        ))}
      </nav>
      <div key={tab} className="animate-fade-up min-w-0">
        {tab === 'numbers' && <NumbersTab />}
        {tab === 'providers' && <ProvidersTab />}
        {tab === 'activity' && <ActivityTab />}
        {tab === 'stats' && <StatsTab />}
      </div>
    </div>
  );
}
