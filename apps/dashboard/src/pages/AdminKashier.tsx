import {
  KASHIER_METHODS,
  KASHIER_MODES,
  kashierAvailableMethods,
  type KashierConnectionError,
  kashierLiveForCustomers,
  type KashierMethod,
  type KashierMode,
  kashierModeComplete,
  type KashierModeView,
  kashierReady,
  type KashierSettings,
  type KashierSettingsInput,
} from '@wa/shared/kashier';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, CheckCircle2, FlaskConical, Info, Loader2, RefreshCw, ShieldCheck, Trash2, Zap } from '../icons';
import { type FormEvent, type ReactNode, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../api';
import { CopyLine, MethodGlyph } from '../app/payments/methods';
import { useI18n } from '../i18n';
import { qk } from '../queries';
import { Badge, Button, cx, ErrorNote, Field, Loading, LoadError, Modal, SuccessNote, TextArea } from '../ui';

type ModeDraft = { merchantId: string; secretKey: string; apiKey: string; clear: boolean };
/** `testers`: the test-mode allow list as typed (one email per line or comma-separated). */
type Draft = { enabled: boolean; mode: KashierMode; methods: KashierMethod[]; test: ModeDraft; live: ModeDraft; testers: string };

const modeDraft = (v: KashierModeView): ModeDraft => ({ merchantId: v.merchantId, secretKey: '', apiKey: '', clear: false });
const fromSettings = (s: KashierSettings): Draft => ({ enabled: s.enabled, mode: s.mode, methods: s.methods, test: modeDraft(s.test), live: modeDraft(s.live), testers: s.testers.join('\n') });
const parseTesters = (text: string) => [...new Set(text.split(/[\s,،;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];

const MODE_ICONS = { test: FlaskConical, live: Zap } as const;

/** Only what changed is sent: untouched keys stay blank, so the stored ones are kept. */
function toInput(d: Draft, s: KashierSettings, confirmLive: boolean): KashierSettingsInput {
  const mode = (m: KashierMode) => {
    const v = d[m];
    if (v.clear) return { clear: true };
    const out: { merchantId?: string; secretKey?: string; apiKey?: string } = {};
    if (v.merchantId !== s[m].merchantId) out.merchantId = v.merchantId.trim();
    if (v.secretKey.trim()) out.secretKey = v.secretKey.trim();
    if (v.apiKey.trim()) out.apiKey = v.apiKey.trim();
    return Object.keys(out).length ? out : undefined;
  };
  const testers = parseTesters(d.testers);
  const testersChanged = testers.join(',') !== s.testers.join(',');
  return { enabled: d.enabled, mode: d.mode, methods: d.methods, test: mode('test'), live: mode('live'), ...(testersChanged ? { testers } : {}), ...(confirmLive ? { confirmLive: true } : {}) };
}

/** On/off switch in the look of the payment method cards. */
function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className={cx('flex shrink-0 items-center gap-2 text-xs font-medium text-muted', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
      {label}
      <span className={cx('relative inline-flex h-5 w-9 items-center rounded-full transition-colors', checked ? 'bg-brand' : 'bg-line-strong')}>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
        <span className={cx('absolute top-0.5 size-4 rounded-full bg-white shadow transition-[inset-inline-start]', checked ? 'start-[1.125rem]' : 'start-0.5')} />
      </span>
    </label>
  );
}

/** One settings row: a numbered title with its explanation beside (wide screens) or above the controls. */
function Section({ step, title, hint, children }: { step: number; title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-4 px-5 py-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10">
      <div>
        <h3 className="flex items-center gap-2.5 text-sm font-semibold">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-raised text-xs text-ink-2 tabular-nums">{step}</span>
          {title}
        </h3>
        {hint && <p className="mt-2 text-xs leading-relaxed text-muted lg:ps-8.5">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

/** What is left before customers can pay: credentials, a passing connection test, a signed webhook, switched on, live. */
function Checklist({ data, mode }: { data: KashierSettings; mode: KashierMode }) {
  const { t } = useI18n();
  const x = t.admin.payments.kashier;
  const view = data[mode];
  const steps = [
    { label: x.checklist.keys, done: kashierModeComplete(view) },
    { label: x.checklist.connection, done: Boolean(view.validatedAt && !view.validationError) },
    { label: x.checklist.webhook, done: Boolean(view.lastWebhookAt) },
    { label: x.checklist.enabled, done: data.enabled && kashierReady(data) },
    { label: x.checklist.live, done: kashierLiveForCustomers(data) },
  ];
  return (
    <div className="border-b border-line/60 bg-raised/20 px-5 py-3">
      <p className="text-[11px] font-medium text-muted">{x.checklistTitle(x.modes[mode])}</p>
      <ol className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {steps.map((s, i) => (
          <li key={s.label} className={cx('flex items-center gap-2 text-xs font-medium', s.done ? 'text-ink' : 'text-muted')}>
            <span
              className={cx(
                'flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] tabular-nums',
                s.done ? 'bg-brand text-on-brand' : 'border border-dashed border-line-strong',
              )}
            >
              {s.done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
            </span>
            {s.label}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Last connection test, the Payment API Key's state, and the last signed webhook of one mode. */
function ConnectionStatus({ view }: { view: KashierModeView }) {
  const { t, fmt, lang } = useI18n();
  const x = t.admin.payments.kashier;
  return (
    <div className="grid gap-1.5 text-xs">
      {view.validationError ? (
        <p className="flex items-start gap-1.5 text-destructive-ink">
          <AlertTriangle className="mt-px size-3.5 shrink-0" /> {x.errors[view.validationError]}
        </p>
      ) : view.validatedAt ? (
        <p className="flex items-center gap-1.5 text-brand">
          <CheckCircle2 className="size-3.5 shrink-0" /> {x.validated(fmt.timeAgo(view.validatedAt))}
        </p>
      ) : (
        <p className="flex items-center gap-1.5 text-muted">
          <Info className="size-3.5 shrink-0" /> {x.notValidated}
        </p>
      )}
      {view.validatedAt && !view.validationError && view.apiKeyUnconfirmed && !view.lastWebhookAt && (
        <p className="flex items-start gap-1.5 text-warning">
          <Info className="mt-px size-3.5 shrink-0" /> {x.apiKeyUnconfirmed}
        </p>
      )}
      <p className={cx('flex items-center gap-1.5', view.lastWebhookAt ? 'text-ink-2' : 'text-muted')}>
        <ShieldCheck className="size-3.5 shrink-0" /> {view.lastWebhookAt ? x.webhookSeen(fmt.timeAgo(view.lastWebhookAt)) : x.webhookNotSeen}
      </p>
      {view.accountMethods && (
        <p className="flex flex-wrap items-center gap-1.5 text-ink-2">
          <Info className="size-3.5 shrink-0 text-muted" />
          {x.accountSummary(view.accountMethods.map((m) => x.methodNames[m]).join(lang === 'ar' ? '، ' : ', '))}
        </p>
      )}
    </div>
  );
}

/** One mode's credentials: Merchant ID, the two write-only keys, connection test, webhook URL. */
function ModeKeys({
  mode,
  view,
  draft,
  onChange,
  errors,
  disabled,
  onTested,
}: {
  mode: KashierMode;
  view: KashierModeView;
  draft: ModeDraft;
  onChange: (v: Partial<ModeDraft>) => void;
  errors: Record<string, string[]>;
  disabled: boolean;
  onTested: (s: KashierSettings) => void;
}) {
  const { t } = useI18n();
  const x = t.admin.payments.kashier;
  const [confirmClear, setConfirmClear] = useState(false);
  const test = useMutation({
    mutationFn: () => api<{ ok: boolean; error: KashierConnectionError | null; settings: KashierSettings }>('/api/admin/kashier/test', { method: 'POST', body: { mode } }),
    onSuccess: (r) => onTested(r.settings),
  });
  const err = (field: string) => errors[`${mode}.${field}`];
  const unsaved = draft.merchantId !== view.merchantId || draft.secretKey !== '' || draft.apiKey !== '' || draft.clear;
  const savedHint = (h: string | null) => (h ? x.secretSet(h) : x.secretMissing);

  if (draft.clear) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-3 text-sm text-warning">
        <span className="flex items-center gap-2">
          <AlertTriangle className="size-4 shrink-0" /> {x.clearPending}
        </span>
        <Button size="sm" variant="outline" onClick={() => onChange({ clear: false })}>
          {x.undo}
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-5">
      {view.unreadable && (
        <p className="flex items-start gap-2 rounded-lg bg-destructive-ink/10 px-3 py-2 text-xs text-destructive-ink">
          <AlertTriangle className="mt-px size-3.5 shrink-0" /> {x.unreadable}
        </p>
      )}
      <Field
        label={x.merchantId}
        value={draft.merchantId}
        onChange={(e) => onChange({ merchantId: e.target.value.trim() })}
        dir="ltr"
        placeholder="MID-XXXX-XXX"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        className="font-mono text-[13px]"
        error={err('merchantId')}
      />
      <div className="grid gap-5 md:grid-cols-2">
        <Field
          label={x.secretKey}
          type="password"
          value={draft.secretKey}
          onChange={(e) => onChange({ secretKey: e.target.value.trim() })}
          dir="ltr"
          placeholder={view.secretKeyHint ?? '••••••••'}
          autoComplete="new-password"
          spellCheck={false}
          disabled={disabled}
          className="font-mono text-[13px]"
          hint={<span className="text-xs">{savedHint(view.secretKeyHint)}</span>}
          error={err('secretKey')}
        />
        <Field
          label={x.apiKey}
          type="password"
          value={draft.apiKey}
          onChange={(e) => onChange({ apiKey: e.target.value.trim() })}
          dir="ltr"
          placeholder={view.apiKeyHint ?? '••••••••'}
          autoComplete="new-password"
          spellCheck={false}
          disabled={disabled}
          className="font-mono text-[13px]"
          hint={<span className="text-xs">{savedHint(view.apiKeyHint)}</span>}
          error={err('apiKey')}
        />
      </div>

      <div className="grid gap-2">
        <span className="text-sm font-medium">{x.connection}</span>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line/70 bg-raised/20 px-3.5 py-3">
          <ConnectionStatus view={view} />
          <Button
            size="sm"
            variant="outline"
            icon={test.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            disabled={disabled || test.isPending || unsaved || !view.secretKeyHint}
            onClick={() => test.mutate()}
            title={unsaved ? x.saveFirst : undefined}
          >
            {x.testConnection}
          </Button>
        </div>
        {unsaved && <p className="text-xs text-muted">{x.saveFirst}</p>}
        {test.isError && <p className="text-xs text-destructive-ink">{errorMessage(test.error)}</p>}
      </div>

      <div className="grid gap-2">
        <span className="text-sm font-medium">{x.webhook}</span>
        <CopyLine label={x.webhookFor(x.modes[mode])} value={view.webhookUrl} />
        <span className="text-xs leading-relaxed text-muted">{x.webhookHint(x.modes[mode])}</span>
      </div>

      {(view.merchantId || view.secretKeyHint || view.apiKeyHint) && (
        <div className="flex justify-end border-t border-line/60 pt-4">
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} className="text-critical hover:text-critical" disabled={disabled} onClick={() => setConfirmClear(true)}>
            {x.clear(x.modes[mode])}
          </Button>
        </div>
      )}
      {confirmClear && (
        <Modal title={x.clearTitle(x.modes[mode])} description={x.clearText} onClose={() => setConfirmClear(false)}>
          <div className="flex justify-end gap-2 pb-4">
            <Button variant="outline" onClick={() => setConfirmClear(false)}>
              {t.common.cancel}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                onChange({ clear: true, secretKey: '', apiKey: '' });
                setConfirmClear(false);
              }}
            >
              {x.clear(x.modes[mode])}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * Kashier: Test and Live credentials kept apart (keys write-only, sealed on the server, shown masked), the
 * active mode, payment methods, connection tests and each mode's webhook. Live payments go on only after
 * a passing live connection test and an explicit confirmation (the server enforces both).
 */
export function KashierSettingsCard() {
  const { t } = useI18n();
  const x = t.admin.payments.kashier;
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: qk.admin.kashier, queryFn: ({ signal }) => api<KashierSettings>('/api/admin/kashier', { signal }) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tab, setTab] = useState<KashierMode | null>(null);
  const [confirmingLive, setConfirmingLive] = useState(false);
  const [saved, setSaved] = useState(false);

  const store = (next: KashierSettings) => {
    queryClient.setQueryData(qk.admin.kashier, next);
    void queryClient.invalidateQueries({ queryKey: qk.kashier });
  };
  const save = useMutation({
    mutationFn: ({ body }: { body: KashierSettingsInput }) => api<KashierSettings>('/api/admin/kashier', { method: 'PUT', body }),
    onSuccess: (next) => {
      store(next);
      setDraft(null);
      setConfirmingLive(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  if (settings.isError) return <LoadError error={settings.error} onRetry={() => void settings.refetch()} retrying={settings.isFetching} />;
  if (!settings.data) return <Loading />;
  const data = settings.data;
  const current = draft ?? fromSettings(data);
  const shownTab = tab ?? current.mode;
  const accountMethods = data[current.mode].accountMethods;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(fromSettings(data));
  const fieldErrors = save.error instanceof ApiRequestError ? (save.error.errors ?? {}) : {};
  const locked = !data.encryptionReady;
  const patch = (value: Partial<Draft>) => setDraft({ ...current, ...value });
  const patchMode = (mode: KashierMode, value: Partial<ModeDraft>) => setDraft({ ...current, [mode]: { ...current[mode], ...value } });
  const toggleMethod = (m: KashierMethod) =>
    patch({ methods: current.methods.includes(m) ? current.methods.filter((v) => v !== m) : KASHIER_METHODS.filter((v) => v === m || current.methods.includes(v)) });
  const turningLiveOn = current.enabled && current.mode === 'live' && !(data.enabled && data.mode === 'live');
  const submit = (confirmLive: boolean) => save.mutate({ body: toInput(current, data, confirmLive) });
  const liveForCustomers = kashierLiveForCustomers(data);
  const ready = kashierReady(data);
  const testersError = Object.entries(fieldErrors).find(([k]) => k.startsWith('testers'))?.[1]?.[0] ? x.testersInvalid : null;
  const connectedButOff = !data.enabled && kashierModeComplete(data[data.mode]) && Boolean(data[data.mode].validatedAt && !data[data.mode].validationError);
  const status = !data.enabled ? { tone: 'neutral' as const, label: x.status.off } : !ready ? { tone: 'warning' as const, label: x.status.incomplete } : data.mode === 'live' ? { tone: 'good' as const, label: x.status.live } : { tone: 'warning' as const, label: x.status.test };
  const saveError = save.isError ? (save.error instanceof ApiRequestError && save.error.code === 'test_connection_first' ? x.testFirst : errorMessage(save.error)) : null;

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (save.isPending || !dirty || locked) return;
        if (turningLiveOn) setConfirmingLive(true);
        else submit(false);
      }}
      className={cx('overflow-hidden rounded-xl border transition-colors', data.enabled && ready ? 'border-brand/50 bg-card' : 'border-line bg-card/60')}
    >
      {/* header */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
        <MethodGlyph method="kashier" />
        <div className="min-w-48 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-base font-semibold">
            {x.title}
            <Badge tone={status.tone}>{status.label}</Badge>
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">{x.text}</p>
        </div>
        <Toggle label={x.enabled} checked={current.enabled} disabled={locked} onChange={(v) => patch({ enabled: v })} />
      </div>

      {(locked || (data.enabled && ready) || connectedButOff) && (
        <div className="px-5 pb-4">
          {locked ? (
            <p className="flex items-start gap-2 rounded-lg bg-destructive-ink/10 px-3 py-2 text-sm text-destructive-ink">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {x.noKey}
            </p>
          ) : connectedButOff ? (
            // A passing connection test doesn't take payments: until Kashier is switched on and saved, customers see the manual request.
            <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {x.offNote}
            </p>
          ) : (
            <p className={cx('flex items-start gap-2 rounded-lg px-3 py-2 text-xs', liveForCustomers ? 'bg-brand/10 text-brand' : 'bg-warning/10 text-warning')}>
              <Info className="mt-px size-3.5 shrink-0" /> {liveForCustomers ? x.liveNote : x.testNote}
            </p>
          )}
        </div>
      )}

      <div className="border-t border-line/60">
        <Checklist data={data} mode={current.mode} />
      </div>

      <div className="divide-y divide-line/60">
        <Section step={1} title={x.activeMode} hint={x.modeHint}>
          <div role="radiogroup" aria-label={x.activeMode} className="grid gap-3 sm:grid-cols-2">
            {KASHIER_MODES.map((m) => {
              const on = current.mode === m;
              const complete = kashierModeComplete(data[m]);
              const Icon = MODE_ICONS[m];
              const tone = m === 'live' ? 'brand' : 'warning';
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={locked}
                  onClick={() => {
                    patch({ mode: m });
                    setTab(m);
                  }}
                  className={cx(
                    'flex items-center gap-3 rounded-xl border p-3.5 text-start transition-all disabled:cursor-not-allowed disabled:opacity-60',
                    on
                      ? tone === 'brand'
                        ? 'border-brand bg-brand/10 shadow-[0_0_0_1px_var(--color-brand)]'
                        : 'border-warning/60 bg-warning/10 shadow-[0_0_0_1px_var(--color-warning)]'
                      : 'border-line hover:border-line-strong hover:bg-raised/40',
                  )}
                >
                  <span
                    className={cx(
                      'flex size-9 shrink-0 items-center justify-center rounded-lg',
                      on ? (tone === 'brand' ? 'bg-brand text-on-brand' : 'bg-warning/20 text-warning') : 'bg-raised text-muted',
                    )}
                  >
                    <Icon className="size-4.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cx('block text-sm font-semibold', on && (tone === 'brand' ? 'text-brand' : 'text-warning'))}>{x.modes[m]}</span>
                    <span className={cx('mt-0.5 flex items-center gap-1.5 text-[11px]', complete ? 'text-ink-2' : 'text-muted')}>
                      <span className={cx('size-1.5 rounded-full', complete ? 'bg-brand' : 'bg-warning')} />
                      {complete ? x.modeComplete : x.modeIncomplete}
                    </span>
                  </span>
                  <span className={cx('flex size-5 shrink-0 items-center justify-center rounded-full border', on ? 'border-transparent bg-ink text-card' : 'border-line-strong')}>
                    {on && <Check className="size-3" strokeWidth={3} />}
                  </span>
                </button>
              );
            })}
          </div>
          {current.mode === 'test' && (
            <div className="mt-4 grid gap-1.5">
              <TextArea label={x.testers} value={current.testers} onChange={(e) => patch({ testers: e.target.value })} dir="ltr" rows={3} placeholder="tester@example.com" disabled={locked} />
              {testersError ? <p className="text-xs text-destructive-ink">{testersError}</p> : <p className="text-xs text-muted">{x.testersHint}</p>}
            </div>
          )}
        </Section>

        <Section step={2} title={x.keysTitle} hint={x.keysHint(x.modes[shownTab])}>
          <div className="grid gap-5">
            <div role="tablist" aria-label={x.keysTitle} className="flex w-full gap-1 rounded-lg border border-line bg-raised/20 p-1 sm:w-fit">
              {KASHIER_MODES.map((m) => {
                const complete = kashierModeComplete(data[m]);
                return (
                  <button
                    key={m}
                    type="button"
                    role="tab"
                    aria-selected={shownTab === m}
                    onClick={() => setTab(m)}
                    className={cx(
                      'flex h-8 flex-1 items-center justify-center gap-2 rounded-md px-3.5 text-xs font-medium transition-colors sm:flex-none',
                      shownTab === m ? 'bg-card text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink',
                    )}
                  >
                    <span className={cx('size-1.5 rounded-full', complete ? 'bg-brand' : 'bg-warning')} />
                    {x.keysFor(x.modes[m])}
                  </button>
                );
              })}
            </div>
            <ModeKeys key={shownTab} mode={shownTab} view={data[shownTab]} draft={current[shownTab]} onChange={(v) => patchMode(shownTab, v)} errors={fieldErrors} disabled={locked} onTested={store} />
          </div>
        </Section>

        <Section step={3} title={x.methods} hint={x.methodsHint}>
          <div className="flex flex-wrap gap-2">
            {KASHIER_METHODS.map((m) => {
              const on = current.methods.includes(m);
              // What the active mode's Kashier account reported at its last connection test (unknown before one).
              const offered = kashierAvailableMethods([m], accountMethods).length > 0;
              return (
                <button
                  key={m}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  // A method the account doesn't have may be switched off, never on.
                  disabled={locked || (!offered && !on)}
                  onClick={() => toggleMethod(m)}
                  title={offered ? x.methodHints[m] : x.methodUnavailable}
                  className={cx(
                    'flex h-9 items-center gap-2 rounded-lg border px-3.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                    on && offered ? 'border-brand/60 bg-brand/10 text-brand' : on ? 'border-warning/50 bg-warning/10 text-warning' : 'border-line text-muted hover:border-line-strong hover:text-ink',
                  )}
                >
                  <span className={cx('flex size-4 items-center justify-center rounded border', on ? (offered ? 'border-brand bg-brand text-on-brand' : 'border-warning bg-warning text-on-warning') : 'border-line-strong')}>
                    {on && <Check className="size-3" strokeWidth={3} />}
                  </span>
                  {x.methodNames[m]}
                  {!offered && <span className="text-[11px] font-normal">· {x.methodOff}</span>}
                </button>
              );
            })}
          </div>
          {fieldErrors.methods && <p className="mt-2 text-xs text-destructive-ink">{fieldErrors.methods.join(' ')}</p>}
          <p className="mt-3 text-xs text-muted">{accountMethods ? x.methodsFromAccount(x.modes[current.mode]) : x.methodsUnknown(x.modes[current.mode])}</p>
          {current.mode === 'test' && <p className="mt-1 text-xs text-warning">{x.testMethodsNote}</p>}
          <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-raised/40 px-3 py-2 text-xs leading-relaxed text-ink-2">
            <Info className="mt-px size-3.5 shrink-0 text-muted" /> {x.methodsNote}
          </p>
        </Section>
      </div>

      {/* footer */}
      <div className="flex flex-wrap items-center gap-3 border-t border-line/60 bg-raised/20 px-5 py-3.5">
        <div className="min-w-0 flex-1 text-xs">
          <ErrorNote>{saveError}</ErrorNote>
          <SuccessNote>{saved && x.saved}</SuccessNote>
          {!saveError && !saved && dirty && <p className="text-warning">{x.unsaved}</p>}
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <Button variant="ghost" onClick={() => setDraft(null)} disabled={save.isPending}>
              {t.common.cancel}
            </Button>
          )}
          <Button type="submit" variant="brand" loading={save.isPending} disabled={!dirty || locked}>
            {x.save}
          </Button>
        </div>
      </div>

      {confirmingLive && (
        <Modal title={x.liveConfirmTitle} description={x.liveConfirmText} onClose={() => setConfirmingLive(false)}>
          <div className="space-y-4 pb-4">
            <ul className="grid gap-1.5 text-sm text-ink-2">
              {x.liveConfirmPoints.map((point) => (
                <li key={point} className="flex items-start gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-brand" /> {point}
                </li>
              ))}
            </ul>
            <ErrorNote>{saveError}</ErrorNote>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmingLive(false)}>
                {t.common.cancel}
              </Button>
              <Button variant="brand" loading={save.isPending} onClick={() => submit(true)}>
                {x.liveConfirm}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </form>
  );
}

/** Whether customers currently pay through Kashier (live mode, ready): then the manual transfers below are hidden from them. */
export function useKashierLive() {
  const settings = useQuery({ queryKey: qk.admin.kashier, queryFn: ({ signal }) => api<KashierSettings>('/api/admin/kashier', { signal }) });
  return Boolean(settings.data && kashierLiveForCustomers(settings.data));
}
