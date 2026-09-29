export const BRAND = 'wa-platform';
export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? (import.meta.env.DEV ? 'https://api.example.com' : typeof window !== 'undefined' ? window.location.origin : '');

export const nav = [
  { href: '#features', label: 'المزايا' },
  { href: '#how', label: 'كيف تعمل' },
  { href: '#pricing', label: 'الأسعار' },
  { href: '#faq', label: 'الأسئلة الشائعة' },
];

export const codeSamples: { id: string; label: string; code: string }[] = [
  {
    id: 'curl',
    label: 'cURL',
    code: `curl -X POST ${API_BASE}/api/send-message \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"to": "+201012345678", "text": "أهلاً من ${BRAND}!"}'`,
  },
  {
    id: 'node',
    label: 'Node.js',
    code: `const res = await fetch('${API_BASE}/api/send-message', {
  method: 'POST',
  headers: {
    Authorization: \`Bearer \${process.env.API_KEY}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ to: '+201012345678', text: 'أهلاً من ${BRAND}!' }),
});

const { data } = await res.json(); // { id, status: 'pending' }`,
  },
  {
    id: 'python',
    label: 'Python',
    code: `import os, requests

res = requests.post(
    "${API_BASE}/api/send-message",
    headers={"Authorization": f"Bearer {os.environ['API_KEY']}"},
    json={"to": "+201012345678", "text": "أهلاً من ${BRAND}!"},
)
print(res.json()["data"])  # {'id': ..., 'status': 'pending'}`,
  },
  {
    id: 'php',
    label: 'PHP',
    code: `<?php
$res = (new GuzzleHttp\\Client())->post('${API_BASE}/api/send-message', [
    'headers' => ['Authorization' => 'Bearer ' . getenv('API_KEY')],
    'json'    => ['to' => '+201012345678', 'text' => 'أهلاً من ${BRAND}!'],
]);

echo $res->getBody();`,
  },
];

export const sdks = [
  { name: 'Node.js', note: 'أنواع TypeScript كاملة، مولّد من OpenAPI' },
  { name: 'Python', note: 'متزامن وغير متزامن، مولّد من OpenAPI' },
  { name: 'Laravel', note: 'Facade وقنوات إشعارات جاهزة' },
  { name: 'n8n', note: 'عقدة لسير العمل بلا كود' },
];

export const steps = [
  { title: 'اربط رقمك', body: 'امسح رمز QR من تطبيق واتساب أو استخدم رمز الربط — ثوانٍ وتصبح الجلسة متصلة.' },
  { title: 'خذ مفتاح API', body: 'كل جلسة لها مفتاح خاص يظهر مرة واحدة. أرسل أول رسالة بطلب HTTP واحد.' },
  { title: 'أرسل واستقبل', body: 'تتبّع حالة التسليم والقراءة لحظياً، واستقبل الرسائل الواردة عبر Webhooks موقّعة.' },
];

export const messageTypes = [
  { icon: 'Aa', title: 'نص', body: 'رسائل نصية مع روابط ومعاينات.' },
  { icon: '▣', title: 'صورة وفيديو', body: 'بتعليق اختياري من أي رابط عام.' },
  { icon: '▤', title: 'مستندات', body: 'PDF وجداول وأي ملف حتى 64 MB.' },
  { icon: '◉', title: 'صوت', body: 'مقاطع صوتية ورسائل صوتية (PTT).' },
  { icon: '☺', title: 'جهة اتصال', body: 'بطاقات vCard قابلة للحفظ مباشرة.' },
  { icon: '⌖', title: 'موقع', body: 'إحداثيات مع اسم وعنوان المكان.' },
];

export const useCases = [
  { title: 'أتمتة خدمة العملاء', body: 'ردود فورية على الأسئلة المتكررة وتحويل الحالات المعقدة لفريقك.' },
  { title: 'تنبيهات لحظية', body: 'تأكيد الطلبات، تذكير المواعيد، ورموز التحقق — تصل حيث يقرأ عميلك فعلاً.' },
  { title: 'مساعدون بالذكاء الاصطناعي', body: 'اربط نموذج لغة بالـ Webhooks ودَعه يجيب على مدار الساعة.' },
  { title: 'متابعة العملاء المحتملين', body: 'رسائل متابعة مخصّصة تحوّل الاهتمام إلى صفقة.' },
  { title: 'التجارة الإلكترونية', body: 'تحديثات الشحن والتسليم تلقائياً من متجرك إلى واتساب العميل.' },
  { title: 'تكامل مع أنظمتك', body: 'زامن المحادثات مع CRM ولوحات الدعم والتحليلات لديك.' },
];

