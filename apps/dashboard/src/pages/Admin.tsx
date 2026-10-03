import { getPlan, PLANS } from '@wa/shared/plans';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Ban, CircleDollarSign, History, Hourglass, Inbox, MessageSquare, Search, Smartphone, Users } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { useAccount } from '../app/account';
import { useI18n } from '../i18n';
import { qk } from '../queries';
import { Badge, Button, Card, cx, delay, EmptyState, ErrorNote, Field, inputClass, Loading, LoadError, Modal, PageHeader, Pagination, Select, usePlanName } from '../ui';

type Stats = {
  users: number;
  suspended: number;
  workspaces: number;
  activePaid: number;
  sessions: number;
  connected: number;
  pendingRequests: number;
  messagesToday: number;
  byPlan: Record<string, number>;
};

type AdminUser = {
  id: string;
  name: string | null;
  email: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended';
  suspendedAt: string | null;
  suspendedReason: string | null;
  phone: string | null;
  phoneVerified: boolean;
  createdAt: string;
  workspace: { id: string; name: string; planId: string; trialEndsAt: string | null; planExpiresAt: string | null } | null;
  workspaces: number;
  sessions: number;
  connected: number;
  messages30d: number;
};

type AdminRequest = {
  id: string;
  planId: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  note: string | null;
  createdAt: string;
  workspace: { id: string; name: string; planId: string; ownerEmail: string | null };
};

type AuditEntry = {
  id: number;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  targetLabel: string | null;
  details: Record<string, unknown>;
  createdAt: string;
};

type Page<T> = { items: T[]; total: number; page: number; pageSize: number };

/** Activation lengths offered to the admin; null = no end date. */
const DURATIONS = [1, 3, 6, 12, null] as const;
type Duration = (typeof DURATIONS)[number];
const PAGE_SIZE = 25;

/** The value, once it has stopped changing for `ms` (search as you type without a request per key). */
function useDebounced<T>(value: T, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Admin changes can touch the admin's own account too (e.g. their plan): refresh both. */
function useRefreshAdmin() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: qk.admin.all });
    void queryClient.invalidateQueries({ queryKey: qk.me });
  };
}

function DurationSelect({ value, onChange, label }: { value: Duration; onChange: (v: Duration) => void; label?: string }) {
  const { t } = useI18n();
  return (
    <Select
      label={label}
      value={value === null ? 'none' : String(value)}
      onChange={(v) => onChange(v === 'none' ? null : (Number(v) as Duration))}
      options={DURATIONS.map((d) => ({ value: d === null ? 'none' : String(d), label: d === null ? t.admin.planModal.noExpiry : t.admin.planModal.months(d) }))}
    />
  );
}

function StatCard({ icon: Icon, label, value, index, accent }: { icon: typeof Users; label: string; value: string; index: number; accent?: 'info' | 'danger' }) {
  return (
    <div
      className={cx(
        'lift animate-fade-up flex items-center gap-4 rounded-xl border bg-card p-5 shadow-sm',
        accent === 'info' ? 'border-sky-500/40' : accent === 'danger' ? 'border-red-500/40' : 'border-line',
      )}
      style={delay(index * 60)}
    >
      <span
        className={cx(
          'flex size-11 items-center justify-center rounded-lg',
          accent === 'info' ? 'bg-sky-500/15 text-sky-300' : accent === 'danger' ? 'bg-red-500/15 text-red-300' : 'bg-raised text-brand',
        )}
      >
        <Icon className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm text-muted">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
      </div>
    </div>
  );
}

