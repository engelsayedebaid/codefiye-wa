import { useState } from 'react';
import { API_PUBLIC } from '../api';
import { Icon } from '../ui';
import { Page } from './pages';

const BASE = API_PUBLIC;

const samples: Record<'cURL' | 'Node.js' | 'Python' | 'PHP', string> = {
  cURL: `curl -X POST ${BASE}/api/send-message \\
  -H "Authorization: Bearer wa_pat_XXXX" \\
  -H "X-Session-Id: SESSION_ID" \\
  -H "Content-Type: application/json" \\
  -d '{"to": "2010XXXXXXXX", "text": "أهلاً من wa-platform"}'`,
  'Node.js': `const res = await fetch("${BASE}/api/send-message", {
  method: "POST",
  headers: {
    Authorization: "Bearer wa_pat_XXXX",
    "X-Session-Id": "SESSION_ID",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ to: "2010XXXXXXXX", text: "أهلاً" }),
});
const { data } = await res.json();`,
  Python: `import requests

res = requests.post(
    "${BASE}/api/send-message",
    headers={
        "Authorization": "Bearer wa_pat_XXXX",
        "X-Session-Id": "SESSION_ID",
    },
    json={"to": "2010XXXXXXXX", "text": "أهلاً"},
)
print(res.json())`,
  PHP: `$ch = curl_init("${BASE}/api/send-message");
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => [
    "Authorization: Bearer wa_pat_XXXX",
    "X-Session-Id: SESSION_ID",
    "Content-Type: application/json",
  ],
  CURLOPT_POSTFIELDS => json_encode([
    "to" => "2010XXXXXXXX",
    "text" => "أهلاً",
  ]),
]);
$response = json_decode(curl_exec($ch), true);`,
};

const endpoints: { method: string; path: string; desc: string; body?: string }[] = [
  { method: 'POST', path: '/api/send-message', desc: 'إرسال رسالة (نص، صورة، فيديو، صوت، ملف، موقع، جهة اتصال، ستيكر)', body: '{ to, text?, imageUrl?, videoUrl?, audioUrl?, documentUrl?, stickerUrl?, location?, contact? }' },
  { method: 'GET', path: '/api/messages/:id', desc: 'حالة رسالة أرسلتها (pending → sent → delivered → read)' },
  { method: 'GET', path: '/api/on-whatsapp/:number', desc: 'التحقق إن رقماً مسجّل على واتساب' },
  { method: 'GET', path: '/api/status', desc: 'حالة الجلسة الحالية' },
  { method: 'GET', path: '/api/whatsapp-sessions', desc: 'قائمة جلساتك (PAT فقط)' },
  { method: 'POST', path: '/api/whatsapp-sessions', desc: 'إنشاء جلسة جديدة (PAT فقط)', body: '{ name, phone? }' },
  { method: 'POST', path: '/api/whatsapp-sessions/:id/connect', desc: 'بدء الاتصال وتوليد QR' },
  { method: 'GET', path: '/api/whatsapp-sessions/:id/qrcode', desc: 'الحصول على رمز QR الحالي (PNG data-url)' },
  { method: 'POST', path: '/api/whatsapp-sessions/:id/pairing-code', desc: 'ربط برمز بدل QR', body: '{ phone }' },
  { method: 'POST', path: '/api/whatsapp-sessions/:id/disconnect', desc: 'فصل مؤقت (يبقى مربوطاً)' },
  { method: 'POST', path: '/api/whatsapp-sessions/:id/logout', desc: 'إلغاء الربط نهائياً ومسح الاعتماد' },
  { method: 'DELETE', path: '/api/whatsapp-sessions/:id', desc: 'حذف الجلسة' },
  { method: 'GET', path: '/api/whatsapp-sessions/:id/events', desc: 'أحداث حية SSE: session.status، qrcode.updated، messages.*' },
];