/** Fixed EGP list prices (≈50 EGP/USD, rounded). Review when the exchange rate moves materially. */
export const plans = [
  { name: 'Basic', tagline: 'للأفراد والمشاريع الصغيرة', egp: 300, usd: 6, sessions: 1, highlight: false, features: ['60 طلب/دقيقة', 'احتفاظ بالسجل 30 يوماً', 'دعم عبر البريد'] },
  { name: 'Pro', tagline: 'للأعمال النامية', egp: 750, usd: 15, sessions: 3, highlight: true, features: ['120 طلب/دقيقة', 'احتفاظ بالسجل 60 يوماً', 'دعم أولوية'] },
  { name: 'Plus', tagline: 'للفرق المتوسعة', egp: 1500, usd: 30, sessions: 6, highlight: false, features: ['Proxy مخصّص لكل جلسة', 'احتفاظ بالسجل 60 يوماً', 'دعم أولوية'] },
  { name: 'Business', tagline: 'للشركات الكبيرة', egp: 2250, usd: 45, sessions: 10, highlight: false, features: ['احتفاظ بالسجل 90 يوماً', 'SLA 99.5%', 'مدير حساب مخصّص'] },
];

export const trial = { days: 3, dailyMessages: 50 };

export const includedInAll = [
  'رسائل غير محدودة بلا رسوم لكل رسالة',
  'جهات اتصال غير محدودة',
  'نص، صور، فيديو، صوت، مستندات، مواقع',
  'API كامل + Webhooks لحظية',
  'إرسال لأفراد ومجموعات',
  'تشفير بيانات الجلسة AES-256',
];

export const egp = (n: number) => n.toLocaleString('ar-EG');

export const faqs = [
  { q: 'كيف أنشئ أول جلسة واتساب؟', a: 'سجّل حساباً، اضغط «جلسة جديدة» في اللوحة، ثم امسح رمز QR من واتساب ← الأجهزة المرتبطة. تحصل فوراً على مفتاح API خاص بالجلسة.' },
  { q: 'هل سيعرف المستلم أنني أستخدم منصة وسيطة؟', a: 'لا. الرسائل تُرسل من رقمك مباشرة كما لو أرسلتها من هاتفك، وتظهر في محادثاتك المعتادة.' },
  { q: 'هل يمكنني ربط أكثر من رقم؟', a: 'نعم، حسب خطتك: من رقم واحد في Basic حتى 10 أرقام في Business، ولكل رقم مفتاحه وإعداداته.' },
  { q: 'ماذا يحدث إذا سجّلت الخروج من هاتفي؟', a: 'تتوقف الجلسة وتصلك حالة session.status = logged_out عبر الـ Webhook. أعد الربط بمسح QR جديد.' },
  { q: 'هل ربط رقمي آمن؟', a: 'بيانات الجلسة مشفّرة بـ AES-256-GCM، والمفاتيح مخزّنة كبصمات SHA-256 فقط، وكل الاتصالات عبر TLS.' },
  { q: 'هل يمكن أن يُحظر رقمي؟', a: 'الخدمة غير تابعة لـ Meta، لذلك يبقى الحظر ممكناً مع الإرسال المزعج. نطبّق تأخيراً بشرياً وتسخيناً للأرقام الجديدة للحدّ من ذلك، لكن لا أحد يستطيع ضمان «لا حظر».' },
  { q: 'ما طرق الدفع المتاحة؟', a: 'الأسعار بالجنيه المصري، والدفع عبر Paymob (فيزا، ميزة، محافظ إلكترونية وفوري). وللعملاء خارج مصر بالبطاقات الدولية عبر Stripe بالدولار.' },
  { q: 'هل أستقبل الرسائل لحظياً؟', a: 'نعم. سجّل رابط Webhook واشترك في الأحداث مثل messages.received و messages.update، وكل طلب موقّع بـ HMAC.' },
];
