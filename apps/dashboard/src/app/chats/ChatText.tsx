import { Fragment, type ReactNode } from 'react';

/** WhatsApp formatting: *bold*, _italic_, ~strike~, ```mono```. */
const FORMAT = /```[\s\S]+?```|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~/g;
const LINK = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/gi;

function linkify(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push(
      <a key={`${key}-${m.index}`} href={m[0]} target="_blank" rel="noreferrer noopener" className="text-sky-400 underline-offset-2 hover:underline" dir="ltr">
        {m[0]}
      </a>,
    );
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

/** A message body as WhatsApp shows it; links open in a new tab, `highlight` marks search hits. */
export function ChatText({ text, highlight }: { text: string; highlight?: string }) {
  const nodes: ReactNode[] = [];
  let last = 0;
  const plain = (s: string, key: string) => (highlight ? mark(s, highlight, key) : linkify(s, key));
  for (const m of text.matchAll(FORMAT)) {
    if (m.index! > last) nodes.push(...plain(text.slice(last, m.index), `t${last}`));
    const raw = m[0];
    const mono = raw.startsWith('```');
    const inner = plain(mono ? raw.slice(3, -3) : raw.slice(1, -1), `f${m.index}`);
    const tag = mono ? 'code' : raw[0] === '*' ? 'strong' : raw[0] === '_' ? 'em' : 's';
    const Tag = tag as 'strong';
    nodes.push(
      <Tag key={m.index} className={mono ? 'font-mono text-[0.92em]' : undefined}>
        {inner}
      </Tag>,
    );
    last = m.index! + raw.length;
  }
  nodes.push(...plain(text.slice(last), `t${last}`));
  return (
    <>
      {nodes.map((n, i) => (
        <Fragment key={i}>{n}</Fragment>
      ))}
    </>
  );
}

function mark(text: string, term: string, key: string): ReactNode[] {
  const lower = text.toLowerCase();
  const needle = term.toLowerCase();
  const out: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0 && needle; at = lower.indexOf(needle, from)) {
    out.push(text.slice(from, at));
    out.push(
      <mark key={`${key}-${at}`} className="rounded-sm bg-amber-400/30 px-0.5 text-ink">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
  }
  out.push(text.slice(from));
  return out;
}
