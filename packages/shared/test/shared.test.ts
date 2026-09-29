import { describe, expect, it } from 'vitest';
import { jidToPhone, maskPhone, sendMessageSchema, toJid } from '../src';

describe('toJid', () => {
  it('normalizes E.164 and formatted numbers', () => {
    expect(toJid('+20 10-1234-5678')).toBe('201012345678@s.whatsapp.net');
    expect(toJid('201012345678')).toBe('201012345678@s.whatsapp.net');
  });
  it('passes through JIDs', () => {
    expect(toJid('120363000000000000@g.us')).toBe('120363000000000000@g.us');
    expect(toJid('12345@lid')).toBe('12345@lid');
  });
  it('rejects garbage', () => {
    expect(() => toJid('abc')).toThrow();
  });
  it('maps JIDs back to phones and masks', () => {
    expect(jidToPhone('201012345678@s.whatsapp.net')).toBe('+201012345678');
    expect(jidToPhone('x@g.us')).toBeNull();
    expect(maskPhone('+201012345678')).toBe('+********5678');
  });
});

describe('sendMessageSchema', () => {
  it('accepts text and single media', () => {
    expect(sendMessageSchema.safeParse({ to: '+201012345678', text: 'hi' }).success).toBe(true);
    expect(sendMessageSchema.safeParse({ to: '+201012345678', imageUrl: 'https://x.test/a.png', text: 'cap' }).success).toBe(true);
  });
  it('rejects empty and multiple media', () => {
    expect(sendMessageSchema.safeParse({ to: '+201012345678' }).success).toBe(false);
    expect(
      sendMessageSchema.safeParse({ to: '+201012345678', imageUrl: 'https://x.test/a.png', videoUrl: 'https://x.test/b.mp4' }).success,
    ).toBe(false);
  });
  it('rejects invalid recipients', () => {
    expect(sendMessageSchema.safeParse({ to: 'hello', text: 'x' }).success).toBe(false);
  });
});
