import { DEFAULT_PLAN_PRICING, listedPriceUsd } from '@wa/shared/plan-pricing';
import { DEFAULT_PAYMENT_SETTINGS, enabledPaymentMethods, PAYMENT_METHODS, type PaymentMethod, type PaymentSettings, planPriceEgp } from '@wa/shared/payments';
import { getPlan, PLANS } from '@wa/shared/plans';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  BadgePercent,
  Ban,
  CircleDollarSign,
  CreditCard,
  History,
  Hourglass,
  ImageOff,
  Inbox,
  LayoutGrid,
  MessageSquare,
  MessageSquareText,
  MonitorPlay,
  Search,
  Smartphone,
  Users,
  ZoomIn,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { type PlanRequest, useAccount } from '../app/account';
import { usePlanPricing } from '../app/plan-pricing';
import { METHOD_LOOK, MethodChip, MethodGlyph, PaymentDetailsRows, usePaymentSettings } from '../app/payments/methods';
import { useI18n } from '../i18n';
import { qk } from '../queries';
import { PlanPricingSettings } from './AdminPricing';
import { SiteSettingsCard } from './AdminSite';
import { TemplatePreview } from './Templates';
import { Badge, Button, Card, cx, delay, EmptyState, ErrorNote, Field, inputClass, Loading, LoadError, Modal, PageHeader, Pagination, Select, SuccessNote, TextArea, usePlanName } from '../ui';

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

type AdminRequest = PlanRequest & {
  workspace: { id: string; name: string; planId: string; ownerEmail: string | null; ownerPhone: string | null };
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

type Tab = 'overview' | 'users' | 'payments' | 'pricing' | 'messages' | 'site' | 'audit';
const TABS: { id: Tab; icon: typeof Users }[] = [
  { id: 'overview', icon: LayoutGrid },
  { id: 'users', icon: Users },
  { id: 'payments', icon: CreditCard },
  { id: 'pricing', icon: BadgePercent },
  { id: 'messages', icon: MessageSquareText },
  { id: 'site', icon: MonitorPlay },
  { id: 'audit', icon: History },
];

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

// --- stats strip ---------------------------------------------------------------------------------

function Stat({ icon: Icon, label, value, index, accent }: { icon: typeof Users; label: string; value: string; index: number; accent?: 'info' | 'danger' | 'brand' }) {
  return (
    <div className="animate-fade-up flex min-w-0 items-center gap-3 px-4 py-3.5" style={delay(index * 50)}>
      <span
        className={cx(
          'flex size-9 shrink-0 items-center justify-center rounded-lg',
          accent === 'info' ? 'bg-info/15 text-info' : accent === 'danger' ? 'bg-critical/15 text-critical' : accent === 'brand' ? 'bg-brand/15 text-brand' : 'bg-raised text-muted',
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-[11px] font-medium tracking-wide text-muted uppercase">{label}</p>
        <p className="text-xl leading-tight font-semibold whitespace-nowrap tabular-nums">{value}</p>
      </div>
    </div>
  );
}

// --- plan requests -------------------------------------------------------------------------------

/** Initials of a workspace name for its avatar tile. */
const initialsOf = (name: string) => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
};

function ProofThumb({ req, onOpen }: { req: AdminRequest; onOpen: () => void }) {
  const { t } = useI18n();
  const r = t.admin.requests;
  const [broken, setBroken] = useState(false);
  if (!req.hasProof || broken) {
    return (
      <span className="flex h-24 w-32 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line text-[11px] text-faint">
        <ImageOff className="size-4" />
        {r.noProof}
      </span>
    );
  }
  return (
    <button type="button" onClick={onOpen} className="group relative h-24 w-32 shrink-0 overflow-hidden rounded-lg border border-line bg-black/30" aria-label={r.viewProof}>
      <img src={`/api/admin/plan-requests/${req.id}/proof`} alt="" loading="lazy" onError={() => setBroken(true)} className="size-full object-cover transition-transform duration-300 group-hover:scale-105" />
      <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
        <ZoomIn className="size-5 text-white" />
      </span>
    </button>
  );
}

function ProofLightbox({ req, onClose }: { req: AdminRequest; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Modal title={t.admin.requests.proofTitle(req.workspace.name)} onClose={onClose} size="xl">
      <div className="flex flex-col gap-4 pb-6 lg:flex-row">
        <img src={`/api/admin/plan-requests/${req.id}/proof`} alt="" className="max-h-[70svh] min-w-0 flex-1 rounded-lg bg-black/40 object-contain" />
        {req.payment && (
          <div className="w-full shrink-0 space-y-3 lg:w-72">
            <MethodChip method={req.payment.method} />
            <PaymentDetailsRows payment={req.payment} />
            {req.note && <p className="rounded-md bg-raised/40 px-3 py-2 text-sm text-ink-2">{req.note}</p>}
          </div>
        )}
      </div>
    </Modal>
  );
}

function RejectRequest({ req, onClose }: { req: AdminRequest; onClose: () => void }) {
  const { t } = useI18n();
  const r = t.admin.requests;
  const refresh = useRefreshAdmin();
  const [note, setNote] = useState('');
  const reject = useMutation({
    mutationFn: () => api(`/api/admin/plan-requests/${req.id}/reject`, { method: 'POST', body: { note: note.trim() || undefined } }),
    onSuccess: onClose,
    onSettled: refresh,
  });
  return (
    <Modal title={r.rejectTitle(req.workspace.name)} description={r.rejectText} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!reject.isPending) reject.mutate();
        }}
        className="space-y-4"
      >
        <Field label={r.rejectReason} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} autoFocus />
        <ErrorNote>{reject.isError ? errorMessage(reject.error) : null}</ErrorNote>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" variant="danger" loading={reject.isPending}>
            {r.rejectSubmit}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const REQUEST_TONES = { pending: 'info', approved: 'good', rejected: 'critical', cancelled: 'neutral' } as const;

