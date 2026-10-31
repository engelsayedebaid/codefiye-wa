import {
  keyMode,
  XPAY_METHODS,
  XPAY_MODES,
  type XPayConnectionError,
  type XPayMethod,
  type XPayMode,
  xpayModeComplete,
  xpayAvailableMethods,
  xpayLiveForCustomers,
  type XPayModeView,
  xpayReady,
  type XPaySettings,
  type XPaySettingsInput,
} from '@wa/shared/payments';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, CheckCircle2, FlaskConical, Info, Loader2, RefreshCw, ShieldCheck, Trash2, Zap } from '../icons';
import { type FormEvent, type ReactNode, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../api';
import { CopyLine, MethodGlyph } from '../app/payments/methods';
import { useI18n } from '../i18n';
import { qk } from '../queries';
import { Badge, Button, cx, ErrorNote, Field, Loading, LoadError, Modal, SuccessNote } from '../ui';

type ModeDraft = { publishableKey: string; secretKey: string; webhookSecret: string; clear: boolean };
type Draft = { enabled: boolean; mode: XPayMode; methods: XPayMethod[]; test: ModeDraft; live: ModeDraft };

const modeDraft = (v: XPayModeView): ModeDraft => ({ publishableKey: v.publishableKey, secretKey: '', webhookSecret: '', clear: false });
const fromSettings = (s: XPaySettings): Draft => ({ enabled: s.enabled, mode: s.mode, methods: s.methods, test: modeDraft(s.test), live: modeDraft(s.live) });

const MODE_ICONS = { test: FlaskConical, live: Zap } as const;

/** Only what changed is sent: untouched secrets stay blank, so the stored ones are kept. */
function toInput(d: Draft, s: XPaySettings, confirmLive: boolean): XPaySettingsInput {
  const mode = (m: XPayMode) => {
    const v = d[m];
    if (v.clear) return { clear: true };
    const out: { publishableKey?: string; secretKey?: string; webhookSecret?: string } = {};
    if (v.publishableKey !== s[m].publishableKey) out.publishableKey = v.publishableKey.trim();
    if (v.secretKey.trim()) out.secretKey = v.secretKey.trim();
    if (v.webhookSecret.trim()) out.webhookSecret = v.webhookSecret.trim();
    return Object.keys(out).length ? out : undefined;
  };
  return { enabled: d.enabled, mode: d.mode, methods: d.methods, test: mode('test'), live: mode('live'), ...(confirmLive ? { confirmLive: true } : {}) };
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

/** What is left before customers can pay: keys, a passing connection test, a signed webhook, live mode on. */
function Checklist({ data, mode }: { data: XPaySettings; mode: XPayMode }) {
  const { t } = useI18n();
  const x = t.admin.payments.xpay;
  const view = data[mode];
  const steps = [
    { label: x.checklist.keys, done: xpayModeComplete(view, mode) },
    { label: x.checklist.connection, done: Boolean(view.validatedAt && !view.validationError) },
    { label: x.checklist.webhook, done: Boolean(view.lastWebhookAt) },
    { label: x.checklist.live, done: xpayLiveForCustomers(data) },
  ];
  return (
    <div className="border-b border-line/60 bg-raised/20 px-5 py-3">
      <p className="text-[11px] font-medium text-muted">{x.checklistTitle(x.modes[mode])}</p>
      <ol className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
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

/** Last connection test and last signed webhook of one mode. */
function ConnectionStatus({ view }: { view: XPayModeView }) {
  const { t, fmt, lang } = useI18n();
  const x = t.admin.payments.xpay;
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
      <p className={cx('flex items-center gap-1.5', view.lastWebhookAt ? 'text-ink-2' : 'text-muted')}>
        <ShieldCheck className="size-3.5 shrink-0" /> {view.lastWebhookAt ? x.webhookSeen(fmt.timeAgo(view.lastWebhookAt)) : x.webhookNotSeen}
      </p>
      {view.capabilities && (
        <p className="flex flex-wrap items-center gap-1.5 text-ink-2">
          <Info className="size-3.5 shrink-0 text-muted" />
          {x.accountSummary(view.capabilities.accountName ?? 'XPay', view.capabilities.methods.map((m) => x.methodNames[m]).join(lang === 'ar' ? '، ' : ', '))}
        </p>
      )}
    </div>
  );
}

/** One mode's keys: publishable key, the two write-only secrets, connection test, webhook URL. */
function ModeKeys({
  mode,
  view,
  draft,
  onChange,
  errors,
  disabled,
  onTested,
}: {
  mode: XPayMode;
  view: XPayModeView;
  draft: ModeDraft;
  onChange: (v: Partial<ModeDraft>) => void;
  errors: Record<string, string[]>;
  disabled: boolean;
  onTested: (s: XPaySettings) => void;
}) {
  const { t } = useI18n();
  const x = t.admin.payments.xpay;
  const [confirmClear, setConfirmClear] = useState(false);
  const test = useMutation({
    mutationFn: () => api<{ ok: boolean; error: XPayConnectionError | null; settings: XPaySettings }>('/api/admin/xpay/test', { method: 'POST', body: { mode } }),
    onSuccess: (r) => onTested(r.settings),
  });
  const err = (field: string) => errors[`${mode}.${field}`];
  const unsaved = draft.publishableKey !== view.publishableKey || draft.secretKey !== '' || draft.webhookSecret !== '' || draft.clear;
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
        label={x.publishableKey}
        value={draft.publishableKey}
        onChange={(e) => onChange({ publishableKey: e.target.value.trim() })}
        dir="ltr"
        placeholder={`pk_${mode}_…`}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        className="font-mono text-[13px]"
        error={err('publishableKey') ?? (draft.publishableKey && keyMode(draft.publishableKey) !== mode ? [x.wrongMode(mode)] : undefined)}
      />
      <div className="grid gap-5 md:grid-cols-2">
        <Field
          label={x.secretKey}
          type="password"
          value={draft.secretKey}
          onChange={(e) => onChange({ secretKey: e.target.value.trim() })}
          dir="ltr"
          placeholder={view.secretKeyHint ?? `sk_${mode}_…`}
          autoComplete="new-password"
          spellCheck={false}
          disabled={disabled}
          className="font-mono text-[13px]"
          hint={<span className="text-xs">{savedHint(view.secretKeyHint)}</span>}
          error={err('secretKey') ?? (draft.secretKey && keyMode(draft.secretKey) !== mode ? [x.wrongMode(mode)] : undefined)}
        />
        <Field
          label={x.webhookSecret}
          type="password"
          value={draft.webhookSecret}
          onChange={(e) => onChange({ webhookSecret: e.target.value.trim() })}
          dir="ltr"
          placeholder={view.webhookSecretHint ?? 'whsec_…'}
          autoComplete="new-password"
          spellCheck={false}
          disabled={disabled}
          className="font-mono text-[13px]"
          hint={<span className="text-xs">{savedHint(view.webhookSecretHint)}</span>}
          error={err('webhookSecret')}
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

      {(view.publishableKey || view.secretKeyHint || view.webhookSecretHint) && (
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
                onChange({ clear: true, secretKey: '', webhookSecret: '' });
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
 * XPay: Test and Live keys kept apart (secrets write-only, sealed on the server, shown masked), the active
 * mode, payment methods, connection tests and each mode's webhook. Live payments go on only after a
 * passing live connection test and an explicit confirmation (the server enforces both).
 */
export function XPaySettingsCard() {
  const { t } = useI18n();
  const x = t.admin.payments.xpay;
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: qk.admin.xpay, queryFn: ({ signal }) => api<XPaySettings>('/api/admin/xpay', { signal }) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tab, setTab] = useState<XPayMode | null>(null);
  const [confirmingLive, setConfirmingLive] = useState(false);
  const [saved, setSaved] = useState(false);

  const store = (next: XPaySettings) => {
    queryClient.setQueryData(qk.admin.xpay, next);
    void queryClient.invalidateQueries({ queryKey: qk.xpay });
  };
  const save = useMutation({
    mutationFn: ({ body }: { body: XPaySettingsInput }) => api<XPaySettings>('/api/admin/xpay', { method: 'PUT', body }),
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
  const caps = data[current.mode].capabilities;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(fromSettings(data));
  const fieldErrors = save.error instanceof ApiRequestError ? (save.error.errors ?? {}) : {};
  const locked = !data.encryptionReady;
  const patch = (value: Partial<Draft>) => setDraft({ ...current, ...value });
  const patchMode = (mode: XPayMode, value: Partial<ModeDraft>) => setDraft({ ...current, [mode]: { ...current[mode], ...value } });
  const toggleMethod = (m: XPayMethod) => patch({ methods: current.methods.includes(m) ? current.methods.filter((v) => v !== m) : XPAY_METHODS.filter((v) => v === m || current.methods.includes(v)) });
  const turningLiveOn = current.enabled && current.mode === 'live' && !(data.enabled && data.mode === 'live');
  const submit = (confirmLive: boolean) => save.mutate({ body: toInput(current, data, confirmLive) });
  const liveForCustomers = xpayLiveForCustomers(data);
  const ready = xpayReady(data);
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
        <MethodGlyph method="xpay" />
        <div className="min-w-48 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-base font-semibold">
            {x.title}
            <Badge tone={status.tone}>{status.label}</Badge>
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">{x.text}</p>
        </div>
        <Toggle label={x.enabled} checked={current.enabled} disabled={locked} onChange={(v) => patch({ enabled: v })} />
      </div>

      {(locked || (data.enabled && ready)) && (
        <div className="px-5 pb-4">
          {locked ? (
            <p className="flex items-start gap-2 rounded-lg bg-destructive-ink/10 px-3 py-2 text-sm text-destructive-ink">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {x.noKey}
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
            {XPAY_MODES.map((m) => {
              const on = current.mode === m;
              const complete = xpayModeComplete(data[m], m);
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
        </Section>

        <Section step={2} title={x.keysTitle} hint={x.keysHint(x.modes[shownTab])}>
          <div className="grid gap-5">
            <div role="tablist" aria-label={x.keysTitle} className="flex w-full gap-1 rounded-lg border border-line bg-raised/20 p-1 sm:w-fit">
              {XPAY_MODES.map((m) => {
                const complete = xpayModeComplete(data[m], m);
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
            {XPAY_METHODS.map((m) => {
              const on = current.methods.includes(m);
              // What the active mode's XPay account reported at its last connection test (unknown before one).
              const offered = xpayAvailableMethods([m], caps).length > 0;
              return (
                <button
                  key={m}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  // A method the account can't offer may be switched off, never on.
                  disabled={locked || (!offered && !on)}
                  onClick={() => toggleMethod(m)}
                  title={offered ? undefined : x.methodUnavailable}
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
          <p className="mt-3 text-xs text-muted">{caps ? x.methodsFromAccount(x.modes[current.mode], caps.accountName ?? 'XPay') : x.methodsUnknown(x.modes[current.mode])}</p>
          <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-raised/40 px-3 py-2 text-xs text-ink-2">
            <Info className="mt-px size-3.5 shrink-0 text-muted" /> {x.walletsNote}
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

/** Whether customers currently pay through XPay (live mode, ready): then the manual transfers below are hidden from them. */
export function useXPayEnabled() {
  const settings = useQuery({ queryKey: qk.admin.xpay, queryFn: ({ signal }) => api<XPaySettings>('/api/admin/xpay', { signal }) });
  return Boolean(settings.data && xpayLiveForCustomers(settings.data));
}
