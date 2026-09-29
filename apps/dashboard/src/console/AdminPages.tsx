import { useEffect, useState } from 'react';
import type { AdminClient, AdminOverview, AdminPayment, AdminPlan, Client, PayMethod } from '../api';
import { date, Empty, Icon, Modal, number } from '../ui';
import { statusLabel, statusTone } from '../status';
import { Page } from './pages';

const planLabel: Record<string, string> = { trial: 'تجريبي', basic: 'Basic', pro: 'Pro', plus: 'Plus', business: 'Business', unlimited: 'غير محدود' };
const planOptions = (plans: AdminPlan[]) => (plans.length ? plans.map((p) => ({ v: p.key, l: p.name })) : Object.entries(planLabel).map(([v, l]) => ({ v, l })));

export function AdminOverviewPage({ client }: { client: Client }) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = () => client.adminOverview().then(setData).catch((e) => setError((e as Error).message));
    void load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [client]);

  const stats = [
    { label: 'العملاء', value: number(data?.counts.workspaces ?? 0), icon: 'users' as const },
    { label: 'الجلسات', value: number(data?.counts.sessions ?? 0), icon: 'phone' as const },
    { label: 'الرسائل', value: number(data?.counts.messages ?? 0), icon: 'chat' as const },
    { label: 'طلبات دفع معلّقة', value: number(data?.pendingPayments ?? 0), icon: 'card' as const },
  ];
  const now = Date.now();
  return (
    <Page title="نظرة عامة — الإدارة" sub="مراقبة المنصة بالكامل">
      {error && <p className="notice error">{error}</p>}
      <div className="stat-grid">
        {stats.map((s) => (
          <div key={s.label} className="stat-card">
            <div>{s.label}<span className="icon-tile"><Icon name={s.icon} size={18} /></span></div>
            <strong>{s.value}</strong>
          </div>
        ))}
      </div>
      <div className="two-columns">
        <div className="panel">
          <div className="panel-heading"><div><h2>العمال (Workers)</h2><p>آخر نبضة خلال ٣٠ ثانية = حي</p></div></div>
          {!data?.workers.length ? <Empty title="لا يوجد عمال" icon="server">شغّل `pnpm dev` لبدء العامل.</Empty> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>العامل</th><th>الجلسات</th><th>آخر نبضة</th><th>الحالة</th></tr></thead>
                <tbody>
                  {data.workers.map((w) => {
                    const alive = now - new Date(w.lastSeenAt).getTime() < 30_000;
                    return (
                      <tr key={w.id}>
                        <td dir="ltr" className="font-mono">{w.id}</td>
                        <td>{w.sessions}/{w.maxSessions}</td>
                        <td><small>{date(w.lastSeenAt)}</small></td>
                        <td><span className={`badge ${alive ? 'success' : 'danger'}`}>{alive ? 'حي' : 'متوقف'}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="panel">
          <div className="panel-heading"><div><h2>كل الجلسات</h2><p>عبر كل العملاء</p></div></div>
          {!data?.sessions.length ? <Empty title="لا توجد جلسات" icon="phone" /> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>الجلسة</th><th>العميل</th><th>الرقم</th><th>الحالة</th></tr></thead>
                <tbody>
                  {data.sessions.map((s) => (
                    <tr key={s.id}>
                      <td>{s.name}</td>
                      <td>{s.workspace}</td>
                      <td dir="ltr" className="font-mono">{s.phone ?? '—'}</td>
                      <td><span className={`badge ${statusTone[s.status]}`}>{statusLabel[s.status]}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}

export function AdminClientsPage({ client }: { client: Client }) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [planId, setPlanId] = useState('trial');
  const [newKey, setNewKey] = useState<{ email: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [planRows, setPlanRows] = useState<AdminPlan[]>([]);

  const reload = () => client.adminOverview().then(setData).catch((e) => setError((e as Error).message));
  useEffect(() => {
    void reload();
    void client.adminPlans().then(setPlanRows).catch(() => {});
  }, [client]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await client.adminCreateClient({ email: email.trim(), name: name.trim(), planId });
      setNewKey({ email: r.email, key: r.key });
      setEmail(''); setName('');
      await reload();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function update(c: AdminClient, body: { planId?: string; extendMonths?: number; suspend?: boolean }) {
    try {
      await client.adminUpdateClient(c.id, body);
      await reload();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  return (
    <Page title="العملاء" sub="حسابات العملاء — إنشاء حساب يولّد رمز دخول (PAT) يُسلَّم للعميل مرة واحدة">
      {newKey && (
        <div className="notice success">
          حساب <b>{newKey.email}</b> أُنشئ. رمز الدخول يُعرض مرة واحدة — انسخه وسلّمه للعميل:
          <code dir="ltr">{newKey.key}</code>
          <div><button className="button secondary" style={{ marginTop: 10 }} onClick={() => navigator.clipboard.writeText(newKey.key)}>نسخ الرمز</button></div>
        </div>
      )}
      {error && <p className="notice error">{error}</p>}
      <div className="panel" style={{ marginBottom: 22 }}>
        <div className="panel-heading"><div><h2>إنشاء حساب عميل</h2><p>العميل يدخل بالرمز من /app</p></div></div>
        <form className="table-controls" onSubmit={create}>
          <label>الإيميل<input dir="ltr" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="client@example.com" /></label>
          <label>اسم الشركة<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="اسم مساحة العمل" /></label>
          <label>الباقة
            <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
              {planOptions(planRows).map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </label>
          <button className="button primary" disabled={busy}>{busy ? '…' : 'إنشاء الحساب'}</button>
        </form>
      </div>
      <div className="panel">
        {!data ? <div className="skeleton" /> : !data.clients.length ? <Empty title="لا يوجد عملاء" icon="users" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>العميل</th><th>الإيميل</th><th>الباقة</th><th>صلاحية الباقة</th><th>الحالة</th><th>إجراءات</th></tr></thead>
              <tbody>
                {data.clients.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td dir="ltr" className="font-mono">{c.email ?? '—'}</td>
                    <td>
                      <select value={c.planId} style={{ width: 'auto', padding: '6px 10px', fontSize: 11 }} onChange={(e) => update(c, { planId: e.target.value })}>
                        {planOptions(planRows).map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                        {!planOptions(planRows).some((o) => o.v === c.planId) && <option value={c.planId}>{c.planId}</option>}
                      </select>
                    </td>
                    <td><small>{date(c.planExpiresAt)}</small></td>
                    <td>{c.suspendedAt ? <span className="badge danger">موقوف</span> : <span className="badge success">نشط</span>}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="button secondary" title="تمديد الباقة شهراً" onClick={() => update(c, { extendMonths: 1 })}>+ شهر</button>
                        {c.suspendedAt ? (
                          <button className="button secondary" onClick={() => update(c, { suspend: false })}>إلغاء الإيقاف</button>
                        ) : (
                          <button className="button danger" onClick={() => confirm(`إيقاف ${c.name}؟ لن يستطيع الإرسال أو إنشاء جلسات.`) && update(c, { suspend: true })}>إيقاف</button>
                        )}
                      </div>
                    </td>
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

export function AdminMethodsPage({ client }: { client: Client }) {
  const [rows, setRows] = useState<PayMethod[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [details, setDetails] = useState('');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<PayMethod | null>(null);
  const reload = () => client.adminMethods().then(setRows).catch((e) => setError((e as Error).message));
  useEffect(() => void reload(), [client]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await client.adminCreateMethod({ label: label.trim(), details: details.trim(), instructions: instructions.trim() });
      setLabel(''); setDetails(''); setInstructions('');
      await reload();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="طرق الدفع" sub="الحسابات والأرقام التي يحوّل عليها العملاء — تظهر لهم في صفحة الاشتراك">
      {error && <p className="notice error">{error}</p>}
      <div className="panel" style={{ marginBottom: 22 }}>
        <div className="panel-heading"><div><h2>إضافة طريقة</h2><p>مثال: إنستاباي + رقم المحفظة، فودافون كاش + الرقم، حساب بنكي + IBAN</p></div></div>
        <form className="table-controls" onSubmit={create}>
          <label>الاسم<input required value={label} onChange={(e) => setLabel(e.target.value)} placeholder="فودافون كاش" /></label>
          <label>بيانات التحويل<input required dir="ltr" className="font-mono" value={details} onChange={(e) => setDetails(e.target.value)} placeholder="01001234567" /></label>
          <label>تعليمات للعميل<input value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="حوّل ثم أرسل رقم العملية" /></label>
          <button className="button primary" disabled={busy}>{busy ? '…' : 'إضافة'}</button>
        </form>
      </div>
      <div className="panel">
        {!rows ? <div className="skeleton" /> : !rows.length ? <Empty title="لا توجد طرق دفع" icon="card" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>الطريقة</th><th>بيانات التحويل</th><th>التعليمات</th><th>الحالة</th><th>إجراءات</th></tr></thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id} style={m.enabled === false ? { opacity: 0.5 } : undefined}>
                    <td style={{ fontWeight: 500 }}>{m.label}</td>
                    <td dir="ltr" className="font-mono">{m.details || '—'}</td>
                    <td style={{ whiteSpace: 'normal', minWidth: 180 }}>{m.instructions || '—'}</td>
                    <td>{m.enabled !== false ? <span className="badge success">مفعّلة</span> : <span className="badge neutral">معطّلة</span>}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="button secondary" onClick={() => setEditing(m)}>تعديل</button>
                        <button className="button secondary" onClick={() => client.adminUpdateMethod(m.id, { enabled: m.enabled === false }).then(reload).catch((e) => alert((e as Error).message))}>
                          {m.enabled !== false ? 'تعطيل' : 'تفعيل'}
                        </button>
                        <button className="button danger" onClick={() => confirm(`حذف «${m.label}»؟ الطلبات السابقة تحتفظ باسمها.`) && client.adminDeleteMethod(m.id).then(reload).catch((e) => alert((e as Error).message))}>حذف</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {editing && (
        <Modal title={`تعديل «${editing.label}»`} onClose={() => setEditing(null)}>
          <MethodEditForm
            method={editing}
            onSave={async (patch) => {
              await client.adminUpdateMethod(editing.id, patch);
              setEditing(null);
              await reload();
            }}
            onCancel={() => setEditing(null)}
          />
        </Modal>
      )}
    </Page>
  );
}

function MethodEditForm({ method, onSave, onCancel }: { method: PayMethod; onSave: (p: Partial<PayMethod>) => Promise<void>; onCancel: () => void }) {
  const [label, setLabel] = useState(method.label);
  const [details, setDetails] = useState(method.details);
  const [instructions, setInstructions] = useState(method.instructions);
  const [enabled, setEnabled] = useState(method.enabled !== false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave({ label: label.trim(), details: details.trim(), instructions: instructions.trim(), enabled });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
      {error && <p className="notice error">{error}</p>}
      <label>اسم الطريقة<input required value={label} onChange={(e) => setLabel(e.target.value)} /></label>
      <label>بيانات التحويل<input required dir="ltr" className="font-mono" value={details} onChange={(e) => setDetails(e.target.value)} placeholder="01001234567" /></label>
      <label>تعليمات للعميل<input value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="حوّل ثم أرسل رقم العملية" /></label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ width: 'auto' }} />
        مفعّلة — تظهر للعملاء في صفحة الاشتراك
      </label>
      <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
        <button className="button primary" disabled={busy} style={{ flex: 1 }}>{busy ? '…' : 'حفظ التعديلات'}</button>
        <button type="button" className="button secondary" onClick={onCancel}>إلغاء</button>
      </div>
    </form>
  );
}

export function AdminPlansPage({ client }: { client: Client }) {
  const [rows, setRows] = useState<AdminPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdminPlan | 'new' | null>(null);
  const reload = () => client.adminPlans().then(setRows).catch((e) => setError((e as Error).message));
  useEffect(() => void reload(), [client]);

  const act = (fn: () => Promise<unknown>) => fn().then(reload).catch((e) => alert((e as Error).message));

  return (
    <Page title="الباقات والأسعار" sub="تحكم في الباقات المعروضة للعملاء — التعديل يطبَّق فوراً على الاشتراكات الجديدة">
      {error && <p className="notice error">{error}</p>}
      <div className="panel">
        <div className="panel-heading">
          <div><h2>الباقات</h2><p>الباقات المعطّلة تختفي من صفحة الاشتراك لكن المشتركين الحاليين لا يتأثرون</p></div>
          <button className="button primary" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> باقة جديدة</button>
        </div>
        {!rows ? <div className="skeleton" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>الباقة</th><th>المعرف</th><th>السعر/شهر</th><th>الأجهزة</th><th>الرسائل/يوم</th><th>الظهور</th><th>إجراءات</th></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.key} style={!p.enabled ? { opacity: 0.5 } : undefined}>
                    <td style={{ fontWeight: 500 }}>{p.name}{p.internal && <small className="muted"> (داخلية)</small>}</td>
                    <td dir="ltr" className="font-mono"><small>{p.key}</small></td>
                    <td><b>{number(p.egp)} ج.م</b></td>
                    <td>{p.sessions}</td>
                    <td>{p.dailyMessages == null ? 'بلا حدود' : number(p.dailyMessages)}</td>
                    <td>{p.internal ? <span className="badge neutral">مخفية</span> : p.enabled ? <span className="badge success">ظاهرة</span> : <span className="badge neutral">معطّلة</span>}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="button secondary" onClick={() => setEditing(p)}>تعديل</button>
                        {!p.internal && (
                          <button className="button secondary" onClick={() => act(() => client.adminUpdatePlan(p.key, { enabled: !p.enabled }))}>
                            {p.enabled ? 'إخفاء' : 'إظهار'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {editing && (
        <Modal title={editing === 'new' ? 'باقة جديدة' : `تعديل «${editing.name}»`} onClose={() => setEditing(null)}>
          <PlanEditForm
            plan={editing === 'new' ? null : editing}
            onSave={async (key, patch) => {
              if (editing === 'new') await client.adminCreatePlan({ key, ...patch });
              else await client.adminUpdatePlan(editing.key, patch);
              setEditing(null);
              await reload();
            }}
            onCancel={() => setEditing(null)}
          />
        </Modal>
      )}
    </Page>
  );
}

function PlanEditForm({ plan, onSave, onCancel }: { plan: AdminPlan | null; onSave: (key: string, p: Omit<AdminPlan, 'key'>) => Promise<void>; onCancel: () => void }) {
  const [key, setKey] = useState(plan?.key ?? '');
  const [name, setName] = useState(plan?.name ?? '');
  const [egp, setEgp] = useState(String(plan?.egp ?? ''));
  const [sessions, setSessions] = useState(String(plan?.sessions ?? 1));
  const [dailyMessages, setDailyMessages] = useState(plan?.dailyMessages == null ? '' : String(plan.dailyMessages));
  const [internal, setInternal] = useState(plan?.internal ?? false);
  const [enabled, setEnabled] = useState(plan?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave(key.trim().toLowerCase(), {
        name: name.trim(),
        egp: Number(egp) || 0,
        sessions: Number(sessions) || 1,
        dailyMessages: dailyMessages.trim() === '' ? null : Number(dailyMessages),
        internal,
        enabled,
        sortOrder: plan?.sortOrder ?? 50,
      });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
      {error && <p className="notice error">{error}</p>}
      {!plan && <label>المعرف (إنجليزي، لا يتغير لاحقاً)<input required dir="ltr" className="font-mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder="enterprise" /></label>}
      <label>اسم الباقة<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Enterprise" /></label>
      <label>السعر الشهري (ج.م)<input required dir="ltr" type="number" min="0" value={egp} onChange={(e) => setEgp(e.target.value)} placeholder="3000" /></label>
      <label>عدد الأجهزة/الأرقام<input required dir="ltr" type="number" min="1" value={sessions} onChange={(e) => setSessions(e.target.value)} /></label>
      <label>حد الرسائل اليومي — اتركه فارغاً لبلا حدود<input dir="ltr" type="number" min="1" value={dailyMessages} onChange={(e) => setDailyMessages(e.target.value)} placeholder="غير محدود" /></label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ width: 'auto' }} />
        ظاهرة — يمكن للعملاء الاشتراك فيها
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} style={{ width: 'auto' }} />
        داخلية — مخفية عن العملاء (لحسابات الشركة)
      </label>
      <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
        <button className="button primary" disabled={busy} style={{ flex: 1 }}>{busy ? '…' : plan ? 'حفظ التعديلات' : 'إنشاء الباقة'}</button>
        <button type="button" className="button secondary" onClick={onCancel}>إلغاء</button>
      </div>
    </form>
  );
}

export function AdminPaymentsPage({ client }: { client: Client }) {
  const [status, setStatus] = useState('pending');
  const [rows, setRows] = useState<AdminPayment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planRows, setPlanRows] = useState<AdminPlan[]>([]);
  const reload = () => client.adminPayments(status).then(setRows).catch((e) => setError((e as Error).message));
  useEffect(() => {
    void reload();
    void client.adminPlans().then(setPlanRows).catch(() => {});
  }, [client, status]);
  const planName = (id: string) => planRows.find((p) => p.key === id)?.name ?? planLabel[id] ?? id;

  async function act(id: string, approve: boolean) {
    const note = approve ? undefined : prompt('سبب الرفض (يظهر للعميل):') ?? undefined;
    if (!approve && note === undefined) return;
    try {
      await (approve ? client.adminApprovePayment(id) : client.adminRejectPayment(id, note));
      await reload();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  return (
    <Page title="طلبات الدفع" sub="راجع التحويلات وفعّل الباقات — الموافقة تفعّل الباقة فوراً">
      <div className="panel">
        <div className="table-controls">
          <label>الحالة
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="pending">قيد المراجعة</option>
              <option value="approved">مقبولة</option>
              <option value="rejected">مرفوضة</option>
              <option value="all">الكل</option>
            </select>
          </label>
          <button className="icon-button" onClick={reload} title="تحديث"><Icon name="refresh" size={17} /></button>
        </div>
        {error && <p className="notice error">{error}</p>}
        {!rows ? <div className="skeleton" /> : !rows.length ? (
          <Empty title="لا توجد طلبات" icon="card">طلبات الدفع الجديدة من العملاء تظهر هنا.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>التاريخ</th><th>العميل</th><th>الباقة</th><th>المبلغ</th><th>الطريقة</th><th>المرجع</th><th>الحالة</th><th>إجراءات</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><small>{date(r.createdAt)}</small></td>
                    <td>{r.workspaceName}<small dir="ltr" className="font-mono">{r.email}</small></td>
                    <td>{planName(r.planId)} × {r.months}</td>
                    <td><b>{number(r.amountEgp)} ج.م</b></td>
                    <td>{r.method}</td>
                    <td dir="ltr" className="font-mono"><small>{r.reference ?? '—'}</small></td>
                    <td>
                      <span className={`badge ${r.status === 'approved' ? 'success' : r.status === 'rejected' ? 'danger' : 'warning'}`} title={r.adminNote ?? ''}>
                        {r.status === 'pending' ? 'قيد المراجعة' : r.status === 'approved' ? 'مقبول' : 'مرفوض'}
                      </span>
                    </td>
                    <td>
                      {r.status === 'pending' && (
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button className="button primary" onClick={() => act(r.id, true)}>موافقة وتفعيل</button>
                          <button className="button danger" onClick={() => act(r.id, false)}>رفض</button>
                        </div>
                      )}
                      {r.status !== 'pending' && r.reviewedBy && <small className="muted">{r.reviewedBy}</small>}
                    </td>
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