function RequestCard({ req, index, egpPerUsd, onProof, onReject }: { req: AdminRequest; index: number; egpPerUsd: number; onProof: () => void; onReject: () => void }) {
  const { t, fmt } = useI18n();
  const r = t.admin.requests;
  const p = t.subscription.payment;
  const planName = usePlanName();
  const refresh = useRefreshAdmin();
  const pricing = usePlanPricing();
  const [months, setMonths] = useState<Duration>((DURATIONS as readonly (number | null)[]).includes(req.months) ? (req.months as Duration) : 1);
  const approve = useMutation({
    mutationFn: () => api(`/api/admin/plan-requests/${req.id}/approve`, { method: 'POST', body: { months } }),
    onSettled: refresh,
  });
  const plan = getPlan(req.planId);
  const expected = planPriceEgp(listedPriceUsd(req.planId, pricing.data ?? DEFAULT_PLAN_PRICING), req.months, egpPerUsd);
  const pending = req.status === 'pending';
  const look = req.payment ? METHOD_LOOK[req.payment.method] : null;

  return (
    <li className="animate-fade-up overflow-hidden rounded-xl border border-line bg-card shadow-sm" style={delay(Math.min(index, 8) * 60)}>
      <div className="flex flex-wrap items-start gap-4 p-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-raised to-line-strong text-sm font-semibold">{initialsOf(req.workspace.name)}</span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{req.workspace.name}</span>
            <Badge tone="info">{r.wants(planName(plan))}</Badge>
            <span className="text-xs text-muted">{r.paidFor(req.months)}</span>
            {!pending && <Badge tone={REQUEST_TONES[req.status]}>{t.status.request[req.status]}</Badge>}
          </p>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted">
            {req.workspace.ownerEmail && <span className="ltr">{req.workspace.ownerEmail}</span>}
            {req.workspace.ownerPhone && <span className="ltr font-mono text-xs">{req.workspace.ownerPhone}</span>}
            <span aria-hidden>·</span>
            <span>{r.currentPlan(planName(getPlan(req.workspace.planId)))}</span>
            <span aria-hidden>·</span>
            <span title={fmt.dateTime(req.createdAt)}>{fmt.timeAgo(req.createdAt)}</span>
          </p>
        </div>
        {pending && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-36">
              <DurationSelect label={r.duration} value={months} onChange={setMonths} />
            </div>
            <Button variant="brand" loading={approve.isPending} onClick={() => approve.mutate()}>
              {r.approve}
            </Button>
            <Button variant="ghost" disabled={approve.isPending} onClick={onReject} className="text-critical hover:text-critical">
              {r.reject}
            </Button>
          </div>
        )}
      </div>

      {/* payment panel */}
      <div className={cx('flex flex-wrap items-start gap-4 border-t px-4 py-3', look ? cx('border-line/60 bg-raised/20') : 'border-line/60 bg-raised/10')}>
        {req.payment ? (
          <>
            <ProofThumb req={req} onOpen={onProof} />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <MethodGlyph method={req.payment.method} size="sm" />
                <span className="text-sm font-semibold">{p.methods[req.payment.method]}</span>
                {expected !== null && egpPerUsd > 0 && (
                  <span className={cx('rounded-full px-2 py-0.5 text-xs tabular-nums', req.payment.amount && Math.abs(req.payment.amount - expected) > expected * 0.02 ? 'bg-warning/15 text-warning' : 'bg-raised text-muted')}>
                    {r.expected(p.egp(expected))}
                  </span>
                )}
              </div>
              <PaymentDetailsRows payment={req.payment} />
              {req.note && (
                <p className="text-sm text-ink-2">
                  <span className="text-muted">{r.note}: </span>
                  <bdi>{req.note}</bdi>
                </p>
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted">
            <AlertTriangle className="size-4 text-warning" />
            {r.noPayment}
            {req.note && (
              <>
                <span aria-hidden>·</span>
                <bdi className="text-ink-2">{req.note}</bdi>
              </>
            )}
          </div>
        )}
        {req.adminNote && !pending && <p className="w-full text-xs text-muted">{req.adminNote}</p>}
      </div>
      <ErrorNote>{approve.isError ? errorMessage(approve.error) : null}</ErrorNote>
    </li>
  );
}

function Requests() {
  const { t } = useI18n();
  const r = t.admin.requests;
  const [scope, setScope] = useState<'pending' | 'all'>('pending');
  const requests = useQuery({
    queryKey: [...qk.admin.requests, scope],
    queryFn: ({ signal }) => api<AdminRequest[]>(`/api/admin/plan-requests?status=${scope}`, { signal }),
    placeholderData: keepPreviousData,
  });
  const settings = usePaymentSettings();
  const [proof, setProof] = useState<AdminRequest | null>(null);
  const [rejecting, setRejecting] = useState<AdminRequest | null>(null);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{r.title}</h2>
          <p className="text-sm text-muted">{r.text}</p>
        </div>
        <div className="flex gap-1 rounded-lg border border-line p-1">
          {(['pending', 'all'] as const).map((s) => (
            <button key={s} type="button" onClick={() => setScope(s)} className={cx('h-7 rounded-md px-3 text-xs font-medium transition-colors', scope === s ? 'bg-raised text-ink' : 'text-muted hover:text-ink')}>
              {s === 'pending' ? r.pendingOnly : r.all}
            </button>
          ))}
        </div>
      </div>
      {requests.isError && <LoadError error={requests.error} onRetry={() => void requests.refetch()} retrying={requests.isFetching} />}
      {!requests.data ? (
        !requests.isError && <Loading />
      ) : requests.data.length === 0 ? (
        <Card>
          <EmptyState icon={Inbox} title={scope === 'pending' ? r.empty : r.emptyAll} />
        </Card>
      ) : (
        <ul className={cx('space-y-3 transition-opacity', requests.isPlaceholderData && 'opacity-60')}>
          {requests.data.map((req, i) => (
            <RequestCard key={req.id} req={req} index={i} egpPerUsd={settings.data?.egpPerUsd ?? 0} onProof={() => setProof(req)} onReject={() => setRejecting(req)} />
          ))}
        </ul>
      )}
      {proof && <ProofLightbox req={proof} onClose={() => setProof(null)} />}
      {rejecting && <RejectRequest req={rejecting} onClose={() => setRejecting(null)} />}
    </section>
  );
}

