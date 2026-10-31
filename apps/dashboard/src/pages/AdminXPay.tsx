import { isTestKey, XPAY_METHODS, type XPayMethod, xpayReady, type XPaySettings, type XPaySettingsInput } from '@wa/shared/payments';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check } from '../icons';
import { type FormEvent, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../api';
import { CopyLine, MethodGlyph } from '../app/payments/methods';
import { useI18n } from '../i18n';
import { qk } from '../queries';
import { Badge, Button, cx, ErrorNote, Field, Loading, LoadError, SuccessNote } from '../ui';

type Draft = Omit<XPaySettingsInput, 'secretKey' | 'webhookSecret'> & { secretKey: string; webhookSecret: string };

const fromSettings = (s: XPaySettings): Draft => ({ enabled: s.enabled, publishableKey: s.publishableKey, methods: s.methods, secretKey: '', webhookSecret: '' });

/** The XPay account: keys (secrets write-only, sealed on the server), methods, and the webhook to add in XPay. */
export function XPaySettingsCard() {
  const { t } = useI18n();
  const x = t.admin.payments.xpay;
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: qk.admin.xpay, queryFn: ({ signal }) => api<XPaySettings>('/api/admin/xpay', { signal }) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(false);
  const current = draft ?? (settings.data ? fromSettings(settings.data) : null);
  const dirty = draft !== null && settings.data !== undefined && JSON.stringify(draft) !== JSON.stringify(fromSettings(settings.data));

  const save = useMutation({
    mutationFn: (body: Draft) =>
      api<XPaySettings>('/api/admin/xpay', {
        method: 'PUT',
        body: { ...body, secretKey: body.secretKey.trim() || undefined, webhookSecret: body.webhookSecret.trim() || undefined },
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(qk.admin.xpay, next);
      void queryClient.invalidateQueries({ queryKey: qk.xpay });
      setDraft(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  if (settings.isError) return <LoadError error={settings.error} onRetry={() => void settings.refetch()} retrying={settings.isFetching} />;
  if (!settings.data || !current) return <Loading />;
  const data = settings.data;
  const fieldErrors = save.error instanceof ApiRequestError ? (save.error.errors ?? {}) : {};
  const patch = (value: Partial<Draft>) => setDraft({ ...current, ...value });
  const toggleMethod = (m: XPayMethod) => patch({ methods: current.methods.includes(m) ? current.methods.filter((v) => v !== m) : XPAY_METHODS.filter((v) => v === m || current.methods.includes(v)) });
  const key = current.publishableKey || data.publishableKey;
  const noEncryption = save.error instanceof ApiRequestError && save.error.code === 'no_encryption_key';

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!save.isPending && dirty) save.mutate(current);
      }}
      className={cx('overflow-hidden rounded-xl border transition-colors', current.enabled ? 'border-brand/50 bg-card' : 'border-line bg-card/60')}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line/60 px-4 py-3">
        <MethodGlyph method="xpay" />
        <div className="min-w-40 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {x.title}
            {key && <Badge tone={isTestKey(key) ? 'warning' : 'good'}>{isTestKey(key) ? x.test : x.live}</Badge>}
          </p>
          <p className="text-xs text-muted">{x.text}</p>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs font-medium text-muted">
          {x.enabled}
          <span className={cx('relative inline-flex h-5 w-9 items-center rounded-full transition-colors', current.enabled ? 'bg-brand' : 'bg-line-strong')}>
            <input type="checkbox" checked={current.enabled} onChange={(e) => patch({ enabled: e.target.checked })} className="peer sr-only" />
            <span className={cx('absolute top-0.5 size-4 rounded-full bg-white shadow transition-[inset-inline-start]', current.enabled ? 'start-[1.125rem]' : 'start-0.5')} />
          </span>
        </label>
      </div>

      <div className="grid gap-4 p-4">
        <p className="text-xs text-muted">{x.keysHint}</p>
        <div className="grid gap-4 md:grid-cols-3">
          <Field
            label={x.publishableKey}
            value={current.publishableKey}
            onChange={(e) => patch({ publishableKey: e.target.value.trim() })}
            dir="ltr"
            placeholder="pk_test_…"
            autoComplete="off"
            spellCheck={false}
            error={fieldErrors.publishableKey}
          />
          <Field
            label={x.secretKey}
            type="password"
            value={current.secretKey}
            onChange={(e) => patch({ secretKey: e.target.value.trim() })}
            dir="ltr"
            placeholder={data.hasSecretKey ? '••••••••••••' : 'sk_test_…'}
            autoComplete="new-password"
            hint={data.hasSecretKey ? x.secretSet : x.secretMissing}
            error={fieldErrors.secretKey}
          />
          <Field
            label={x.webhookSecret}
            type="password"
            value={current.webhookSecret}
            onChange={(e) => patch({ webhookSecret: e.target.value.trim() })}
            dir="ltr"
            placeholder={data.hasWebhookSecret ? '••••••••••••' : 'whsec_…'}
            autoComplete="new-password"
            hint={data.hasWebhookSecret ? x.secretSet : x.secretMissing}
            error={fieldErrors.webhookSecret}
          />
        </div>

        <div className="grid gap-2">
          <span className="text-sm font-medium">{x.methods}</span>
          <div className="flex flex-wrap gap-2">
            {XPAY_METHODS.map((m) => {
              const on = current.methods.includes(m);
              return (
                <button
                  key={m}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggleMethod(m)}
                  className={cx(
                    'flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors',
                    on ? 'border-brand/60 bg-brand/10 text-brand' : 'border-line text-muted hover:border-line-strong hover:text-ink',
                  )}
                >
                  {on && <Check className="size-3.5" />}
                  {x.methodNames[m]}
                </button>
              );
            })}
          </div>
          <span className={cx('text-xs', fieldErrors.methods ? 'text-destructive-ink' : 'text-muted')}>{fieldErrors.methods?.join(' ') ?? x.methodsHint}</span>
        </div>

        <div className="grid gap-2">
          <span className="text-sm font-medium">{x.webhook}</span>
          <CopyLine label="POST" value={data.webhookUrl} />
          <span className="text-xs text-muted">{x.webhookHint}</span>
        </div>

        {noEncryption && (
          <p className="flex items-center gap-2 text-xs text-warning">
            <AlertTriangle className="size-3.5" /> {x.noKey}
          </p>
        )}
        <ErrorNote>{save.isError && !noEncryption ? errorMessage(save.error) : null}</ErrorNote>
        <SuccessNote>{saved && x.saved}</SuccessNote>
        <div className="flex justify-end">
          <Button type="submit" variant="brand" loading={save.isPending} disabled={!dirty}>
            {x.save}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** Whether customers currently pay through XPay (then the manual transfers below are hidden). */
export function useXPayEnabled() {
  const settings = useQuery({ queryKey: qk.admin.xpay, queryFn: ({ signal }) => api<XPaySettings>('/api/admin/xpay', { signal }) });
  const s = settings.data;
  return Boolean(s && xpayReady(s));
}