const steps = [
  { n: 1, title: 'اربط رقم واتساب', body: 'من صفحة «الجلسات» أنشئ جلسة ثم اضغط «ربط / اتصال» وامسح الـ QR من واتساب على الموبايل.', page: 'sessions' },
  { n: 2, title: 'أنشئ مفتاح API', body: 'من «مفاتيح API» أنشئ مفتاحاً عاماً (PAT) أو مفتاحاً مخصصاً لجلسة واحدة. المفتاح يظهر مرة واحدة — انسخه.', page: 'keys' },
  { n: 3, title: 'أرسل أول رسالة', body: 'استخدم أي مثال من الأمثلة بالأسفل. بدّل wa_pat_XXXX بمفتاحك وSESSION_ID بمعرّف الجلسة من صفحة الجلسات.', page: null },
];

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="button secondary"
      style={{ padding: '6px 12px', minHeight: 32, fontSize: 11 }}
      onClick={() => navigator.clipboard.writeText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1500)))}
    >
      {done ? 'تم النسخ ✓' : 'نسخ'}
    </button>
  );
}

export function ApiDocsPage({ go }: { go: (p: string) => void }) {
  const [tab, setTab] = useState<keyof typeof samples>('cURL');
  return (
    <Page
      title="التكامل والـ API"
      sub="كل ما تحتاجه لربط تطبيقك — بثلاث خطوات"
      action={
        <a className="button secondary" href={`${BASE}/docs`} target="_blank" rel="noreferrer">
          <Icon name="code" size={16} /> Swagger التفاعلي
        </a>
      }
    >
      <div className="panel" style={{ marginBottom: 22 }}>
        <div className="panel-heading"><div><h2>عنوان الـ API</h2><p>كل الطلبات تبدأ منه</p></div></div>
        <div className="plan-sessions" style={{ justifyContent: 'space-between' }}>
          <code dir="ltr" className="font-mono" style={{ fontSize: 14 }}>{BASE}</code>
          <Copy text={BASE} />
        </div>
      </div>

      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 22 }}>
        {steps.map((s) => (
          <div key={s.n} className="stat-card">
            <div>الخطوة {s.n}<span className="icon-tile"><Icon name={s.n === 1 ? 'phone' : s.n === 2 ? 'key' : 'chat'} size={18} /></span></div>
            <h3 style={{ fontSize: 15, fontWeight: 600, marginTop: 10 }}>{s.title}</h3>
            <small style={{ lineHeight: 1.9, display: 'block', marginTop: 8 }}>{s.body}</small>
            {s.page && <button className="button secondary" style={{ marginTop: 14, fontSize: 11, minHeight: 34 }} onClick={() => go(s.page!)}>افتح الصفحة ←</button>}
          </div>
        ))}
      </div>

      <div className="panel" style={{ marginBottom: 22 }}>
        <div className="panel-heading"><div><h2>إرسال رسالة — أمثلة جاهزة</h2><p>بدّل المفتاح ومعرّف الجلسة بالخاصين بك</p></div></div>
        <div className="code-window">
          <div className="code-tabs" dir="ltr">
            {(Object.keys(samples) as (keyof typeof samples)[]).map((t) => (
              <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>
            ))}
            <span style={{ marginInlineStart: 'auto' }}><Copy text={samples[tab]} /></span>
          </div>
          <pre dir="ltr">{samples[tab]}</pre>
          <div className="code-footer"><span>POST /api/send-message</span><span>المعرف Idempotency-Key في الهيدر يمنع تكرار الرسالة</span></div>
        </div>
        <div className="notice" style={{ marginTop: 18, marginBottom: 0 }}>
          الرد دائماً بالشكل <code dir="ltr">{'{ "success": true, "data": {...} }'}</code> وعند الخطأ <code dir="ltr">{'{ "success": false, "message": "..." }'}</code>
        </div>
      </div>

      <div className="panel">
        <div className="panel-heading"><div><h2>مرجع الـ Endpoints</h2><p>«PAT فقط» = تحتاج مفتاح مساحة عمل وليس مفتاح جلسة</p></div></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Method</th><th>المسار</th><th>الوظيفة</th></tr></thead>
            <tbody>
              {endpoints.map((e) => (
                <tr key={e.method + e.path}>
                  <td><span className={`badge ${e.method === 'GET' ? 'neutral' : e.method === 'DELETE' ? 'danger' : 'success'}`} dir="ltr">{e.method}</span></td>
                  <td dir="ltr" className="font-mono" style={{ fontSize: 11 }}>{e.path}{e.body && <small>{e.body}</small>}</td>
                  <td style={{ whiteSpace: 'normal' }}>{e.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Page>
  );
}