// --- payment methods settings --------------------------------------------------------------------

function MethodSettings({ method, enabled, complete, onToggle, children }: { method: PaymentMethod; enabled: boolean; complete: boolean; onToggle: (v: boolean) => void; children: ReactNode }) {
  const { t } = useI18n();
  const look = METHOD_LOOK[method];
  return (
    <div className={cx('rounded-xl border transition-colors', enabled ? cx('bg-card', look.ring) : 'border-line bg-card/60')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line/60 px-4 py-3">
        <MethodGlyph method={method} />
        <p className="min-w-24 flex-1 text-sm font-semibold">{t.subscription.payment.methods[method]}</p>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs font-medium text-muted">
          {t.admin.payments.enabled}
          <span className={cx('relative inline-flex h-5 w-9 items-center rounded-full transition-colors', enabled ? 'bg-brand' : 'bg-line-strong')}>
            <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} className="peer sr-only" />
            <span className={cx('absolute top-0.5 size-4 rounded-full bg-white shadow transition-[inset-inline-start]', enabled ? 'start-[1.125rem]' : 'start-0.5')} />
          </span>
        </label>
      </div>
      <div className={cx('grid gap-3 p-4 transition-opacity', !enabled && 'opacity-60')}>{children}</div>
      {enabled && !complete && (
        <p className="flex items-center gap-2 border-t border-line/60 px-4 py-2 text-xs text-warning">
          <AlertTriangle className="size-3.5" /> {t.admin.payments.incomplete}
        </p>
      )}
    </div>
  );
}