function Requests() {
  const { t, fmt } = useI18n();
  const r = t.admin.requests;
  const planName = usePlanName();
  const refresh = useRefreshAdmin();
  const [durations, setDurations] = useState<Record<string, Duration>>({});
  const requests = useQuery({ queryKey: qk.admin.requests, queryFn: ({ signal }) => api<AdminRequest[]>('/api/admin/plan-requests?status=pending', { signal }) });

  const decide = useMutation({
    mutationFn: ({ req, approve, note }: { req: AdminRequest; approve: boolean; note?: string }) =>
      api(`/api/admin/plan-requests/${req.id}/${approve ? 'approve' : 'reject'}`, {
        method: 'POST',
        body: approve ? { months: durations[req.id] === undefined ? 1 : durations[req.id] } : { note },
      }),
    onSettled: refresh,
  });

  const reject = (req: AdminRequest) => {
    const answer = prompt(r.rejectPrompt);
    if (answer !== null) decide.mutate({ req, approve: false, note: answer.trim() || undefined });
  };
  const busy = decide.isPending ? decide.variables.req.id : null;

  return (
    <Card title={r.title} description={r.text} className="animate-fade-up" style={delay(200)}>
      <ErrorNote>{decide.isError ? errorMessage(decide.error) : null}</ErrorNote>
      {requests.isError && <LoadError error={requests.error} onRetry={() => void requests.refetch()} retrying={requests.isFetching} />}
      {!requests.data ? (
        !requests.isError && <Loading />
      ) : requests.data.length === 0 ? (
        <EmptyState icon={Inbox} title={r.empty} />
      ) : (
        <ul className="divide-y divide-line">
          {requests.data.map((req, i) => (
            <li key={req.id} className="animate-fade-up flex flex-wrap items-center gap-4 py-4" style={delay(i * 60)}>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {req.workspace.name}
                  <Badge tone="info">{r.wants(planName(getPlan(req.planId)))}</Badge>
                </p>
                <p className="text-sm text-muted">
                  {req.workspace.ownerEmail && <span className="ltr">{req.workspace.ownerEmail}</span>} · {r.currentPlan(planName(getPlan(req.workspace.planId)))} ·{' '}
                  {fmt.timeAgo(req.createdAt)}
                </p>
                {req.note && <p className="rounded-md bg-raised/40 px-3 py-2 text-sm text-ink-2">{req.note}</p>}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div className="w-36">
                  <DurationSelect label={r.duration} value={durations[req.id] === undefined ? 1 : durations[req.id]!} onChange={(v) => setDurations((d) => ({ ...d, [req.id]: v }))} />
                </div>
                <Button variant="brand" loading={busy === req.id && decide.variables?.approve} disabled={busy !== null} onClick={() => decide.mutate({ req, approve: true })}>
                  {r.approve}
                </Button>
                <Button variant="ghost" disabled={busy !== null} onClick={() => reject(req)} className="text-red-400 hover:text-red-300">
                  {r.reject}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ChangePlan({ user, onClose }: { user: AdminUser & { workspace: NonNullable<AdminUser['workspace']> }; onClose: () => void }) {
  const { t } = useI18n();
  const m = t.admin.planModal;
  const planName = usePlanName();
  const refresh = useRefreshAdmin();
  const [planId, setPlanId] = useState(user.workspace.planId);
  const [months, setMonths] = useState<Duration>(planId === 'unlimited' ? null : 1);
  const save = useMutation({
    mutationFn: () => api(`/api/admin/workspaces/${user.workspace.id}/plan`, { method: 'PUT', body: { planId, months: planId === 'trial' ? null : months } }),
    onSuccess: onClose,
    onSettled: refresh,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!save.isPending) save.mutate();
  };

  return (
    <Modal title={m.title(user.workspace.name)} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Select
          label={m.plan}
          value={planId}
          onChange={(next) => {
            setPlanId(next);
            if (next === 'unlimited') setMonths(null);
          }}
          options={Object.values(PLANS).map((p) => ({
            value: p.id,
            label: (
              <span className="flex items-center gap-2">
                {planName(p)}
                {p.priceUsd ? <span className="ltr text-muted">${p.priceUsd}</span> : null}
              </span>
            ),
          }))}
        />
        {planId === 'trial' ? (
          <p className="text-sm text-muted">{m.trialNote}</p>
        ) : (
          <>
            <DurationSelect label={m.duration} value={months} onChange={setMonths} />
            {planId === user.workspace.planId && <p className="text-sm text-muted">{m.renewNote}</p>}
          </>
        )}
        <ErrorNote>{save.isError ? errorMessage(save.error) : null}</ErrorNote>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" variant="brand" loading={save.isPending}>
            {m.submit}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SuspendUser({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const { t } = useI18n();
  const s = t.admin.suspendModal;
  const refresh = useRefreshAdmin();
  const [reason, setReason] = useState('');
  const suspend = useMutation({
    mutationFn: () => api(`/api/admin/users/${user.id}/suspend`, { method: 'POST', body: { reason } }),
    onSuccess: onClose,
    onSettled: refresh,
  });

  return (
    <Modal title={s.title(user.email)} description={s.text} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!suspend.isPending) suspend.mutate();
        }}
        className="space-y-4"
      >
        <Field label={s.reason} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required autoFocus />
        <ErrorNote>{suspend.isError ? errorMessage(suspend.error) : null}</ErrorNote>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" variant="danger" loading={suspend.isPending} disabled={!reason.trim()}>
            {s.submit}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteUser({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const { t } = useI18n();
  const m = t.admin.deleteModal;
  const refresh = useRefreshAdmin();
  const [typed, setTyped] = useState('');
  const matches = typed.trim().toLowerCase() === user.email.toLowerCase();
  const remove = useMutation({
    // Unlinking devices can take a few seconds per session.
    mutationFn: () => api(`/api/admin/users/${user.id}`, { method: 'DELETE', body: { confirmEmail: typed.trim() }, timeoutMs: 45_000 }),
    onSuccess: onClose,
    onSettled: refresh,
  });

  return (
    <Modal title={m.title(user.email)} description={m.text} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (matches && !remove.isPending) remove.mutate();
        }}
        className="space-y-4"
      >
        <Field label={m.confirm(user.email)} value={typed} onChange={(e) => setTyped(e.target.value)} dir="ltr" autoComplete="off" required autoFocus />
        <ErrorNote>{remove.isError ? errorMessage(remove.error) : null}</ErrorNote>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" variant="danger" loading={remove.isPending} disabled={!matches}>
            {m.submit}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function UsersTable({ selfId }: { selfId: string | null }) {
  const { t, fmt } = useI18n();
  const u = t.admin.users;
  const w = t.admin.workspaces;
  const planName = usePlanName();
  const refresh = useRefreshAdmin();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'suspended'>('all');
  const q = useDebounced(search.trim(), 300);
  // The page belongs to one search: a new search or filter starts again at page 1.
  const filters = `${q}|${status}`;
  const [paging, setPaging] = useState({ filters, page: 1 });
  const page = paging.filters === filters ? paging.page : 1;
  const setPage = (next: number) => setPaging({ filters, page: next });
  const [dialog, setDialog] = useState<{ kind: 'plan' | 'suspend' | 'delete'; user: AdminUser } | null>(null);

  // Each search/page is its own cache entry, so a slow older response can never overwrite a newer one.
  const params = { q, status, page };
  const users = useQuery({
    queryKey: qk.admin.users(params),
    queryFn: ({ signal }) => {
      const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (q) query.set('q', q);
      if (status !== 'all') query.set('status', status);
      return api<Page<AdminUser>>(`/api/admin/users?${query}`, { signal });
    },
    placeholderData: keepPreviousData,
  });

  const reactivate = useMutation({
    mutationFn: (user: AdminUser) => api(`/api/admin/users/${user.id}/reactivate`, { method: 'POST' }),
    onSettled: refresh,
  });

  const ends = (user: AdminUser) => {
    const ws = user.workspace;
    if (!ws) return '—';
    if (ws.planId === 'trial') return ws.trialEndsAt ? w.trialEnds(fmt.date(ws.trialEndsAt)) : '—';
    if (!ws.planExpiresAt) return w.noExpiry;
    const expired = new Date(ws.planExpiresAt).getTime() < Date.now();
    return expired ? <span className="text-red-400">{`${w.expired} · ${fmt.date(ws.planExpiresAt)}`}</span> : fmt.date(ws.planExpiresAt);
  };

  const th = 'h-10 px-2 text-start font-medium whitespace-nowrap text-muted';
  const td = 'p-2 whitespace-nowrap align-top';
  const data = users.data;

  return (
    <Card
      title={u.title}
      className="animate-fade-up"
      style={delay(260)}
      bodyClassName="px-4"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative block w-64 max-w-full">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={u.search} className={cx(inputClass, 'ps-8')} />
          </label>
          <Select
            value={status}
            onChange={setStatus}
            className="w-40"
            aria-label={u.cols.status}
            options={[
              { value: 'all', label: u.statusAll },
              { value: 'active', label: u.statusActive },
              { value: 'suspended', label: u.statusSuspended },
            ]}
          />
        </div>
      }
    >
      <ErrorNote>{reactivate.isError ? errorMessage(reactivate.error) : null}</ErrorNote>
      {users.isError && <LoadError error={users.error} onRetry={() => void users.refetch()} retrying={users.isFetching} className="mb-4" />}
      {!data ? (
        !users.isError && <Loading />
      ) : data.items.length === 0 ? (
        <EmptyState icon={Users} title={u.empty} />
      ) : (
        <div className={cx('overflow-x-auto transition-opacity', users.isPlaceholderData && 'opacity-60')}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className={th}>{u.cols.user}</th>
                <th className={th}>{u.cols.status}</th>
                <th className={th}>{u.cols.plan}</th>
                <th className={th}>{u.cols.expires}</th>
                <th className={th}>{u.cols.sessions}</th>
                <th className={th}>{u.cols.messages}</th>
                <th className={th}>{u.cols.joined}</th>
                <th className={th}>
                  <span className="sr-only">{u.actions}</span>
                </th>
              </tr>
            </thead>
            <tbody className="[&_tr]:border-b [&_tr]:border-line [&_tr:last-child]:border-0">
              {data.items.map((row, i) => {
                const isSelf = row.id === selfId;
                const manageable = !isSelf && row.role !== 'admin';
                const workspace = row.workspace;
                return (
                  <tr key={row.id} className="animate-fade-up transition-colors hover:bg-raised/30" style={delay(Math.min(i, 12) * 35)}>
                    <td className={td}>
                      <p className="flex items-center gap-1.5 font-medium">
                        {row.name ?? row.email}
                        {row.role === 'admin' && <Badge tone="good">{t.app.admin}</Badge>}
                        {isSelf && <Badge tone="neutral">{u.you}</Badge>}
                      </p>
                      <p className="ltr text-xs text-muted">{row.email}</p>
                      <p className="mt-0.5 flex items-center gap-1 text-xs">
                        <Smartphone className="size-3 text-muted" />
                        {row.phone && row.phoneVerified ? <span className="ltr text-muted">{row.phone}</span> : <span className="text-amber-400">{u.phoneUnverified}</span>}
                      </p>
                    </td>
                    <td className={td}>
                      {row.status === 'suspended' ? (
                        <div className="space-y-1">
                          <Badge tone="critical">{u.statusSuspended}</Badge>
                          {row.suspendedAt && <p className="text-xs text-muted">{u.suspendedSince(fmt.date(row.suspendedAt))}</p>}
                          {row.suspendedReason && <p className="max-w-56 truncate text-xs text-muted" title={row.suspendedReason}>{row.suspendedReason}</p>}
                        </div>
                      ) : (
                        <Badge tone="good">{u.statusActive}</Badge>
                      )}
                    </td>
                    <td className={td}>
                      {workspace ? (
                        <Badge tone={workspace.planId === 'trial' ? 'neutral' : workspace.planId === 'unlimited' ? 'good' : 'info'}>{planName(getPlan(workspace.planId))}</Badge>
                      ) : (
                        <span className="text-muted">{u.noWorkspace}</span>
                      )}
                    </td>
                    <td className={td}>{ends(row)}</td>
                    <td className={`${td} tabular-nums`}>
                      {row.connected}/{row.sessions}
                    </td>
                    <td className={`${td} tabular-nums`}>{fmt.number.format(row.messages30d)}</td>
                    <td className={td}>{fmt.date(row.createdAt)}</td>
                    <td className={`${td} text-end`}>
                      <div className="flex justify-end gap-1">
                        {workspace && (
                          <Button variant="outline" size="sm" onClick={() => setDialog({ kind: 'plan', user: row })}>
                            {u.changePlan}
                          </Button>
                        )}
                        {manageable &&
                          (row.status === 'suspended' ? (
                            <Button
                              variant="outline"
                              size="sm"
                              loading={reactivate.isPending && reactivate.variables?.id === row.id}
                              onClick={() => confirm(u.reactivateConfirm(row.email)) && reactivate.mutate(row)}
                            >
                              {u.reactivate}
                            </Button>
                          ) : (
                            <Button variant="ghost" size="sm" icon={<Ban className="size-4" />} onClick={() => setDialog({ kind: 'suspend', user: row })} className="text-amber-400 hover:text-amber-300">
                              {u.suspend}
                            </Button>
                          ))}
                        {manageable && (
                          <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: 'delete', user: row })} className="text-red-400 hover:text-red-300">
                            {u.delete}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} busy={users.isFetching} />
        </div>
      )}
      {dialog?.kind === 'plan' && dialog.user.workspace && <ChangePlan user={{ ...dialog.user, workspace: dialog.user.workspace }} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'suspend' && <SuspendUser user={dialog.user} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && <DeleteUser user={dialog.user} onClose={() => setDialog(null)} />}
    </Card>
  );
}

function AuditLog() {
  const { t, fmt } = useI18n();
  const a = t.admin.audit;
  const [page, setPage] = useState(1);
  const log = useQuery({
    queryKey: qk.admin.audit(page),
    queryFn: ({ signal }) => api<Page<AuditEntry>>(`/api/admin/audit-logs?page=${page}&pageSize=${PAGE_SIZE}`, { signal }),
    placeholderData: keepPreviousData,
  });
  const data = log.data;

  return (
    <Card title={a.title} description={a.text} className="animate-fade-up" style={delay(320)}>
      {log.isError && <LoadError error={log.error} onRetry={() => void log.refetch()} retrying={log.isFetching} />}
      {!data ? (
        !log.isError && <Loading />
      ) : data.items.length === 0 ? (
        <EmptyState icon={History} title={a.empty} />
      ) : (
        <>
          <ul className={cx('divide-y divide-line transition-opacity', log.isPlaceholderData && 'opacity-60')}>
            {data.items.map((entry) => {
              const reason = typeof entry.details.reason === 'string' ? entry.details.reason : null;
              return (
                <li key={entry.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3 text-sm">
                  <div className="min-w-0 space-y-0.5">
                    <p>
                      <span className="font-medium">{a.actions[entry.action] ?? entry.action}</span>
                      {entry.targetLabel && (
                        <>
                          {' · '}
                          <bdi className="ltr text-ink-2">{entry.targetLabel}</bdi>
                        </>
                      )}
                    </p>
                    {reason && <p className="text-xs text-muted">{reason}</p>}
                    {entry.actorEmail && <p className="text-xs text-faint">{a.by(entry.actorEmail)}</p>}
                  </div>
                  <span className="text-xs whitespace-nowrap text-muted">{fmt.dateTime(entry.createdAt)}</span>
                </li>
              );
            })}
          </ul>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} busy={log.isFetching} />
        </>
      )}
    </Card>
  );
}

export function AdminPage() {
  const { t, fmt } = useI18n();
  const a = t.admin;
  const { account } = useAccount();
  const isAdmin = Boolean(account?.user?.isAdmin);
  // The server refuses non-admins anyway; this only avoids pointless requests and a broken page.
  const stats = useQuery({ queryKey: qk.admin.stats, queryFn: ({ signal }) => api<Stats>('/api/admin/stats', { signal }), enabled: isAdmin });

  if (account && !isAdmin) return <ErrorNote>{a.forbidden}</ErrorNote>;

  const n = (v: number | undefined) => (v === undefined ? '…' : fmt.number.format(v));
  const s = stats.data;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader title={a.title} description={a.description} />
      {stats.isError && <LoadError error={stats.error} onRetry={() => void stats.refetch()} retrying={stats.isFetching} />}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard index={0} icon={Users} label={a.stats.users} value={n(s?.users)} />
        <StatCard index={1} icon={Activity} label={a.stats.workspaces} value={n(s?.workspaces)} />
        <StatCard index={2} icon={CircleDollarSign} label={a.stats.activePaid} value={n(s?.activePaid)} />
        <StatCard index={3} icon={Smartphone} label={a.stats.sessions} value={s ? `${n(s.connected)} / ${n(s.sessions)}` : '…'} />
        <StatCard index={4} icon={Hourglass} label={a.stats.pending} value={n(s?.pendingRequests)} accent={s?.pendingRequests ? 'info' : undefined} />
        <StatCard index={5} icon={MessageSquare} label={a.stats.messagesToday} value={n(s?.messagesToday)} />
        <StatCard index={6} icon={Ban} label={a.stats.suspended} value={n(s?.suspended)} accent={s?.suspended ? 'danger' : undefined} />
      </div>
      <Requests />
      <UsersTable selfId={account?.user?.id ?? null} />
      <AuditLog />
    </div>
  );
}
