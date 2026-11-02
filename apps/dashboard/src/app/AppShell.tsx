import {
  BookOpen,
  ChevronRight,
  CircleDollarSign,
  CircleHelp,
  CircleX,
  Clock,
  CreditCard,
  EllipsisVertical,
  FileText,
  filledIcon,
  Home,
  Hourglass,
  KeyRound,
  LockKeyhole,
  LogOut,
  Mail,
  Megaphone,
  MessagesSquare,
  PanelLeft,
  ShieldCheck,
  Smartphone,
  Sparkles,
  UserRound,
  X,
} from '../icons';
import { getPlan, planHasFeature } from '@wa/shared/plans';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiRequestError, errorMessage } from '../api';
import { PhoneVerifyModal } from '../auth/Otp';
import { useLiveEvents } from '../events';
import { debouncedInvalidate, qk } from '../queries';
import { signOut } from '../session';
import type { Session } from '../types';
import { BRAND } from '../brand';
import { useI18n } from '../i18n';
import { prefetchAllPages, prefetchPage } from '../prefetch';
import { Link, navigate, usePath } from '../router';
import type { ChatNumber } from './chats/model';
import { notificationsOn, NoteStack, useInboxNotes } from './chats/Notifier';
import { OPEN_CHAT_EVENT, type OpenChatDetail, ReadNoteStack, useReadNotes } from './chats/ReadNotes';
import { Button, buttonClass, cx, ErrorNote, Field, flip, LangSwitch, Logo, LogoMark, Modal, SuccessNote, ThemeSwitch, usePlanName, VerifiedMark } from '../ui';
import { type Account, AccountContext, isUnlimitedPlan, planState, useAccount } from './account';
import { useActivityPing } from './activity';
import { UserAvatar } from './avatar';

const COLLAPSE_KEY = 'wa.sidebar.collapsed';
/** The user's own choice (toggle button), or null when they never made one. */
const readCollapsed = () => {
  try {
    const saved = localStorage.getItem(COLLAPSE_KEY);
    return saved === null ? null : saved === '1';
  } catch {
    return null;
  }
};

// Tablets (md up to lg): the full sidebar would take a third of the width, so it starts as the
// icon rail there unless the user chose otherwise.
const TABLET = '(min-width: 768px) and (max-width: 1023.98px)';
const subscribeTablet = (notify: () => void) => {
  const query = window.matchMedia(TABLET);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
};
const isTablet = () => window.matchMedia(TABLET).matches;

type NavItem = { href: string; label: string; icon: typeof Home; badge?: 'lock' | 'soon'; count?: number };

const chatsAllowed = (account: Account | null) => account?.user?.isAdmin === true || (account ? planHasFeature(account.plan.id, 'chats') : false);

