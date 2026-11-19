import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { useI18n } from '../i18n';
import { Check, ChevronLeft, ChevronRight, ShieldCheck, Smartphone } from '../icons';
import { qk } from '../queries';
import { Link } from '../router';
import type { Session } from '../types';
import { Badge, Button, Card, cx, EmptyState, ErrorNote, Field, flip, KeyReveal, LoadError, Loading, Modal, PageHeader, Phone, Select, SessionStatusBadge } from '../ui';

type Limits = { pools: number; sessionsPerPool: number; daily: number | null; queuePerSession: number };
type Member = {
  session_id: string;
  name: string;
  status: string;
  phone: string | null;
  enabled: boolean;
  membership: string;
  queued: number;
};
type Pool = {
  id: string;
  name: string;
  status: 'active' | 'paused' | 'archived';
  is_default: boolean;
  code_length: number;
  ttl_seconds: number;
  max_attempts: number;
  resend_cooldown_sec: number;
  max_sends: number;
  members: Member[];
};
type Overview = {
  counts: { pools: number; queued: number; sent: number; delivered: number; failed: number; expired: number; uncertain: number; verified: number };
  usageToday: number;
  limits: Limits;
};
type LogRow = {
  requestId: string;
  to: string;
  purpose: string;
  deliveryStatus: string;
  verifyStatus: string;
  failure: string | null;
  createdAt: string;
  sessionId: string | null;
};
type OtpKey = {
  id: string;
  name: string;
  prefix: string;
  poolId: string | null;
  poolName: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
};

