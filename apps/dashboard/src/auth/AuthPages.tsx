import { normalizePhone } from '@wa/shared/phone';
import { KeyRound } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../api';
import { useI18n } from '../i18n';
import type { Dict } from '../i18n/ar';
import { Link } from '../router';
import { Button, Checkbox, delay, ErrorNote, Field, LangSwitch, LogoMark } from '../ui';
import { CodeStep, type Ticket } from './Otp';

const linkClass = 'text-ink underline decoration-neutral-500 underline-offset-4 transition-colors hover:decoration-current';

function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle: ReactNode; children: ReactNode; footer: ReactNode }) {
  const { t } = useI18n();
  return (
    <main className="relative flex min-h-svh flex-col items-center justify-center gap-6 overflow-hidden bg-bg p-6 md:p-10">
      <div aria-hidden className="animate-glow pointer-events-none absolute -top-40 left-1/2 size-[480px] -translate-x-1/2 rounded-full bg-brand/[0.07] blur-[110px]" />
      <div className="absolute top-4 end-4 flex items-center gap-1">
        <LangSwitch />
      </div>
      <div className="relative flex w-full max-w-sm flex-col gap-8">
        <div className="animate-fade-up flex flex-col items-center gap-4">
          <Link href="/" aria-label={t.common.home} className="transition-transform duration-500 hover:scale-105 hover:-rotate-6">
            <LogoMark className="size-11" />
          </Link>
          <div className="space-y-2 text-center">
            <h1 className="text-xl font-medium">{title}</h1>
            <p className="text-sm text-muted">{subtitle}</p>
          </div>
        </div>
        <div className="animate-fade-up" style={delay(120)}>
          {children}
        </div>
        <p className="animate-fade-in text-center text-sm text-muted" style={delay(300)}>
          {footer}
        </p>
      </div>
    </main>
  );
}

/** The API speaks English to developers; the dashboard maps the auth failures users can hit to the UI language. */
function authError(err: unknown, flow: 'login' | 'register', t: Dict): { message: string | null; fields: Record<string, string[]> } {
  const e = t.auth.errors;
  if (err instanceof ApiRequestError) {
    switch (err.code) {
      case 'invalid_credentials':
        return { message: e.invalidLogin, fields: {} };
      case 'account_suspended': {
        const reason = typeof err.details?.reason === 'string' ? ` ${t.app.suspended.reason}: ${err.details.reason}` : '';
        return { message: e.suspended + reason, fields: {} };
      }
      case 'email_taken':
        return { message: null, fields: { email: [e.emailTaken] } };
      case 'phone_taken':
        return { message: null, fields: { phone: [e.phoneTaken] } };
      case 'phone_unreachable':
        return { message: null, fields: { phone: [e.phoneUnreachable] } };
      case 'otp_unavailable':
        return { message: e.otpUnavailable, fields: {} };
      case 'rate_limited':
        return { message: t.errors.rateLimited(Number(err.details?.retryAfter ?? 0) || null), fields: {} };
    }
    if (flow === 'register' && err.status === 422 && err.errors) {
      const fields: Record<string, string[]> = {};
      if (err.errors.password) fields.password = [e.weakPassword];
      if (err.errors.phone) fields.phone = [e.phoneInvalid];
      if (err.errors.email) fields.email = [e.checkInput];
      if (err.errors.name) fields.name = [e.checkInput];
      return { message: Object.keys(fields).length ? null : e.checkInput, fields };
    }
    if (err.status === 422) return { message: e.checkInput, fields: {} };
    if (err.status === 401) return { message: e.invalidToken, fields: {} };
  }
  return { message: errorMessage(err), fields: {} };
}