function useChatNumbers(account: Account | null) {
  return useQuery({
    queryKey: qk.chats.numbers,
    queryFn: ({ signal }) => api<ChatNumber[]>('/api/chats/numbers', { signal }),
    enabled: chatsAllowed(account),
  });
}

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
  // Chats likewise: shown to everyone, locked below Business.
  const chatsBadge: NavItem['badge'] = chatsAllowed(account) ? undefined : 'lock';
  const unread = (useChatNumbers(account).data ?? []).reduce((sum, n) => sum + n.unreadChats, 0);
  return {
    main: [
      { href: '/dashboard', label: n.dashboard, icon: Home },
      { href: '/sessions', label: n.sessions, icon: Smartphone },
      { href: '/chats', label: n.chats, icon: MessagesSquare, badge: chatsBadge, count: unread },
      { href: '/templates', label: n.templates, icon: FileText },
      { href: '/keys', label: n.keys, icon: KeyRound },
      { href: '/ads', label: n.ads, icon: Megaphone, badge: adsBadge },
      { href: '/subscription', label: n.subscription, icon: CircleDollarSign },
    ] as NavItem[],
    admin: [
      { href: '/auto-reply', label: n.autoReply, icon: Sparkles },
      { href: '/admin', label: n.admin, icon: ShieldCheck },
    ] as NavItem[],
    secondary: [
      { href: '/guide', label: t.app.secondary.guide, icon: BookOpen, newTab: false },
      { href: '/docs', label: t.app.secondary.docs, icon: FileText, newTab: true },
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
    : path === '/profile'
      ? [{ label: t.profile.title }]
      : [{ label: labels[path] ?? labels['/dashboard']! }];
  return (
    <nav aria-label={t.app.breadcrumb} className="min-w-0">
      {/* One line on any width: the current page shortens with an ellipsis instead of wrapping. */}
      <ol className="flex min-w-0 items-center gap-1.5 text-sm text-muted">
        {parts.map((p, i) => (
          <li key={p.label} className={cx('animate-fade-in flex items-center gap-1.5 whitespace-nowrap', p.href ? 'shrink-0' : 'min-w-0')}>
            {i > 0 && <ChevronRight className={cx('size-3.5 shrink-0', flip)} />}
            {p.href ? (
              <Link href={p.href} className="transition-colors hover:text-ink">
                {p.label}
              </Link>
            ) : (
              <span aria-current="page" className="truncate text-ink">
                {p.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Whop's sidebar row: 40px tall, a 20px glyph, grey until hovered; the open page sits on a grey fill. */
const itemClass = (active: boolean, collapsed: boolean) =>
  cx(
    'relative flex h-9 w-full items-center gap-2.5 rounded-[10px] px-[10px] text-sm font-medium transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring [&>svg]:size-[18px] [&>svg]:shrink-0',
    active ? 'bg-ink/10 text-ink' : 'text-muted hover:bg-ink/[0.06] hover:text-ink',
    collapsed && 'mx-auto w-10 justify-center px-0',
  );

export function ChangePassword({ onClose }: { onClose: () => void }) {
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

  // The profile picture, or the monogram in the brand gradient, as a rounded square (iOS-icon corners), with a green "signed in" dot.
  const avatar = (
    <span className="relative shrink-0">
      <UserAvatar user={account?.user ?? null} name={name} className="size-9 rounded-[11px] text-sm shadow-[inset_0_1px_0_rgb(255_255_255/0.28)] ring-1 ring-black/10" />
      <span aria-hidden className="absolute -end-1 -bottom-1 size-3 rounded-full bg-good ring-2 ring-bg" />
    </span>
  );
  const menuItem = 'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-raised';

  return (
    <div ref={ref} className="relative">
      {open && (
        <div role="menu" className="animate-scale-in absolute start-0 bottom-full z-50 mb-2 w-60 origin-bottom rounded-xl border border-line bg-card p-1 shadow-xl shadow-black/40 light:shadow-black/10">
          <div className="flex items-center gap-2 px-1 py-1.5">
            {avatar}
            <div className="min-w-0 leading-tight">
              <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                {name}
                {account?.user?.isAdmin && <VerifiedMark />}
              </p>
              {email && <p className="ltr truncate text-xs text-muted">{email}</p>}
            </div>
          </div>
          <div className="-mx-1 my-1 h-px bg-line" />
          <Link href="/profile" role="menuitem" onClick={() => setOpen(false)} className={menuItem}>
            <UserRound className="size-4 text-muted" /> {t.app.userMenu.profile}
          </Link>
          {account ? (
            <PlanRow account={account} onClick={() => setOpen(false)} />
          ) : (
            <Link href="/subscription" role="menuitem" onClick={() => setOpen(false)} className={menuItem}>
              <CreditCard className="size-4 text-muted" /> {t.app.userMenu.subscription}
            </Link>
          )}
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
        className={cx('group flex w-full items-center gap-3 rounded-xl p-2 text-start transition-colors hover:bg-ink/[0.06]', open && 'bg-ink/[0.06]', collapsed && 'justify-center p-1')}
      >
        {avatar}
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="flex items-center gap-1">
                <span className="truncate text-sm font-semibold">{name}</span>
                {account?.user?.isAdmin && <VerifiedMark />}
              </span>
              {email && <span className="ltr mt-0.5 block truncate text-xs text-faint">{email}</span>}
            </span>
            <span className={cx('flex size-7 shrink-0 items-center justify-center rounded-lg text-muted transition-colors group-hover:bg-ink/[0.07] group-hover:text-ink', open && 'bg-ink/[0.07] text-ink')}>
              <EllipsisVertical className="size-4" />
            </span>
          </>
        )}
      </button>
      {/* Out to <body>: inside the sticky sidebar the dialog would sit under the page column (its own stacking context). */}
      {password && createPortal(<ChangePassword onClose={() => setPassword(false)} />, document.body)}
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
  const active = (item: NavItem) => path === item.href || path.startsWith(`${item.href}/`);
  return (
    <div className="p-2">
      {!collapsed && <p className="flex h-7 items-center px-3 text-xs font-medium text-faint">{label}</p>}
      <ul className="flex flex-col gap-0.5">
        {items.map((item, i) => {
          const Icon = active(item) ? filledIcon(item.icon) : item.icon;
          return (
            <li key={item.href} className="animate-fade-up" style={{ animationDelay: `${i * 40}ms` }}>
              <Link
                href={item.href}
                onClick={onNavigate}
                onPointerEnter={() => prefetchPage(item.href)}
                onFocus={() => prefetchPage(item.href)}
                aria-current={active(item) ? 'page' : undefined}
                title={collapsed ? item.label : undefined}
                className={itemClass(active(item), collapsed)}
              >
                {/* The icon rail marks the open page with a pill on its outer edge, as Whop does. */}
                {collapsed && <span aria-hidden className={cx('absolute -start-3 top-1/2 w-1 -translate-y-1/2 rounded-e-full bg-ink transition-all duration-200', active(item) ? 'h-6 opacity-100' : 'h-0 opacity-0')} />}
                <Icon />
                {!collapsed && <span className="truncate">{item.label}</span>}
                {!!item.count && !collapsed && (
                  <span className={cx('ms-auto min-w-5 shrink-0 rounded-full px-1.5 py-0.5 text-center text-[11px] leading-none font-semibold tabular-nums', 'bg-brand text-on-brand')}>
                    {item.count > 99 ? '99+' : item.count}
                  </span>
                )}
                {!!item.count && collapsed && <span aria-hidden className="absolute top-1 end-3 size-2 rounded-full bg-brand ring-2 ring-bg" />}
                {!collapsed && item.badge === 'lock' && <LockKeyhole className="ms-auto size-4 shrink-0 text-faint" />}
                {!collapsed && item.badge === 'soon' && (
                  <span className={cx('ms-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium', 'bg-brand/15 text-brand')}>{t.ads.gate.soon}</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The plan and how many of its number slots are used (the sessions list is shared with the pages). */
function usePlanUsage(account: Account) {
  const { t } = useI18n();
  const planName = usePlanName();
  const sessions = useQuery({ queryKey: qk.sessions, queryFn: ({ signal }) => api<Session[]>('/api/whatsapp-sessions', { signal }) });
  const used = sessions.data?.length;
  const limit = isUnlimitedPlan(account.plan) ? null : account.plan.sessions;
  const text = used === undefined ? '…' : limit === null ? t.sessions.usageUnlimited(used) : t.sessions.usageText(used, limit);
  const pct = limit !== null && used !== undefined ? Math.min(100, limit > 0 ? (used / limit) * 100 : 0) : null;
  return { name: planName(account.plan), text, pct, full: pct !== null && pct >= 100 };
}

/** The plan as a pill on the header's far side (Whop keeps quick links there); opens the subscription page. */
function PlanChip({ account, className }: { account: Account; className?: string }) {
  const { t } = useI18n();
  const plan = usePlanUsage(account);
  return (
    <Link
      href="/subscription"
      title={t.app.userMenu.subscription}
      className={cx('h-8 items-center gap-2 rounded-full border border-line ps-2.5 pe-3 text-sm transition-colors hover:border-line-strong hover:bg-ink/[0.04]', className)}
    >
      <span className={cx('size-2 shrink-0 rounded-full', plan.full ? 'bg-warning' : 'bg-brand')} />
      <span className="font-semibold">{plan.name}</span>
      <span aria-hidden className="h-3.5 w-px bg-line" />
      <span className="text-xs whitespace-nowrap text-muted">{plan.text}</span>
      {plan.pct !== null && (
        <span aria-hidden className="h-1 w-10 overflow-hidden rounded-full bg-ink/10">
          <span className={cx('block h-full rounded-full transition-[width] duration-700', plan.full ? 'bg-warning' : 'bg-brand')} style={{ width: `${plan.pct}%` }} />
        </span>
      )}
    </Link>
  );
}

/** The same plan line inside the user menu, where phones (no header pill) still find it. */
function PlanRow({ account, onClick }: { account: Account; onClick: () => void }) {
  const { t } = useI18n();
  const plan = usePlanUsage(account);
  return (
    <Link href="/subscription" role="menuitem" onClick={onClick} className="block rounded-lg px-2 py-2 transition-colors hover:bg-raised">
      <span className="flex items-center gap-2 text-sm">
        <CreditCard className="size-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate">{t.app.userMenu.subscription}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold">
          <span className={cx('size-1.5 rounded-full', plan.full ? 'bg-warning' : 'bg-brand')} />
          {plan.name}
        </span>
      </span>
      <span className="mt-1 block ps-6 text-xs text-muted">{plan.text}</span>
      {plan.pct !== null && (
        <span className="ms-6 mt-1.5 block h-1 overflow-hidden rounded-full bg-ink/10">
          <span className={cx('block h-full rounded-full', plan.full ? 'bg-warning' : 'bg-brand')} style={{ width: `${plan.pct}%` }} />
        </span>
      )}
    </Link>
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
      <div className={cx('flex h-14 shrink-0 items-center border-b border-line px-3', collapsed && 'justify-center px-0')}>
        <Link href="/dashboard" onClick={onNavigate} className="flex items-center rounded-[10px] p-1 transition-opacity hover:opacity-80">
          {collapsed ? <LogoMark className="size-7" /> : <Logo />}
        </Link>
      </div>

      <nav className="code-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pt-2">
        <NavGroup label={t.app.groupPlatform} items={nav.main} path={path} collapsed={collapsed} onNavigate={onNavigate} />
        {account?.user?.isAdmin && <NavGroup label={t.app.groupAdmin} items={nav.admin} path={path} collapsed={collapsed} onNavigate={onNavigate} />}

        <ul className="mt-auto flex flex-col gap-0.5 p-2">
          {nav.secondary.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                title={collapsed ? item.label : undefined}
                {...(item.newTab ? { target: '_blank', rel: 'noreferrer' } : {})}
                className={itemClass(false, collapsed)}
              >
                <item.icon />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {/* The account sits in its own card at the foot of the sidebar (the icon rail shows just the avatar). */}
      <div className="p-2">
        <div className={cx('rounded-2xl border transition-colors', collapsed ? 'border-transparent' : 'border-line bg-ink/[0.03] p-1 hover:border-line-strong')}>
          <UserMenu account={account} collapsed={collapsed} onLogout={onLogout} />
        </div>
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
      box: 'border-info/25 bg-info/12',
      title: 'text-info',
      icon: <Hourglass className="size-7 animate-pulse" />,
      heading: a.pending.title(planName(getPlan(pending.planId))),
      text: a.pending.text,
      cta: a.pending.cta,
      variant: 'white',
    };
  } else if (state.kind === 'trial-expired' || state.kind === 'expired') {
    const copy = state.kind === 'expired' ? a.planExpired : a.trialExpired;
    tone = { box: 'border-destructive-ink/20 bg-destructive/15', title: 'text-critical', icon: <CircleX className="size-7" />, heading: copy.title, text: copy.text, cta: copy.cta, variant: 'danger' };
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
      box: 'border-warning/25 bg-warning/10',
      title: 'text-warning',
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
    <div className="animate-fade-up mx-auto flex w-full max-w-3xl flex-wrap items-center gap-4 rounded-lg border border-warning/25 bg-warning/10 p-4">
      <Smartphone className="size-6 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-medium text-warning">{p.bannerTitle}</h2>
        <p className="text-sm text-muted">{p.bannerText}</p>
      </div>
      <Button variant="white" onClick={() => setOpen(true)}>
        {p.cta}
      </Button>
      {open && <PhoneVerifyModal onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Events that change what the chats page shows (its lists and conversations). */
const CHAT_EVENTS = new Set<string>(['messages.received', 'messages.created', 'messages.update', 'message.changed', 'poll.vote', 'chat.read', 'chats.synced']);

/**
 * Keeps one event stream open while inside the app and folds events into the shared cache, so
 * every page shows live state without reloading.
 */
function useLiveCache() {
  const queryClient = useQueryClient();
  const invalidate = useMemo(() => debouncedInvalidate(queryClient), [queryClient]);
  useLiveEvents((event) => {
    // The chats page folds these into its own cache while it is open; while it isn't, nothing does,
    // and coming back within its stale time showed the old copy (a notified message missing until a
    // reload). Marked stale here without fetching: the page refetches what it shows when it opens.
    if (CHAT_EVENTS.has(event.type)) void queryClient.invalidateQueries({ queryKey: ['chats', event.sessionId], refetchType: 'none' });
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
      case 'messages.created':
      case 'messages.update':
      case 'poll.vote':
        invalidate(qk.messages(event.sessionId));
        invalidate(['overview']);
        if (event.type === 'messages.received') invalidate(qk.chats.numbers);
        break;
      case 'chat.read':
      case 'chats.synced':
        invalidate(qk.chats.numbers);
        break;
    }
  });
}

/**
 * Incoming chat messages reach every page: unread chats in the tab title, and notification cards
 * outside `/chats` (the chats page shows its own, aware of the open chat). A card opens its chat.
 */
function InboxAlerts({ account, path }: { account: Account; path: string }) {
  const onChats = path === '/chats';
  const list = useChatNumbers(account).data ?? [];
  const inbox = useInboxNotes({
    enabled: chatsAllowed(account) && !onChats && notificationsOn(),
    numbers: list,
    onOpen: (note) => navigate(`/chats?${new URLSearchParams({ session: note.sessionId, chat: note.jid })}`),
  });

  const unread = list.reduce((sum, n) => sum + n.unreadChats, 0);
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\)\s/, '');
    document.title = unread > 0 ? `(${unread}) ${base}` : base;
  }, [unread]);
  useEffect(
    () => () => {
      document.title = document.title.replace(/^\(\d+\)\s/, '');
    },
    [],
  );

  if (onChats) return null;
  return <NoteStack notes={inbox.notes} onOpen={inbox.open} onDismiss={inbox.dismiss} />;
}

/** The chats page has this chat open (the URL carries it): its blue ticks already say it was read. */
function lookingAt(sessionId: string, jid: string) {
  if (location.pathname !== '/chats') return false;
  const params = new URLSearchParams(location.search);
  return params.get('session') === sessionId && params.get('chat') === jid;
}

/** "Your message was read", on every page (the chats page included). A notice opens its chat. */
function ReadAlerts({ account }: { account: Account }) {
  const reads = useReadNotes({ enabled: chatsAllowed(account), isLooking: lookingAt });
  return (
    <ReadNoteStack
      notes={reads.notes}
      onDismiss={reads.dismiss}
      onOpen={(note) => {
        // Already on the chats page: it opens the chat itself (a navigation wouldn't reach it).
        if (location.pathname === '/chats') window.dispatchEvent(new CustomEvent<OpenChatDetail>(OPEN_CHAT_EVENT, { detail: { sessionId: note.sessionId, jid: note.jid } }));
        else navigate(`/chats?${new URLSearchParams({ session: note.sessionId, chat: note.jid })}`);
      }}
    />
  );
}

export function AppShell({ children, account }: { children: ReactNode; account: Account }) {
  const { t } = useI18n();
  const path = usePath();
  const queryClient = useQueryClient();
  const [drawer, setDrawer] = useState(false);
  const [savedCollapsed, setSavedCollapsed] = useState(readCollapsed);
  const tablet = useSyncExternalStore(subscribeTablet, isTablet, () => false);
  const collapsed = savedCollapsed ?? tablet;
  // The account is cached and kept fresh by React Query; pages call reload() after changing it.
  const context = useMemo(() => ({ account, reload: () => void queryClient.invalidateQueries({ queryKey: qk.me }) }), [account, queryClient]);
  useLiveCache();
  useActivityPing(path);
  // The other pages' code arrives in idle time, so the first click on each is instant.
  useEffect(() => prefetchAllPages(location.pathname), []);

  const toggle = () => {
    if (window.matchMedia('(min-width: 768px)').matches) {
      const next = !collapsed;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // per-tab only
      }
      setSavedCollapsed(next);
    } else setDrawer(true);
  };

  const logout = () => void signOut(queryClient);

  return (
    <AccountContext.Provider value={context}>
      <InboxAlerts account={account} path={path} />
      <ReadAlerts account={account} />
      <div className="flex min-h-svh bg-bg">
        <aside className={cx('sticky top-0 z-20 hidden h-svh shrink-0 border-e border-line bg-bg transition-[width] duration-300 ease-out md:block', collapsed ? 'w-16' : 'w-[280px]')}>
          <Sidebar path={path} account={account} collapsed={collapsed} onLogout={logout} />
        </aside>

        {drawer && (
          <div className="fixed inset-0 z-50 md:hidden">
            <div className="animate-fade-in absolute inset-0 bg-black/60" onClick={() => setDrawer(false)} />
            <aside className="animate-fade-in absolute inset-y-0 start-0 w-[280px] border-e border-line bg-bg">
              <button onClick={() => setDrawer(false)} className="absolute top-4 end-3 rounded-xs p-1 opacity-70 hover:opacity-100" aria-label={t.app.closeMenu}>
                <X className="size-4" />
              </button>
              <Sidebar path={path} account={account} onLogout={logout} onNavigate={() => setDrawer(false)} />
            </aside>
          </div>
        )}

        <div className="relative flex min-w-0 flex-1 flex-col bg-bg">
          <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-bg/85 px-4 backdrop-blur-md">
            <button onClick={toggle} className="-ms-1 flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-ink/[0.06] hover:text-ink" aria-label={t.app.toggleSidebar}>
              <PanelLeft className={cx('size-5', flip)} />
            </button>
            <span className="me-2 h-4 w-px bg-line" />
            <Breadcrumbs path={path} />
            <PlanChip account={account} className="ms-auto hidden sm:inline-flex" />
            <ThemeSwitch className="ms-auto sm:ms-0" />
            <LangSwitch />
          </header>
          {/* Chats fill the page edge to edge, like Whop's messages; every other page sits in a 1200px column. */}
          <div className={cx('flex w-full flex-1 flex-col', path === '/chats' ? '' : 'mx-auto max-w-[1200px] gap-4 p-4 md:p-6')}>
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