export function OtpPage() {
  const { t, fmt } = useI18n();
  const o = t.otp;
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [keyName, setKeyName] = useState('Website');
  const [revealed, setRevealed] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [rules, setRules] = useState(false);
  const [setup, setSetup] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const top = useRef<HTMLDivElement>(null);

  const overview = useQuery({ queryKey: [...qk.otp, 'overview'], queryFn: ({ signal }) => api<Overview>('/api/v1/otp/overview', { signal }) });
  const pools = useQuery({ queryKey: [...qk.otp, 'pools'], queryFn: ({ signal }) => api<{ pools: Pool[]; limits: Limits }>('/api/v1/otp/pools', { signal }) });
  const logs = useQuery({ queryKey: [...qk.otp, 'logs'], queryFn: ({ signal }) => api<{ logs: LogRow[] }>('/api/v1/otp/logs', { signal }) });
  const keys = useQuery({ queryKey: [...qk.otp, 'keys'], queryFn: ({ signal }) => api<{ keys: OtpKey[] }>('/api/v1/otp/keys', { signal }) });
  const sessions = useQuery({ queryKey: qk.sessions, queryFn: ({ signal }) => api<Session[]>('/api/whatsapp-sessions', { signal }) });

  const list = pools.data?.pools ?? [];
  const current = list.find((p) => p.id === selected) ?? list.find((p) => p.is_default) ?? list[0] ?? null;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.otp });
    void queryClient.invalidateQueries({ queryKey: qk.keys });
  };

  const fail = (err: unknown) => setError(errorMessage(err));
  const create = useMutation({
    mutationFn: () => api<{ id: string }>('/api/v1/otp/pools', { method: 'POST', body: { name: name.trim(), sessionIds: picked } }),
    onSuccess: (row) => {
      setCreating(false);
      setName('');
      setPicked([]);
      setSelected(row.id);
      setError(null);
      refresh();
    },
    onError: fail,
  });
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown> & { id: string }) => {
      const { id, ...rest } = body;
      return api(`/api/v1/otp/pools/${id}`, { method: 'PATCH', body: rest });
    },
    onSuccess: () => {
      setNotice(o.saved);
      setError(null);
      refresh();
    },
    onError: fail,
  });
  const setDefault = useMutation({
    mutationFn: (id: string) => api(`/api/v1/otp/pools/${id}/default`, { method: 'POST' }),
    onSuccess: refresh,
    onError: fail,
  });
  const removePool = useMutation({
    mutationFn: (id: string) => api(`/api/v1/otp/pools/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setSelected(null);
      refresh();
    },
    onError: (err) => setError(errorMessage(err) || o.busy),
  });
  const addMember = useMutation({
    mutationFn: (sessionId: string) => api(`/api/v1/otp/pools/${current?.id}/members`, { method: 'POST', body: { sessionId } }),
    onSuccess: refresh,
    onError: fail,
  });
  const member = useMutation({
    mutationFn: (input: { sessionId: string; enabled?: boolean; remove?: boolean }) =>
      input.remove
        ? api(`/api/v1/otp/pools/${current?.id}/members/${input.sessionId}`, { method: 'DELETE' })
        : api(`/api/v1/otp/pools/${current?.id}/members/${input.sessionId}`, { method: 'PATCH', body: { enabled: input.enabled } }),
    onSuccess: refresh,
    onError: fail,
  });
  const makeKey = useMutation({
    mutationFn: () => api<{ key: string }>('/api/v1/otp/keys', { method: 'POST', body: { name: keyName.trim(), poolId: current?.id } }),
    onSuccess: (row) => {
      setSetup(false);
      setRevealed(row.key);
      setError(null);
      refresh();
    },
    onError: fail,
  });

  const revokeKey = useMutation({
    mutationFn: (id: string) => api(`/api/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setOpenKey(null);
      setError(null);
      refresh();
    },
    onError: fail,
  });

  const available = useMemo(() => {
    const inPool = new Set(current?.members.map((m) => m.session_id) ?? []);
    return (sessions.data ?? []).filter((s) => !inPool.has(s.id));
  }, [sessions.data, current]);

  const submitCreate = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate();
  };

  const connected = (sessions.data ?? []).filter((s) => s.status === 'connected');
  const f = o.flow;
  const steps = [f.numbersTitle, f.poolTitle, f.keyTitle, f.callTitle, f.todayTitle];
  const at = Math.min(index, steps.length - 1);
  const keyRows = keys.data?.keys ?? [];
  const showList = keyRows.length > 0 && !setup;
  const opened = keyRows.find((key) => key.id === openKey) ?? null;
  const openedPool = list.find((pool) => pool.id === opened?.poolId) ?? null;

  useEffect(() => {
    top.current?.scrollIntoView({ block: 'start' });
  }, [at, showList]);

  const keyForm = (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (current && keyName.trim()) makeKey.mutate();
      }}
    >
      <Field label={o.keyName} value={keyName} onChange={(e) => setKeyName(e.target.value)} required />
      <p className="text-sm text-muted">{current ? current.name : o.empty}</p>
      <Button type="submit" variant="brand" loading={makeKey.isPending} disabled={!current}>{o.createKey}</Button>
    </form>
  );

  const sharedModals = (
    <>
      {creating ? (
        <Modal onClose={() => setCreating(false)} title={o.create}>
          <form className="grid gap-4" onSubmit={submitCreate}>
            <Field label={o.name} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
            <NumberPicker sessions={sessions.data ?? []} picked={picked} onToggle={(id, on) => setPicked((ids) => (on ? [...ids, id] : ids.filter((x) => x !== id)))} empty={o.noSessions} label={o.sessions} />
            <Button type="submit" variant="brand" loading={create.isPending}>{o.create}</Button>
          </form>
        </Modal>
      ) : null}
      {revealed ? <KeyReveal title={o.createKey} value={revealed} onClose={() => setRevealed(null)} /> : null}
      {opened ? (
        <Modal onClose={() => setOpenKey(null)} title={opened.name} description={f.detailHint} size="lg">
          <div className="grid gap-4">
            <p className="ltr font-mono text-sm"><code className="rounded-md border border-line bg-surface px-2 py-1">{opened.prefix}…</code></p>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted">{f.cols.pool}</span>
              <span className="font-medium">{opened.poolName ?? f.noPool}</span>
              {openedPool?.is_default ? <Badge tone="good">{o.default}</Badge> : null}
              {openedPool && openedPool.status !== 'active' ? <Badge tone="warning">{o.pause}</Badge> : null}
            </div>
            {openedPool ? (
              <ul className="grid gap-2">
                {openedPool.members.map((m) => (
                  <li key={m.session_id} className="flex items-center justify-between gap-2 rounded-2xl border border-line px-3 py-2">
                    <span>
                      <span className="block font-medium">{m.name}</span>
                      <span className="ltr block text-sm text-muted">{m.phone ?? ''}</span>
                    </span>
                    <Badge tone={m.status === 'connected' ? 'good' : 'warning'}>{m.status === 'connected' ? o.connected : o.other}</Badge>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-sm text-muted">{f.cols.lastUsed}: {opened.lastUsedAt ? fmt.timeAgo(opened.lastUsedAt) : f.never}</p>
            <div className="grid gap-3">
              <CallCard title={f.sendTitle} text={f.sendText} sample={'POST /api/v1/otp/send\n{"to":"+2010XXXXXXX","purpose":"login"}'} />
              <CallCard title={f.verifyTitle} text={f.verifyText} sample={'POST /api/v1/otp/verify\n{"requestId":"…","code":"123456"}'} />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              {openedPool ? (
                <Button variant="outline" onClick={() => patch.mutate({ id: openedPool.id, status: openedPool.status === 'active' ? 'paused' : 'active' })}>
                  {openedPool.status === 'active' ? o.pause : o.resume}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                className="text-critical hover:text-critical"
                loading={revokeKey.isPending}
                onClick={() => confirm(f.revokeConfirm(opened.name)) && revokeKey.mutate(opened.id)}
              >
                {f.revoke}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );

  if (showList) {
    const th = 'h-10 px-2 text-start font-medium whitespace-nowrap text-muted';
    const td = 'p-2 whitespace-nowrap';
    return (
      <div ref={top} className="mx-auto w-full max-w-5xl space-y-6">
        <PageHeader
          title={o.title}
          description={f.listText}
          actions={<Button variant="brand" icon={<ShieldCheck className="size-4" />} onClick={() => { setIndex(0); setSetup(true); }}>{f.newKey}</Button>}
        />
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {notice ? <p className="text-sm text-muted">{notice}</p> : null}
        <Card bodyClassName="px-4">
          <div className="table-stack overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface text-muted">
                <tr className="border-b border-line">
                  <th className={th}>{f.cols.name}</th>
                  <th className={th}>{f.cols.key}</th>
                  <th className={th}>{f.cols.pool}</th>
                  <th className={th}>{f.cols.numbers}</th>
                  <th className={th}>{f.cols.lastUsed}</th>
                  <th className={th}>{f.cols.created}</th>
                  <th />
                </tr>
              </thead>
              <tbody className="[&_tr]:border-b [&_tr]:border-line [&_tr:last-child]:border-0">
                {keyRows.map((key) => {
                  const pool = list.find((p) => p.id === key.poolId);
                  return (
                    <tr key={key.id} className="cursor-pointer transition-colors hover:bg-raised/30" onClick={() => setOpenKey(key.id)}>
                      <td data-label={f.cols.name} className={`${td} font-medium`}>{key.name}</td>
                      <td data-label={f.cols.key} className={td}><code className="ltr rounded-md border border-line bg-surface px-2 py-1 font-mono text-xs">{key.prefix}…</code></td>
                      <td data-label={f.cols.pool} className={td}>{key.poolName ?? f.noPool}</td>
                      <td data-label={f.cols.numbers} className={td}>{f.numberCount(pool?.members.length ?? 0)}</td>
                      <td data-label={f.cols.lastUsed} className={td}>{key.lastUsedAt ? fmt.timeAgo(key.lastUsedAt) : f.never}</td>
                      <td data-label={f.cols.created} className={td}>{fmt.timeAgo(key.createdAt)}</td>
                      <td className={`${td} text-end`}>
                        <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setOpenKey(key.id); }}>{f.details}</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
        <section>
          <h2 className="text-lg font-semibold">{f.logsTitle}</h2>
          <p className="mt-1 mb-3 text-sm text-muted">{f.logsText}</p>
          <LogsPanel query={logs} copy={o} />
        </section>
        {sharedModals}
      </div>
    );
  }

  return (
    <div ref={top} className="mx-auto w-full max-w-3xl">
      <PageHeader
        title={o.title}
        description={o.description}
        actions={keyRows.length > 0 ? <Button variant="outline" onClick={() => setSetup(false)}>{f.backToList}</Button> : undefined}
      />
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {notice ? <p className="mb-3 text-sm text-muted">{notice}</p> : null}

      <nav aria-label={o.title} className="mb-4">
        <p className="mb-1 text-sm text-muted">{f.stepOf(at + 1, steps.length)}</p>
        {/* The path is drawn left to right, then mirrored in Arabic so step 1 starts on the right. The numbers are flipped back so they stay readable. */}
        <ol className="relative h-14 w-full rtl:-scale-x-100">
          <Route n={steps.length} />
          {steps.map((title, i) => (
            <li key={title} className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: `${routeX(i, steps.length)}%` }}>
              <button
                type="button"
                title={title}
                aria-label={title}
                aria-current={i === at ? 'step' : undefined}
                onClick={() => setIndex(i)}
                className={cx(
                  'grid size-8 place-items-center rounded-full text-sm font-semibold tabular-nums rtl:-scale-x-100',
                  i === at ? 'bg-brand text-on-brand' : 'bg-card text-muted ring-1 ring-line hover:text-ink',
                )}
              >
                {i + 1}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <Card
        title={steps[at]}
        description={at === 0 ? f.numbersText : at === 1 ? f.poolText : at === 2 ? f.keyText : at === 3 ? f.callText : f.todayText}
      >
        {at === 0 ? (
          <div className="grid gap-3">
            {connected.length === 0 ? <p className="text-sm text-muted">{o.noSessions}</p> : null}
            <ul className="grid gap-2">
              {connected.map((s) => (
                <li key={s.id} className="flex items-center gap-3 rounded-2xl border border-line px-3 py-2.5">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface text-ink-2 ring-1 ring-line">
                    <Smartphone className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1 text-start">
                    <span className="block truncate font-medium"><bdi>{s.name}</bdi></span>
                    <span className="mt-0.5 block text-sm text-muted">{s.phoneNumber ? <Phone value={s.phoneNumber} /> : s.status}</span>
                  </span>
                  <SessionStatusBadge status={s.status} />
                </li>
              ))}
            </ul>
            <Link href="/sessions" className="text-sm font-medium text-brand underline-offset-4 hover:underline">{f.openSessions}</Link>
          </div>
        ) : null}

        {at === 1 ? (
          <div className="grid gap-4">
            {pools.isLoading ? <Loading /> : null}
            {pools.error ? <LoadError error={pools.error} onRetry={() => void pools.refetch()} /> : null}
            {!pools.isLoading && list.length === 0 ? <p className="text-sm text-muted">{o.emptyHint}</p> : null}
            {current ? (
              <PoolCard
                pool={current}
                pools={list}
                available={available}
                copy={o}
                onSelect={setSelected}
                onDefault={(id) => setDefault.mutate(id)}
                onPause={(pool) => patch.mutate({ id: pool.id, status: pool.status === 'active' ? 'paused' : 'active' })}
                onDelete={(id) => removePool.mutate(id)}
                onAdd={(id) => addMember.mutate(id)}
                onMember={(input) => member.mutate(input)}
              />
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button icon={<ShieldCheck className="size-4" />} onClick={() => setCreating(true)}>{o.create}</Button>
              {current ? <Button variant="ghost" onClick={() => setRules((open) => !open)}>{f.rules}</Button> : null}
            </div>
            {rules && current ? <SettingsPanel key={current.id} pool={current} copy={o} saving={patch.isPending} onSave={(body) => patch.mutate({ id: current.id, ...body })} /> : null}
          </div>
        ) : null}

        {at === 2 ? <div className="sm:max-w-md">{keyForm}</div> : null}

        {at === 3 ? (
          <div className="grid gap-3">
            <CallCard title={f.sendTitle} text={f.sendText} sample={'POST /api/v1/otp/send\n{"to":"+2010XXXXXXX","purpose":"login"}'} />
            <CallCard title={f.verifyTitle} text={f.verifyText} sample={'POST /api/v1/otp/verify\n{"requestId":"…","code":"123456"}'} />
            <CallCard title={f.statusTitle} text={f.statusText} sample={'GET /api/v1/otp/{requestId}'} />
          </div>
        ) : null}

        {at === 4 ? (
          <div className="grid gap-6">
            <OverviewPanel query={overview} copy={o} />
            <div>
              <h3 className="text-base font-semibold">{f.logsTitle}</h3>
              <p className="mt-1 mb-3 text-sm text-muted">{f.logsText}</p>
              <LogsPanel query={logs} copy={o} />
            </div>
          </div>
        ) : null}

        <div className="mt-6 flex items-center justify-between gap-3">
          <Button variant="ghost" disabled={at === 0} icon={<ChevronLeft className={cx('size-4', flip)} />} onClick={() => setIndex((i) => Math.max(0, i - 1))}>{f.back}</Button>
          {at < steps.length - 1 ? (
            <Button variant="brand" onClick={() => setIndex((i) => Math.min(steps.length - 1, i + 1))}>
              {f.next}
              <ChevronRight className={cx('size-4', flip)} />
            </Button>
          ) : <span />}
        </div>
      </Card>

      {sharedModals}
    </div>
  );
}

/** Centers of the step dots, as a percent of the route width. Matches `Route`. */
function routeX(i: number, n: number) {
  const w = 400;
  const r = 16;
  return ((r + (i / (n - 1)) * (w - r * 2)) / w) * 100;
}

/** One dashed curve between the steps, like a path on a map. The dots cover where it passes through them. */
function Route({ n }: { n: number }) {
  const w = 400;
  const h = 56;
  const r = 16;
  const y = h / 2;
  const xs = Array.from({ length: n }, (_, i) => r + (i / (n - 1)) * (w - r * 2));
  let d = `M ${xs[0]} ${y}`;
  for (let i = 0; i < n - 1; i++) {
    const x0 = xs[i]!;
    const x1 = xs[i + 1]!;
    const bow = i % 2 === 0 ? -16 : 16;
    d += ` Q ${(x0 + x1) / 2} ${y + bow} ${x1} ${y}`;
  }
  return (
    <svg aria-hidden viewBox={`0 0 ${w} ${h}`} className="pointer-events-none absolute inset-0 h-full w-full text-line" preserveAspectRatio="none">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeDasharray="7 8" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function NumberPicker({ sessions, picked, onToggle, empty, label }: { sessions: Session[]; picked: string[]; onToggle: (id: string, on: boolean) => void; empty: string; label: string }) {
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium">{label}</legend>
      {sessions.length === 0 ? <p className="text-sm text-muted">{empty}</p> : null}
      {sessions.map((s) => {
        const on = picked.includes(s.id);
        return (
          <button
            key={s.id}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(s.id, !on)}
            className={cx(
              'flex items-center gap-3 rounded-2xl border px-3 py-2.5 text-start transition-colors',
              on ? 'border-brand bg-brand/10' : 'border-line bg-card hover:border-line-strong',
            )}
          >
            <span className={cx('grid size-5 shrink-0 place-items-center rounded-md border', on ? 'border-brand bg-brand text-on-brand' : 'border-line-strong bg-card')}>
              {on ? <Check className="size-3.5" strokeWidth={3} /> : null}
            </span>
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface text-ink-2 ring-1 ring-line">
              <Smartphone className="size-4" />
            </span>
            <span className="min-w-0 flex-1 text-start">
              <span className="block truncate font-medium"><bdi>{s.name}</bdi></span>
              <span className="mt-0.5 block text-sm text-muted">{s.phoneNumber ? <Phone value={s.phoneNumber} /> : s.status}</span>
            </span>
            <SessionStatusBadge status={s.status} />
          </button>
        );
      })}
    </fieldset>
  );
}

function CallCard({ title, text, sample }: { title: string; text: string; sample: string }) {
  return (
    <div className="rounded-2xl border border-line px-4 py-3">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted">{text}</p>
      <pre className="ltr mt-3 overflow-x-auto rounded-xl bg-bg/60 p-3 text-xs leading-6">{sample}</pre>
    </div>
  );
}

function OverviewPanel({ query, copy }: { query: { isLoading: boolean; error: unknown; data?: Overview; refetch: () => void }; copy: ReturnType<typeof useI18n>['t']['otp'] }) {
  const { fmt } = useI18n();
  if (query.isLoading) return <Loading />;
  if (query.error) return <LoadError error={query.error} onRetry={query.refetch} />;
  const c = query.data?.counts;
  const daily = query.data?.limits.daily;
  const n = (value: number) => fmt.number.format(value);
  const tiles: [string, string][] = [
    [copy.stats.queued, n(c?.queued ?? 0)],
    [copy.stats.sent, n(c?.sent ?? 0)],
    [copy.stats.verified, n(c?.verified ?? 0)],
    [copy.stats.failed, n(c?.failed ?? 0)],
    [copy.stats.usage, `${n(query.data?.usageToday ?? 0)} / ${daily == null ? copy.stats.unlimited : n(daily)}`],
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {tiles.map(([label, value]) => (
        <Card key={label}>
          <p className="text-sm text-muted">{label}</p>
          <p className="ltr text-2xl font-semibold">{value}</p>
        </Card>
      ))}
    </div>
  );
}

function PoolCard(props: {
  pools: Pool[];
  pool: Pool;
  onSelect: (id: string) => void;
  available: Session[];
  copy: ReturnType<typeof useI18n>['t']['otp'];
  onDefault: (id: string) => void;
  onPause: (pool: Pool) => void;
  onDelete: (id: string) => void;
  onAdd: (sessionId: string) => void;
  onMember: (input: { sessionId: string; enabled?: boolean; remove?: boolean }) => void;
}) {
  const { copy, pool } = props;
  const [add, setAdd] = useState('');
  return (
    <div className="grid gap-4">
      {props.pools.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {props.pools.map((p) => (
            <button key={p.id} type="button" className={cx('rounded-full border px-3 py-1 text-sm', p.id === pool.id ? 'border-brand bg-brand/10' : 'border-line')} onClick={() => props.onSelect(p.id)}>
              {p.name}
              {p.is_default ? ` · ${copy.default}` : ''}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!pool.is_default ? <Button size="sm" variant="outline" onClick={() => props.onDefault(pool.id)}>{copy.makeDefault}</Button> : <Badge tone="good">{copy.default}</Badge>}
        <Button size="sm" variant="outline" onClick={() => props.onPause(pool)}>{pool.status === 'active' ? copy.pause : copy.resume}</Button>
        <Button size="sm" variant="ghost" onClick={() => props.onDelete(pool.id)}>{copy.remove}</Button>
      </div>
      {pool.members.length === 0 ? <p className="text-sm text-muted">{copy.noSessions}</p> : null}
      <ul className="grid gap-2">
        {pool.members.map((m) => (
          <li key={m.session_id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line px-3 py-2">
            <div>
              <p className="font-medium">{m.name}{m.enabled ? '' : ` · ${copy.disable}`}</p>
              <p className="ltr text-sm text-muted">{m.phone ?? ''}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={m.status === 'connected' ? 'good' : 'warning'}>{m.status === 'connected' ? copy.connected : copy.other}</Badge>
              {m.membership === 'draining' ? <Badge tone="progress">{copy.draining}</Badge> : null}
              <Button size="sm" variant="outline" onClick={() => props.onMember({ sessionId: m.session_id, enabled: !m.enabled })}>{m.enabled ? copy.disable : copy.enable}</Button>
              <Button size="sm" variant="ghost" onClick={() => props.onMember({ sessionId: m.session_id, remove: true })}>{copy.removeSession}</Button>
            </div>
          </li>
        ))}
      </ul>
      {props.available.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2">
          <Select
            label={copy.addSession}
            value={add}
            onChange={setAdd}
            options={[{ value: '', label: copy.addSession }, ...props.available.map((s) => ({ value: s.id, label: s.name }))]}
          />
          <Button disabled={!add} onClick={() => { props.onAdd(add); setAdd(''); }}>{copy.addSession}</Button>
        </div>
      ) : null}
    </div>
  );
}

function LogsPanel({ query, copy }: { query: { isLoading: boolean; error: unknown; data?: { logs: LogRow[] }; refetch: () => void }; copy: ReturnType<typeof useI18n>['t']['otp'] }) {
  const { fmt } = useI18n();
  if (query.isLoading) return <Loading />;
  if (query.error) return <LoadError error={query.error} onRetry={query.refetch} />;
  const rows = query.data?.logs ?? [];
  if (rows.length === 0) return <EmptyState icon={ShieldCheck} title={copy.logsEmpty} />;
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-start text-muted">
              <th className="px-2 py-2 text-start">{copy.to}</th>
              <th className="px-2 py-2 text-start">{copy.purpose}</th>
              <th className="px-2 py-2 text-start">{copy.delivery}</th>
              <th className="px-2 py-2 text-start">{copy.verification}</th>
              <th className="px-2 py-2 text-start">{copy.failure}</th>
              <th className="px-2 py-2 text-start">{copy.created}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.requestId} className="border-t border-line">
                <td className="ltr px-2 py-2">{row.to}</td>
                <td className="px-2 py-2">{row.purpose}</td>
                <td className="px-2 py-2">{row.deliveryStatus}</td>
                <td className="px-2 py-2">{row.verifyStatus}</td>
                <td className="px-2 py-2">{row.failure ?? '—'}</td>
                <td className="px-2 py-2 whitespace-nowrap">{fmt.dateTime(row.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function SettingsPanel({ pool, copy, saving, onSave }: { pool: Pool; copy: ReturnType<typeof useI18n>['t']['otp']; saving: boolean; onSave: (body: Record<string, number>) => void }) {
  const [codeLength, setCodeLength] = useState(String(pool.code_length));
  const [ttl, setTtl] = useState(String(pool.ttl_seconds));
  const [attempts, setAttempts] = useState(String(pool.max_attempts));
  const [cooldown, setCooldown] = useState(String(pool.resend_cooldown_sec));
  const [maxSends, setMaxSends] = useState(String(pool.max_sends));
  return (
    <form
      className="grid gap-4 rounded-2xl border border-line p-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          codeLength: Number(codeLength),
          ttlSeconds: Number(ttl),
          maxAttempts: Number(attempts),
          resendCooldownSec: Number(cooldown),
          maxSends: Number(maxSends),
        });
      }}
    >
      <p className="text-sm text-muted sm:col-span-2">{copy.settingsHint}</p>
      <Field label={copy.codeLength} type="number" min={4} max={8} value={codeLength} onChange={(e) => setCodeLength(e.target.value)} />
      <Field label={copy.ttl} type="number" min={60} max={600} value={ttl} onChange={(e) => setTtl(e.target.value)} />
      <Field label={copy.attempts} type="number" min={1} max={10} value={attempts} onChange={(e) => setAttempts(e.target.value)} />
      <Field label={copy.cooldown} type="number" min={30} max={600} value={cooldown} onChange={(e) => setCooldown(e.target.value)} />
      <Field label={copy.maxSends} type="number" min={1} max={5} value={maxSends} onChange={(e) => setMaxSends(e.target.value)} />
      <div className="flex items-end"><Button type="submit" variant="brand" loading={saving}>{copy.save}</Button></div>
    </form>
  );
}
