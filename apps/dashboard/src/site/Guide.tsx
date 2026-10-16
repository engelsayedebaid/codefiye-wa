import { DEFAULT_OTP_TEMPLATES } from '@wa/shared';
import { ArrowLeft, ArrowUpRight, BookOpen, Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { sessionHint } from '../api';
import { BRAND } from '../brand';
import { useI18n } from '../i18n';
import { Link } from '../router';
import { buttonClass, CopyField, cx, flip, LangSwitch, Logo, LogoMark, ThemeSwitch } from '../ui';

const origin = typeof window !== 'undefined' ? window.location.origin : 'https://api.example.com';

type CodeLang = 'nodejs' | 'php' | 'python' | 'curl' | 'flutter';

const CODE_LANGS: { id: CodeLang; label: string }[] = [
  { id: 'nodejs', label: 'Node.js' },
  { id: 'php', label: 'PHP / Laravel' },
  { id: 'python', label: 'Python' },
  { id: 'flutter', label: 'Flutter' },
  { id: 'curl', label: 'cURL' },
];

function CodeBlock({ title, code }: { title?: string; code: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div dir="ltr" className="my-4 overflow-hidden rounded-lg border border-line bg-[#111312] text-[#e5e7eb]">
      <div className="flex items-center justify-between border-b border-white/10 bg-white/[0.03] px-4 py-2 text-xs text-white/60">
        <span className="font-mono">{title ?? 'Code'}</span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs text-white/75 transition hover:bg-white/10 hover:text-white"
        >
          {copied ? <Check className="size-3.5 text-brand" /> : <Copy className="size-3.5" />}
          <span>{copied ? t.guide.codeSection.copied : t.guide.codeSection.copy}</span>
        </button>
      </div>
      <pre className="code-scroll overflow-x-auto p-4 font-mono text-[13px] leading-6">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function getQuickCode(lang: CodeLang): string {
  switch (lang) {
    case 'curl':
      return `curl -X POST ${origin}/api/send-otp \\
  -H "Authorization: Bearer was_YOUR_SESSION_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "+201012345678",
    "lang": "ar",
    "length": 6
  }'`;

    case 'nodejs':
      return `const response = await fetch('${origin}/api/send-otp', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer was_YOUR_SESSION_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    to: '+201012345678',
    lang: 'ar',
    length: 6,
  }),
});

const result = await response.json();
console.log(result.data.code); // e.g. "482910"`;

    case 'php':
      return `<?php
$ch = curl_init('${origin}/api/send-otp');
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => [
        'Authorization: Bearer was_YOUR_SESSION_API_KEY',
        'Content-Type: application/json',
    ],
    CURLOPT_POSTFIELDS => json_encode([
        'to' => '+201012345678',
        'lang' => 'ar',
        'length' => 6,
    ]),
]);

$res = json_decode(curl_exec($ch), true);
$otpCode = $res['data']['code']; // e.g. "482910"`;

    case 'python':
      return `import requests

res = requests.post(
    "${origin}/api/send-otp",
    headers={"Authorization": "Bearer was_YOUR_SESSION_API_KEY"},
    json={
        "to": "+201012345678",
        "lang": "ar",
        "length": 6,
    },
)

data = res.json()["data"]
print("OTP Code:", data["code"])`;

    case 'flutter':
      return `import 'dart:convert';
import 'package:http/http.dart' as http;

final res = await http.post(
  Uri.parse('${origin}/api/send-otp'),
  headers: {
    'Authorization': 'Bearer was_YOUR_SESSION_API_KEY',
    'Content-Type': 'application/json',
  },
  body: jsonEncode({
    'to': '+201012345678',
    'lang': 'ar',
    'length': 6,
  }),
);

final data = jsonDecode(res.body)['data'];
print('OTP Code: \${data['code']}');`;
  }
}

function getFullBackendCode(lang: CodeLang): string {
  switch (lang) {
    case 'nodejs':
      return `import express from 'express';

const app = express();
app.use(express.json());

const WA_API_KEY = process.env.WA_API_KEY; // was_...
const otpStore = new Map(); // phone -> { code, expiresAt }

// Step A: Your website calls this route to send the OTP
app.post('/auth/send-otp', async (req, res) => {
  const { phone } = req.body; // "+201012345678"

  const waRes = await fetch('${origin}/api/send-otp', {
    method: 'POST',
    headers: {
      'Authorization': \`Bearer \${WA_API_KEY}\`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to: phone, lang: 'ar', length: 6 }),
  });

  const payload = await waRes.json();
  if (!waRes.ok || !payload.success) {
    return res.status(400).json({ error: payload.message });
  }

  // Save the returned code for 5 minutes
  otpStore.set(phone, {
    code: payload.data.code,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  res.json({ success: true });
});

// Step B: Your website calls this route when the user enters the code
app.post('/auth/verify-otp', (req, res) => {
  const { phone, code } = req.body;
  const saved = otpStore.get(phone);

  if (!saved || Date.now() > saved.expiresAt) {
    return res.status(400).json({ valid: false, error: 'Code expired' });
  }
  if (saved.code !== String(code).trim()) {
    return res.status(400).json({ valid: false, error: 'Invalid code' });
  }

  otpStore.delete(phone); // Single use
  res.json({ valid: true });
});`;

    case 'php':
      return `<?php
// Laravel Controller Example (routes/api.php -> OtpController)
namespace App\\Http\\Controllers;

use Illuminate\\Http\\Request;
use Illuminate\\Support\\Facades\\Cache;
use Illuminate\\Support\\Facades\\Http;

class OtpController extends Controller
{
    // Step A: Send OTP to user's WhatsApp
    public function sendOtp(Request $request)
    {
        $phone = $request->input('phone'); // "+201012345678"

        $res = Http::withToken(env('WA_API_KEY')) // was_...
            ->post('${origin}/api/send-otp', [
                'to'     => $phone,
                'lang'   => 'ar',
                'length' => 6,
            ]);

        if (! $res->successful()) {
            return response()->json(['error' => 'Failed to send OTP'], 400);
        }

        // Store the returned code in cache for 5 minutes
        $code = $res->json('data.code');
        Cache::put("otp:{$phone}", $code, now()->addMinutes(5));

        return response()->json(['success' => true]);
    }

    // Step B: Verify code entered by the user
    public function verifyOtp(Request $request)
    {
        $phone = $request->input('phone');
        $code  = $request->input('code');

        $saved = Cache::get("otp:{$phone}");
        if (! $saved || $saved !== $code) {
            return response()->json(['valid' => false, 'error' => 'Invalid or expired code'], 422);
        }

        Cache::forget("otp:{$phone}");
        return response()->json(['valid: true']);
    }
}`;

    case 'python':
      return `import os, time, requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()
WA_API_KEY = os.environ["WA_API_KEY"]  # was_...
otp_store = {}  # phone -> (code, expires_at)

class SendReq(BaseModel):
    phone: str

class VerifyReq(BaseModel):
    phone: str
    code: str

# Step A: Send OTP
@app.post("/auth/send-otp")
def send_otp(body: SendReq):
    res = requests.post(
        "${origin}/api/send-otp",
        headers={"Authorization": f"Bearer {WA_API_KEY}"},
        json={"to": body.phone, "lang": "ar", "length": 6},
    ).json()

    if not res.get("success"):
        raise HTTPException(400, res.get("message", "Send failed"))

    otp_store[body.phone] = (res["data"]["code"], time.time() + 300)
    return {"success": True}

# Step B: Verify OTP
@app.post("/auth/verify-otp")
def verify_otp(body: VerifyReq):
    saved = otp_store.get(body.phone)
    if not saved or time.time() > saved[1] or saved[0] != body.code.strip():
        raise HTTPException(400, "Invalid or expired code")

    otp_store.pop(body.phone, None)
    return {"valid": True}`;

    case 'flutter':
      return `import 'dart:convert';
import 'package:http/http.dart' as http;

// In your Flutter app, call the 2 routes on your backend server:
Future<bool> requestOtp(String phone) async {
  final res = await http.post(
    Uri.parse('https://your-website.com/api/auth/send-otp'),
    headers: {'Content-Type': 'application/json'},
    body: jsonEncode({'phone': phone}),
  );
  return res.statusCode == 200;
}

Future<bool> verifyOtp(String phone, String code) async {
  final res = await http.post(
    Uri.parse('https://your-website.com/api/auth/verify-otp'),
    headers: {'Content-Type': 'application/json'},
    body: jsonEncode({'phone': phone, 'code': code}),
  );
  return res.statusCode == 200;
}`;

    case 'curl':
      return `# Option 1: Let our platform generate a 6-digit code and return it to you
curl -X POST ${origin}/api/send-otp \\
  -H "Authorization: Bearer was_YOUR_SESSION_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"to": "+201012345678", "lang": "ar", "length": 6}'

# Option 2: Generate the code on your own server and pass it in "code"
curl -X POST ${origin}/api/send-otp \\
  -H "Authorization: Bearer was_YOUR_SESSION_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"to": "+201012345678", "lang": "ar", "code": "482910"}'`;
  }
}

export function GuidePage() {
  const { t, lang } = useI18n();
  const g = t.guide;
  const signedIn = sessionHint.get();
  const [codeLang, setCodeLang] = useState<CodeLang>('nodejs');
  const isAr = lang === 'ar';

  const sections = isAr
    ? [
        { id: 'overview', label: 'نظرة عامة' },
        { id: 'step-1', label: 'الخطوة 1: استخراج مفتاح API' },
        { id: 'step-2', label: 'الخطوة 2: إرسال رمز الـ OTP' },
        { id: 'step-3', label: 'الخطوة 3: التحقق من الرمز في موقعك' },
        { id: 'params', label: 'جدول الحقول (Parameters)' },
        { id: 'custom-template', label: 'تخصيص نص الرسالة' },
        { id: 'errors', label: 'أكواد الأخطاء الشائعة' },
      ]
    : [
        { id: 'overview', label: 'Overview' },
        { id: 'step-1', label: 'Step 1: Get your API key' },
        { id: 'step-2', label: 'Step 2: Send an OTP code' },
        { id: 'step-3', label: 'Step 3: Verify the code in your app' },
        { id: 'params', label: 'Request & Response fields' },
        { id: 'custom-template', label: 'Customize message text' },
        { id: 'errors', label: 'Error codes' },
      ];

  return (
    <div className="min-h-svh bg-bg text-ink">
      {/* Simple Documentation Top Bar */}
      <header className="sticky top-0 z-30 border-b border-line bg-bg/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/" aria-label={BRAND.name} className="shrink-0">
              <span className="sm:hidden">
                <LogoMark />
              </span>
              <span className="hidden sm:inline">
                <Logo />
              </span>
            </Link>
            {/* The page's own title says it below; the bar keeps room for the buttons on phones. */}
            <span className="hidden h-4 w-px bg-line md:block" />
            <span className="hidden items-center gap-1.5 text-sm font-medium text-muted md:flex">
              <BookOpen className="size-4" />
              <span>{ isAr ? 'التوثيق ودليل الربط' : 'Documentation' }</span>
            </span>
          </div>

          {/* Phones: icon-only buttons (names kept for screen readers). */}
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <a href="/docs" target="_blank" rel="noreferrer" aria-label="OpenAPI" className={buttonClass('outline', 'sm')}>
              <span className="hidden sm:inline">OpenAPI</span>
              <ArrowUpRight className={cx('size-3.5 text-muted', flip)} />
            </a>
            <ThemeSwitch />
            <LangSwitch />
            <Link href={signedIn ? '/dashboard' : '/login'} aria-label={signedIn ? g.backDashboard : t.landing.login} className={buttonClass('white', 'sm')}>
              <ArrowLeft className={cx('size-3.5', flip)} />
              <span className="hidden sm:inline">{signedIn ? g.backDashboard : t.landing.login}</span>
            </Link>
          </div>
        </div>
      </header>

      {/* Classic 2-Column Documentation Layout */}
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        {/* Sidebar Navigation */}
        <aside className="hidden lg:block">
          <nav aria-label={g.tocTitle} className="sticky top-22 space-y-1 border-e border-line pe-4 text-sm">
            <p className="mb-2 px-2.5 text-xs font-semibold text-muted uppercase">{g.tocTitle}</p>
            {sections.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="block rounded-md px-2.5 py-1.5 text-ink-2 transition-colors hover:bg-raised hover:text-ink"
              >
                {s.label}
              </a>
            ))}
          </nav>
        </aside>

        {/* Main Documentation Article */}
        <main className="min-w-0 max-w-3xl space-y-12 leading-relaxed">
          {/* Overview */}
          <section id="overview" className="scroll-mt-20 border-b border-line pb-8">
            <p className="text-xs font-semibold text-brand uppercase">{isAr ? 'دليل ربط المطورين' : 'Developer Guide'}</p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
              {isAr ? 'تفعيل خدمة رسائل التحقق (OTP) عبر واتساب' : ' WhatsApp OTP Integration Guide'}
            </h1>
            <p className="mt-3 text-base text-ink-2">{g.subtitle}</p>

            <div className="mt-6 rounded-lg border border-line bg-card p-4">
              <p className="mb-1.5 text-xs font-medium text-muted">
                {isAr ? 'رابط مسار إرسال الـ OTP (Endpoint URL):' : 'OTP Endpoint URL:'}
              </p>
              <CopyField value={`POST ${origin}/api/send-otp`} />
            </div>
          </section>

          {/* STEP 1 */}
          <section id="step-1" className="scroll-mt-20 space-y-5 border-b border-line pb-10">
            <h2 className="text-xl font-bold sm:text-2xl">
              {isAr ? 'الخطوة 1: كيف تحصل على مفتاح الـ API من المنصة' : 'Step 1: Get your API key from the dashboard'}
            </h2>
            <p className="text-sm text-ink-2">
              {isAr
                ? 'لإرسال رسائل من موقعك أو تطبيقك، تحتاج أولاً إلى ربط رقم واتساب واستخراج مفتاح الجلسة الخاص به:'
                : 'To send messages from your website or app, connect a WhatsApp number and copy its session key:'}
            </p>

            <ol className="space-y-4 text-sm">
              {g.getKey.steps.map((s, i) => (
                <li key={s.step} className="flex items-start gap-3.5 rounded-lg border border-line bg-card p-4">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink text-xs font-bold text-bg">
                    {i + 1}
                  </span>
                  <div className="space-y-1">
                    <h3 className="font-semibold text-ink">{s.title}</h3>
                    <p className="text-ink-2">{s.text}</p>
                    <Link href={s.href} className="inline-block pt-1 text-xs font-semibold text-brand hover:underline">
                      {s.cta} ←
                    </Link>
                  </div>
                </li>
              ))}
            </ol>

            <div className="rounded-lg border border-line bg-surface/50 p-4 text-sm">
              <p className="font-semibold">{isAr ? 'ملاحظة حول أنواع المفاتيح:' : 'Note on API Key types:'}</p>
              <ul className="mt-2 list-disc space-y-1.5 ps-5 text-ink-2">
                <li>
                  <code className="ltr font-mono text-ink">was_...</code> —{' '}
                  {isAr
                    ? 'مفتاح جلسة (Session Key): خاص برقم واتساب واحد، وهو الأسهل للـ OTP لأنه لا يحتاج أي ترويسة إضافية.'
                    : 'Session Key: tied to a single WhatsApp number. Easiest for OTP — only requires the Authorization header.'}
                </li>
                <li>
                  <code className="ltr font-mono text-ink">wap_...</code> —{' '}
                  {isAr
                    ? 'رمز مساحة العمل (Workspace Token): يدير كل الأرقام، ويتطلب إرسال ترويسة إضافية X-Session-Id مع الطلب.'
                    : 'Workspace Token: manages all sessions; requires passing an additional X-Session-Id header.'}
                </li>
              </ul>
            </div>
          </section>

          {/* STEP 2 */}
          <section id="step-2" className="scroll-mt-20 space-y-5 border-b border-line pb-10">
            <h2 className="text-xl font-bold sm:text-2xl">
              {isAr ? 'الخطوة 2: إرسال رمز التحقق (OTP) إلى رقم العميل' : 'Step 2: Send an OTP code to the user'}
            </h2>
            <p className="text-sm text-ink-2">
              {isAr
                ? 'أرسل طلب POST إلى المسار /api/send-otp مع تمرير مفتاح الجلسة في ترويسة Authorization ورقم هاتف العميل بالصيغة الدولية. ستقوم المنصة بتوليد الرمز وإرساله عبر واتساب وإرجاع الرمز لك في الاستجابة:'
                : 'Send a POST request to /api/send-otp with your session key in the Authorization header and the recipient phone number. The platform generates the code, sends it on WhatsApp, and returns it in the response:'}
            </p>

            {/* Language Tabs */}
            <div className="flex flex-wrap gap-1.5 border-b border-line pb-2" dir="ltr">
              {CODE_LANGS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setCodeLang(l.id)}
                  className={cx(
                    'cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                    codeLang === l.id ? 'bg-ink text-bg' : 'bg-raised/60 text-ink-2 hover:bg-raised',
                  )}
                >
                  {l.label}
                </button>
              ))}
            </div>

            <CodeBlock title={`POST ${origin}/api/send-otp`} code={getQuickCode(codeLang)} />

            <p className="text-sm font-semibold">
              {isAr ? 'شكل الاستجابة من المنصة (Response 200 OK):' : 'Response from the platform (200 OK):'}
            </p>
            <CodeBlock
              title="JSON Response"
              code={`{
  "success": true,
  "data": {
    "msgId": 1042,
    "jid": "201012345678@s.whatsapp.net",
    "status": "queued",
    "code": "482910"
  }
}`}
            />
          </section>

          {/* STEP 3 */}
          <section id="step-3" className="scroll-mt-20 space-y-5 border-b border-line pb-10">
            <h2 className="text-xl font-bold sm:text-2xl">
              {isAr ? 'الخطوة 3: كيف تتحقق من الرمز في موقعك أو تطبيقك (مثال كامل)' : 'Step 3: Verify the OTP code in your backend (Full Example)'}
            </h2>
            <p className="text-sm text-ink-2">
              {isAr
                ? 'لتفعيل الـ OTP بشكل آمن في موقعك، أنشئ مسارين في الباك-إند الخاص بك:'
                : 'To implement OTP verification safely in your website or app, create two routes in your backend:'}
            </p>

            <ol className="list-decimal space-y-2 ps-5 text-sm text-ink-2">
              <li>
                <strong className="text-ink">{isAr ? 'مسار إرسال الرمز (/auth/send-otp):' : 'Send route (/auth/send-otp):'}</strong>{' '}
                {isAr
                  ? 'يستقبل رقم هاتف العميل من واجهة موقعك، يستدعي /api/send-otp، ويحفظ الرمز الراجع (data.code) مؤقتاً في الكاش أو قاعدة البيانات لمدة 5 دقائق.'
                  : 'Receives the phone number from your frontend, calls /api/send-otp, and stores the returned data.code in cache/DB for 5 minutes.'}
              </li>
              <li>
                <strong className="text-ink">{isAr ? 'مسار التحقق من الرمز (/auth/verify-otp):' : 'Verify route (/auth/verify-otp):'}</strong>{' '}
                {isAr
                  ? 'يستقبل الرمز الذي كتبه العميل في موقعك ويقارنه بالرمز المحفوظ لديك. إذا تطابقا، يتم تسجيل دخول العميل وحذف الرمز.'
                  : 'Compares the code typed by the user with the stored code. If they match, logs the user in and deletes the code.'}
              </li>
            </ol>

            <div className="flex flex-wrap gap-1.5 border-b border-line pb-2" dir="ltr">
              {CODE_LANGS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setCodeLang(l.id)}
                  className={cx(
                    'cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                    codeLang === l.id ? 'bg-ink text-bg' : 'bg-raised/60 text-ink-2 hover:bg-raised',
                  )}
                >
                  {l.label}
                </button>
              ))}
            </div>

            <CodeBlock title={`Full Backend Flow (${CODE_LANGS.find((x) => x.id === codeLang)?.label})`} code={getFullBackendCode(codeLang)} />
          </section>

          {/* PARAMETERS */}
          <section id="params" className="scroll-mt-20 space-y-5 border-b border-line pb-10">
            <h2 className="text-xl font-bold sm:text-2xl">{g.params.title}</h2>
            <p className="text-sm text-ink-2">{g.params.subtitle}</p>

            <div className="overflow-x-auto rounded-lg border border-line bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface/60 text-xs text-muted">
                    <th className="px-4 py-2.5 text-start font-semibold">{g.params.colField}</th>
                    <th className="px-4 py-2.5 text-start font-semibold">{g.params.colType}</th>
                    <th className="px-4 py-2.5 text-start font-semibold">{g.params.colReq}</th>
                    <th className="px-4 py-2.5 text-start font-semibold">{g.params.colDesc}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {g.params.requestRows.map((r) => (
                    <tr key={r.field}>
                      <td className="px-4 py-3 font-mono text-xs font-bold text-ink">
                        <span className="ltr">{r.field}</span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted">
                        <span className="ltr">{r.type}</span>
                      </td>
                      <td className="px-4 py-3 text-xs font-medium">
                        {r.req ? <span className="text-brand">{g.params.required}</span> : <span className="text-muted">{g.params.optional}</span>}
                      </td>
                      <td className="px-4 py-3 text-xs text-ink-2">{r.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* CUSTOM TEMPLATE */}
          <section id="custom-template" className="scroll-mt-20 space-y-4 border-b border-line pb-10">
            <h2 className="text-xl font-bold sm:text-2xl">{g.templates.title}</h2>
            <p className="text-sm text-ink-2">{g.templates.subtitle}</p>

            <ol className="list-decimal space-y-2 ps-5 text-sm text-ink-2">
              {g.templates.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>

            <div className="grid gap-4 pt-2 sm:grid-cols-2">
              <div className="rounded-lg border border-line bg-card p-4">
                <p className="text-xs font-semibold text-muted">{g.templates.defaultArLabel}</p>
                <pre dir="rtl" className="mt-2 font-sans text-xs whitespace-pre-line text-ink">
                  {DEFAULT_OTP_TEMPLATES.ar}
                </pre>
              </div>
              <div className="rounded-lg border border-line bg-card p-4">
                <p className="text-xs font-semibold text-muted">{g.templates.customLabel}</p>
                <pre className="mt-2 font-sans text-xs whitespace-pre-line text-ink">{g.templates.customExample}</pre>
              </div>
            </div>
          </section>

          {/* ERRORS */}
          <section id="errors" className="scroll-mt-20 space-y-4">
            <h2 className="text-xl font-bold sm:text-2xl">{g.other.errorsTitle}</h2>
            <div className="overflow-x-auto rounded-lg border border-line bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface/60 text-xs text-muted">
                    <th className="px-4 py-2.5 text-start font-semibold">HTTP Status</th>
                    <th className="px-4 py-2.5 text-start font-semibold">{isAr ? 'السبب والحل' : 'Meaning & Solution'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {g.other.errors.map((err) => (
                    <tr key={err.code}>
                      <td className="px-4 py-3 font-mono text-xs font-bold whitespace-nowrap text-ink">
                        <span className="ltr">{err.code}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-ink-2">{err.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
