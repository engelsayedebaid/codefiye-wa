import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CloudOff, RefreshCw } from 'lucide-react';
import { Component, lazy, type ReactNode, Suspense, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api, ApiRequestError, errorMessage, onSessionProblem, sessionHint } from './api';
import type { Account } from './app/account';
import { BRAND } from './brand';
import { stopLiveEvents } from './events';
import { signOut } from './session';
import { getDict, useI18n } from './i18n';
import { pageChunks } from './prefetch';
import { qk } from './queries';
import { afterLoginPath, isAppPath, Link, navigate, usePath } from './router';
import { Button, buttonClass, LangSwitch, Loading, Logo, ThemeSwitch } from './ui';

/**
 * Loads a code chunk, riding out a dropped connection: offline, it waits for the network to come
 * back instead of failing; other failures get two more tries. What still fails is a deploy that
 * removed the chunk (handled by ChunkErrorBoundary).
 */
function loadChunk<T>(load: () => Promise<T>, attempts = 3): Promise<T> {
  return load().catch(async (err: unknown) => {
    if (attempts <= 1) throw err;
    if (!navigator.onLine) await new Promise((resolve) => window.addEventListener('online', resolve, { once: true }));
    else await new Promise((resolve) => setTimeout(resolve, 1_000));
    return loadChunk(load, attempts - 1);
  });
}

// Each area loads on demand: the landing page doesn't download the dashboard, and the reverse.
const Landing = lazy(() => loadChunk(() => import('./site/Landing')).then((m) => ({ default: m.Landing })));
const GuidePage = lazy(() => loadChunk(() => import('./site/Guide')).then((m) => ({ default: m.GuidePage })));
const LoginPage = lazy(() => loadChunk(() => import('./auth/AuthPages')).then((m) => ({ default: m.LoginPage })));
const RegisterPage = lazy(() => loadChunk(() => import('./auth/AuthPages')).then((m) => ({ default: m.RegisterPage })));
const TwoFactorSetup = lazy(() => loadChunk(() => import('./auth/TwoFactor')).then((m) => ({ default: m.TwoFactorSetup })));
const RecoveryCodes = lazy(() => loadChunk(() => import('./auth/TwoFactor')).then((m) => ({ default: m.RecoveryCodes })));
const AppShell = lazy(() => loadChunk(() => import('./app/AppShell')).then((m) => ({ default: m.AppShell })));

const DashboardPage = lazy(() => loadChunk(pageChunks['/dashboard']).then((m) => ({ default: m.DashboardPage })));
const SessionsPage = lazy(() => loadChunk(pageChunks['/sessions']).then((m) => ({ default: m.SessionsPage })));
const SessionDetailPage = lazy(() => loadChunk(() => import('./pages/SessionDetail')).then((m) => ({ default: m.SessionDetailPage })));
const TemplatesPage = lazy(() => loadChunk(pageChunks['/templates']).then((m) => ({ default: m.TemplatesPage })));
const KeysPage = lazy(() => loadChunk(pageChunks['/keys']).then((m) => ({ default: m.KeysPage })));
const SubscriptionPage = lazy(() => loadChunk(pageChunks['/subscription']).then((m) => ({ default: m.SubscriptionPage })));
const AdminPage = lazy(() => loadChunk(pageChunks['/admin']).then((m) => ({ default: m.AdminPage })));
const AdsPage = lazy(() => loadChunk(pageChunks['/ads']).then((m) => ({ default: m.AdsPage })));
const ChatsPage = lazy(() => loadChunk(pageChunks['/chats']).then((m) => ({ default: m.ChatsPage })));
const ProfilePage = lazy(() => loadChunk(pageChunks['/profile']).then((m) => ({ default: m.ProfilePage })));

const subscribeOnline = (notify: () => void) => {
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
  return () => {
    window.removeEventListener('online', notify);
    window.removeEventListener('offline', notify);
  };
};

/** Says so while the browser is offline; requests and the event stream resume on their own afterwards. */
function OfflineBanner() {
  const { t } = useI18n();
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  if (online) return null;
  return (
    <div role="status" className="animate-fade-in fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-2 bg-warning px-4 py-2 text-sm font-medium text-on-warning shadow">
      <CloudOff className="size-4 shrink-0" />
      {t.app.offline.banner}
    </div>
  );
}