/** `onAuthed` runs once the session cookie is set (it clears the previous user's cached data and moves on). */
export function LoginPage({ onAuthed }: { onAuthed: () => void }) {
  const { t } = useI18n();
  const l = t.auth.login;
  const [mode, setMode] = useState<'password' | 'token'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setErrors({});
    try {
      if (mode === 'password') {
        await api('/api/auth/login', { method: 'POST', body: { email, password, remember } });
      } else {
        const value = token.trim();
        if (!value.startsWith('wap_')) throw new Error(l.tokenPrefixError);
        // The token itself is never stored: it's exchanged for the HttpOnly session cookie.
        await api('/api/auth/session', { method: 'POST', token: value, body: { remember } });
      }
      onAuthed();
    } catch (err) {
      const { message, fields } = authError(err, 'login', t);
      setError(message);
      setErrors(fields);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title={l.title}
      subtitle={mode === 'password' ? l.subtitlePassword : l.subtitleToken}
      footer={
        <>
          {l.noAccount}{' '}
          <Link href="/register" className={linkClass}>
            {l.register}
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="grid gap-6">
        {mode === 'password' ? (
          <div key="password" className="animate-fade-in grid gap-6">
            <Field
              label={l.email}
              type="email"
              autoComplete="email"
              placeholder="email@example.com"
              dir="ltr"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              error={errors.email}
            />
            <Field
              label={l.password}
              type="password"
              autoComplete="current-password"
              placeholder={l.passwordPlaceholder}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              error={errors.password}
            />
          </div>
        ) : (
          <div key="token" className="animate-fade-in">
            <Field
              label={l.token}
              placeholder="wap_…"
              dir="ltr"
              className="font-mono"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              autoFocus
              autoComplete="off"
              hint={l.tokenHint}
            />
          </div>
        )}
        <Checkbox label={l.remember} checked={remember} onChange={setRemember} />
        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" loading={loading} className="mt-4 w-full">
          {l.submit}
        </Button>
        <button
          type="button"
          onClick={() => {
            setMode((m) => (m === 'password' ? 'token' : 'password'));
            setError(null);
            setErrors({});
          }}
          className="mx-auto flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-ink"
        >
          <KeyRound className="size-3.5" />
          {mode === 'password' ? l.toToken : l.toPassword}
        </button>
      </form>
    </AuthLayout>
  );
}

/**
 * Sign-up in two steps: the details (email, phone, password), then the code sent to the phone.
 * The account exists only after the code is confirmed.
 */
export function RegisterPage({ onAuthed }: { onAuthed: () => void }) {
  const { t, lang } = useI18n();
  const r = t.auth.register;
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setErrors({});
    const normalized = normalizePhone(phone);
    if (!normalized) return setErrors({ phone: [t.auth.errors.phoneInvalid] });
    if (password !== confirm) return setErrors({ confirm: [r.mismatch] });
    setLoading(true);
    try {
      setTicket(await api<Ticket>('/api/auth/register', { method: 'POST', body: { name, email, phone: normalized, password, lang } }));
    } catch (err) {
      const { message, fields } = authError(err, 'register', t);
      setError(message);
      setErrors(fields);
    } finally {
      setLoading(false);
    }
  };

  const footer = (
    <>
      {r.haveAccount}{' '}
      <Link href="/login" className={linkClass}>
        {r.login}
      </Link>
    </>
  );

  if (ticket) {
    return (
      <AuthLayout title={t.auth.verify.title} subtitle={r.subtitle} footer={footer}>
        <CodeStep
          ticket={ticket}
          submitLabel={t.auth.verify.submit}
          onVerify={async (verificationId, code) => {
            await api('/api/auth/register/verify', { method: 'POST', body: { verificationId, code, remember: true } });
            onAuthed();
          }}
          onResend={(verificationId) => api<Ticket>('/api/auth/register/resend', { method: 'POST', body: { verificationId } })}
          onRestart={(message) => {
            setTicket(null);
            setError(message ?? null);
          }}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={r.title} subtitle={r.subtitle} footer={footer}>
      <form onSubmit={submit} className="grid gap-6">
        <Field label={r.name} autoComplete="name" placeholder={r.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} required autoFocus error={errors.name} />
        <Field
          label={t.auth.login.email}
          type="email"
          autoComplete="email"
          placeholder="email@example.com"
          dir="ltr"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          error={errors.email}
        />
        <Field
          label={r.phone}
          type="tel"
          autoComplete="tel"
          placeholder={r.phonePlaceholder}
          dir="ltr"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
          hint={r.phoneHint}
          error={errors.phone}
        />
        <Field
          label={r.password}
          type="password"
          autoComplete="new-password"
          placeholder={r.passwordPlaceholder}
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          error={errors.password}
        />
        <Field
          label={r.confirm}
          type="password"
          autoComplete="new-password"
          placeholder={r.confirmPlaceholder}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          error={errors.confirm}
        />
        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" loading={loading} className="mt-4 w-full">
          {r.next}
        </Button>
      </form>
    </AuthLayout>
  );
}

