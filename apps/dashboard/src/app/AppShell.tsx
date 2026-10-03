import {
  BookOpen,
  ChevronRight,
  ChevronsUpDown,
  CircleDollarSign,
  CircleHelp,
  CircleX,
  Clock,
  CreditCard,
  FileText,
  Hourglass,
  KeyRound,
  LayoutGrid,
  LockKeyhole,
  LogOut,
  Mail,
  Megaphone,
  PanelLeft,
  PhoneCall,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react';
import { getPlan, planHasFeature } from '@wa/shared/plans';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../api';
import { PhoneVerifyModal } from '../auth/Otp';
import { useLiveEvents } from '../events';
import { debouncedInvalidate, qk } from '../queries';
import { signOut } from '../session';
import type { Session } from '../types';
import { BRAND } from '../brand';
import { useI18n } from '../i18n';
import { Link, usePath } from '../router';
import { Badge, Button, buttonClass, cx, ErrorNote, Field, flip, LangSwitch, Logo, LogoMark, Modal, SuccessNote, usePlanName } from '../ui';
import { type Account, AccountContext, planState, useAccount } from './account';

const COLLAPSE_KEY = 'wa.sidebar.collapsed';
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
};

type NavItem = { href: string; label: string; icon: typeof LayoutGrid; badge?: 'lock' | 'soon' };

function useNav() {
  const { t } = useI18n();
  const { account } = useAccount();
  const n = t.app.nav;
  // Ads is visible to everyone: locked when the plan doesn't bundle it, "soon" until the admin flips it on.
  const isAdmin = account?.user?.isAdmin === true;
  const adsBadge: NavItem['badge'] = isAdmin
    ? undefined
    : !account || !planHasFeature(account.plan.id, 'ads')
      ? 'lock'
      : account.features.ads
        ? undefined
        : 'soon';
  return {
    main: [
      { href: '/dashboard', label: n.dashboard, icon: LayoutGrid },
      { href: '/sessions', label: n.sessions, icon: PhoneCall },
      { href: '/templates', label: n.templates, icon: FileText },
      { href: '/keys', label: n.keys, icon: KeyRound },
      { href: '/ads', label: n.ads, icon: Megaphone, badge: adsBadge },
      { href: '/subscription', label: n.subscription, icon: CircleDollarSign },
    ] as NavItem[],
    admin: [{ href: '/admin', label: n.admin, icon: ShieldCheck }] as NavItem[],
    secondary: [
      { href: '/docs', label: t.app.secondary.docs, icon: BookOpen, newTab: true },
      { href: '/#faq', label: t.app.secondary.help, icon: CircleHelp, newTab: false },
      { href: `mailto:${BRAND.supportEmail}`, label: t.app.secondary.contact, icon: Mail, newTab: false },
    ],
  };
}

