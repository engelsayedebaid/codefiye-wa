import { useEffect, useState } from 'react';
import { API_PUBLIC } from '../api';
import type { Billing, Client, KeyRow, MessagePage, Overview, Session } from '../api';
import { date, Empty, Icon, number } from '../ui';
import { messageStatusLabel, messageStatusTone, methodLabel } from '../status';

const planName = (plans: { id: string; name: string }[], id: string) => plans.find((p) => p.id === id)?.name ?? id;

export function Page({ title, sub, action, children }: { title: string; sub?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{title}</h1>
          {sub && <p>{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </>
  );
}

function useData<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = () => {
    setLoading(true);
    fn()
      .then((d) => (setData(d), setError(null)))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, deps);
  return { data, error, loading, reload };
}

export function OverviewPage({ client, profile, go }: { client: Client; profile: { workspace: { name: string } }; go: (p: string) => void }) {
  const { data, error, loading } = useData<Overview>(() => client.overview());
  const max = Math.max(1, ...(data?.daily.map((d) => d.count) ?? []));
  const days = [...Array(7)].map((_, i) => {
    const d = new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10);
    return { day: d, count: data?.daily.find((r) => r.day === d)?.count ?? 0 };
  });
  const stats = [
    { label: 'جلسات متصلة', value: `${data?.sessions.connected ?? 0}/${data?.sessions.total ?? 0}`, icon: 'phone' as const, hint: 'إجمالي الجلسات' },
    { label: 'رسائل صادرة', value: number(data?.messages.sent ?? 0), icon: 'chat' as const, hint: 'منذ البداية' },
    { label: 'رسائل واردة', value: number(data?.messages.received ?? 0), icon: 'chat' as const, hint: 'منذ البداية' },
    { label: 'مفاتيح نشطة', value: number(data?.activeKeys ?? 0), icon: 'key' as const, hint: 'غير ملغاة' },
  ];
  return (
    <Page title="الرئيسية" sub={`أهلاً بك في ${profile.workspace.name}`}>
      {error && <p className="notice error">{error}</p>}
      {loading && !data ? <div className="skeleton" /> : (
        <>
          <div className="stat-grid">
            {stats.map((s) => (
              <div key={s.label} className="stat-card">
                <div>{s.label}<span className="icon-tile"><Icon name={s.icon} size={18} /></span></div>
                <strong>{s.value}</strong>
                <small>{s.hint}</small>
              </div>
            ))}
          </div>
          <div className="dashboard-columns">
            <div className="panel">
              <div className="panel-heading">
                <div><h2>نشاط الرسائل</h2><p>آخر ٧ أيام</p></div>
                <span className="badge neutral">{number(data?.messages.failed ?? 0)} فاشلة</span>
              </div>
              <div className="activity-chart">
                {days.map((d) => (
                  <div key={d.day}>
                    <div className="bar" style={{ height: `${Math.max(2, (d.count / max) * 100)}%` }} title={`${d.count}`} />
                    <small className="muted">{d.day.slice(5)}</small>
                  </div>
                ))}
              </div>
            </div>
            <div className="panel">
              <div className="panel-heading"><div><h2>ابدأ من هنا</h2><p>خطوات التشغيل</p></div></div>
              <div className="checklist">
                {[
                  { t: 'أنشئ جلسة واتساب', d: 'من صفحة الجلسات', p: 'sessions', icon: 'phone' as const },
                  { t: 'اربط رقمك', d: 'امسح الـ QR أو استخدم رمز الربط', p: 'sessions', icon: 'check' as const },
                  { t: 'أرسل أول رسالة', d: 'جرّب الإرسال من صفحة الجلسة', p: 'sessions', icon: 'chat' as const },
                  { t: 'أنشئ مفتاح API', d: 'لتكامل تطبيقك مع الـ REST API', p: 'keys', icon: 'key' as const },
                ].map((s, i) => (
                  <div key={s.t}>
                    <span className="icon-tile"><Icon name={s.icon} size={17} /></span>
                    <div style={{ flex: 1 }}>
                      <strong>{i + 1}. {s.t}</strong>
                      <small>{s.d}</small>
                    </div>
                    <button className="button secondary" onClick={() => go(s.p)}>فتح</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </Page>
  );
}

export function MessagesPage({ client }: { client: Client }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const { data, error, loading } = useData<MessagePage>(() => client.messages(page, search, status), [page, search, status]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <Page title="الرسائل" sub="سجل الرسائل الصادرة والواردة عبر جلساتك">
      <div className="panel">
        <div className="table-controls">
          <label>بحث بالرقم<input dir="ltr" className="font-mono" placeholder="2010…" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} /></label>
          <label>الحالة
            <select value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
              <option value="all">الكل</option>
              {Object.entries(messageStatusLabel).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        </div>
        {error && <p className="notice error">{error}</p>}
        {loading ? <div className="skeleton" /> : !data?.items.length ? (
          <Empty title="لا توجد رسائل" icon="chat">ستظهر هنا الرسائل بعد ربط جلسة وبدء الإرسال.</Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead><tr><th>الوقت</th><th>الجلسة</th><th>الرقم</th><th>الاتجاه</th><th>النوع</th><th>الحالة</th></tr></thead>
                <tbody>
                  {data.items.map((m) => (
                    <tr key={m.id}>
                      <td><small>{date(m.createdAt)}</small></td>
                      <td>{m.sessionName}</td>
                      <td dir="ltr" className="font-mono">{m.remoteJid.split('@')[0]}</td>
                      <td><span className={`badge ${m.direction === 'out' ? 'neutral' : 'success'}`}>{m.direction === 'out' ? 'صادرة' : 'واردة'}</span></td>
                      <td>{m.type}</td>
                      <td><span className={`badge ${messageStatusTone[m.status] ?? 'neutral'}`} title={m.error ?? ''}>{messageStatusLabel[m.status] ?? m.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span className="muted">{number(data.total)} رسالة</span>
              <div>
                <button className="button secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>السابق</button>
                <span className="muted" style={{ alignSelf: 'center' }}>{number(page)} / {number(pages)}</span>
                <button className="button secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>التالي</button>
              </div>
            </div>
          </>
        )}
      </div>
    </Page>
  );
}

export function KeysPage({ client }: { client: Client }) {
  const { data, error, loading, reload } = useData<KeyRow[]>(() => client.keys());
  const { data: sessions } = useData<Session[]>(() => client.listSessions());
  const [name, setName] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const k = await client.createKey(name.trim() || 'API key', sessionId || null);
      setNewKey(k.key);
      setName('');
      reload();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="مفاتيح API" sub="مفاتيح للوصول البرمجي — مفتاح الجلسة يقتصر على جلسة واحدة، والمفتاح العام (PAT) لكل مساحة العمل">
      {newKey && (
        <div className="notice success">
          المفتاح يُعرض مرة واحدة فقط — انسخه الآن.
          <code dir="ltr">{newKey}</code>
          <button className="button secondary" style={{ marginTop: 10 }} onClick={() => navigator.clipboard.writeText(newKey)}>نسخ</button>
        </div>
      )}
      <div className="panel" style={{ marginBottom: 22 }}>
        <div className="panel-heading"><div><h2>مفتاح جديد</h2><p>اترك «الجلسة» فارغة لإنشاء مفتاح عام</p></div></div>
        <form className="table-controls" onSubmit={create}>
          <label>الاسم<input value={name} onChange={(e) => setName(e.target.value)} placeholder="تكامل المتجر" /></label>
          <label>الجلسة (اختياري)
            <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
              <option value="">كل الجلسات (PAT)</option>
              {(sessions ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <button className="button primary" disabled={busy}>{busy ? '…' : 'إنشاء'}</button>
        </form>
      </div>
      <div className="panel">
        {error && <p className="notice error">{error}</p>}
        {loading ? <div className="skeleton" /> : !data?.length ? (
          <Empty title="لا توجد مفاتيح" icon="key">أنشئ مفتاحاً لاستخدام الـ REST API من تطبيقك.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>الاسم</th><th>البادئة</th><th>النطاق</th><th>آخر استخدام</th><th>أُنشئ</th><th /></tr></thead>
              <tbody>
                {data.map((k) => (
                  <tr key={k.id} style={k.revokedAt ? { opacity: 0.45 } : undefined}>
                    <td>{k.name}</td>
                    <td dir="ltr" className="font-mono">{k.prefix}…</td>
                    <td><span className="badge neutral">{k.sessionId ? 'جلسة' : 'مساحة العمل'}</span></td>
                    <td><small>{date(k.lastUsedAt)}</small></td>
                    <td><small>{date(k.createdAt)}</small></td>
                    <td>{k.revokedAt ? <span className="badge danger">ملغي</span> : (
                      <button className="button danger" onClick={() => confirm('إلغاء هذا المفتاح؟ لن يعمل بعدها.') && client.revokeKey(k.id).then(reload)}>إلغاء</button>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Page>
  );
}

const requestStatus: Record<string, { label: string; tone: string }> = {
  pending: { label: 'قيد المراجعة', tone: 'warning' },
  approved: { label: 'مقبول — الباقة مفعّلة', tone: 'success' },
  rejected: { label: 'مرفوض', tone: 'danger' },
};

export function BillingPage({ client, onChanged }: { client: Client; onChanged: () => void }) {
  const { data, error, loading, reload } = useData<Billing>(() => client.billing());
  const [planId, setPlanId] = useState('pro');
  const [months, setMonths] = useState(1);
  const [methodId, setMethodId] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const selectedMethod = data?.methods.find((m) => m.id === methodId) ?? data?.methods[0];
  const activeMethodId = methodId || selectedMethod?.id || '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await client.requestPayment({ planId, months, methodId: activeMethodId, reference: reference || undefined });
      setDone(true);
      setReference('');
      reload();
      onChanged();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const pending = data?.requests.find((r) => r.status === 'pending');
  return (
    <Page title="الاشتراك والفوترة" sub="الدفع يدوي حالياً — أرسل إثبات التحويل ويتم تفعيل الباقة بعد مراجعة الإدارة">
      {error && <p className="notice error">{error}</p>}
      {loading ? <div className="skeleton" /> : data && (
        <div className="two-columns">
          <div style={{ display: 'grid', gap: 22, alignContent: 'start' }}>
            <div className="panel">
              <div className="panel-heading"><div><h2>باقتك الحالية</h2><p>{data.planExpiresAt ? `صالحة حتى ${date(data.planExpiresAt)}` : data.planId === 'trial' && data.trialEndsAt ? `تنتهي التجربة ${date(data.trialEndsAt)}` : ''}</p></div></div>
              <div className="plan-sessions" style={{ justifyContent: 'space-between' }}>
                <strong style={{ fontSize: 18 }}>{data.plan.name}</strong>
                <span>{data.plan.sessions} جلسة{data.plan.dailyMessages ? ` · ${data.plan.dailyMessages} رسالة/يوم` : ' · رسائل غير محدودة'}</span>
              </div>
              {data.planId !== 'trial' && !data.planExpiresAt && null}
            </div>
            <div className="panel">
              <div className="panel-heading"><div><h2>طلبات الدفع</h2><p>سجل طلباتك</p></div></div>
              {!data.requests.length ? <p className="muted" style={{ fontSize: 12 }}>لا توجد طلبات بعد.</p> : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>التاريخ</th><th>الباقة</th><th>المبلغ</th><th>الطريقة</th><th>الحالة</th></tr></thead>
                    <tbody>
                      {data.requests.map((r) => (
                        <tr key={r.id}>
                          <td><small>{date(r.createdAt)}</small></td>
                          <td>{planName(data.plans, r.planId)} × {r.months}</td>
                          <td>{number(r.amountEgp)} ج.م</td>
                          <td>{methodLabel[r.method] ?? r.method}</td>
                          <td><span className={`badge ${requestStatus[r.status]?.tone ?? 'neutral'}`} title={r.adminNote ?? ''}>{requestStatus[r.status]?.label ?? r.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
          <div className="panel" style={{ alignSelf: 'start' }}>
            <div className="panel-heading"><div><h2>ترقية الباقة</h2><p>اختر الباقة وطريقة الدفع</p></div></div>
            {pending ? (
              <div className="notice">لديك طلب {planName(data.plans, pending.planId)} بمبلغ {number(pending.amountEgp)} ج.م قيد المراجعة منذ {date(pending.createdAt)}.</div>
            ) : done ? (
              <div className="notice success">تم استلام طلبك. سنفعّل الباقة بعد مراجعة التحويل.</div>
            ) : (
              <form className="form-grid" style={{ maxWidth: 'none' }} onSubmit={submit}>
                <label>الباقة
                  <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
                    {data.plans.filter((p) => p.id !== 'trial').map((p) => (
                      <option key={p.id} value={p.id}>{p.name} — {number(p.egp)} ج.م/شهر · {p.sessions} جلسة</option>
                    ))}
                  </select>
                </label>
                <label>المدة
                  <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>
                    {[1, 3, 6, 12].map((m) => <option key={m} value={m}>{m === 1 ? 'شهر' : m === 3 ? '٣ أشهر' : m === 6 ? '٦ أشهر' : 'سنة'}</option>)}
                  </select>
                </label>
                <label>طريقة الدفع
                  <select value={activeMethodId} onChange={(e) => setMethodId(e.target.value)} required>
                    {!data.methods.length && <option value="">لا توجد طرق دفع مفعّلة</option>}
                    {data.methods.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                </label>
                {selectedMethod && (
                  <div className="notice" style={{ margin: 0 }}>
                    <b>{selectedMethod.label}</b>
                    {selectedMethod.details && <code dir="ltr" style={{ fontSize: 14, fontWeight: 600, textAlign: 'center' }}>{selectedMethod.details}</code>}
                    {selectedMethod.instructions && <div style={{ marginTop: 6 }}>{selectedMethod.instructions}</div>}
                    <button type="button" className="button secondary" style={{ marginTop: 10 }} onClick={() => selectedMethod.details && navigator.clipboard.writeText(selectedMethod.details)}>نسخ بيانات التحويل</button>
                  </div>
                )}
                <label>رقم العملية / المرجع (اختياري)<input dir="ltr" className="font-mono" value={reference} onChange={(e) => setReference(e.target.value)} /></label>
                <button className="button primary" disabled={busy}>{busy ? '…' : `إرسال طلب دفع — ${number((data.plans.find((p) => p.id === planId)?.egp ?? 0) * months)} ج.م`}</button>
                <small>سيظهر الطلب للإدارة فوراً. التفعيل يتم يدوياً بعد تأكيد التحويل.</small>
              </form>
            )}
          </div>
        </div>
      )}
    </Page>
  );
}

export function SettingsPage({ client, profile, onChanged }: { client: Client; profile: { workspace: { id: string; name: string } }; onChanged: () => void }) {
  const [name, setName] = useState(profile.workspace.name);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await client.renameWorkspace(name.trim());
      setSaved(true);
      onChanged();
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page title="الإعدادات" sub="إعدادات مساحة العمل">
      <div className="two-columns">
        <div className="panel" style={{ alignSelf: 'start' }}>
          <div className="panel-heading"><div><h2>مساحة العمل</h2><p>الاسم الظاهر في اللوحة والفواتير</p></div></div>
          <form className="form-grid" style={{ maxWidth: 'none' }} onSubmit={save}>
            <label>الاسم<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
            <button className="button primary" disabled={busy}>{saved ? 'تم الحفظ ✓' : busy ? '…' : 'حفظ'}</button>
          </form>
        </div>
        <div className="panel" style={{ alignSelf: 'start' }}>
          <div className="panel-heading"><div><h2>معلومات تقنية</h2></div></div>
          <div style={{ display: 'grid', gap: 14, fontSize: 12 }}>
            <div><small>معرّف مساحة العمل</small><div dir="ltr" className="font-mono">{profile.workspace.id}</div></div>
            <div><small>وثائق الـ API</small><div><a href={`${API_PUBLIC}/docs`} target="_blank" rel="noreferrer" className="text-link" style={{ color: '#2b7350' }}>فتح Swagger /docs ↗</a></div></div>
          </div>
        </div>
      </div>
    </Page>
  );
}
