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
        'rounded-2xl border border-brand/30 bg-gradient-to-b from-brand/10 to-surface p-4 shadow-[0_0_80px_-20px_rgba(36,211,102,0.35)] sm:p-7',
        className,
      )}
    >
      <div role="tablist" className="grid grid-cols-4 gap-1 rounded-lg bg-ink/[0.04] p-1">
        {SNIPPETS.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={s.id === active}
            onClick={() => setActive(s.id)}
            className={cx(
              'rounded-md py-2 text-sm font-semibold transition-all duration-300',
              s.id === active ? 'bg-brand text-on-brand shadow-lg shadow-brand/20' : 'text-ink-2 hover:bg-ink/[0.06]',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="relative mt-5 rounded-xl border border-line bg-[#141414] light:border-transparent">
        <button
          onClick={copy}
          className="absolute top-3 right-3 rounded-md border border-white/10 bg-white/[0.04] p-1.5 text-white/60 transition hover:text-white"
          aria-label={t.landing.integration.copy}
        >
          {copied ? <Check className="animate-scale-in size-4 text-brand" /> : <Copy className="size-4" />}
        </button>
        <pre key={active} className="code-scroll animate-fade-in overflow-x-auto p-5 pr-14 font-mono text-[13px] leading-6 text-[#d4d4d4]">
          <code>{highlight(snippet.code)}</code>
        </pre>
      </div>
    </div>
  );
}
