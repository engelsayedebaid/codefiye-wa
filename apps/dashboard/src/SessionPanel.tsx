import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import type { Client, Session, SessionStatus } from './api';
import { statusLabel, statusTone } from './status';

type Props = { client: Client; session: Session; onChanged: () => void; onError: (m: string) => void };
type LogLine = { t: number; event: string; text: string };

export function SessionPanel({ client, session, onChanged, onError }: Props) {
  const [status, setStatus] = useState<SessionStatus>(session.status);
  const [phone, setPhone] = useState(session.phone);
  const [qr, setQr] = useState<string | null>(null);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [pairPhone, setPairPhone] = useState('');
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const push = (event: string, text: string) => setLog((l) => [{ t: Date.now(), event, text }, ...l].slice(0, 40));
    client.events(
      session.id,
      (event, data) => {
        if (event === 'session.status') {
          setStatus(data.status);
          if (data.phone) setPhone(data.phone);
          if (data.status !== 'qr') setQr(null);
          if (data.status === 'connected') setPairCode(null);
          push(event, `${data.status}${data.reason ? ` · ${data.reason}` : ''}`);
          onChanged();
        } else if (event === 'qrcode.updated') {
          void QRCode.toDataURL(data.qr, { margin: 1, width: 300, color: { dark: '#1d3a2c', light: '#ffffff' } }).then(setQr);
        } else if (event === 'messages.received') {
          push(event, `${data.from.split('@')[0]}: ${data.text ?? `[${data.type}]`}`);
        } else if (event === 'messages.update') {
          push(event, `${data.id.slice(0, 10)}… → ${data.status}`);
        }
      },
      ctrl.signal,
    );
    return () => ctrl.abort();
  }, [client, session.id, onChanged]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    try {
      await fn();
      onChanged();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const linked = status === 'connected';

  return (
    <div className="session-detail">
      <div className="panel">
        <div className="row-between">
          <div>
            <div className="row-between" style={{ justifyContent: 'start', gap: 12 }}>
              <h2 style={{ fontSize: 20, fontWeight: 600 }}>{session.name}</h2>
              <span className={`badge ${statusTone[status]}`}>
                <span className="status-pill"><i />{statusLabel[status]}</span>
              </span>
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 10, display: 'flex', gap: 18, flexWrap: 'wrap' }}>
              <span dir="ltr" className="font-mono">{phone ?? 'لا يوجد رقم'}</span>
              <span dir="ltr" className="font-mono" style={{ fontSize: 11 }}>{session.id}</span>
            </p>
          </div>
          <div className="topbar-actions">
            {!linked && (
              <button disabled={!!busy} onClick={() => run('connect', () => client.connect(session.id))} className="button primary">
                {busy === 'connect' ? '…' : 'ربط / اتصال'}
              </button>
            )}
            {linked && (
              <button disabled={!!busy} onClick={() => run('disconnect', () => client.disconnect(session.id))} className="button secondary">
                فصل مؤقت
              </button>
            )}
            <button
              disabled={!!busy}
              onClick={() => confirm('سيتم إلغاء ربط الجهاز ومسح بيانات الاعتماد. متابعة؟') && run('logout', () => client.logout(session.id))}
              className="button secondary"
            >
              تسجيل خروج
            </button>
            <button
              disabled={!!busy}
              onClick={() => confirm('حذف الجلسة نهائياً؟') && run('delete', () => client.remove(session.id))}
              className="button danger"
            >
              حذف
            </button>
          </div>
        </div>
      </div>

      <div className="two-columns">
        <div className="panel">
          <div className="panel-heading"><h2>الربط بالرقم</h2></div>
          {linked ? (
            <div className="qr-box" style={{ borderStyle: 'solid', background: '#edf8ef', color: '#386c3f' }}>
              <div>
                <div style={{ fontSize: 34 }}>✓</div>
                <div style={{ marginTop: 8, fontWeight: 500 }}>الجهاز مربوط</div>
              </div>
            </div>
          ) : qr ? (
            <div className="qr-box">
              <img src={qr} alt="QR" style={{ width: 260 }} />
            </div>
          ) : (
            <div className="qr-box">{status === 'connecting' ? 'جارٍ تجهيز رمز QR…' : 'اضغط «ربط / اتصال» لعرض رمز QR'}</div>
          )}
          {!linked && (
            <form
              className="row-between"
              style={{ marginTop: 18 }}
              onSubmit={(e) => {
                e.preventDefault();
                void run('pair', async () => setPairCode((await client.pairingCode(session.id, pairPhone)).code));
              }}
            >
              <input dir="ltr" className="font-mono" style={{ flex: 1 }} placeholder="+2010XXXXXXXX" value={pairPhone} onChange={(e) => setPairPhone(e.target.value)} />
              <button disabled={!!busy || !pairPhone} className="button secondary">رمز الربط</button>
            </form>
          )}
          {pairCode && (
            <div dir="ltr" className="font-mono" style={{ marginTop: 16, textAlign: 'center', fontSize: 28, letterSpacing: '0.35em', color: '#98621b' }}>
              {pairCode.replace(/(.{4})/, '$1-')}
            </div>
          )}
        </div>

        <div className="panel" style={{ display: 'grid', alignContent: 'start' }}>
          <div className="panel-heading"><h2>إرسال تجريبي</h2></div>
          <form
            className="form-grid"
            style={{ maxWidth: 'none' }}
            onSubmit={(e) => {
              e.preventDefault();
              void run('send', async () => {
                const m = await client.sendText(session.id, to, text);
                setLog((l) => [{ t: Date.now(), event: 'queued', text: `${m.id.slice(0, 8)} → ${m.status}` }, ...l]);
                setText('');
              });
            }}
          >
            <input dir="ltr" className="font-mono" placeholder="+2010XXXXXXXX" value={to} onChange={(e) => setTo(e.target.value)} />
            <textarea rows={3} placeholder="نص الرسالة" value={text} onChange={(e) => setText(e.target.value)} />
            <button disabled={!linked || !!busy || !to || !text} className="button primary">
              {busy === 'send' ? 'جارٍ الإرسال…' : 'إرسال'}
            </button>
          </form>

          <div className="panel-heading" style={{ marginTop: 28 }}><h2>الأحداث الحية</h2></div>
          <ol dir="ltr" className="event-log" style={{ listStyle: 'none' }}>
            {log.map((l, i) => (
              <li key={l.t + ':' + i} style={{ display: 'flex', gap: 12 }}>
                <span className="muted">{new Date(l.t).toLocaleTimeString('en-GB')}</span>
                <span style={{ color: '#28744f' }}>{l.event}</span>
                <span className="muted" style={{ overflowWrap: 'anywhere' }}>{l.text}</span>
              </li>
            ))}
            {log.length === 0 && <li className="muted">waiting for events…</li>}
          </ol>
        </div>
      </div>
    </div>
  );
}
