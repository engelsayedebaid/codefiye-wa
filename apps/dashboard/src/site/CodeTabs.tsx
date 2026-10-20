import { Check, Copy } from '../icons';
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

/** The landing page's code sample: a language picker, the request, and the response it gets. Always dark, like an editor. */
export function CodeTabs({ className }: { className?: string }) {
  const { t } = useI18n();
  const d = t.landing.developers;
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
        'overflow-hidden rounded-2xl border border-white/10 bg-[#0a0e0d] text-[#d4d4d4] shadow-[0_40px_90px_-40px_rgb(0_0_0/0.85)] light:shadow-[0_40px_80px_-40px_rgb(16_24_20/0.45)]',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-white/10 ps-1 pe-2">
        <div role="tablist" className="code-scroll flex min-w-0 overflow-x-auto">
          {SNIPPETS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === active}
              onClick={() => setActive(s.id)}
              className={cx(
                '-mb-px shrink-0 cursor-pointer border-b-2 px-3.5 py-3 text-xs font-medium transition-colors',
                s.id === active ? 'border-[#34d399] text-white' : 'border-transparent text-white/55 hover:text-white',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={copy}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-white/65 transition hover:bg-white/10 hover:text-white"
          aria-label={d.copy}
        >
          {copied ? <Check className="animate-scale-in size-3.5 text-[#34d399]" /> : <Copy className="size-3.5" />}
          <span className={cx('hidden sm:inline', copied && 'text-[#34d399]')}>{copied ? d.copied : d.copy}</span>
        </button>
      </div>

      <div className="flex items-center gap-2 border-b border-white/[0.06] bg-white/[0.02] px-5 py-2 font-mono text-[11px] text-white/55">
        <span className="rounded bg-[#34d399]/15 px-1.5 py-0.5 font-bold text-[#34d399]">POST</span>
        /api/send-message
      </div>

      <pre key={active} className="code-scroll animate-fade-in overflow-x-auto p-5 font-mono text-[13px] leading-6 sm:p-6">
        <code className="grid">
          {lines.map((line, idx) => (
            <span key={idx} className="flex">
              <span aria-hidden className="me-4 w-5 shrink-0 text-end text-[11px] text-white/25 select-none">
                {idx + 1}
              </span>
              <span className="min-w-0 flex-1">{highlight(line)}</span>
            </span>
          ))}
        </code>
      </pre>

      <div className="border-t border-white/10 bg-black/30 px-5 py-4 sm:px-6">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="inline-flex items-center gap-2 font-mono text-white/70">
            <span className="size-1.5 rounded-full bg-[#34d399]" />
            <bdi>{d.responseTitle}</bdi> · 200 OK
          </span>
          <span className="font-mono text-[11px] text-[#34d399]/90">38 ms</span>
        </div>
        <pre className="code-scroll mt-3 overflow-x-auto font-mono text-[12px] leading-6 text-[#6ee7b7]/90">
          <code>{`{ "success": true, "data": { "msgId": "3EB0C767D097B7C1", "status": "queued" } }`}</code>
        </pre>
      </div>
    </div>
  );
}
