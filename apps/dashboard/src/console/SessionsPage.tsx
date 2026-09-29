import { useEffect, useState } from 'react';
import type { Client, Session } from '../api';
import { date, Empty, Icon } from '../ui';
import { statusLabel, statusTone } from '../status';
import { SessionPanel } from '../SessionPanel';
import { Page } from './pages';

export function SessionsPage({ client, sessionId, onNavigate }: { client: Client; sessionId: string | null; onNavigate: (id: string | null) => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [name, setName] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setSessions(await client.listSessions());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const s = await client.createSession(name.trim());
      setNewKey(s.apiKey);
      setName('');
      await refresh();
      onNavigate(s.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const current = sessions.find((s) => s.id === sessionId) ?? null;

  if (current) {
    return (
      <Page
        title={current.name}
        sub="إدارة الجلسة والربط"
        action={<button className="button secondary" onClick={() => onNavigate(null)}><Icon name="arrow" size={16} /> كل الجلسات</button>}
      >
        {error && <p className="notice error" onClick={() => setError(null)}>{error}</p>}
        <SessionPanel key={current.id} client={client} session={current} onChanged={refresh} onError={setError} />
      </Page>
    );
  }

  return (
    <Page title="الجلسات" sub="أرقام واتساب المربوطة بحسابك — كل جلسة = رقم واحد">
      {newKey && (
        <div className="notice success">
          مفتاح API للجلسة الجديدة — يُعرض مرة واحدة فقط.
          <code dir="ltr">{newKey}</code>
          <button className="button secondary" style={{ marginTop: 10 }} onClick={() => navigator.clipboard.writeText(newKey)}>نسخ</button>
        </div>
      )}
      {error && <p className="notice error" onClick={() => setError(null)}>{error}</p>}
      <div className="panel" style={{ marginBottom: 22 }}>
        <form className="table-controls" onSubmit={create}>
          <label>جلسة جديدة<input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: خدمة العملاء" /></label>
          <button className="button primary" disabled={busy || !name.trim()}><Icon name="plus" size={16} /> {busy ? '…' : 'إنشاء جلسة'}</button>
        </form>
      </div>
      {loading ? <div className="skeleton" /> : !sessions.length ? (
        <div className="panel"><Empty title="لا توجد جلسات بعد" icon="phone">أنشئ أول جلسة ثم اربطها بمسح رمز QR من واتساب.</Empty></div>
      ) : (
        <div className="session-grid">
          {sessions.map((s) => (
            <button key={s.id} className="panel session-card" style={{ textAlign: 'right', cursor: 'pointer' }} onClick={() => onNavigate(s.id)}>
              <div className="row-between">
                <div>
                  <h3>{s.name}</h3>
                  <p dir="ltr" className="font-mono" style={{ textAlign: 'right' }}>{s.phone ?? 'غير مربوط'}</p>
                </div>
                <span className={`badge ${statusTone[s.status]}`}><span className="status-pill"><i />{statusLabel[s.status]}</span></span>
              </div>
              <small className="muted">آخر ظهور: {date(s.lastSeenAt)}</small>
            </button>
          ))}
        </div>
      )}
    </Page>
  );
}