function Redirect({ to }: { to: string }) {
  useEffect(() => {
    navigate(to, { replace: true });
  }, [to]);
  return null;
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="page-wash relative flex min-h-svh flex-col items-center justify-center gap-6 p-6 text-center">
      <div className="absolute top-4 end-4 flex items-center gap-1">
        <ThemeSwitch />
        <LangSwitch />
      </div>
      {children}
    </main>
  );
}

function NotFound() {
  const { t } = useI18n();
  return (
    <Centered>
      <Link href="/" className="animate-fade-up">
        <Logo />
      </Link>
      <div className="animate-fade-up space-y-2" style={{ animationDelay: '100ms' }}>
        <p className="ltr text-shimmer text-7xl font-bold tracking-tight">404</p>
        <p className="text-muted">{t.notFound.text}</p>
      </div>
      <Link href="/" className={buttonClass('white', 'md', 'animate-fade-up')}>
        {t.notFound.home}
      </Link>
    </Centered>
  );
}

const PageLoading = () => <Loading className="min-h-svh" />;

/**
 * A chunk that fails to load almost always means a new version was deployed while this tab was
 * open (old files are gone). Say so and offer a reload instead of a blank page.
 */
class ChunkErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    const t = getDict().app.newVersion;
    return (
      <Centered>
        <RefreshCw className="size-8 text-brand" />
        <div className="space-y-2">
          <h1 className="text-xl font-medium">{t.title}</h1>
          <p className="max-w-sm text-sm text-muted">{t.text}</p>
        </div>
        <Button onClick={() => location.reload()}>{t.reload}</Button>
      </Centered>
    );
  }
}

function SuspendedScreen({ reason }: { reason: string | null }) {
  const { t } = useI18n();
  const s = t.app.suspended;
  const queryClient = useQueryClient();
  return (
    <Centered>
      <span className="animate-scale-in flex size-14 items-center justify-center rounded-full bg-destructive/20 text-destructive-ink">
        <Ban className="size-7" />
      </span>
      <div className="animate-fade-up max-w-md space-y-2">
        <h1 className="text-2xl font-semibold">{s.title}</h1>
        <p className="text-muted">{s.text}</p>
        {reason && (
          <p className="rounded-lg border border-line bg-raised/40 px-4 py-3 text-sm">
            <span className="font-medium">{s.reason}:</span> <bdi>{reason}</bdi>
          </p>
        )}
      </div>
      <div className="animate-fade-up flex flex-wrap justify-center gap-2">
        <a href={`mailto:${BRAND.supportEmail}`} className={buttonClass('white', 'md')}>
          {s.contact}
        </a>
        <Button variant="outline" onClick={() => void signOut(queryClient)}>
          {s.logout}
        </Button>
      </div>
    </Centered>
  );
}

function OfflineScreen({ error, onRetry, retrying }: { error: unknown; onRetry: () => void; retrying: boolean }) {
  const { t } = useI18n();
  const o = t.app.offline;
  return (
    <Centered>
      <CloudOff className="size-10 text-muted" />
      <div className="max-w-md space-y-2">
        <h1 className="text-xl font-medium">{o.title}</h1>
        <p className="text-sm text-muted">{o.text}</p>
        <p className="text-xs text-faint">{errorMessage(error)}</p>
      </div>
      <Button loading={retrying} onClick={onRetry}>
        {o.retry}
      </Button>
    </Centered>
  );
}

function AppPage({ path }: { path: string }) {
  const sessionMatch = /^\/sessions\/([0-9a-f-]{36})$/.exec(path);
  if (sessionMatch) return <SessionDetailPage key={sessionMatch[1]} id={sessionMatch[1]!} />;
  switch (path) {
    case '/dashboard':
      return <DashboardPage />;
    case '/sessions':
      return <SessionsPage />;
    case '/templates':
      return <TemplatesPage />;
    case '/keys':
      return <KeysPage />;
    case '/subscription':
      return <SubscriptionPage />;
    case '/admin':
      return <AdminPage />;
    case '/ads':
      return <AdsPage />;
    case '/chats':
      return <ChatsPage />;
    case '/profile':
      return <ProfilePage />;
    default:
      return <Redirect to="/dashboard" />;
  }
}

