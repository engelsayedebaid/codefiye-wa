import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, createClient, loadCreds, saveCreds, type Client, type Creds, type Profile } from './api';
import { neonAuth, neonToken } from './auth';
import { Brand, Icon, type IconName } from './ui';
import { AdminClientsPage, AdminMethodsPage, AdminOverviewPage, AdminPaymentsPage, AdminPlansPage } from './console/AdminPages';
import { ApiDocsPage } from './console/ApiDocsPage';
import { BillingPage, KeysPage, MessagesPage, OverviewPage, SettingsPage } from './console/pages';
import { SessionsPage } from './console/SessionsPage';

type Route = { page: string; param: string | null };
const parseHash = (): Route => {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { page: parts[0] || 'overview', param: parts[1] ?? null };
};
const go = (page: string, param?: string | null) => {
  location.hash = `#/${page}${param ? `/${param}` : ''}`;
};

type Theme = 'light' | 'dark';
const useTheme = (): [Theme, () => void] => {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('wa.theme') === 'dark' ? 'dark' : 'light'));
  const toggle = () => setTheme((t) => {
    const next = t === 'dark' ? 'light' : 'dark';
    localStorage.setItem('wa.theme', next);
    return next;
  });
  return [theme, toggle];
};

export function App() {
  const [theme, toggleTheme] = useTheme();
  const [creds, setCreds] = useState<Creds | null | 'loading'>('loading');
  useEffect(() => {
    const stored = loadCreds();
    if (!stored || stored.mode !== 'neon' || !neonAuth) return setCreds(stored);
    // Restore the Neon Auth session (cookie) after reload.
    neonAuth
      .getSession()
      .then(({ data }) => setCreds(data ? { ...stored, token: '', getToken: neonToken } : null))
      .catch(() => setCreds(null));
  }, []);
  const client = useMemo(() => (creds && creds !== 'loading' ? createClient(creds) : null), [creds]);
  if (creds === 'loading') return <main className="grid min-h-screen place-items-center" data-theme={theme}><div className="skeleton" style={{ width: 320 }} /></main>;
  if (!client) return <Login theme={theme} onLogin={(c) => (saveCreds({ ...c, getToken: undefined }), setCreds(c))} />;
  const logout = () => {
    if (creds?.mode === 'neon') void neonAuth?.signOut();
    saveCreds(null);
    setCreds(null);
  };
  return <Console client={client} theme={theme} onToggleTheme={toggleTheme} onLogout={logout} />;
}

