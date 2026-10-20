import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Building2, Check, CheckCircle2, Lock, LockKeyhole, Mail, ShieldCheck, Smartphone, UserRound, XCircle } from '../icons';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../api';
import { type Account, planState, useAccount } from '../app/account';
import { ChangePassword } from '../app/AppShell';
import { PhoneVerifyModal } from '../auth/Otp';
import { useI18n } from '../i18n';
import { qk } from '../queries';
import { Link } from '../router';
import { Badge, Button, cx, delay, ErrorNote, Field, flip, PageHeader, type Tone, TONES, usePlanName, VerifiedMark } from '../ui';

type User = NonNullable<Account['user']>;

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

/** Section label: small caps with wide tracking (as on the dashboard). */
function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">{children}</p>;
}

/** Square tinted icon in front of a row or a section title. */
function Tile({ icon: Icon, tone, className }: { icon: typeof Mail; tone?: Tone; className?: string }) {
  return (
    <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-xl', tone ? TONES[tone].chip : 'bg-brand/12 text-brand', className)}>
      <Icon className="size-[1.125rem]" />
    </span>
  );
}

/** A settings panel: icon, title and a line of help, then the body. */
function Section({ icon, title, text, index, children, bodyClassName }: { icon: typeof Mail; title: string; text: string; index: number; children: ReactNode; bodyClassName?: string }) {
  return (
    <section style={delay(120 + index * 80)} className="card-luxury animate-fade-up min-w-0 rounded-2xl border border-line transition-colors hover:border-line-strong">
      <header className="flex items-start gap-3.5 px-6 pt-6">
        <Tile icon={icon} className="mt-0.5" />
        <div className="min-w-0 space-y-1">
          <h2 className="text-lg leading-tight font-bold tracking-tight">{title}</h2>
          <p className="text-sm text-muted">{text}</p>
        </div>
      </header>
      <div className={cx('px-6 pt-5 pb-6', bodyClassName)}>{children}</div>
    </section>
  );
}

// --- identity ------------------------------------------------------------------------------------

type Check = { label: string; tone: Tone; status: string };