function Breadcrumbs({ path }: { path: string }) {
  const { t } = useI18n();
  const nav = useNav();
  const labels = Object.fromEntries([...nav.main, ...nav.admin].map((n) => [n.href, n.label]));
  const parts: { label: string; href?: string }[] = path.startsWith('/sessions/')
    ? [{ label: labels['/sessions']!, href: '/sessions' }, { label: t.app.sessionDetail }]
    : [{ label: labels[path] ?? labels['/dashboard']! }];
  return (
    <nav aria-label={t.app.breadcrumb}>
      <ol className="flex items-center gap-1.5 text-sm text-muted">
        {parts.map((p, i) => (
          <li key={p.label} className="animate-fade-in flex items-center gap-1.5">
            {i > 0 && <ChevronRight className={cx('size-3.5', flip)} />}
            {p.href ? (
              <Link href={p.href} className="transition-colors hover:text-ink">
                {p.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-ink">
                {p.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

const itemClass = (active: boolean, collapsed: boolean) =>
  cx(
    'relative flex h-8 w-full items-center gap-2 overflow-hidden rounded-md p-2 text-sm transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring [&>svg]:size-4 [&>svg]:shrink-0',
    active ? 'bg-raised font-medium text-ink' : 'text-ink hover:bg-raised hover:ps-3',
    collapsed && 'justify-center hover:ps-2',
  );

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

function ChangePassword({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const p = t.app.password;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    setError(null);
    setDone(null);
    if (next !== confirm) return setErrors({ confirm: [p.mismatch] });
    setLoading(true);
    try {
      const result = await api<{ otherSessionsEnded: number }>('/api/auth/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      setDone(p.othersEnded(result.otherSessionsEnded));
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      if (err instanceof ApiRequestError && err.errors?.currentPassword) setErrors({ current: [p.wrong] });
      else if (err instanceof ApiRequestError && err.errors?.newPassword) setErrors({ next: [t.auth.errors.weakPassword] });
      else setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title={p.title} description={p.description} onClose={onClose}>
      <form onSubmit={submit} className="grid gap-4">
        <Field label={p.current} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoFocus error={errors.current} />
        <Field label={p.next} type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required error={errors.next} />
        <Field label={p.confirm} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required error={errors.confirm} />
        <ErrorNote>{error}</ErrorNote>
        <SuccessNote>{done}</SuccessNote>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t.common.close}
          </Button>
          <Button type="submit" loading={loading}>
            {p.submit}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function UserMenu({ account, collapsed, onLogout }: { account: Account | null; collapsed: boolean; onLogout: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const name = account?.user?.name ?? account?.workspace.name ?? '';
  const email = account?.user?.email ?? '';

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const avatar = (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-raised to-line-strong text-sm font-medium">{initials(name)}</span>
  );
  const menuItem = 'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-raised';

  return (
    <div ref={ref} className="relative">
      {open && (
        <div role="menu" className="animate-scale-in absolute start-0 bottom-full z-50 mb-2 w-60 origin-bottom rounded-lg border border-line bg-bg p-1 shadow-lg">
          <div className="flex items-center gap-2 px-1 py-1.5">
            {avatar}
            <div className="min-w-0 leading-tight">
              <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                {name}
                {account?.user?.isAdmin && <Badge tone="good">{t.app.admin}</Badge>}
              </p>
              {email && <p className="ltr truncate text-xs text-muted">{email}</p>}
            </div>
          </div>
          <div className="-mx-1 my-1 h-px bg-line" />
          <Link href="/subscription" role="menuitem" onClick={() => setOpen(false)} className={menuItem}>
            <CreditCard className="size-4 text-muted" /> {t.app.userMenu.subscription}
          </Link>
          {account?.user && (
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setPassword(true);
              }}
              className={menuItem}
            >
              <LockKeyhole className="size-4 text-muted" /> {t.app.userMenu.password}
            </button>
          )}
          <div className="-mx-1 my-1 h-px bg-line" />
          <button role="menuitem" onClick={onLogout} className={menuItem}>
            <LogOut className="size-4 text-muted" /> {t.app.userMenu.logout}
          </button>
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={collapsed ? name : undefined}
        className={cx('flex w-full items-center gap-2 rounded-md p-2 text-start transition-colors hover:bg-raised', open && 'bg-raised', collapsed && 'justify-center p-0')}
      >
        {avatar}
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted" />
          </>
        )}
      </button>
      {password && <ChangePassword onClose={() => setPassword(false)} />}
    </div>
  );
}

function NavGroup({
  label,
  items,
  path,
  collapsed,
  onNavigate,
}: {
  label: string;
  items: NavItem[];
  path: string;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="p-2">
      {!collapsed && <p className="flex h-8 items-center px-2 text-xs font-medium text-ink/70">{label}</p>}
      <ul className="flex flex-col gap-1">
        {items.map((item, i) => {
          const active = path === item.href || path.startsWith(`${item.href}/`);
          return (
            <li key={item.href} className="animate-fade-up" style={{ animationDelay: `${i * 40}ms` }}>
              <Link
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                title={collapsed ? item.label : undefined}
                className={itemClass(active, collapsed)}
              >
                {active && <span className="absolute inset-y-1.5 start-0 w-0.5 rounded-full bg-brand" />}
                <item.icon />
                {!collapsed && <span className="truncate">{item.label}</span>}
                {!collapsed && item.badge === 'lock' && <LockKeyhole className="ms-auto size-3.5 shrink-0 text-muted" />}
                {!collapsed && item.badge === 'soon' && (
                  <span className="ms-auto shrink-0 rounded-full bg-brand/15 px-1.5 py-0.5 text-[10px] leading-none font-medium text-brand">{t.ads.gate.soon}</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Sidebar({
  path,
  account,
  collapsed = false,
  onLogout,
  onNavigate,
}: {
  path: string;
  account: Account | null;
  collapsed?: boolean;
  onLogout: () => void;
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const nav = useNav();
  return (
    <div className="flex h-full flex-col">
      <div className="p-2">
        <Link href="/dashboard" onClick={onNavigate} className={cx('flex h-12 items-center rounded-md p-2 transition-colors hover:bg-raised', collapsed && 'justify-center p-0')}>
          {collapsed ? <LogoMark /> : <Logo />}
        </Link>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <NavGroup label={t.app.groupPlatform} items={nav.main} path={path} collapsed={collapsed} onNavigate={onNavigate} />
        {account?.user?.isAdmin && <NavGroup label={t.app.groupAdmin} items={nav.admin} path={path} collapsed={collapsed} onNavigate={onNavigate} />}

        <ul className="mt-auto flex flex-col gap-1 p-2">
          {nav.secondary.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                title={collapsed ? item.label : undefined}
                {...(item.newTab ? { target: '_blank', rel: 'noreferrer' } : {})}
                className={cx(itemClass(false, collapsed), 'text-ink-2')}
              >
                <item.icon />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="p-2">
        <UserMenu account={account} collapsed={collapsed} onLogout={onLogout} />
      </div>
    </div>
  );
}

/** Plan notice at the top of every page, as in the reference dashboard. */
function PlanAlert({ account }: { account: Account | null }) {
  const { t, fmt } = useI18n();
  const planName = usePlanName();
  if (!account) return null;
  const a = t.app.alerts;
  const state = planState(account);
  const pending = account.pendingRequest;

  type Tone = { box: string; title: string; icon: ReactNode; heading: string; text: string; cta: string; variant: 'danger' | 'white' };
  let tone: Tone | null = null;
  if (pending) {
    tone = {
      box: 'border-sky-500/20 bg-sky-500/10',
      title: 'text-sky-300',
      icon: <Hourglass className="size-7 animate-pulse" />,
      heading: a.pending.title(planName(getPlan(pending.planId))),
      text: a.pending.text,
      cta: a.pending.cta,
      variant: 'white',
    };
  } else if (state.kind === 'trial-expired' || state.kind === 'expired') {
    const copy = state.kind === 'expired' ? a.planExpired : a.trialExpired;
    tone = { box: 'border-destructive-ink/20 bg-destructive/15', title: 'text-red-500', icon: <CircleX className="size-7" />, heading: copy.title, text: copy.text, cta: copy.cta, variant: 'danger' };
  } else if (state.kind === 'trial') {
    tone = {
      box: 'border-ink/20 bg-ink/10',
      title: 'text-ink',
      icon: <Clock className="size-7" />,
      heading: a.trialActive.title,
      text: a.trialActive.text(fmt.date(state.endsAt)),
      cta: a.trialActive.cta,
      variant: 'white',
    };
  } else if (state.kind === 'expiring') {
    tone = {
      box: 'border-amber-500/25 bg-amber-500/10',
      title: 'text-amber-300',
      icon: <Clock className="size-7" />,
      heading: a.planExpiring.title,
      text: a.planExpiring.text(fmt.date(state.endsAt)),
      cta: a.planExpiring.cta,
      variant: 'white',
    };
  }
  if (!tone) return null;

  return (
    <div className={cx('animate-fade-up mx-auto w-full max-w-3xl rounded-lg border p-5', tone.box)}>
      <div className="flex flex-col items-start gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 items-start gap-3">
          <div className={cx('mt-0.5 flex items-center justify-center rounded-md p-2', tone.title)}>{tone.icon}</div>
          <div className="flex-1">
            <h2 className={cx('mb-1 text-sm font-medium', tone.title)}>{tone.heading}</h2>
            <p className="text-sm text-muted">{tone.text}</p>
          </div>
        </div>
        <Link href="/subscription" className={buttonClass(tone.variant, 'md', 'w-full lg:w-auto')}>
          {tone.cta}
        </Link>
      </div>
    </div>
  );
}

/** Accounts from before phone verification, or that never finished it, are asked to confirm a number. */
function PhoneAlert({ account }: { account: Account }) {
  const { t } = useI18n();
  const p = t.app.phone;
  const [open, setOpen] = useState(false);
  if (!account.user || account.user.phoneVerified || account.user.isAdmin) return null;
  return (
    <div className="animate-fade-up mx-auto flex w-full max-w-3xl flex-wrap items-center gap-4 rounded-lg border border-amber-500/25 bg-amber-500/10 p-4">
      <Smartphone className="size-6 shrink-0 text-amber-300" />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-medium text-amber-200">{p.bannerTitle}</h2>
        <p className="text-sm text-muted">{p.bannerText}</p>
      </div>
      <Button variant="white" onClick={() => setOpen(true)}>
        {p.cta}
      </Button>
      {open && <PhoneVerifyModal onClose={() => setOpen(false)} />}
    </div>
  );
}

/**
 * Keeps one event stream open while inside the app and folds events into the shared cache, so
 * every page shows live state without reloading.
 */
function useLiveCache() {
  const queryClient = useQueryClient();
  const invalidate = useMemo(() => debouncedInvalidate(queryClient), [queryClient]);
  useLiveEvents((event) => {
    switch (event.type) {
      case 'session.status': {
        const patch = (s: Session) =>
          s.id === event.sessionId ? { ...s, status: event.data.status, phoneNumber: event.data.phone, lastError: event.data.lastError } : s;
        queryClient.setQueryData<Session[]>(qk.sessions, (list) => list?.map(patch));
        queryClient.setQueryData<Session>(qk.session(event.sessionId), (s) => s && patch(s));
        invalidate(['overview']);
        break;
      }
      case 'messages.received':
      case 'messages.update':
      case 'poll.vote':
        invalidate(qk.messages(event.sessionId));
        invalidate(['overview']);
        break;
    }
  });
}

export function AppShell({ children, account }: { children: ReactNode; account: Account }) {
  const { t } = useI18n();
  const path = usePath();
  const queryClient = useQueryClient();
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // The account is cached and kept fresh by React Query; pages call reload() after changing it.
  const context = useMemo(() => ({ account, reload: () => void queryClient.invalidateQueries({ queryKey: qk.me }) }), [account, queryClient]);
  useLiveCache();

  const toggle = () => {
    if (window.matchMedia('(min-width: 768px)').matches) {
      setCollapsed((c) => {
        try {
          localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
        } catch {
          // per-tab only
        }
        return !c;
      });
    } else setDrawer(true);
  };

  const logout = () => void signOut(queryClient);

  return (
    <AccountContext.Provider value={context}>
      <div className="flex min-h-svh bg-surface">
        <aside className={cx('sticky top-0 hidden h-svh shrink-0 transition-[width] duration-300 ease-out md:block', collapsed ? 'w-14' : 'w-64')}>
          <Sidebar path={path} account={account} collapsed={collapsed} onLogout={logout} />
        </aside>

        {drawer && (
          <div className="fixed inset-0 z-50 md:hidden">
            <div className="animate-fade-in absolute inset-0 bg-black/60" onClick={() => setDrawer(false)} />
            <aside className="animate-fade-in absolute inset-y-0 start-0 w-72 bg-surface">
              <button onClick={() => setDrawer(false)} className="absolute top-4 end-3 rounded-xs p-1 opacity-70 hover:opacity-100" aria-label={t.app.closeMenu}>
                <X className="size-4" />
              </button>
              <Sidebar path={path} account={account} onLogout={logout} onNavigate={() => setDrawer(false)} />
            </aside>
          </div>
        )}

        <div className="relative flex min-w-0 flex-1 flex-col bg-bg md:m-2 md:ms-0 md:min-h-[calc(100svh-1rem)] md:rounded-xl md:shadow-sm">
          <header className="flex h-16 shrink-0 items-center gap-2 border-b border-line/50 px-6 md:px-4">
            <button onClick={toggle} className="-ms-1 flex size-7 items-center justify-center rounded-md transition-colors hover:bg-raised" aria-label={t.app.toggleSidebar}>
              <PanelLeft className={cx('size-4', flip)} />
            </button>
            <span className="me-2 h-4 w-px bg-line" />
            <Breadcrumbs path={path} />
            <LangSwitch className="ms-auto" />
          </header>
          <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
            {path !== '/subscription' && <PlanAlert account={account} />}
            <PhoneAlert account={account} />
            <main key={path} className="animate-fade-up min-w-0 flex-1">
              {children}
            </main>
          </div>
        </div>
      </div>
    </AccountContext.Provider>
  );
}
