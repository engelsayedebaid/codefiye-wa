import { Check, Copy } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useI18n } from '../i18n';
import { cx } from '../ui';

const origin = typeof window !== 'undefined' ? window.location.origin : 'https://api.example.com';

export const SNIPPETS: { id: string; label: string; code: string }[] = [
  {
    id: 'curl',
    label: 'cURL',
    code: `curl -X POST ${origin}/api/send-message \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"to": "+201012345678", "text": "Hello from the API 👋"}'`,
  },
  {
    id: 'js',
    label: 'JavaScript',
    code: `// Your session API key
const apiKey = 'YOUR_API_KEY';

// Send a text message
const res = await fetch('${origin}/api/send-message', {
  method: 'POST',
  headers: {
    Authorization: \`Bearer \${apiKey}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ to: '+201012345678', text: 'Hello from the API 👋' }),
});

console.log(await res.json());`,
  },
  {
    id: 'python',
    label: 'Python',
    code: `import requests

# Your session API key
api_key = "YOUR_API_KEY"

# Send a text message
response = requests.post(
    "${origin}/api/send-message",
    headers={"Authorization": f"Bearer {api_key}"},
    json={"to": "+201012345678", "text": "Hello from the API 👋"},
)
print(response.json())`,
  },
  {
    id: 'php',
    label: 'PHP',
    code: `<?php
// Your session API key
$apiKey = 'YOUR_API_KEY';

// Send a text message
$ch = curl_init('${origin}/api/send-message');
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => [
        "Authorization: Bearer $apiKey",
        'Content-Type: application/json',
    ],
    CURLOPT_POSTFIELDS => json_encode(['to' => '+201012345678', 'text' => 'Hello from the API 👋']),
]);
echo curl_exec($ch);`,
  },
];

// VS Code dark+ token colors.
// Comments: `//` not part of a URL, or a Python `#` line.
const TOKEN = /((?<![:\w])\/\/.*|^\s*#.*$)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\$\w+)|\b(const|await|import|print|echo|true|false|new|return|def|from|curl|method|headers|body|json)\b|\b(\d+)\b/gm;
const COLORS = ['text-[#6a9955]', 'text-[#ce9178]', 'text-[#9cdcfe]', 'text-[#569cd6]', 'text-[#b5cea8]'];

/** Tiny highlighter for the marketing snippets. Builds React nodes, never HTML strings. */
function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of code.matchAll(TOKEN)) {
    const index = m.index ?? 0;
    if (index > last) out.push(code.slice(last, index));
    const group = m.slice(1).findIndex((g) => g !== undefined);
    out.push(
      <span key={index} className={COLORS[group]}>
        {m[0]}
      </span>,
    );
    last = index + m[0].length;
  }
  out.push(code.slice(last));
  return out;
}

export function CodeTabs({ className }: { className?: string }) {
  const { t } = useI18n();
  const [active, setActive] = useState(SNIPPETS[1]!.id);
  const [copied, setCopied] = useState(false);
  const snippet = SNIPPETS.find((s) => s.id === active)!;
  const lines = snippet.code.split('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  };

  return (
    <div
      dir="ltr"
      className={cx(
        'relative overflow-hidden rounded-3xl border border-brand/25 bg-gradient-to-b from-[#111615] via-[#0c100f] to-[#090c0b] p-1.5 shadow-[0_28px_90px_-24px_rgba(14,175,81,0.28)]',
        className,
      )}
    >
      <div aria-hidden className="pointer-events-none absolute -top-24 left-1/2 h-44 w-2/3 -translate-x-1/2 rounded-full bg-brand/15 blur-3xl" />

      <div className="relative overflow-hidden rounded-[1.35rem] border border-white/[0.08] bg-[#0b0e0d]">
        {/* IDE Top Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] bg-white/[0.02] px-4 py-3 sm:px-5">
          <div className="flex items-center gap-3">
            <div className="flex gap-1.5">
              <span className="size-3 rounded-full bg-[#ff5f57]/90" />
              <span className="size-3 rounded-full bg-[#febc2e]/90" />
              <span className="size-3 rounded-full bg-[#28c840]/90" />
            </div>
            <span className="hidden h-4 w-px bg-white/10 sm:block" />
            <span className="hidden items-center gap-2 rounded-md border border-white/[0.07] bg-white/[0.03] px-2.5 py-1 font-mono text-[11px] text-white/60 sm:inline-flex">
              <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-400">POST</span>
              /api/send-message
            </span>
          </div>

          <div role="tablist" className="flex flex-wrap items-center gap-1 rounded-xl border border-white/[0.07] bg-black/40 p-1">
            {SNIPPETS.map((s) => (
              <button
                key={s.id}
                role="tab"
                aria-selected={s.id === active}
                onClick={() => setActive(s.id)}
                className={cx(
                  'cursor-pointer rounded-lg px-3 py-1.5 text-xs font-semibold transition-all duration-200',
                  s.id === active
                    ? 'bg-gradient-to-r from-brand to-teal text-on-brand shadow-md shadow-brand/25'
                    : 'text-white/60 hover:bg-white/[0.06] hover:text-white',
                )}
              >
                {s.label}
              </button>
            ))}
          </div>

          <button
            onClick={copy}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-white/75 transition hover:border-brand/40 hover:bg-white/[0.08] hover:text-white"
            aria-label={t.landing.integration.copy}
          >
            {copied ? (
              <>
                <Check className="animate-scale-in size-3.5 text-brand" />
                <span className="text-brand">{t.landing.integration.copied}</span>
              </>
            ) : (
              <>
                <Copy className="size-3.5" />
                <span>{t.landing.integration.copy}</span>
              </>
            )}
          </button>
        </div>

        {/* Code + Live Response Split */}
        <div className="grid divide-y divide-white/[0.07] lg:grid-cols-[1.45fr_1fr] lg:divide-x lg:divide-y-0">
          <pre key={active} className="code-scroll animate-fade-in overflow-x-auto p-5 font-mono text-[13px] leading-6 text-[#d4d4d4] sm:p-6">
            <code className="grid">
              {lines.map((line, idx) => (
                <span key={idx} className=" flex">
                  <span aria-hidden className="me-4 w-6 shrink-0 text-end text-[11px] text-white/25 select-none">
                    {idx + 1}
                  </span>
                  <span className="min-w-0 flex-1">{highlight(line)}</span>
                </span>
              ))}
            </code>
          </pre>

          <div className="flex flex-col justify-between bg-[#080b0a] p-5 sm:p-6">
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2 font-mono text-xs font-medium text-white/70">
                  <span className="size-2 animate-pulse rounded-full bg-emerald-400" />
                  {t.landing.integration.responseTitle}
                </span>
                <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 font-mono text-[11px] text-emerald-400">
                  38 ms
                </span>
              </div>
              <pre className="mt-4 overflow-x-auto rounded-xl border border-white/[0.06] bg-black/50 p-4 font-mono text-[12px] leading-6 text-emerald-300/90">
                <code>{`{
  "success": true,
  "data": {
    "msgId": "3EB0C767D097B7C1",
    "jid": "201012345678@s.whatsapp.net",
    "status": "queued"
  }
}`}</code>
              </pre>
            </div>
            <div className="mt-4 flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-2.5 text-xs text-white/55">
              <span className="font-mono">Idempotency-Key: supported</span>
              <span className="text-emerald-400">✓ Zero per-msg fee</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
