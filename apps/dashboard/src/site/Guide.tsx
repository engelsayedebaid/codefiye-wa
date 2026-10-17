import { DEFAULT_OTP_TEMPLATES } from '@wa/shared';
import { ArrowUpRight, BookOpen, Check, ChevronRight, Copy, KeyRound, LayoutTemplate, LifeBuoy, Mail, ShieldCheck, Smartphone } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { sessionHint } from '../api';
import { BRAND } from '../brand';
import { useI18n } from '../i18n';
import { Link } from '../router';
import { buttonClass, CopyField, cx, delay, flip, Reveal } from '../ui';
import { Arrow, SiteFooter, SiteHeader } from './SiteChrome';
import { TocAside, TocFold, useActiveSection } from './TocNav';

const origin = typeof window !== 'undefined' ? window.location.origin : 'https://api.example.com';

type CodeLang = 'nodejs' | 'php' | 'python' | 'curl' | 'flutter';

const CODE_LANGS: { id: CodeLang; label: string }[] = [
  { id: 'nodejs', label: 'Node.js' },
  { id: 'php', label: 'PHP / Laravel' },
  { id: 'python', label: 'Python' },
  { id: 'flutter', label: 'Flutter' },
  { id: 'curl', label: 'cURL' },
];

const OTP_RESPONSE = `{
  "success": true,
  "data": {
    "msgId": 1042,
    "jid": "201012345678@s.whatsapp.net",
    "status": "queued",
    "code": "482910"
  }
}`;