/** Login and sign-up skip straight to the app when a session is already there (only checked when we think there is one). */
function GuestOnly({ children }: { children: ReactNode }) {
  const hinted = sessionHint.get();
  // Always asks the server: an account cached from a session that has since ended must not count.
  const me = useQuery({ queryKey: qk.me, queryFn: ({ signal }) => api<Account>('/api/me', { signal }), enabled: hinted, retry: false, staleTime: 0, refetchOnMount: 'always' });
  if (!hinted) return children;
  if (me.isFetching && !me.isError) return <PageLoading />;
  if (me.isSuccess) return <Redirect to={afterLoginPath()} />;
  return children;
}

const loginRedirect = () => `/login?next=${encodeURIComponent(location.pathname + location.search)}`;

/** App pages need a session: the account decides between the dashboard, the login page, or a clear explanation. */
function AuthGate({ path }: { path: string }) {
  const me = useQuery({ queryKey: qk.me, queryFn: ({ signal }) => api<Account>('/api/me', { signal }) });
  const graceUntil = me.data?.user?.twoFactorGraceUntil ?? null;
  // The skip lasts 48 hours. When that moment arrives, reload the account so the setup screen
  // comes back on its own, even if nothing else is talking to the API.
  useEffect(() => {
    if (!graceUntil) return;
    const left = new Date(graceUntil).getTime() - Date.now();
    const id = setTimeout(() => void me.refetch(), Math.max(left, 0) + 1_000);
    return () => clearTimeout(id);
  }, [graceUntil, me.refetch]);
  // Kept here, not in the setup screen: once two-factor is on, the account reloads and the setup
  // screen goes away, but the recovery codes must stay until the user says they saved them.
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const error = me.error instanceof ApiRequestError ? me.error : null;
  if (error?.status === 401) return <Redirect to={loginRedirect()} />;
  if (error?.code === 'account_suspended') return <SuspendedScreen reason={typeof error.details?.reason === 'string' ? error.details.reason : null} />;
  if (!me.data) return me.isError ? <OfflineScreen error={me.error} onRetry={() => void me.refetch()} retrying={me.isFetching} /> : <PageLoading />;
  if (recoveryCodes) return <RecoveryCodes codes={recoveryCodes} onDone={() => setRecoveryCodes(null)} />;
  const user = me.data.user;
  if (user && !user.twoFactorEnabled && !user.twoFactorGraceUntil) return <TwoFactorSetup canSkip={user.twoFactorSkippable} onEnabled={setRecoveryCodes} />;
  return (
    <AppShell account={me.data}>
      <Suspense fallback={<Loading className="py-24" />}>
        <AppPage path={path} />
      </Suspense>
    </AppShell>
  );
}

export function App() {
  const path = usePath();
  const queryClient = useQueryClient();

  // Any request can learn that the session ended (expired, revoked, logged out elsewhere), that
  // the account was suspended, or that a two-factor skip has expired; react once, centrally.
  useEffect(() => {
    onSessionProblem((err) => {
      if (err.code === 'account_suspended' || err.code === 'two_factor_required') {
        void queryClient.invalidateQueries({ queryKey: qk.me });
        return;
      }
      // The session ended (expired, revoked, logged out elsewhere). Forget the account it belonged to
      // — leaving it cached would bounce the login page straight back here — and log in again.
      sessionHint.set(false);
      stopLiveEvents();
      if (isAppPath(location.pathname)) navigate(loginRedirect(), { replace: true });
      queryClient.removeQueries({ queryKey: qk.me });
    });
  }, [queryClient]);

  // Signed in (login, sign-up, token): drop whatever another account left in the cache, then go on.
  const onAuthed = useCallback(() => {
    sessionHint.set(true);
    queryClient.clear();
    navigate(afterLoginPath(), { replace: true });
  }, [queryClient]);

  // Links from the old hash-routed console (#/sessions/…) keep working.
  const legacy = /^#(\/.*)$/.exec(location.hash)?.[1];
  if (legacy) return <Redirect to={legacy} />;

  let page: ReactNode;
  if (path === '/') page = <Landing />;
  else if (path === '/guide') page = <GuidePage />;
  else if (path === '/login')
    page = (
      <GuestOnly>
        <LoginPage onAuthed={onAuthed} />
      </GuestOnly>
    );
  else if (path === '/register')
    page = (
      <GuestOnly>
        <RegisterPage onAuthed={onAuthed} />
      </GuestOnly>
    );
  else if (isAppPath(path)) page = <AuthGate path={path} />;
  else page = <NotFound />;

  return (
    <ChunkErrorBoundary>
      <OfflineBanner />
      <Suspense fallback={<PageLoading />}>{page}</Suspense>
    </ChunkErrorBoundary>
  );
}
