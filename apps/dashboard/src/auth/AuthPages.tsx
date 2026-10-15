import { asciiDigits, normalizePhone } from '@wa/shared/phone';
import { KeyRound, LifeBuoy, Loader2, MonitorSmartphone } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useEffectEvent, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../api';
import { getDict, useI18n } from '../i18n';
import type { Dict } from '../i18n/ar';
import { Link } from '../router';
import { Button, Checkbox, cx, delay, ErrorNote, Field, LangSwitch, LogoMark, ThemeSwitch } from '../ui';
import { CodeStep, codeError, type Ticket } from './Otp';

const linkClass = 'text-ink underline decoration-neutral-500 underline-offset-4 transition-colors hover:decoration-current';

/** `wide`: a two-column screen (two-factor setup) that should fit without scrolling. */
export function AuthLayout({ title, subtitle, children, footer, wide }: { title: string; subtitle: ReactNode; children: ReactNode; footer: ReactNode; wide?: boolean }) {
  const { t } = useI18n();
  return (
    <main className={cx('page-wash relative flex min-h-svh flex-col items-center justify-center gap-6 overflow-hidden bg-bg p-6 md:p-10', wide && 'px-4 pt-16 pb-6 md:p-8')}>
      <div aria-hidden className="animate-glow pointer-events-none absolute -top-40 left-1/2 size-[480px] -translate-x-1/2 rounded-full bg-brand/[0.07] blur-[110px]" />
      <div className="absolute top-4 end-4 flex items-center gap-1">
        <ThemeSwitch />
        <LangSwitch />
      </div>
      <div className={cx('relative flex w-full flex-col', wide ? 'max-w-4xl gap-6' : 'max-w-sm gap-8')}>
        <div className={cx('animate-fade-up flex flex-col items-center', wide ? 'gap-3' : 'gap-4')}>
          <Link href="/" aria-label={t.common.home} className="transition-transform duration-500 hover:scale-105 hover:-rotate-6">
            <LogoMark className={wide ? 'size-10' : 'size-11'} />
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

/** A login in progress (see `/api/auth/login`): the client holds it by id + secret token. */
type LoginRef = { loginId: string; loginToken: string };
type LoginStep = 'phone' | 'totp' | 'approval' | 'done';
type LoginResponse = { step: LoginStep; loginId: string; loginToken?: string; expiresAt: string; ticket: Ticket | null };
type Stage = { kind: 'credentials' } | { kind: 'phone'; ticket: Ticket } | { kind: 'totp'; recovery: boolean } | { kind: 'approval' };

/** The authenticator step; `recoveryOnly` when coming from the approval wait ("can't reach the other device"). */
function TotpStep({
  login,
  recoveryOnly,
  onNext,
  onRestart,
}: {
  login: LoginRef;
  recoveryOnly: boolean;
  onNext: (res: LoginResponse) => void;
  onRestart: (message?: string) => void;
}) {
  const { t } = useI18n();
  const s = t.auth.totp;
  const [recovery, setRecovery] = useState(recoveryOnly);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const ready = recovery ? code.replace(/[\s-]/g, '').length >= 10 : code.length === 6;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || loading) return;
    setLoading(true);
    setError(null);
    try {
      onNext(await api<LoginResponse>(recovery ? '/api/auth/login/recovery' : '/api/auth/login/totp', { method: 'POST', body: { ...login, code } }));
    } catch (err) {
      setCode('');
      const { message, restart } = codeError(err, t);
      if (restart) return onRestart(message);
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-5">
      {recovery ? (
        <Field
          key="recovery"
          label={s.recovery}
          value={code}
          onChange={(e) => setCode(e.target.value.toLowerCase().slice(0, 16))}
          autoComplete="off"
          dir="ltr"
          placeholder="xxxxx-xxxxx"
          className="text-center font-mono text-lg tracking-widest"
          hint={s.recoveryHint}
          autoFocus
          required
        />
      ) : (
        <Field
          key="app"
          label={s.code}
          value={code}
          onChange={(e) => setCode(asciiDigits(e.target.value).replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          dir="ltr"
          placeholder="••••••"
          className="text-center font-mono text-xl tracking-[0.5em]"
          autoFocus
          required
        />
      )}
      <ErrorNote>{error}</ErrorNote>
      <Button type="submit" loading={loading} disabled={!ready} className="w-full">
        {s.submit}
      </Button>
      <div className="flex items-center justify-between gap-3 text-sm">
        <button type="button" onClick={() => onRestart()} className="text-muted underline-offset-4 transition-colors hover:text-ink hover:underline">
          {t.auth.loginPhone.back}
        </button>
        {!recoveryOnly && (
          <button
            type="button"
            onClick={() => {
              setRecovery((r) => !r);
              setCode('');
              setError(null);
            }}
            className="flex items-center gap-1.5 text-muted transition-colors hover:text-ink"
          >
            <LifeBuoy className="size-3.5" />
            {recovery ? s.useApp : s.useRecovery}
          </button>
        )}
      </div>
    </form>
  );
}

/** Polls the login while the signed-in device decides. */
function ApprovalStep({ login, onNext, onRestart, onRecovery }: { login: LoginRef; onNext: (res: LoginResponse) => void; onRestart: (message?: string) => void; onRecovery: () => void }) {
  const { t } = useI18n();
  const a = t.auth.approval;
  const next = useEffectEvent(onNext);
  const restart = useEffectEvent((err: unknown) => onRestart(codeError(err, getDict()).message));

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const res = await api<LoginResponse>('/api/auth/login/status', { method: 'POST', body: login, timeoutMs: 10_000 });
        if (stopped) return;
        if (res.step !== 'approval') return next(res);
      } catch (err) {
        if (stopped) return;
        // Network blips and rate limits just wait for the next round; an ended login goes back to the start.
        if (err instanceof ApiRequestError && (err.status === 403 || err.status === 404)) return restart(err);
      }
      timer = setTimeout(() => void poll(), 3_000);
    };
    timer = setTimeout(() => void poll(), 3_000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [login]);

  const cancel = () => {
    void api('/api/auth/login/cancel', { method: 'POST', body: login }).catch(() => {});
    onRestart();
  };

  return (
    <div className="grid gap-5">
      <div className="flex flex-col items-center gap-4 rounded-lg border border-line bg-raised/30 p-5 text-center">
        <span className="relative flex size-14 items-center justify-center rounded-full bg-brand/15 text-brand">
          <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-brand/20 motion-reduce:animate-none" />
          <MonitorSmartphone className="size-7" />
        </span>
        <p className="text-sm text-ink-2">{a.text}</p>
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          {a.waiting}
        </p>
      </div>
      <button type="button" onClick={onRecovery} className="mx-auto flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-ink">
        <LifeBuoy className="size-3.5" />
        {a.lost}
      </button>
      <Button variant="outline" className="w-full" onClick={cancel}>
        {a.cancel}
      </Button>
    </div>
  );
}

/** `onAuthed` runs once the session cookie is set (it clears the previous user's cached data and moves on). */
export function LoginPage({ onAuthed }: { onAuthed: () => void }) {
  const { t, lang } = useI18n();
  const l = t.auth.login;
  const [mode, setMode] = useState<'password' | 'token'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false);
  const [login, setLogin] = useState<LoginRef | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'credentials' });

  /** Where the server says this login goes next. */
  const proceed = (res: LoginResponse, ref: LoginRef) => {
    if (res.step === 'done') return onAuthed();
    setLogin(ref);
    if (res.step === 'phone' && res.ticket) setStage({ kind: 'phone', ticket: res.ticket });
    else if (res.step === 'totp') setStage({ kind: 'totp', recovery: false });
    else if (res.step === 'approval') setStage({ kind: 'approval' });
  };

  const restart = (message?: string) => {
    setStage({ kind: 'credentials' });
    setLogin(null);
    setPassword('');
    setError(message ?? null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setErrors({});
    try {
      if (mode === 'password') {
        const res = await api<LoginResponse>('/api/auth/login', { method: 'POST', body: { email, password, remember, lang } });
        return proceed(res, { loginId: res.loginId, loginToken: res.loginToken ?? '' });
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

  if (login && stage.kind !== 'credentials') {
    const step =
      stage.kind === 'phone'
        ? { title: t.auth.loginPhone.title, subtitle: t.auth.loginPhone.subtitle }
        : stage.kind === 'totp'
          ? { title: t.auth.totp.title, subtitle: stage.recovery ? t.auth.totp.recoveryHint : t.auth.totp.subtitle }
          : { title: t.auth.approval.title, subtitle: email };
    return (
      <AuthLayout title={step.title} subtitle={step.subtitle} footer={null}>
        {stage.kind === 'phone' ? (
          <CodeStep
            ticket={stage.ticket}
            submitLabel={t.auth.loginPhone.submit}
            onVerify={async (_verificationId, code) => proceed(await api<LoginResponse>('/api/auth/login/phone', { method: 'POST', body: { ...login, code } }), login)}
            onResend={() => api<Ticket>('/api/auth/login/phone/resend', { method: 'POST', body: login })}
            onRestart={restart}
          />
        ) : stage.kind === 'totp' ? (
          <TotpStep key={String(stage.recovery)} login={login} recoveryOnly={stage.recovery} onNext={(res) => proceed(res, login)} onRestart={restart} />
        ) : (
          <ApprovalStep login={login} onNext={(res) => proceed(res, login)} onRestart={restart} onRecovery={() => setStage({ kind: 'totp', recovery: true })} />
        )}
      </AuthLayout>
    );
  }

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