function PaymentMethodsSettings() {
  const { t } = useI18n();
  const a = t.admin.payments;
  const queryClient = useQueryClient();
  const settings = usePaymentSettings();
  const [draft, setDraft] = useState<PaymentSettings | null>(null);
  const current = draft ?? settings.data ?? DEFAULT_PAYMENT_SETTINGS;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(settings.data);
  const enabled = enabledPaymentMethods(current);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () => api<PaymentSettings>('/api/admin/payment-methods', { method: 'PUT', body: current }),
    onSuccess: (next) => {
      queryClient.setQueryData(qk.paymentMethods, next);
      setDraft(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  const patch = <K extends keyof PaymentSettings>(key: K, value: PaymentSettings[K]) => setDraft({ ...current, [key]: value });
  const patchMethod = <M extends 'vodafone_cash' | 'instapay' | 'bank_transfer'>(m: M, value: Partial<PaymentSettings[M]>) => patch(m, { ...current[m], ...value } as PaymentSettings[M]);

  if (settings.isError) return <LoadError error={settings.error} onRetry={() => void settings.refetch()} retrying={settings.isFetching} />;
  if (!settings.data) return <Loading />;

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!save.isPending && dirty) save.mutate();
      }}
      className="space-y-5"
    >
      <div>
        <h2 className="text-lg font-semibold">{a.title}</h2>
        <p className="max-w-2xl text-sm text-muted">{a.text}</p>
      </div>

      <Card bodyClassName="grid gap-4 md:grid-cols-[14rem_1fr] md:items-start">
        <Field
          label={a.rate}
          hint={a.rateHint}
          type="number"
          min={1}
          step="0.01"
          dir="ltr"
          value={current.egpPerUsd}
          onChange={(e) => patch('egpPerUsd', Math.max(0, Number(e.target.value) || 0))}
        />
        <TextArea label={a.instructions} placeholder={a.instructionsPlaceholder} value={current.instructions} onChange={(e) => patch('instructions', e.target.value)} maxLength={500} rows={3} />
      </Card>

      {/* As many columns as fit the content area (it narrows with the sidebar open), up to one per method. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-4">
        <MethodSettings method="vodafone_cash" enabled={current.vodafone_cash.enabled} complete={enabled.includes('vodafone_cash')} onToggle={(v) => patchMethod('vodafone_cash', { enabled: v })}>
          <Field label={a.vodafone.number} value={current.vodafone_cash.number} onChange={(e) => patchMethod('vodafone_cash', { number: e.target.value })} dir="ltr" inputMode="tel" placeholder="010xxxxxxxx" />
          <Field label={a.vodafone.name} value={current.vodafone_cash.name} onChange={(e) => patchMethod('vodafone_cash', { name: e.target.value })} />
        </MethodSettings>
        <MethodSettings method="instapay" enabled={current.instapay.enabled} complete={enabled.includes('instapay')} onToggle={(v) => patchMethod('instapay', { enabled: v })}>
          <Field label={a.instapay.address} value={current.instapay.address} onChange={(e) => patchMethod('instapay', { address: e.target.value })} dir="ltr" placeholder="name@instapay" />
          <Field label={a.instapay.name} value={current.instapay.name} onChange={(e) => patchMethod('instapay', { name: e.target.value })} />
        </MethodSettings>
        <MethodSettings method="bank_transfer" enabled={current.bank_transfer.enabled} complete={enabled.includes('bank_transfer')} onToggle={(v) => patchMethod('bank_transfer', { enabled: v })}>
          <Field label={a.bank.bankName} value={current.bank_transfer.bankName} onChange={(e) => patchMethod('bank_transfer', { bankName: e.target.value })} />
          <Field label={a.bank.accountName} value={current.bank_transfer.accountName} onChange={(e) => patchMethod('bank_transfer', { accountName: e.target.value })} />
          <Field label={a.bank.accountNumber} value={current.bank_transfer.accountNumber} onChange={(e) => patchMethod('bank_transfer', { accountNumber: e.target.value })} dir="ltr" />
          <Field label={a.bank.iban} value={current.bank_transfer.iban} onChange={(e) => patchMethod('bank_transfer', { iban: e.target.value })} dir="ltr" placeholder="EG…" />
        </MethodSettings>
      </div>

      <ErrorNote>{save.isError ? errorMessage(save.error) : null}</ErrorNote>
      <SuccessNote>{saved && a.saved}</SuccessNote>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted">{a.enabledCount(enabled.length, PAYMENT_METHODS.length)}</p>
        <Button type="submit" variant="brand" loading={save.isPending} disabled={!dirty}>
          {a.save}
        </Button>
      </div>
    </form>
  );
}

// --- users ---------------------------------------------------------------------------------------

function ChangePlan({ user, onClose }: { user: AdminUser & { workspace: NonNullable<AdminUser['workspace']> }; onClose: () => void }) {
  const { t } = useI18n();
  const m = t.admin.planModal;
  const planName = usePlanName();
  const refresh = useRefreshAdmin();
  const pricing = usePlanPricing();
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
          options={Object.values(PLANS).map((p) => {
            const price = listedPriceUsd(p.id, pricing.data ?? DEFAULT_PLAN_PRICING);
            return {
              value: p.id,
              label: (
                <span className="flex items-center gap-2">
                  {planName(p)}
                  {price ? <span className="ltr text-muted">${price}</span> : null}
                </span>
              ),
            };
          })}
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
    return expired ? <span className="text-critical">{`${w.expired} · ${fmt.date(ws.planExpiresAt)}`}</span> : fmt.date(ws.planExpiresAt);
  };

  const th = 'h-10 px-2 text-start font-medium whitespace-nowrap text-muted';
  const td = 'p-2 whitespace-nowrap align-top';
  const data = users.data;

  return (
    <Card
      title={u.title}
      className="animate-fade-up"
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
        <div className={cx('table-stack overflow-x-auto transition-opacity', users.isPlaceholderData && 'opacity-60')}>
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
                    <td data-label={u.cols.user} className={td}>
                      <p className="flex flex-wrap items-center gap-1.5 font-medium">
                        {row.name ?? row.email}
                        {row.role === 'admin' && <Badge tone="good">{t.app.admin}</Badge>}
                        {isSelf && <Badge tone="neutral">{u.you}</Badge>}
                      </p>
                      <p className="text-xs text-muted">
                        <span className="ltr">{row.email}</span>
                      </p>
                      <p className="mt-0.5 flex items-center gap-1 text-xs">
                        <Smartphone className="size-3 text-muted" />
                        {row.phone && row.phoneVerified ? <span className="ltr text-muted">{row.phone}</span> : <span className="text-warning">{u.phoneUnverified}</span>}
                      </p>
                    </td>
                    <td data-label={u.cols.status} className={td}>
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
                    <td data-label={u.cols.plan} className={td}>
                      {workspace ? (
                        <Badge tone={workspace.planId === 'trial' ? 'neutral' : workspace.planId === 'unlimited' ? 'good' : 'info'}>{planName(getPlan(workspace.planId))}</Badge>
                      ) : (
                        <span className="text-muted">{u.noWorkspace}</span>
                      )}
                    </td>
                    <td data-label={u.cols.expires} className={td}>{ends(row)}</td>
                    <td data-label={u.cols.sessions} className={`${td} tabular-nums`}>
                      {row.connected}/{row.sessions}
                    </td>
                    <td data-label={u.cols.messages} className={`${td} tabular-nums`}>{fmt.number.format(row.messages30d)}</td>
                    <td data-label={u.cols.joined} className={td}>{fmt.date(row.createdAt)}</td>
                    <td className={`${td} text-end`}>
                      <div className="flex flex-wrap justify-end gap-1">
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
                            <Button variant="ghost" size="sm" icon={<Ban className="size-4" />} onClick={() => setDialog({ kind: 'suspend', user: row })} className="text-warning hover:text-warning">
                              {u.suspend}
                            </Button>
                          ))}
                        {manageable && (
                          <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: 'delete', user: row })} className="text-critical hover:text-critical">
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

// --- verification message ------------------------------------------------------------------------

type OtpTextResponse = { texts: { ar: string | null; en: string | null }; defaults: { ar: string; en: string } };

/** The message sent for sign-up / phone-link codes — per language, empty falls back to the built-in text. */
function OtpText() {
  const { t } = useI18n();
  const o = t.admin.otpText;
  const queryClient = useQueryClient();
  const texts = useQuery({ queryKey: qk.admin.otpText, queryFn: ({ signal }) => api<OtpTextResponse>('/api/admin/otp-text', { signal }) });
  const [draft, setDraft] = useState<{ ar: string; en: string } | null>(null);
  const [lang, setLang] = useState<'ar' | 'en'>('ar');

  // Edit the stored override; an empty box means the built-in text (shown as a hint inside it).
  const current = draft ?? { ar: texts.data?.texts.ar ?? '', en: texts.data?.texts.en ?? '' };
  const needsCode = (v: string) => v.trim() !== '' && !/\{\{\s*code\s*\}\}/.test(v);
  const invalid = needsCode(current.ar) || needsCode(current.en);
  const dirty = draft !== null && (draft.ar !== (texts.data?.texts.ar ?? '') || draft.en !== (texts.data?.texts.en ?? ''));

  const save = useMutation({
    mutationFn: () => api('/api/admin/otp-text', { method: 'PUT', body: { ar: current.ar.trim() || null, en: current.en.trim() || null } }),
    onSuccess: () => setDraft(null),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: qk.admin.otpText }),
  });
  const reset = () => setDraft({ ar: '', en: '' });

  return (
    <Card
      title={o.title}
      description={o.text}
      className="animate-fade-up"
      actions={
        <div className="flex gap-1 rounded-lg border border-line p-1">
          {(['ar', 'en'] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLang(l)}
              className={cx('h-7 rounded-md px-3 text-xs font-medium transition-colors', lang === l ? 'bg-raised text-ink' : 'text-muted hover:text-ink')}
            >
              {l === 'ar' ? 'عربي' : 'English'}
            </button>
          ))}
        </div>
      }
    >
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-3">
          <textarea
            value={current[lang]}
            onChange={(e) => setDraft({ ...current, [lang]: e.target.value })}
            placeholder={texts.data?.defaults[lang]}
            rows={6}
            dir={lang === 'ar' ? 'rtl' : 'ltr'}
            maxLength={1000}
            aria-label={o.label(lang === 'ar' ? 'العربية' : 'الإنجليزية')}
            className={cx(inputClass, 'h-auto min-h-36 py-2 leading-relaxed')}
          />
          <p className="text-xs text-muted">
            {o.hint}{' '}
            <code className="ltr rounded bg-raised px-1 font-mono">{'{{code}}'}</code> <code className="ltr rounded bg-raised px-1 font-mono">{'{{minutes}}'}</code>
          </p>
          {needsCode(current[lang]) && <p className="text-xs text-critical">{o.missingCode}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="brand" loading={save.isPending} disabled={invalid || !dirty} onClick={() => save.mutate()}>
              {o.save}
            </Button>
            <Button variant="ghost" onClick={reset}>
              {o.reset}
            </Button>
          </div>
          <ErrorNote>{save.isError ? errorMessage(save.error) : null}</ErrorNote>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted">{o.preview}</p>
          <TemplatePreview
            template={{ body: current[lang].trim() || texts.data?.defaults[lang] || '' }}
            values={{ code: '123456', minutes: '10' }}
            className="min-h-44 rounded-xl p-4"
          />
        </div>
      </div>
    </Card>
  );
}

