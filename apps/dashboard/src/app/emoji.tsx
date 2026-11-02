import { Fragment, type ReactNode, useState } from 'react';
import { cx } from '../ui';

/*
 * Emoji drawn as images, so every visitor sees the same iPhone-style set instead of their own
 * system's (Windows draws Microsoft's 3D ones). The images are emoji-datasource's, loaded one by
 * one from jsDelivr as they scroll in (the CSP's img-src already allows https:).
 *
 * The "apple" set is Apple's artwork: emoji-datasource's MIT license covers its code, not the
 * images, and Apple doesn't license them for other sites, so using them is the site owner's call.
 * Switching to a freely licensed set is this one line: 'google' (Noto, Apache 2.0) or 'twitter'
 * (Twemoji, CC-BY 4.0).
 */
const SET: 'apple' | 'google' | 'twitter' = 'apple';
const BASE = `https://cdn.jsdelivr.net/npm/emoji-datasource-${SET}@16.0.0/img/${SET}/64/`;

/** The image name of an emoji: its code points in lowercase hex, joined by dashes (😀 → 1f600, ❤️ → 2764-fe0f). */
export const emojiCode = (emoji: string) => [...emoji].map((c) => c.codePointAt(0)!.toString(16)).join('-');

/**
 * One emoji as an image. When the set has no file under the full name it retries without the
 * variation selectors (FE0F), and failing that shows the system emoji, so nothing ever goes blank.
 */
export function EmojiImg({ char, className }: { char: string; className?: string }) {
  const full = emojiCode(char);
  const bare = full.replace(/-fe0f/g, '');
  const [step, setStep] = useState<0 | 1 | 2>(0);
  if (step === 2) return <span className={className}>{char}</span>;
  return (
    <img
      src={`${BASE}${step === 0 ? full : bare}.png`}
      alt={char}
      draggable={false}
      loading="lazy"
      decoding="async"
      className={cx('inline-block shrink-0 select-none', className)}
      onError={() => setStep((s) => (s === 0 && bare !== full ? 1 : 2))}
    />
  );
}

/**
 * An emoji inside text: a flag (two regional letters), a keycap (1️⃣), or a pictograph that shows as
 * an emoji (by default, or with FE0F) with its skin tone and any ZWJ-joined parts (👩‍💻, 🏳️‍🌈).
 * Symbols written as plain text (©, ™, ↔ without FE0F) stay text.
 */
const EMOJI =
  /\p{Regional_Indicator}\p{Regional_Indicator}|[#*0-9]️?⃣|(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️)\p{Emoji_Modifier}?(?:‍\p{Extended_Pictographic}️?\p{Emoji_Modifier}?)*/gu;

/** Text with its emoji swapped for images sized to the text (1.2em), so a big emoji-only message stays big. */
export function emojify(text: string, key = 'e'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(EMOJI)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push(<EmojiImg key={`${key}-${m.index}`} char={m[0]} className="mx-[0.05em] size-[1.2em] align-[-0.22em]" />);
    last = m.index! + m[0].length;
  }
  if (last === 0) return [text];
  out.push(text.slice(last));
  return out;
}

/** The same, for nodes that mix strings with elements (links, highlights): only the strings change. */
export function emojifyNodes(nodes: ReactNode[], key = 'n'): ReactNode[] {
  return nodes.flatMap<ReactNode>((n, i) => (typeof n === 'string' ? emojify(n, `${key}${i}`).map((part, j) => <Fragment key={`${key}${i}-${j}`}>{part}</Fragment>) : [n]));
}
