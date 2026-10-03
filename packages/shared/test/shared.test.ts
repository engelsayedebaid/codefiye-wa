import { describe, expect, it } from 'vitest';
import {
  getPlan,
  jidToPhone,
  maskPhone,
  renderTemplate,
  renderTemplateParts,
  sendMessageBody,
  suggestNames,
  templatePartsVariables,
  templateVariables,
  toJid,
  toOutboundContent,
} from '../src';

describe('toJid', () => {
  it.each([
    ['+201012345678', '201012345678@s.whatsapp.net'],
    ['201012345678', '201012345678@s.whatsapp.net'],
    ['00201012345678', '201012345678@s.whatsapp.net'],
    ['+20 (101) 234-5678', '201012345678@s.whatsapp.net'],
    ['120363012345678901@g.us', '120363012345678901@g.us'],
    ['123456789012345@lid', '123456789012345@lid'],
  ])('%s → %s', (input, jid) => expect(toJid(input)).toBe(jid));

  it.each(['', 'abc', '+0123456789', '12345', '1234567890123456', 'x@example.com'])('rejects %j', (input) =>
    expect(toJid(input)).toBeNull(),
  );
});

describe('jidToPhone / maskPhone', () => {
  it('strips the device suffix', () => expect(jidToPhone('201012345678:12@s.whatsapp.net')).toBe('+201012345678'));
  it('returns null for groups', () => expect(jidToPhone('1203630@g.us')).toBeNull());
  it('masks the middle', () => expect(maskPhone('201012345678@s.whatsapp.net')).toBe('2010****5678@s.whatsapp.net'));
});

describe('sendMessageBody', () => {
  it('treats text alone as a text message', () => {
    const body = sendMessageBody.parse({ to: '+201012345678', text: 'hi' });
    expect(toOutboundContent(body)).toEqual({ type: 'text', text: 'hi' });
  });

  it('uses text as the caption for media', () => {
    const body = sendMessageBody.parse({ to: '+201012345678', text: 'look', imageUrl: 'https://x.test/a.jpg' });
    expect(toOutboundContent(body)).toEqual({ type: 'image', url: 'https://x.test/a.jpg', caption: 'look' });
  });

  it('rejects two media kinds at once', () => {
    const result = sendMessageBody.safeParse({ to: '1', imageUrl: 'https://x.test/a', videoUrl: 'https://x.test/b' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty message', () => {
    expect(sendMessageBody.safeParse({ to: '+201012345678' }).success).toBe(false);
  });

  it('rejects non-http URLs', () => {
    expect(sendMessageBody.safeParse({ to: '+201012345678', imageUrl: 'file:///etc/passwd' }).success).toBe(false);
  });
});

describe('getPlan', () => {
  it('falls back to trial for unknown ids', () => expect(getPlan('nope').id).toBe('trial'));
});

describe('suggestNames', () => {
  it('counts up from 2 over the taken names', () => {
    expect(suggestNames('Shop', ['Shop'])).toEqual(['Shop 2', 'Shop 3', 'Shop 4']);
    expect(suggestNames('Shop', ['Shop', 'Shop 2', 'Shop 3'])).toEqual(['Shop 4', 'Shop 5', 'Shop 6']);
  });

  it('continues the number already in the input and ignores case', () => {
    expect(suggestNames('Shop 2', ['shop', 'shop 2', 'Shop 4'])).toEqual(['Shop 3', 'Shop 5', 'Shop 6']);
  });

  it('keeps names within the 100-char limit', () => {
    const long = 'x'.repeat(100);
    expect(suggestNames(long, [long]).every((n) => n.length <= 100)).toBe(true);
  });
});

describe('templates', () => {
  it('lists placeholders once, in order', () => {
    expect(templateVariables('Hi {{name}}, code {{ code }} — again {{name}}')).toEqual(['name', 'code']);
    expect(templateVariables('No placeholders, {{ 1bad }} {{}}')).toEqual([]);
  });

  it('renders values and reports missing ones', () => {
    expect(renderTemplate('Code: {{code}} for {{app}}', { code: 123456, app: 'Shop' })).toEqual({ text: 'Code: 123456 for Shop', missing: [] });
    expect(renderTemplate('Code: {{code}} for {{app}}', { code: '1', app: '  ' })).toEqual({ text: null, missing: ['app'] });
  });

  it('accepts a template instead of text, but not both', () => {
    expect(sendMessageBody.safeParse({ to: '+201012345678', template: 'otp', variables: { code: '1234' } }).success).toBe(true);
    expect(sendMessageBody.safeParse({ to: '+201012345678', template: 'otp', text: 'x' }).success).toBe(false);
    expect(sendMessageBody.safeParse({ to: '+201012345678', template: 'has space' }).success).toBe(false);
  });
});

describe('polls and card templates', () => {
  it('validates polls and maps them to poll content', () => {
    const body = sendMessageBody.parse({ to: '+201012345678', poll: { question: 'Confirm?', options: ['Yes', 'No'] } });
    expect(toOutboundContent(body)).toEqual({ type: 'poll', name: 'Confirm?', options: ['Yes', 'No'], selectableCount: 1 });
    const multi = sendMessageBody.parse({ to: '+201012345678', poll: { question: 'Pick', options: ['A', 'B', 'C'], multiSelect: true } });
    expect(toOutboundContent(multi)).toMatchObject({ selectableCount: 0 });
    expect(sendMessageBody.safeParse({ to: '+201012345678', poll: { question: 'Q', options: ['Only one'] } }).success).toBe(false);
    expect(sendMessageBody.safeParse({ to: '+201012345678', poll: { question: 'Q', options: ['Same', 'Same'] } }).success).toBe(false);
    expect(sendMessageBody.safeParse({ to: '+201012345678', poll: { question: 'Q', options: ['A', 'B'] }, text: 'x' }).success).toBe(false);
  });

  it('renders every template part and reports missing variables across them', () => {
    const template = { body: 'Hi {{name}}', imageUrl: 'https://example.com/a.jpg', buttons: ['Track {{order}}', 'Cancel'], buttonsTitle: 'Order {{order}}?' };
    expect(renderTemplateParts(template, { name: 'Sara' })).toEqual({ rendered: null, missing: ['order'] });
    expect(renderTemplateParts(template, { name: 'Sara', order: 7 }).rendered).toEqual({
      text: 'Hi Sara',
      imageUrl: 'https://example.com/a.jpg',
      poll: { name: 'Order 7?', options: ['Track 7', 'Cancel'] },
    });
    // Without buttons, the title's placeholders don't count.
    expect(templatePartsVariables({ body: 'Hi', buttons: [], buttonsTitle: '{{unused}}' })).toEqual([]);
  });
});
