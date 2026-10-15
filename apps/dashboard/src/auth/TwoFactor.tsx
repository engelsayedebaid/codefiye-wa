import { asciiDigits } from '@wa/shared/phone';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Download, ShieldCheck, Smartphone } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../api';
import type { Account } from '../app/account';
import { useI18n } from '../i18n';
import { qk } from '../queries';
import { signOut } from '../session';
import { Button, cx, ErrorNote, Loading } from '../ui';
import { AuthLayout } from './AuthPages';

type Setup = { secret: string; otpauthUrl: string; qrImage: string };

/**
 * A signed-in user without two-factor sees only this until an authenticator app is set up (the API
 * refuses everything else with `two_factor_required`). The first time they may skip for 48 hours
 * (`canSkip`); after that the screen is mandatory. `onEnabled` gets the recovery codes, which the
 * caller keeps on screen until the user confirms they saved them.
 */
export function TwoFactorSetup({ canSkip, onEnabled }: { canSkip: boolean; onEnabled: (codes: string[]) => void }) {
  const { t } = useI18n();
  const s = t.auth.setup2fa;
  const queryClient = useQueryClient();
  // A query, not an effect: concurrent mounts share one request, so the QR shown is the secret stored.
  const setup = useQuery({
    queryKey: ['2fa-setup'],
    queryFn: () => api<Setup>('/api/account/2fa/setup', { method: 'POST' }),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [skipping, setSkipping] = useState(false);

  const skip = async () => {
    if (skipping) return;
    setSkipping(true);
    setError(null);
    try {
      const account = await api<Account>('/api/account/2fa/skip', { method: 'POST' });
      queryClient.setQueryData(qk.me, account);
    } catch (err) {
      setError(errorMessage(err));
      setSkipping(false);
    }
  };

  const verify = async (value: string) => {
    if (value.length !== 6 || loading) return;
    setLoading(true);
    setError(null);
    try {
      const { recoveryCodes } = await api<{ recoveryCodes: string[] }>('/api/account/2fa/enable', { method: 'POST', body: { code: value } });
      onEnabled(recoveryCodes);
      void queryClient.invalidateQueries({ queryKey: qk.me });
    } catch (err) {
      setCode('');
      setError(err instanceof ApiRequestError && err.code === 'code_invalid' ? s.wrong : errorMessage(err));
    } finally {
      setLoading(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void verify(code);
  };

  const logout = (
    <button type="button" onClick={() => void signOut(queryClient)} className="text-muted underline-offset-4 transition-colors hover:text-ink hover:underline">
      {s.logout}
    </button>
  );

  const skipButton = canSkip ? (
    <div className="grid w-full gap-2">
      <Button type="button" variant="outline" loading={skipping} onClick={() => void skip()} className="h-11 w-full">
        {s.skip}
      </Button>
      <p className="text-center text-xs leading-relaxed text-muted">{s.skipHint}</p>
    </div>
  ) : null;

  return (
    <AuthLayout title={s.title} subtitle={canSkip ? s.text : s.mandatory} footer={logout} wide>
      {setup.isPending ? (
        <div className="mx-auto grid max-w-sm gap-4">
          <Loading className="py-16" />
          {skipButton}
        </div>
      ) : setup.isError ? (
        <div className="mx-auto grid max-w-sm gap-4">
          <ErrorNote>{error ?? errorMessage(setup.error)}</ErrorNote>
          <Button onClick={() => void setup.refetch()}>{t.common.retry}</Button>
          {skipButton}
        </div>
      ) : (
        <form onSubmit={submit} className="overflow-hidden rounded-3xl border border-line bg-card shadow-xl md:grid md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          {/* Scan: the QR, or on a phone the app opened directly; the key for typing it in. */}
          <section className="flex flex-col items-center justify-center gap-4 border-b border-line bg-raised/40 p-5 md:border-e md:border-b-0 md:p-8">
            <a
              href={setup.data.otpauthUrl}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 py-3 text-sm font-semibold text-on-brand shadow-sm transition-opacity hover:opacity-90 md:hidden"
            >
              <Smartphone className="size-4" /> {s.openApp}
            </a>
            <p className="text-xs text-muted md:hidden">{s.orScan}</p>
            <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-black/5">
              <img src={setup.data.qrImage} alt="QR" width={192} height={192} className="size-40 md:size-48" />
            </div>
            <div className="grid w-full gap-1.5">
              <p className="text-center text-xs text-muted">{s.manual}</p>
              <SecretKey value={setup.data.secret} />
            </div>
          </section>

          {/* The steps, then the code: everything to finish without leaving this side. */}
          <section className="flex flex-col justify-center gap-5 p-5 md:p-8">
            <ol className="grid gap-3.5">
              <Step n={1} title={s.step1Title}>
                <span className="mt-1.5 flex flex-wrap gap-1.5">
                  {['Google Authenticator', 'Microsoft Authenticator', 'Authy'].map((app) => (
                    <span key={app} className="ltr rounded-full border border-line bg-raised/50 px-2.5 py-0.5 text-[11px] text-ink-2">
                      {app}
                    </span>
                  ))}
                </span>
              </Step>
              <Step n={2} title={s.step2Title} text={s.step2} />
              <Step n={3} title={s.step3Title} text={s.step3} />
            </ol>
            <CodeBoxes
              value={code}
              disabled={loading}
              label={t.auth.totp.code}
              onChange={(next) => {
                setCode(next);
                setError(null);
                // The sixth digit sends it: no extra click.
                if (next.length === 6) void verify(next);
              }}
            />
            <ErrorNote>{error}</ErrorNote>
            <Button type="submit" loading={loading} disabled={code.length !== 6 || skipping} icon={<ShieldCheck className="size-4" />} className="h-11 w-full">
              {s.submit}
            </Button>
            {skipButton}
          </section>
        </form>
      )}
    </AuthLayout>
  );
}

/** One numbered step: a title, and a line or two under it. */
function Step({ n, title, text, children }: { n: number; title: string; text?: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="ltr grid size-7 shrink-0 place-items-center rounded-full bg-brand/15 text-xs font-bold text-brand">{n}</span>
      <span className="min-w-0 flex-1 pt-0.5">
        <span className="block text-sm font-semibold text-ink">{title}</span>
        {text && <span className="mt-0.5 block text-[13px] leading-relaxed text-muted">{text}</span>}
        {children}
      </span>
    </li>
  );
}

/** The setup key in groups of four, easy to read off and type; copies as one string. */
function SecretKey({ value }: { value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable; the key is selectable
    }
  };
  return (
    <div className="flex items-center gap-2 rounded-xl border border-line bg-raised/40 p-1.5 ps-3">
      <code className="ltr min-w-0 flex-1 font-mono text-[13px] leading-relaxed tracking-wider break-all text-ink select-all">{value.match(/.{1,4}/g)?.join(' ')}</code>
      <button
        type="button"
        onClick={() => void copy()}
        className="grid size-9 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-raised hover:text-ink"
        aria-label={t.common.copy}
        title={t.common.copy}
      >
        {copied ? <Check className="animate-scale-in size-4 text-brand" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

/**
 * Six boxes for the code, drawn over one real input (so paste, autofill and the phone's one-time-code
 * suggestion all work); the box being typed into is highlighted.
 */
function CodeBoxes({ value, onChange, disabled, label }: { value: string; onChange: (v: string) => void; disabled?: boolean; label: string }) {
  const [focused, setFocused] = useState(false);
  return (
    <label className="relative block">
      <span className="sr-only">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(asciiDigits(e.target.value).replace(/\D/g, '').slice(0, 6))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={disabled}
        inputMode="numeric"
        autoComplete="one-time-code"
        // Not on phones: the keyboard would cover the "open in app" button.
        autoFocus={typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches}
        dir="ltr"
        maxLength={6}
        className="absolute inset-0 z-10 size-full cursor-text opacity-0"
      />
      <span className="ltr grid grid-cols-6 gap-2" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => {
          const active = focused && (i === value.length || (value.length === 6 && i === 5));
          return (
            <span
              key={i}
              className={cx(
                'grid h-12 place-items-center rounded-xl border bg-raised/30 font-mono text-xl font-semibold text-ink transition-[border-color,box-shadow]',
                active ? 'border-ring ring-[3px] ring-ring/30' : value[i] ? 'border-line-strong' : 'border-line',
              )}
            >
              {value[i] ?? (active ? <span className="h-5 w-px animate-pulse bg-ink" /> : '')}
            </span>
          );
        })}
      </span>
    </label>
  );
}

/** Shown once, right after two-factor is turned on. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useI18n();
  const s = t.auth.setup2fa;
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable; the codes are selectable
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([`WA CodeFiye — recovery codes\n\n${text}\n`], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'wa-codefiye-recovery-codes.txt' });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AuthLayout title={s.codesTitle} subtitle={s.codesText} footer={null}>
      <div className="grid gap-5">
        <ul className="ltr grid grid-cols-2 gap-2 rounded-lg border border-line bg-raised/30 p-4 font-mono text-sm select-all">
          {codes.map((c) => (
            <li key={c} className="text-center">
              {c}
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />} onClick={() => void copy()}>
            {copied ? s.copied : s.copy}
          </Button>
          <Button variant="outline" icon={<Download className="size-4" />} onClick={download}>
            {s.download}
          </Button>
        </div>
        <Button className="w-full" onClick={onDone}>
          {s.saved}
        </Button>
      </div>
    </AuthLayout>
  );
}
