import type { WAMessage } from '@whiskeysockets/baileys';
import { describe, expect, it } from 'vitest';
import { toInbound } from '../src';

const msg = (over: Partial<WAMessage>): WAMessage =>
  ({ key: { remoteJid: '201012345678@s.whatsapp.net', id: 'ABC', fromMe: false }, messageTimestamp: 1_700_000_000, ...over }) as WAMessage;

describe('toInbound', () => {
  it('normalises a plain text message', () => {
    const inbound = toInbound(msg({ message: { conversation: 'hello' }, pushName: 'Ali' }));
    expect(inbound).toMatchObject({
      waMessageId: 'ABC',
      chatJid: '201012345678@s.whatsapp.net',
      from: '201012345678@s.whatsapp.net',
      pushName: 'Ali',
      isGroup: false,
      type: 'text',
      text: 'hello',
      timestamp: 1_700_000_000,
    });
  });

  it('uses the image caption as text', () => {
    const inbound = toInbound(msg({ message: { imageMessage: { caption: 'pic', mimetype: 'image/jpeg' } } }));
    expect(inbound).toMatchObject({ type: 'image', text: 'pic' });
  });

  it('prefers the phone-number JID over a LID', () => {
    const inbound = toInbound(
      msg({ key: { remoteJid: '99999@lid', remoteJidAlt: '201012345678@s.whatsapp.net', id: 'X' }, message: { conversation: 'x' } }),
    );
    expect(inbound?.from).toBe('201012345678@s.whatsapp.net');
    expect(inbound?.chatJid).toBe('99999@lid');
  });

  it('reports the group participant as sender', () => {
    const inbound = toInbound(
      msg({ key: { remoteJid: '1203630@g.us', participant: '201012345678@s.whatsapp.net', id: 'G' }, message: { conversation: 'hey' } }),
    );
    expect(inbound).toMatchObject({ isGroup: true, from: '201012345678@s.whatsapp.net', participant: '201012345678@s.whatsapp.net' });
  });

  it('unwraps ephemeral messages', () => {
    const inbound = toInbound(msg({ message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'eph' } } } } }));
    expect(inbound).toMatchObject({ type: 'text', text: 'eph' });
  });

  it.each([
    ['own messages', msg({ key: { remoteJid: '1@s.whatsapp.net', id: 'A', fromMe: true }, message: { conversation: 'x' } })],
    ['status broadcasts', msg({ key: { remoteJid: 'status@broadcast', id: 'A' }, message: { conversation: 'x' } })],
    ['protocol messages', msg({ message: { protocolMessage: { type: 0 } } })],
    ['empty messages', msg({ message: undefined })],
  ])('ignores %s', (_, m) => expect(toInbound(m)).toBeNull());
});