// --- audit log -----------------------------------------------------------------------------------

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
    <Card title={a.title} description={a.text} className="animate-fade-up">
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

// --- page ----------------------------------------------------------------------------------------

export function AdminPage() {
  const { t, fmt } = useI18n();
  const a = t.admin;
  const { account } = useAccount();
  const isAdmin = Boolean(account?.user?.isAdmin);
  // The server refuses non-admins anyway; this only avoids pointless requests and a broken page.
  const stats = useQuery({ queryKey: qk.admin.stats, queryFn: ({ signal }) => api<Stats>('/api/admin/stats', { signal }), enabled: isAdmin });
  const [tab, setTab] = useState<Tab>('overview');

  if (account && !isAdmin) return <ErrorNote>{a.forbidden}</ErrorNote>;

  const n = (v: number | undefined) => (v === undefined ? '…' : fmt.number.format(v));
  const s = stats.data;
  const pendingCount = s?.pendingRequests ?? 0;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader title={a.title} description={a.description} />
      {stats.isError && <LoadError error={stats.error} onRetry={() => void stats.refetch()} retrying={stats.isFetching} />}

      {/* stats strip: as many columns as fit the content area (it narrows with the sidebar open). Every
          tile draws its end and bottom edge; the grid reaches 1px past the box so the outer ones are clipped. */}
      <div className="overflow-hidden rounded-xl border border-line bg-card shadow-sm">
        <div className="-me-px -mb-px grid grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))] [&>*]:border-e [&>*]:border-b [&>*]:border-line/60">
        <Stat index={0} icon={Users} label={a.stats.users} value={n(s?.users)} />
        <Stat index={1} icon={Activity} label={a.stats.workspaces} value={n(s?.workspaces)} />
        <Stat index={2} icon={CircleDollarSign} label={a.stats.activePaid} value={n(s?.activePaid)} accent="brand" />
        <Stat index={3} icon={Smartphone} label={a.stats.sessions} value={s ? `${n(s.connected)} / ${n(s.sessions)}` : '…'} />
        <Stat index={4} icon={Hourglass} label={a.stats.pending} value={n(s?.pendingRequests)} accent={pendingCount ? 'info' : undefined} />
        <Stat index={5} icon={MessageSquare} label={a.stats.messagesToday} value={n(s?.messagesToday)} />
        <Stat index={6} icon={Ban} label={a.stats.suspended} value={n(s?.suspended)} accent={s?.suspended ? 'danger' : undefined} />
        </div>
      </div>

      {/* tabs */}
      <nav aria-label={a.title} className="code-scroll -mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {TABS.map(({ id, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={active ? 'page' : undefined}
              className={cx(
                'flex h-9 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors',
                active ? 'border-ink bg-ink text-bg' : 'border-line bg-card text-muted hover:border-line-strong hover:text-ink',
              )}
            >
              <Icon className="size-4" />
              {a.tabs[id]}
              {id === 'overview' && pendingCount > 0 && (
                <span className={cx('rounded-full px-1.5 py-0.5 text-[11px] leading-none font-semibold tabular-nums', active ? 'bg-bg/20 text-bg' : 'bg-brand text-on-brand')}>{pendingCount}</span>
              )}
            </button>
          );
        })}
      </nav>

      <div key={tab} className="animate-fade-up">
        {tab === 'overview' && <Requests />}
        {tab === 'users' && <UsersTable selfId={account?.user?.id ?? null} />}
        {tab === 'payments' && <PaymentMethodsSettings />}
        {tab === 'pricing' && <PlanPricingSettings />}
        {tab === 'messages' && <OtpText />}
        {tab === 'site' && <SiteSettingsCard />}
        {tab === 'audit' && <AuditLog />}
      </div>
    </div>
  );
}
