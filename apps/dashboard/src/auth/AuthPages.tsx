import { asciiDigits, phoneWithCountry } from '@wa/shared/phone';
import { Check, Code2, LayoutDashboard, LifeBuoy, Mail, Smartphone, Wallet } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../api';
import { BRAND } from '../brand';
import { useI18n } from '../i18n';
import type { Dict } from '../i18n/ar';
import { Link } from '../router';
import { Button, buttonClass, Checkbox, cx, delay, ErrorNote, Field, LangSwitch, LogoMark, ThemeSwitch } from '../ui';
import { countryByIso } from './countries';
import { DialField } from './DialField';
import { CodeStep, codeError, SEND_CODE_TIMEOUT_MS, type Ticket } from './Otp';

const linkClass = 'text-ink underline decoration-neutral-500 underline-offset-4 transition-colors hover:decoration-current';

type SignInMethod = 'phone' | 'email';

/** What the login and reset APIs store: an email, or a phone with the chosen calling code. */
function accountIdentity(method: SignInMethod, value: string, iso: string): string | null {
  const trimmed = value.trim();
  if (method === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : null;
  return phoneWithCountry(trimmed, countryByIso(iso).dial);
}

/** Phone or email, chosen before the field. The selected one is filled; the other stays quiet. */
function MethodSwitch({ value, onChange }: { value: SignInMethod; onChange: (method: SignInMethod) => void }) {
  const { t } = useI18n();
  const m = t.auth.method;
  const options = [
    { id: 'phone' as const, label: m.phone, icon: Smartphone },
    { id: 'email' as const, label: m.email, icon: Mail },
  ];
  return (
    <div role="tablist" aria-label={m.label} className="grid grid-cols-2 gap-1 rounded-lg bg-raised p-1">
      {options.map((option) => {
        const on = value === option.id;
        const Icon = option.icon;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(option.id)}
            className={cx('flex h-9 items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors', on ? 'bg-card text-ink shadow-xs' : 'text-muted hover:text-ink')}
          >
            <Icon className="size-4" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

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
      case 'reset_unavailable':
        return { message: e.resetUnavailable, fields: {} };
    }
    if (err.status === 422 && err.errors?.identifier) return { message: null, fields: { identifier: [e.identifierInvalid] } };
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
type LoginStep = 'phone' | 'totp' | 'done';
type LoginResponse = { step: LoginStep; loginId: string; loginToken?: string; expiresAt: string; ticket: Ticket | null };
type Stage = { kind: 'credentials' } | { kind: 'phone'; ticket: Ticket } | { kind: 'totp' };

/** The authenticator step; a recovery code can stand in for the app. */
function TotpStep({ login, onNext, onRestart }: { login: LoginRef; onNext: (res: LoginResponse) => void; onRestart: (message?: string) => void }) {
  const { t } = useI18n();
  const s = t.auth.totp;
  const [recovery, setRecovery] = useState(false);
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
      </div>
    </form>
  );
}

/** `onAuthed` runs once the session cookie is set (it clears the previous user's cached data and moves on). */
export function LoginPage({ onAuthed }: { onAuthed: () => void }) {
  const { t, lang } = useI18n();
  const l = t.auth.login;
  const [method, setMethod] = useState<SignInMethod>('phone');
  const [country, setCountry] = useState('EG');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
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
    else if (res.step === 'totp') setStage({ kind: 'totp' });
  };

  const restart = (message?: string) => {
    setStage({ kind: 'credentials' });
    setLogin(null);
    setPassword('');
    setError(message ?? null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setErrors({});
    const identity = accountIdentity(method, identifier, country);
    if (!identity) {
      setErrors({ [method]: [method === 'email' ? t.auth.errors.emailInvalid : t.auth.errors.phoneInvalid] });
      return;
    }
    setLoading(true);
    try {
      const res = await api<LoginResponse>('/api/auth/login', { method: 'POST', body: { identifier: identity, password, remember, lang }, timeoutMs: SEND_CODE_TIMEOUT_MS });
      proceed(res, { loginId: res.loginId, loginToken: res.loginToken ?? '' });
    } catch (err) {
      const { message, fields } = authError(err, 'login', t);
      setError(message);
      setErrors(fields.identifier ? { [method]: fields.identifier } : fields);
    } finally {
      setLoading(false);
    }
  };

  const ls = t.auth.register.loginSteps;
  // The phone step is skipped by the server when it can't send a code, so it only shows once reached.
  const stepItems = [{ id: 'credentials', label: ls.credentials }, ...(stage.kind === 'phone' ? [{ id: 'phone', label: ls.phone }] : []), { id: 'totp', label: ls.totp }];
  const steps = { items: stepItems, current: stage.kind };
  const panel = t.auth.register.loginPanel;

  if (login && stage.kind !== 'credentials') {
    const step = stage.kind === 'phone' ? { title: t.auth.loginPhone.title, subtitle: t.auth.loginPhone.subtitle } : { title: t.auth.totp.title, subtitle: t.auth.totp.subtitle };
    return (
      <SplitAuthLayout panel={panel} steps={steps} title={step.title} subtitle={step.subtitle} footer={null}>
        {stage.kind === 'phone' ? (
          <CodeStep
            ticket={stage.ticket}
            submitLabel={t.auth.loginPhone.submit}
            onVerify={async (_verificationId, code) => proceed(await api<LoginResponse>('/api/auth/login/phone', { method: 'POST', body: { ...login, code } }), login)}
            onResend={() => api<Ticket>('/api/auth/login/phone/resend', { method: 'POST', body: login, timeoutMs: SEND_CODE_TIMEOUT_MS })}
            onRestart={restart}
          />
        ) : (
          <TotpStep login={login} onNext={(res) => proceed(res, login)} onRestart={restart} />
        )}
      </SplitAuthLayout>
    );
  }

  return (
    <SplitAuthLayout
      panel={panel}
      steps={steps}
      title={l.title}
      subtitle={l.subtitle}
      footer={
        <>
          {l.noAccount}{' '}
          <Link href="/register" className={linkClass}>
            {l.register}
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="grid gap-5">
        <MethodSwitch
          value={method}
          onChange={(next) => {
            setMethod(next);
            setIdentifier('');
            setErrors({});
            setError(null);
          }}
        />
        {method === 'phone' ? (
          <DialField
            name={t.auth.method.phone}
            value={identifier}
            onChange={setIdentifier}
            country={country}
            onCountry={setCountry}
            placeholder={t.auth.register.phonePlaceholder}
            autoFocus
            required
            error={errors.phone}
          />
        ) : (
          <Field
            label={l.email}
            type="email"
            autoComplete="email"
            placeholder={l.emailPlaceholder}
            dir="ltr"
            className="ltr"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            required
            autoFocus
            error={errors.email}
          />
        )}
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
        <div className="flex items-center justify-between gap-3">
          <Checkbox label={l.remember} checked={remember} onChange={setRemember} />
          <Link href="/forgot" className="text-sm text-muted underline-offset-4 transition-colors hover:text-ink hover:underline">
            {l.forgot}
          </Link>
        </div>
        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" loading={loading} size="lg" className="mt-2 w-full">
          {l.submit}
        </Button>
      </form>
    </SplitAuthLayout>
  );
}

/** Rough strength from length and variety — a hint, not the server's rule (which is length + a blocklist). */
function passwordStrength(password: string): 0 | 1 | 2 | 3 {
  if (!password) return 0;
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[^a-z0-9]/i.test(password) || (/[a-z]/.test(password) && /[A-Z]/.test(password)) || (/\d/.test(password) && /[a-z]/i.test(password))) score++;
  if (/^(.)\1+$/.test(password) || /^(1234|abcd|qwer|pass)/i.test(password)) score = Math.min(score, 1);
  return Math.min(3, Math.max(1, score)) as 1 | 2 | 3;
}

function StrengthMeter({ password }: { password: string }) {
  const { t } = useI18n();
  const s = t.auth.register.strength;
  const level = passwordStrength(password);
  if (!password) return null;
  const label = level <= 1 ? s.weak : level === 2 ? s.fair : s.strong;
  const color = level <= 1 ? 'bg-critical' : level === 2 ? 'bg-warning' : 'bg-brand';
  return (
    <div className="animate-fade-in flex items-center gap-2" aria-live="polite">
      <span className="flex flex-1 gap-1">
        {[1, 2, 3].map((i) => (
          <span key={i} className={cx('h-1 flex-1 rounded-full transition-colors duration-300', i <= level ? color : 'bg-line')} />
        ))}
      </span>
      <span className="text-[11px] text-muted">
        {s.label}: <span className="font-medium text-ink-2">{label}</span>
      </span>
    </div>
  );
}

/** Where we are in a multi-step flow: done steps ticked, the current one highlighted. */
function Steps({ items, current }: { items: { id: string; label: string }[]; current: string }) {
  const at = items.findIndex((s) => s.id === current);
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs">
      {items.map((s, i) => {
        const done = i < at;
        const active = i === at;
        return (
          <li key={s.id} className="flex items-center gap-2">
            {i > 0 && <span className={cx('h-px w-6 transition-colors sm:w-8', done || active ? 'bg-brand' : 'bg-line')} />}
            <span className={cx('flex size-5 items-center justify-center rounded-full text-[11px] font-semibold transition-colors', active || done ? 'bg-brand text-on-brand' : 'bg-raised text-muted')}>
              {done ? <Check className="size-3" /> : i + 1}
            </span>
            <span className={cx('font-medium', active ? 'text-ink' : 'text-muted')}>{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Two columns: what the product offers on the start side (the brand gradient), the form on the end
 * side; on small screens only the form shows. `steps` draws the progress of a multi-step flow.
 */
function SplitAuthLayout({
  panel,
  steps,
  title,
  subtitle,
  children,
  footer,
}: {
  panel: { eyebrow: string; heading: string };
  steps?: { items: { id: string; label: string }[]; current: string };
  title: string;
  subtitle: ReactNode;
  children: ReactNode;
  footer: ReactNode;
}) {
  const { t } = useI18n();
  const r = t.auth.register;
  const icons = [Wallet, Code2, LayoutDashboard];
  return (
    <main className="relative flex min-h-svh bg-bg">
      {/* brand panel */}
      <aside className="relative hidden w-[46%] max-w-xl shrink-0 overflow-hidden bg-gradient-to-br from-grad-from to-grad-to text-on-brand lg:sticky lg:top-0 lg:flex lg:h-svh lg:flex-col lg:justify-between lg:p-10 xl:p-12">
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.12] [background-image:radial-gradient(currentColor_1px,transparent_1px)] [background-size:22px_22px]" />
        <div aria-hidden className="animate-glow pointer-events-none absolute -bottom-32 -start-24 size-[420px] rounded-full bg-white/15 blur-[100px]" />
        <Link href="/" aria-label={t.common.home} className="animate-fade-up relative inline-flex w-fit items-center gap-2.5">
          <LogoMark className="size-9" />
          <span dir="ltr" className="text-lg font-bold tracking-tight">
            {BRAND.name}
          </span>
        </Link>
        <div className="relative space-y-6 py-6">
          <div className="animate-fade-up space-y-2" style={delay(80)}>
            <p className="text-xs font-semibold tracking-[0.2em] uppercase opacity-70">{panel.eyebrow}</p>
            <h2 className="text-2xl leading-tight font-bold xl:text-3xl">{panel.heading}</h2>
          </div>
          <ul className="space-y-4">
            {r.panel.points.map((p, i) => {
              const Icon = icons[i] ?? Check;
              return (
                <li key={p.title} className="animate-fade-up flex items-start gap-4" style={delay(160 + i * 80)}>
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/15 ring-1 ring-white/20 backdrop-blur">
                    <Icon className="size-5" />
                  </span>
                  <span>
                    <span className="block font-semibold">{p.title}</span>
                    <span className="block text-sm opacity-80">{p.text}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="animate-fade-in relative flex flex-wrap gap-2 text-xs font-medium" style={delay(450)}>
          <span className="rounded-full bg-white/15 px-3 py-1.5 ring-1 ring-white/20">{r.panel.trial}</span>
          <span className="rounded-full bg-white/15 px-3 py-1.5 ring-1 ring-white/20">{r.panel.noCard}</span>
        </div>
      </aside>

      {/* form */}
      <section className="page-wash relative flex min-w-0 flex-1 flex-col items-center justify-center px-6 py-14 md:px-10 lg:py-8">
        <div className="absolute top-3 end-3 flex items-center gap-1">
          <ThemeSwitch />
          <LangSwitch />
        </div>
        <Link href="/" aria-label={t.common.home} className="absolute top-4 start-5 lg:hidden">
          <LogoMark className="size-9" />
        </Link>
        <div className="relative w-full max-w-md space-y-6">
          <div className="animate-fade-up space-y-4">
            {steps && <Steps items={steps.items} current={steps.current} />}
            <div className="space-y-1.5">
              <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
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
      </section>
    </main>
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
  const [country, setCountry] = useState('EG');
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
    const normalized = phoneWithCountry(phone, countryByIso(country).dial);
    if (!normalized) return setErrors({ phone: [t.auth.errors.phoneInvalid] });
    if (password !== confirm) return setErrors({ confirm: [r.mismatch] });
    setLoading(true);
    try {
      setTicket(await api<Ticket>('/api/auth/register', { method: 'POST', body: { name, email, phone: normalized, password, lang }, timeoutMs: SEND_CODE_TIMEOUT_MS }));
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

  const steps = (current: 'details' | 'verify') => ({ items: [{ id: 'details', label: r.steps.details }, { id: 'verify', label: r.steps.verify }], current });

  if (ticket) {
    return (
      <SplitAuthLayout panel={r.panel} steps={steps('verify')} title={t.auth.verify.title} subtitle={r.subtitle} footer={footer}>
        <CodeStep
          ticket={ticket}
          submitLabel={t.auth.verify.submit}
          onVerify={async (verificationId, code) => {
            await api('/api/auth/register/verify', { method: 'POST', body: { verificationId, code, remember: true } });
            onAuthed();
          }}
          onResend={(verificationId) => api<Ticket>('/api/auth/register/resend', { method: 'POST', body: { verificationId }, timeoutMs: SEND_CODE_TIMEOUT_MS })}
          onRestart={(message) => {
            setTicket(null);
            setError(message ?? null);
          }}
        />
      </SplitAuthLayout>
    );
  }

  return (
    <SplitAuthLayout panel={r.panel} steps={steps('details')} title={r.title} subtitle={r.subtitle} footer={footer}>
      <form onSubmit={submit} className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
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
        </div>
        <DialField
          label={r.phone}
          value={phone}
          onChange={setPhone}
          country={country}
          onCountry={setCountry}
          placeholder={r.phonePlaceholder}
          required
          hint={r.phoneHint}
          error={errors.phone}
        />
        <div className="grid gap-2">
          <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
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
              aside={confirm && password === confirm ? <Check className="size-3.5 text-brand" aria-hidden /> : undefined}
            />
          </div>
          <StrengthMeter password={password} />
        </div>
        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" loading={loading} size="lg" className="mt-1 w-full">
          {r.next}
        </Button>
        <p className="text-center text-xs text-faint">{r.agree}</p>
      </form>
    </SplitAuthLayout>
  );
}

/**
 * Replace a forgotten password: name the account, then the code sent to its verified phone plus a
 * new password. The session is not opened here — logging in still asks for the authenticator.
 */
export function ForgotPasswordPage() {
  const { t, lang } = useI18n();
  const f = t.auth.forgot;
  const r = t.auth.register;
  const [country, setCountry] = useState('EG');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false);

  const steps = {
    items: [
      { id: 'account', label: f.steps.account },
      { id: 'password', label: f.steps.password },
    ],
    current: ticket || done ? 'password' : 'account',
  };
  const footer = (
    <Link href="/login" className={linkClass}>
      {f.back}
    </Link>
  );

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setErrors({});
    const identity = phoneWithCountry(phone, countryByIso(country).dial);
    if (!identity) {
      setErrors({ phone: [t.auth.errors.phoneInvalid] });
      return;
    }
    setLoading(true);
    try {
      setTicket(await api<Ticket>('/api/auth/forgot', { method: 'POST', body: { identifier: identity, lang }, timeoutMs: SEND_CODE_TIMEOUT_MS }));
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'phone_unreachable') {
        setError(t.auth.errors.phoneUnreachable);
      } else {
        const mapped = authError(err, 'login', t);
        setError(mapped.message);
        setErrors(mapped.fields.identifier ? { phone: mapped.fields.identifier } : mapped.fields);
      }
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <SplitAuthLayout panel={f.panel} steps={steps} title={f.doneTitle} subtitle={f.done} footer={footer}>
        <Link href="/login" className={buttonClass('brand', 'lg', 'w-full')}>
          {f.login}
        </Link>
      </SplitAuthLayout>
    );
  }

  if (ticket) {
    return (
      <SplitAuthLayout panel={f.panel} steps={steps} title={f.codeTitle} subtitle={f.codeSubtitle} footer={footer}>
        <CodeStep
          ticket={ticket}
          submitLabel={f.save}
          prepare={() => (password !== confirm ? r.mismatch : password.length < 8 ? t.auth.errors.weakPassword : null)}
          onVerify={async (verificationId, code) => {
            try {
              await api('/api/auth/forgot/confirm', { method: 'POST', body: { verificationId, code, password } });
            } catch (err) {
              if (err instanceof ApiRequestError && err.errors?.password) throw new Error(t.auth.errors.weakPassword);
              throw err;
            }
            setDone(true);
          }}
          onResend={(verificationId) => api<Ticket>('/api/auth/forgot/resend', { method: 'POST', body: { verificationId }, timeoutMs: SEND_CODE_TIMEOUT_MS })}
          onRestart={(message) => {
            setTicket(null);
            setPassword('');
            setConfirm('');
            setError(message ?? null);
          }}
        >
          <Field
            label={f.password}
            type="password"
            autoComplete="new-password"
            placeholder={r.passwordPlaceholder}
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <div className="grid gap-2">
            <Field
              label={f.confirm}
              type="password"
              autoComplete="new-password"
              placeholder={r.confirmPlaceholder}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              aside={confirm && password === confirm ? <Check className="size-3.5 text-brand" aria-hidden /> : undefined}
            />
            <StrengthMeter password={password} />
          </div>
        </CodeStep>
      </SplitAuthLayout>
    );
  }

  return (
    <SplitAuthLayout panel={f.panel} steps={steps} title={f.title} subtitle={f.subtitle} footer={footer}>
      <form onSubmit={send} className="grid gap-5">
        <DialField
          label={r.phone}
          value={phone}
          onChange={setPhone}
          country={country}
          onCountry={setCountry}
          placeholder={r.phonePlaceholder}
          autoFocus
          required
          error={errors.phone}
        />
        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" loading={loading} size="lg" className="mt-2 w-full">
          {f.submit}
        </Button>
      </form>
    </SplitAuthLayout>
  );
}