function Login({ onLogin, theme }: { onLogin: (c: Creds) => void; theme: Theme }) {
  const [mode, setMode] = useState<'signin' | 'signup' | 'pat'>(neonAuth ? 'signin' : 'pat');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const baseUrl = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:4000' : '');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'pat') {
        await createClient({ baseUrl, token }).profile();
        onLogin({ baseUrl, token, mode: 'pat' });
        return;
      }
      if (!neonAuth) throw new Error('Neon Auth غير مفعّل');
      const result =
        mode === 'signup'
          ? await neonAuth.signUp.email({ email: email.trim(), password, name: name.trim() || email.split('@')[0]! })
          : await neonAuth.signIn.email({ email: email.trim(), password });
      if (result.error) throw new Error(result.error.message ?? 'فشل تسجيل الدخول');
      await createClient({ baseUrl, token: '', mode: 'neon', getToken: neonToken }).profile();
      onLogin({ baseUrl, token: '', mode: 'neon', getToken: neonToken });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message || 'تعذّر الوصول إلى الخادم');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-layout" dir="rtl" data-theme={theme}>
      <div className="auth-story">
        <div>
          <Brand />
          <div style={{ marginTop: 70 }}>
            <span className="icon-tile"><Icon name="chat" size={30} /></span>
            <h1>حوّل واتساب إلى <span>API</span> لتطبيقك</h1>
            <p>لوحة تحكم لإدارة أرقام واتساب، إرسال واستقبال الرسائل، ومتابعة الاستخدام — كل ذلك من مكان واحد.</p>
          </div>
        </div>
        <small>wa-platform — منصّة مستقلة، غير تابعة لـ WhatsApp أو Meta.</small>
      </div>
      <div className="auth-main">
        <div className="auth-form">
          {neonAuth && mode !== 'pat' && (
            <div className="sidebar-nav" style={{ gridTemplateColumns: '1fr 1fr', display: 'grid', gap: 8, marginBottom: 22 }}>
              <a href="#" onClick={(e) => (e.preventDefault(), setMode('signin'))} className={mode === 'signin' ? 'active' : ''} style={{ justifyContent: 'center' }}>دخول</a>
              <a href="#" onClick={(e) => (e.preventDefault(), setMode('signup'))} className={mode === 'signup' ? 'active' : ''} style={{ justifyContent: 'center' }}>حساب جديد</a>
            </div>
          )}
          <h2>{mode === 'signup' ? 'إنشاء حساب' : 'تسجيل الدخول'}</h2>
          <p>
            {mode === 'pat'
              ? 'أدخل رمز الدخول (PAT) الخاص بمساحة عملك.'
              : mode === 'signup'
                ? 'أنشئ حسابك وابدأ تجربتك المجانية (٣ أيام، جلسة واحدة).'
                : 'سجّل دخولك بإيميلك وكلمة السر.'}
          </p>
          <form onSubmit={submit}>
            {mode === 'signup' && (
              <label>الاسم<input value={name} onChange={(e) => setName(e.target.value)} placeholder="اسمك أو اسم شركتك" autoFocus /></label>
            )}
            {mode !== 'pat' && (
              <>
                <label>الإيميل<input dir="ltr" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoFocus={mode === 'signin'} /></label>
                <label>كلمة السر<input dir="ltr" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="8 أحرف على الأقل" /></label>
              </>
            )}
            {mode === 'pat' && (
              <label>رمز الدخول
                <input dir="ltr" type="password" className="font-mono" placeholder="wa_pat_…" value={token} onChange={(e) => setToken(e.target.value)} required autoFocus />
              </label>
            )}
            {error && <p className="notice error" style={{ margin: 0 }}>{error}</p>}
            <button className="button primary large" disabled={busy}>
              {busy ? 'جارٍ التحقق…' : mode === 'signup' ? 'إنشاء الحساب' : 'دخول'}
            </button>
          </form>
          <div className="auth-links">
            {neonAuth && (mode === 'pat' ? <button onClick={() => setMode('signin')}>دخول بالإيميل</button> : <button onClick={() => setMode('pat')}>لدي رمز دخول (PAT)</button>)}
            <a href="/">← العودة للموقع</a>
          </div>
        </div>
      </div>
    </main>
  );
}

type NavItem = { id: string; label: string; icon: IconName };
const NAV: NavItem[] = [
  { id: 'overview', label: 'الرئيسية', icon: 'grid' },
  { id: 'sessions', label: 'الجلسات', icon: 'phone' },
  { id: 'messages', label: 'الرسائل', icon: 'chat' },
  { id: 'keys', label: 'مفاتيح API', icon: 'key' },
  { id: 'api', label: 'التكامل والـ API', icon: 'code' },
  { id: 'billing', label: 'الاشتراك', icon: 'card' },
  { id: 'settings', label: 'الإعدادات', icon: 'settings' },
];
const ADMIN_NAV: NavItem[] = [
  { id: 'admin', label: 'نظرة عامة', icon: 'chart' },
  { id: 'admin-clients', label: 'العملاء', icon: 'users' },
  { id: 'admin-payments', label: 'طلبات الدفع', icon: 'card' },
  { id: 'admin-plans', label: 'الباقات', icon: 'chart' },
  { id: 'admin-methods', label: 'طرق الدفع', icon: 'settings' },
];