/** Copy with `backticks` around code: those parts render as inline code, left-to-right inside Arabic. */
function Rich({ text }: { text: string }) {
  const parts = text.split('`');
  return (
    <>
      {parts.map((part, i) =>
        i % 2 ? (
          <code key={i} className="ltr rounded-md border border-line bg-raised/60 px-1.5 py-px font-mono text-[0.85em] whitespace-nowrap text-ink">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

function CodeBlock({ title, code }: { title: string; code: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  };

  return (
    <div dir="ltr" className="mt-4 overflow-hidden rounded-xl border border-white/10 bg-[#0a0e0d] text-[#e5e7eb] shadow-[0_24px_60px_-36px_rgb(0_0_0/0.8)]">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-white/[0.03] px-4 py-2 text-xs text-white/60">
        <bdi className="truncate font-mono">{title}</bdi>
        <button
          type="button"
          onClick={copy}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-white/70 transition hover:bg-white/10 hover:text-white"
        >
          {copied ? <Check className="size-3.5 text-[#34d399]" /> : <Copy className="size-3.5" />}
          <span>{copied ? t.guide.codeSection.copied : t.guide.codeSection.copy}</span>
        </button>
      </div>
      <pre className="code-scroll overflow-x-auto p-4 font-mono text-[13px] leading-6">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function LangTabs({ value, onChange, className }: { value: CodeLang; onChange: (lang: CodeLang) => void; className?: string }) {
  return (
    <div role="tablist" dir="ltr" className={cx('inline-flex max-w-full flex-wrap gap-1 rounded-lg border border-line bg-surface/60 p-1', className)}>
      {CODE_LANGS.map((l) => (
        <button
          key={l.id}
          type="button"
          role="tab"
          aria-selected={value === l.id}
          onClick={() => onChange(l.id)}
          className={cx(
            'cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
            value === l.id ? 'bg-card text-ink shadow-xs ring-1 ring-line' : 'text-muted hover:text-ink',
          )}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

function DocSection({ id, title, lead, children }: { id: string; title: string; lead?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="group flex items-baseline gap-2 text-2xl font-semibold tracking-tight sm:text-[1.75rem]">
        <span>
          <Rich text={title} />
        </span>
        <a href={`#${id}`} aria-hidden tabIndex={-1} className="text-lg text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-brand">
          #
        </a>
      </h2>
      {lead && (
        <p className="mt-3 leading-relaxed text-ink-2">
          <Rich text={lead} />
        </p>
      )}
      {children}
    </section>
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
        return response()->json(['valid' => true]);
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

const METHOD_TINT: Record<string, string> = {
  POST: 'bg-good/12 text-good',
  GET: 'bg-info/12 text-info',
};

export function GuidePage() {
  const { t } = useI18n();
  const g = t.guide;
  const signedIn = sessionHint.get();
  const [codeLang, setCodeLang] = useState<CodeLang>('nodejs');
  const langLabel = CODE_LANGS.find((l) => l.id === codeLang)!.label;

  const toc = [
    { id: 'flow', label: g.toc.flow },
    { id: 'get-key', label: g.toc.key },
    { id: 'send', label: g.toc.send },
    { id: 'verify', label: g.toc.verify },
    { id: 'params', label: g.toc.params },
    { id: 'templates', label: g.toc.templates },
    { id: 'endpoints', label: g.toc.endpoints },
    { id: 'practices', label: g.toc.practices },
    { id: 'errors', label: g.toc.errors },
  ];
  const active = useActiveSection(toc.map((item) => item.id));

  const quickLinks = [
    { href: '/sessions', label: g.links.sessions, icon: Smartphone },
    { href: '/keys', label: g.links.keys, icon: KeyRound },
    { href: '/templates', label: g.links.templates, icon: LayoutTemplate },
  ];

  return (
    <div className="min-h-svh overflow-x-clip">
      <SiteHeader />
      <main id="main">
        <header className="relative isolate overflow-hidden border-b border-line">
          <div aria-hidden className="hero-aura absolute inset-0 -z-10" />
          <div aria-hidden className="site-grid absolute inset-0 -z-10" />
          <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 sm:py-20 lg:px-8">
            <p className="animate-fade-up flex items-center gap-2 text-sm text-muted">
              <BookOpen className="size-4" />
              {g.crumb}
              <ChevronRight className={cx('size-3.5 text-faint', flip)} />
              <span className="font-medium text-ink-2">{g.crumbPage}</span>
            </p>
            <h1 className="animate-fade-up mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl" style={delay(60)}>
              {g.title}
            </h1>
            <p className="animate-fade-up mt-5 max-w-2xl text-lg leading-relaxed text-muted" style={delay(120)}>
              {g.subtitle}
            </p>
            <div className="animate-fade-up mt-8 max-w-2xl" style={delay(180)}>
              <p className="mb-2 text-xs font-medium text-muted">{g.endpointLabel}</p>
              <CopyField value={`POST ${origin}/api/send-otp`} />
            </div>
            <div className="animate-fade-up mt-6 flex flex-wrap gap-3" style={delay(240)}>
              <Link href={signedIn ? '/dashboard' : '/register'} className={buttonClass('brand', 'md', 'rounded-lg px-4')}>
                {signedIn ? g.backDashboard : g.startFree} <Arrow />
              </Link>
              <a href="/docs" target="_blank" rel="noreferrer" className={buttonClass('outline', 'md', 'rounded-lg')}>
                <BookOpen className="size-4 text-muted" />
                {g.openReference}
                <ArrowUpRight className={cx('size-3.5 text-muted', flip)} />
              </a>
            </div>
          </div>
        </header>

        <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-12 lg:px-8 xl:grid-cols-[220px_minmax(0,1fr)_240px]">
          <TocAside title={g.tocTitle} items={toc} active={active} />

          <article className="max-w-3xl min-w-0">
            <TocFold title={g.tocTitle} items={toc} active={active} className="mb-10" />
            <div className="space-y-16">
              <DocSection id="flow" title={g.flow.title} lead={g.flow.subtitle}>
                <ol className="mt-6 grid gap-4 sm:grid-cols-2">
                  {g.flow.stages.map((s, i) => (
                    <li key={s.title}>
                      <Reveal delay={i * 70} className="site-card h-full rounded-xl p-5">
                        <span className="flex items-center gap-3">
                          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-on-brand">{i + 1}</span>
                          <span className="text-xs font-medium text-muted">{s.actor}</span>
                        </span>
                        <span className="mt-3 block font-semibold">
                          <Rich text={s.title} />
                        </span>
                        <span className="mt-1.5 block text-sm leading-relaxed text-muted">
                          <Rich text={s.desc} />
                        </span>
                      </Reveal>
                    </li>
                  ))}
                </ol>
              </DocSection>

              <DocSection id="get-key" title={g.getKey.title} lead={g.getKey.subtitle}>
                <ol className="mt-6 space-y-3">
                  {g.getKey.steps.map((s, i) => (
                    <li key={s.title} className="site-card flex gap-4 rounded-xl p-5">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line bg-raised font-mono text-sm font-semibold">{i + 1}</span>
                      <div className="min-w-0">
                        <h3 className="font-semibold">
                          <Rich text={s.title} />
                        </h3>
                        <p className="mt-1 text-sm leading-relaxed text-muted">
                          <Rich text={s.text} />
                        </p>
                        <Link href={s.href} className="group mt-2.5 inline-flex items-center gap-1.5 text-sm font-semibold text-brand hover:text-brand-strong">
                          {s.cta} <Arrow className="size-3.5" />
                        </Link>
                      </div>
                    </li>
                  ))}
                </ol>

                <h3 className="mt-10 text-lg font-semibold">{g.getKey.keyTypesTitle}</h3>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  {[g.getKey.sessionKey, g.getKey.workspaceKey].map((k, i) => (
                    <div key={k.prefix} className={cx('site-card flex flex-col rounded-xl p-5', i === 0 && 'border-brand/50 ring-1 ring-brand/20')}>
                      <div className="flex items-center justify-between gap-2">
                        <code className="ltr rounded-md bg-raised px-2 py-0.5 font-mono text-sm font-semibold">{k.prefix}</code>
                        <span className={cx('rounded-full px-2.5 py-0.5 text-[11px] font-medium', i === 0 ? 'bg-brand/12 text-brand' : 'bg-raised text-muted')}>{k.badge}</span>
                      </div>
                      <h4 className="mt-4 font-semibold">{k.title}</h4>
                      <p className="mt-1.5 flex-1 text-sm leading-relaxed text-muted">
                        <Rich text={k.desc} />
                      </p>
                      <pre dir="ltr" className="code-scroll mt-4 overflow-x-auto rounded-lg bg-[#0a0e0d] px-3 py-2.5 font-mono text-[11.5px] leading-5 text-[#9cdcfe]">
                        {k.header}
                      </pre>
                    </div>
                  ))}
                </div>
              </DocSection>

              <DocSection id="send" title={g.send.title} lead={g.send.text}>
                <LangTabs value={codeLang} onChange={setCodeLang} className="mt-6" />
                <CodeBlock title={`POST ${origin}/api/send-otp`} code={getQuickCode(codeLang)} />
                <p className="mt-8 text-sm font-semibold">{g.send.responseLabel}</p>
                <CodeBlock title="application/json" code={OTP_RESPONSE} />
              </DocSection>

              <DocSection id="verify" title={g.verify.title} lead={g.verify.text}>
                <ul className="mt-5 space-y-3">
                  {g.verify.routes.map((r) => (
                    <li key={r.path} className="flex flex-col gap-2 rounded-xl border border-line bg-surface/40 p-4 sm:flex-row sm:gap-4">
                      <code className="ltr h-fit w-fit shrink-0 rounded-md bg-raised px-2 py-0.5 font-mono text-xs font-semibold">{r.path}</code>
                      <p className="text-sm leading-relaxed text-ink-2">
                        <Rich text={r.text} />
                      </p>
                    </li>
                  ))}
                </ul>
                <LangTabs value={codeLang} onChange={setCodeLang} className="mt-6" />
                <CodeBlock title={g.verify.codeTitle(langLabel)} code={getFullBackendCode(codeLang)} />
              </DocSection>

              <DocSection id="params" title={g.params.title} lead={g.params.subtitle}>
                <h3 className="mt-6 text-sm font-semibold text-muted">
                  <Rich text={g.params.reqTitle} />
                </h3>
                <div className="table-stack site-card mt-3 overflow-hidden rounded-xl">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line bg-surface/60 text-xs text-muted">
                        <th className="px-4 py-2.5 text-start font-medium">{g.params.colField}</th>
                        <th className="px-4 py-2.5 text-start font-medium">{g.params.colType}</th>
                        <th className="px-4 py-2.5 text-start font-medium">{g.params.colReq}</th>
                        <th className="px-4 py-2.5 text-start font-medium">{g.params.colDesc}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {g.params.requestRows.map((r) => (
                        <tr key={r.field} className="px-4 align-top">
                          <td data-label={g.params.colField} className="px-4 py-3 font-mono text-xs font-semibold">
                            <span className="ltr">{r.field}</span>
                          </td>
                          <td data-label={g.params.colType} className="px-4 py-3 font-mono text-xs whitespace-nowrap text-muted">
                            <span className="ltr">{r.type}</span>
                          </td>
                          <td data-label={g.params.colReq} className="px-4 py-3 text-xs">
                            {r.req ? <span className="font-medium text-brand">{g.params.required}</span> : <span className="text-muted">{g.params.optional}</span>}
                          </td>
                          <td data-label={g.params.colDesc} className="px-4 py-3 text-xs leading-relaxed text-ink-2">
                            <Rich text={r.desc} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <h3 className="mt-8 text-sm font-semibold text-muted">
                  <Rich text={g.params.resTitle} />
                </h3>
                <div className="table-stack site-card mt-3 overflow-hidden rounded-xl">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line bg-surface/60 text-xs text-muted">
                        <th className="px-4 py-2.5 text-start font-medium">{g.params.colField}</th>
                        <th className="px-4 py-2.5 text-start font-medium">{g.params.colType}</th>
                        <th className="px-4 py-2.5 text-start font-medium">{g.params.colDesc}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {g.params.responseRows.map((r) => (
                        <tr key={r.field} className="px-4 align-top">
                          <td data-label={g.params.colField} className="px-4 py-3 font-mono text-xs font-semibold">
                            <span className="ltr">{r.field}</span>
                          </td>
                          <td data-label={g.params.colType} className="px-4 py-3 font-mono text-xs whitespace-nowrap text-muted">
                            <span className="ltr">{r.type}</span>
                          </td>
                          <td data-label={g.params.colDesc} className="px-4 py-3 text-xs leading-relaxed text-ink-2">
                            <Rich text={r.desc} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </DocSection>

              <DocSection id="templates" title={g.templates.title} lead={g.templates.subtitle}>
                <ol className="mt-5 list-decimal space-y-2 ps-5 text-sm leading-relaxed text-ink-2 marker:font-semibold marker:text-brand">
                  {g.templates.steps.map((s) => (
                    <li key={s}>
                      <Rich text={s} />
                    </li>
                  ))}
                </ol>
                <div className="mt-6 grid gap-4 sm:grid-cols-2">
                  <div className="site-card rounded-xl p-5">
                    <p className="text-xs font-medium text-muted">{g.templates.defaultArLabel}</p>
                    <pre dir="rtl" className="mt-3 font-sans text-sm leading-relaxed whitespace-pre-line text-ink">
                      {DEFAULT_OTP_TEMPLATES.ar}
                    </pre>
                  </div>
                  <div className="site-card rounded-xl border-brand/40 p-5">
                    <p className="text-xs font-medium text-muted">{g.templates.customLabel}</p>
                    <pre className="mt-3 font-sans text-sm leading-relaxed whitespace-pre-line text-ink">{g.templates.customExample}</pre>
                  </div>
                </div>
                <Link href="/templates" className="group mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-brand hover:text-brand-strong">
                  {g.templates.openTemplates} <Arrow className="size-3.5" />
                </Link>
              </DocSection>

              <DocSection id="endpoints" title={g.other.title} lead={g.other.subtitle}>
                <ul className="mt-6 space-y-3">
                  {g.other.endpoints.map((e) => (
                    <li key={e.path} className="site-card rounded-xl p-5">
                      <p className="flex flex-wrap items-center gap-2.5" dir="ltr">
                        <span className={cx('rounded-md px-2 py-0.5 font-mono text-[11px] font-bold', METHOD_TINT[e.method] ?? 'bg-raised text-muted')}>{e.method}</span>
                        <code className="font-mono text-sm font-semibold break-all">{e.path}</code>
                      </p>
                      <h3 className="mt-3 font-semibold">{e.title}</h3>
                      <p className="mt-1 text-sm leading-relaxed text-muted">
                        <Rich text={e.desc} />
                      </p>
                    </li>
                  ))}
                </ul>
              </DocSection>

              <DocSection id="practices" title={g.other.securityTitle}>
                <ul className="mt-6 space-y-3">
                  {g.other.securityItems.map((s) => (
                    <li key={s.title} className="flex gap-4 rounded-xl border border-line bg-surface/40 p-5">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand ring-1 ring-brand/20">
                        <ShieldCheck className="size-4.5" />
                      </span>
                      <div className="min-w-0">
                        <h3 className="font-semibold">{s.title}</h3>
                        <p className="mt-1 text-sm leading-relaxed text-muted">
                          <Rich text={s.text} />
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </DocSection>

              <DocSection id="errors" title={g.other.errorsTitle}>
                <div className="table-stack site-card mt-6 overflow-hidden rounded-xl">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line bg-surface/60 text-xs text-muted">
                        <th className="px-4 py-2.5 text-start font-medium">{g.other.colStatus}</th>
                        <th className="px-4 py-2.5 text-start font-medium">{g.other.colMeaning}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {g.other.errors.map((e) => (
                        <tr key={e.code} className="px-4 align-top">
                          <td data-label={g.other.colStatus} className="px-4 py-3 whitespace-nowrap">
                            <span className="ltr block font-mono text-xs font-bold">{e.code}</span>
                            <span className="mt-0.5 block text-[11px] text-muted">{e.status}</span>
                          </td>
                          <td data-label={g.other.colMeaning} className="px-4 py-3 text-xs leading-relaxed text-ink-2">
                            <Rich text={e.desc} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </DocSection>
            </div>
          </article>

          <aside className="hidden xl:block">
            <div className="sticky top-24 space-y-4">
              <div className="site-card rounded-xl p-5">
                <span className="flex size-9 items-center justify-center rounded-lg bg-brand/10 text-brand ring-1 ring-brand/20">
                  <LifeBuoy className="size-4.5" />
                </span>
                <p className="mt-3 font-semibold">{g.help.title}</p>
                <p className="mt-1 text-sm leading-relaxed text-muted">{g.help.text}</p>
                <a href={`mailto:${BRAND.supportEmail}`} className={buttonClass('outline', 'sm', 'mt-4 w-full rounded-lg')}>
                  <Mail className="size-3.5" />
                  {g.help.cta}
                </a>
              </div>
              <nav aria-label={g.links.title} className="site-card rounded-xl p-2">
                <p className="px-3 pt-2 pb-1 text-xs font-semibold text-faint">{g.links.title}</p>
                <a href="/docs" target="_blank" rel="noreferrer" className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-ink-2 transition-colors hover:bg-raised hover:text-ink">
                  <BookOpen className="size-4 text-muted" />
                  <span className="flex-1">{g.links.reference}</span>
                  <ArrowUpRight className={cx('size-3.5 text-faint', flip)} />
                </a>
                {quickLinks.map(({ href, label, icon: Icon }) => (
                  <Link key={href} href={href} className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-ink-2 transition-colors hover:bg-raised hover:text-ink">
                    <Icon className="size-4 text-muted" />
                    {label}
                  </Link>
                ))}
              </nav>
            </div>
          </aside>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