/** The account at a glance: who you are, the plan, and what still needs attention. */
function IdentityCard({ account }: { account: Account }) {
  const { t, fmt } = useI18n();
  const planName = usePlanName();
  const user = account.user;
  const name = user?.name ?? account.workspace.name;
  const mark = initials(name);

  const state = planState(account);
  const planOk = state.kind !== 'expired' && state.kind !== 'trial-expired';
  const d = t.dashboard;
  const planLine =
    state.endsAt === null
      ? d.noExpiry
      : state.kind === 'trial' || state.kind === 'trial-expired'
        ? d.trialEnds(fmt.date(state.endsAt))
        : state.kind === 'expired'
          ? d.expired(fmt.date(state.endsAt))
          : d.expires(fmt.date(state.endsAt));

  const checks: Check[] = [];
  if (user) {
    const ph = t.profile.phone;
    checks.push({
      label: ph.title,
      tone: !user.phone ? 'neutral' : user.phoneVerified ? 'good' : 'warning',
      status: !user.phone ? ph.missing : user.phoneVerified ? ph.verified : ph.unverified,
    });
    checks.push({
      label: t.profile.security.twoFactor,
      tone: user.twoFactorEnabled ? 'good' : 'warning',
      status: user.twoFactorEnabled ? t.profile.security.on : t.profile.security.twoFactorOff,
    });
  }
  checks.push({ label: d.subscription, tone: planOk ? 'good' : 'critical', status: planOk ? t.subscription.active : t.subscription.expired });
  const done = checks.filter((c) => c.tone === 'good').length;

  return (
    <aside className="card-premium animate-fade-up overflow-hidden rounded-2xl xl:sticky xl:top-6">
      {/* Cover: the brand gradient under a dot grid, with the monogram as a watermark in the end corner. */}
      <div aria-hidden className="relative h-28 overflow-hidden bg-gradient-to-br from-grad-from to-grad-to">
        <div className="absolute inset-0 opacity-[0.14] [background-image:radial-gradient(#fff_1px,transparent_1px)] [background-size:18px_18px]" />
        <span className="absolute -bottom-8 end-3 text-[8rem] leading-none font-bold tracking-tighter text-on-brand/10 select-none">{mark}</span>
      </div>

      <div className="relative px-6 pb-6">
        <span className="-mt-10 flex size-20 items-center justify-center rounded-2xl bg-ink text-2xl font-bold tracking-tight text-bg shadow-lg ring-4 ring-card">{mark}</span>

        <div className="mt-4 min-w-0">
          <h2 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            <span className="truncate">{name}</span>
            {user?.isAdmin && <VerifiedMark className="[&>svg]:size-5" />}
          </h2>
          <ul className="mt-1.5 space-y-1 text-sm text-muted">
            {user?.email && (
              <li className="flex items-center gap-2">
                <Mail className="size-3.5 shrink-0" />
                <span className="ltr truncate">{user.email}</span>
              </li>
            )}
            <li className="flex items-center gap-2">
              <Building2 className="size-3.5 shrink-0" />
              <span className="truncate">{account.workspace.name}</span>
            </li>
          </ul>
          {user?.isAdmin && (
            <Badge tone="info" className="mt-3 gap-1">
              <ShieldCheck className="size-3.5" />
              {t.profile.verified}
            </Badge>
          )}
        </div>

        <div className="mt-6 grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-1">
          {/* plan */}
          <div className="animate-fade-up space-y-2 border-t border-line pt-5" style={delay(160)}>
            <div className="flex items-center justify-between gap-2">
              <Eyebrow>{d.subscription}</Eyebrow>
              <Badge tone={planOk ? 'good' : 'critical'}>{planOk ? t.subscription.active : t.subscription.expired}</Badge>
            </div>
            <p className="text-lg leading-tight font-bold tracking-tight">{planName(account.plan)}</p>
            <p className={cx('text-xs', planOk ? 'text-muted' : 'text-critical')}>{planLine}</p>
            <Link href="/subscription" className="group inline-flex items-center gap-1 pt-1 text-sm font-semibold text-brand hover:underline">
              {d.manageSubscription}
              <ArrowRight className={cx('size-4 transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5', flip)} />
            </Link>
          </div>

          {/* checklist */}
          <div className="animate-fade-up space-y-3 border-t border-line pt-5" style={delay(220)}>
            <div className="flex items-center justify-between gap-2">
              <Eyebrow>{t.profile.status}</Eyebrow>
              <span className={cx('ltr font-mono text-xs font-semibold tabular-nums', done === checks.length ? 'text-brand' : 'text-muted')}>
                {done}/{checks.length}
              </span>
            </div>
            <ul className="space-y-2.5">
              {checks.map((c, i) => (
                <li key={c.label} className="animate-fade-up flex items-center justify-between gap-3 text-sm" style={delay(280 + i * 50)}>
                  <span className="flex min-w-0 items-center gap-2.5 text-ink-2">
                    <span className={cx('size-1.5 shrink-0 rounded-full', TONES[c.tone].dot, c.tone === 'good' && 'shadow-[0_0_0_3px] shadow-good/25')} />
                    <span className="truncate">{c.label}</span>
                  </span>
                  <span className={cx('shrink-0 text-xs font-medium', TONES[c.tone].text)}>{c.status}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </aside>
  );
}

// --- sections ------------------------------------------------------------------------------------

function PersonalInfo({ account, saved, onSaved }: { account: Account; saved: boolean; onSaved: () => void }) {
  const { t } = useI18n();
  const p = t.profile.info;
  const { reload } = useAccount();
  const queryClient = useQueryClient();
  const [name, setName] = useState(account.user?.name ?? '');
  const [workspace, setWorkspace] = useState(account.workspace.name);
  const dirty = name.trim() !== (account.user?.name ?? '') || workspace.trim() !== account.workspace.name;

  const save = useMutation({
    mutationFn: () => api<Account>('/api/account/profile', { method: 'PUT', body: { name: name.trim(), workspaceName: workspace.trim() } }),
    onSuccess: (next) => {
      queryClient.setQueryData(qk.me, next);
      reload();
      onSaved();
    },
  });
  const fieldErrors = save.error instanceof ApiRequestError && save.error.status === 422 ? (save.error.errors ?? {}) : {};

  return (
    <Section icon={UserRound} title={p.title} text={p.text} index={0}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (dirty && !save.isPending) save.mutate();
        }}
        className="grid gap-5"
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={p.name} value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={120} required error={fieldErrors.name} />
          <Field label={p.workspace} value={workspace} onChange={(e) => setWorkspace(e.target.value)} minLength={2} maxLength={120} required error={fieldErrors.workspaceName} />
        </div>
        <Field
          label={p.email}
          value={account.user?.email ?? ''}
          dir="ltr"
          readOnly
          disabled
          hint={p.emailHint}
          aside={<Lock className="size-3.5 text-faint" aria-hidden />}
        />
        <ErrorNote>{save.isError && !Object.keys(fieldErrors).length ? errorMessage(save.error) : null}</ErrorNote>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <p className="min-h-5 text-sm" aria-live="polite">
            {saved && !dirty ? (
              <span className="animate-fade-in flex items-center gap-1.5 font-medium text-good">
                <Check className="size-4" />
                {p.saved}
              </span>
            ) : dirty ? (
              <span className="animate-fade-in flex items-center gap-2 text-muted">
                <span className="size-1.5 rounded-full bg-warning" aria-hidden />
                {p.unsaved}
              </span>
            ) : null}
          </p>
          <Button type="submit" variant="brand" loading={save.isPending} disabled={!dirty}>
            {p.save}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function PhoneSection({ user, onEdit }: { user: User | null; onEdit: () => void }) {
  const { t } = useI18n();
  const ph = t.profile.phone;
  const phone = user?.phone ?? null;
  const tone: Tone = !phone ? 'neutral' : user?.phoneVerified ? 'good' : 'warning';
  return (
    <Section icon={Smartphone} title={ph.title} text={ph.text} index={1}>
      <div className={cx('flex flex-wrap items-center gap-4 rounded-xl border p-4', phone ? 'border-line bg-surface/40' : 'border-dashed border-line-strong/70')}>
        <div className="flex min-w-0 items-center gap-3">
          <Tile icon={Smartphone} tone={tone} className="size-11" />
          {phone ? (
            <p dir="ltr" className="truncate font-mono text-lg font-semibold tracking-tight">
              {phone}
            </p>
          ) : (
            <p className="font-medium">{ph.none}</p>
          )}
          {phone &&
            (user?.phoneVerified ? (
              <Badge tone="good" className="gap-1">
                <CheckCircle2 className="size-3" /> {ph.verified}
              </Badge>
            ) : (
              <Badge tone="warning" className="gap-1">
                <XCircle className="size-3" /> {ph.unverified}
              </Badge>
            ))}
        </div>
        {user && (
          <Button variant={phone ? 'outline' : 'brand'} className="ms-auto shrink-0" onClick={onEdit}>
            {phone ? ph.change : ph.add}
          </Button>
        )}
      </div>
    </Section>
  );
}

function SecuritySection({ user, onPassword }: { user: User | null; onPassword: () => void }) {
  const { t } = useI18n();
  const sec = t.profile.security;
  const on = Boolean(user?.twoFactorEnabled);
  return (
    <Section icon={ShieldCheck} title={sec.title} text={sec.text} index={2} bodyClassName="pt-2">
      <ul className="divide-y divide-line">
        <li className="flex flex-wrap items-center gap-4 py-4">
          <Tile icon={LockKeyhole} tone="neutral" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{sec.password}</p>
            <p className="text-sm text-muted">{sec.passwordText}</p>
          </div>
          {user && (
            <Button variant="outline" onClick={onPassword}>
              {sec.change}
            </Button>
          )}
        </li>
        <li className="flex flex-wrap items-center gap-4 py-4 last:pb-0">
          <Tile icon={ShieldCheck} tone={on ? 'good' : 'warning'} />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{sec.twoFactor}</p>
            <p className="text-sm text-muted">{on ? sec.twoFactorOn : sec.twoFactorOff}</p>
          </div>
          <Badge tone={on ? 'good' : 'warning'} className="gap-1.5">
            <span className="relative flex size-1.5">
              {on && <span className="absolute inset-0 animate-ping rounded-full bg-good/60 motion-reduce:hidden" />}
              <span className={cx('relative size-1.5 rounded-full', on ? 'bg-good' : 'bg-warning')} />
            </span>
            {on ? sec.on : sec.twoFactorOff}
          </Badge>
        </li>
      </ul>
    </Section>
  );
}

// --- page ----------------------------------------------------------------------------------------

export function ProfilePage() {
  const { t } = useI18n();
  const { account } = useAccount();
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  // Lives here, not in the form: a save changes the account, which remounts the form (see its `key`).
  const [savedAt, setSavedAt] = useState(0);
  useEffect(() => {
    if (!savedAt) return;
    const id = setTimeout(() => setSavedAt(0), 3000);
    return () => clearTimeout(id);
  }, [savedAt]);

  if (!account) return null;
  const user = account.user;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader title={t.profile.title} description={t.profile.description} />
      <div className="grid gap-6 xl:grid-cols-[20rem_minmax(0,1fr)] xl:items-start">
        <IdentityCard account={account} />
        <div className="min-w-0 space-y-6">
          <PersonalInfo key={`${user?.name}|${account.workspace.name}`} account={account} saved={savedAt > 0} onSaved={() => setSavedAt(Date.now())} />
          <PhoneSection user={user} onEdit={() => setPhoneOpen(true)} />
          <SecuritySection user={user} onPassword={() => setPasswordOpen(true)} />
        </div>
      </div>

      {phoneOpen && <PhoneVerifyModal onClose={() => setPhoneOpen(false)} />}
      {passwordOpen && <ChangePassword onClose={() => setPasswordOpen(false)} />}
    </div>
  );
}