function Console({ client, onLogout, theme, onToggleTheme }: { client: Client; onLogout: () => void; theme: Theme; onToggleTheme: () => void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [route, setRoute] = useState<Route>(parseHash);
  const [menuOpen, setMenuOpen] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);

  const loadProfile = useCallback(() => {
    client.profile()
      .then(setProfile)
      .catch((e) => (e instanceof ApiError && e.status === 401 ? onLogout() : setFatal((e as Error).message)));
  }, [client, onLogout]);

  useEffect(loadProfile, [loadProfile]);
  useEffect(() => {
    const onHash = () => (setRoute(parseHash()), setMenuOpen(false));
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  if (fatal) {
    return (
      <main className="grid min-h-screen place-items-center p-6">
        <div className="panel" style={{ maxWidth: 420, textAlign: 'center' }}>
          <h2 style={{ marginBottom: 12 }}>تعذّر تحميل اللوحة</h2>
          <p className="muted" style={{ fontSize: 13, lineHeight: 2 }}>{fatal}</p>
          <button className="button secondary" style={{ marginTop: 18 }} onClick={onLogout}>خروج</button>
        </div>
      </main>
    );
  }
  if (!profile) {
    return (
      <main className="console-shell" style={{ gridTemplateColumns: '1fr' }}>
        <div className="console-content"><div className="skeleton" style={{ maxWidth: 700, margin: '80px auto' }} /></div>
      </main>
    );
  }

  const ws = profile.workspace;
  const nav = (items: NavItem[], label: string) => (
    <div>
      <div className="sidebar-label">{label}</div>
      <nav className="sidebar-nav">
        {items.map((item) => (
          <a key={item.id} href={`#/${item.id}`} className={route.page === item.id ? 'active' : ''}>
            <Icon name={item.icon} size={18} />
            {item.label}
          </a>
        ))}
      </nav>
    </div>
  );

  return (
    <div className="console-shell" data-theme={theme}>
      <aside className={`console-sidebar${menuOpen ? ' open' : ''}`}>
        <div className="row-between">
          <Brand />
          <button className="icon-button sidebar-close" onClick={() => setMenuOpen(false)}><Icon name="close" size={17} /></button>
        </div>
        <div className="workspace-chip">
          <div className="chip-row">
            <span className="avatar">{ws.name.slice(0, 1)}</span>
            <div className="chip-meta">
              <strong>{ws.name}</strong>
              {profile.email && <small dir="ltr">{profile.email}</small>}
            </div>
          </div>
          <div className="chip-foot">
            <i className="dot" />
            <span>{profile.plan.name}</span>
            {profile.isAdmin && <span className="role"><Icon name="shield" size={10} /> أدمن</span>}
          </div>
        </div>
        {nav(NAV, 'مساحة العمل')}
        {profile.isAdmin && nav(ADMIN_NAV, 'إدارة المنصة')}
        <div className="sidebar-bottom">
          <div className="sidebar-help">
            <h4>التكامل والـ API</h4>
            <p>أمثلة جاهزة للنسخ ومرجع لكل الـ endpoints بالعربي.</p>
            <a href="#/api"><Icon name="code" size={15} /> افتح دليل التكامل</a>
          </div>
          <button className="sidebar-logout" onClick={onLogout}><Icon name="logout" size={17} /> تسجيل الخروج</button>
        </div>
      </aside>

      <div className="console-body">
        <header className="console-topbar">
          <div className="topbar-actions">
            <button className="icon-button mobile-menu" onClick={() => setMenuOpen(true)}><Icon name="menu" size={18} /></button>
            <span className="muted">{route.page === 'overview' ? 'الرئيسية' : NAV.concat(ADMIN_NAV).find((n) => n.id === route.page)?.label}</span>
          </div>
          <div className="topbar-actions">
            {ws.suspendedAt && <span className="badge danger">الحساب موقوف</span>}
            <span className="badge neutral">{profile.plan.name}</span>
            <button className="icon-button" onClick={onToggleTheme} title={theme === 'dark' ? 'وضع فاتح' : 'وضع داكن'}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
            </button>
          </div>
        </header>
        <main className="console-content">
          {ws.suspendedAt && <div className="notice error">هذا الحساب موقوف من الإدارة — الإرسال وإنشاء الجلسات معطّلان. تواصل مع الدعم.</div>}
          {route.page === 'overview' && <OverviewPage client={client} profile={profile} go={(p) => go(p)} />}
          {route.page === 'sessions' && <SessionsPage client={client} sessionId={route.param} onNavigate={(id) => go('sessions', id)} />}
          {route.page === 'messages' && <MessagesPage client={client} />}
          {route.page === 'keys' && <KeysPage client={client} />}
          {route.page === 'api' && <ApiDocsPage go={(p) => go(p)} />}
          {route.page === 'billing' && <BillingPage client={client} onChanged={loadProfile} />}
          {route.page === 'settings' && <SettingsPage client={client} profile={profile} onChanged={loadProfile} />}
          {route.page === 'admin' && profile.isAdmin && <AdminOverviewPage client={client} />}
          {route.page === 'admin-clients' && profile.isAdmin && <AdminClientsPage client={client} />}
          {route.page === 'admin-payments' && profile.isAdmin && <AdminPaymentsPage client={client} />}
          {route.page === 'admin-plans' && profile.isAdmin && <AdminPlansPage client={client} />}
          {route.page === 'admin-methods' && profile.isAdmin && <AdminMethodsPage client={client} />}
        </main>
      </div>
    </div>
  );
}
