import { isValidElement, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { emojiCode, emojify } from '../src/app/emoji';

/** The emoji an emojify() result turned into images, in order. */
const images = (text: string) => emojify(text).filter(isValidElement).map((n) => (n as ReactElement<{ char: string }>).props.char);

describe('emoji', () => {
  it('names an emoji by its code points, as the image set does', () => {
    expect(emojiCode('😀')).toBe('1f600');
    expect(emojiCode('❤️')).toBe('2764-fe0f');
    expect(emojiCode('👍🏽')).toBe('1f44d-1f3fd');
    expect(emojiCode('👩‍💻')).toBe('1f469-200d-1f4bb');
  });

  it('finds whole emoji in text: skin tones, ZWJ sequences, flags and keycaps stay in one piece', () => {
    expect(images('hi 👋🏽 team 👩‍💻 from 🇪🇬 press 1️⃣')).toEqual(['👋🏽', '👩‍💻', '🇪🇬', '1️⃣']);
    expect(images('🏳️‍🌈❤️😂')).toEqual(['🏳️‍🌈', '❤️', '😂']);
  });

  it('leaves text-style symbols and plain text alone', () => {
    expect(images('© 2026 WA™ ↔ 123 #1')).toEqual([]);
    expect(emojify('no emoji here')).toEqual(['no emoji here']);
  });

  it('keeps the text around the emoji', () => {
    const parts = emojify('شكرا 🙏 جدا');
    expect(parts[0]).toBe('شكرا ');
    expect(parts.at(-1)).toBe(' جدا');
  });
});
