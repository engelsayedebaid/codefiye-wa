import type { WAMessage } from '@whiskeysockets/baileys';
import { describe, expect, it } from 'vitest';
import { toEcho, toInbound } from '../src';

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

  it('never files a contact under a device JID (one chat per contact)', () => {
    const inbound = toInbound(msg({ key: { remoteJid: '201012345678:12@s.whatsapp.net', id: 'D' }, message: { conversation: 'x' } }));
    expect(inbound).toMatchObject({ chatJid: '201012345678@s.whatsapp.net', from: '201012345678@s.whatsapp.net' });
    const echo = toEcho(msg({ key: { remoteJid: '99999:3@lid', remoteJidAlt: '201012345678:3@s.whatsapp.net', id: 'E', fromMe: true }, message: { conversation: 'y' } }));
    expect(echo?.chatJid).toBe('201012345678@s.whatsapp.net');
    const lidOnly = toEcho(msg({ key: { remoteJid: '99999:3@lid', id: 'F', fromMe: true }, message: { conversation: 'z' } }));
    expect(lidOnly?.chatJid).toBe('99999@lid');
  });

  it('reports the group participant as sender', () => {
    const inbound = toInbound(
      msg({ key: { remoteJid: '1203630@g.us', participant: '201012345678@s.whatsapp.net', id: 'G' }, message: { conversation: 'hey' } }),
    );
    expect(inbound).toMatchObject({ isGroup: true, from: '201012345678@s.whatsapp.net', participant: '201012345678@s.whatsapp.net' });
  });

  it('finds the group sender of a history message (beside the key, not in it)', () => {
    const inbound = toInbound(msg({ key: { remoteJid: '1203630@g.us', id: 'H', fromMe: false }, participant: '149392468262946:3@lid', message: { conversation: 'old' } }));
    expect(inbound).toMatchObject({ isGroup: true, from: '149392468262946@lid', participant: '149392468262946:3@lid' });
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

describe('chat extras', () => {
  it('keeps media details and the embedded preview', () => {
    const inbound = toInbound(
      msg({ message: { imageMessage: { caption: 'pic', mimetype: 'image/jpeg', width: 800, height: 600, fileLength: 12345, jpegThumbnail: new Uint8Array([1, 2, 3]) } } }),
    );
    expect(inbound?.extras.media).toEqual({ mimetype: 'image/jpeg', size: 12345, width: 800, height: 600, thumb: Buffer.from([1, 2, 3]).toString('base64') });
  });

  it('marks voice notes', () => {
    const inbound = toInbound(msg({ message: { audioMessage: { ptt: true, seconds: 7, mimetype: 'audio/ogg; codecs=opus' } } }));
    expect(inbound).toMatchObject({ type: 'audio', extras: { media: { ptt: true, seconds: 7 } } });
  });

  it('reads locations, contact cards and reactions', () => {
    expect(toInbound(msg({ message: { locationMessage: { degreesLatitude: 30.04, degreesLongitude: 31.23, name: 'Cairo' } } }))?.extras.location).toEqual({
      latitude: 30.04,
      longitude: 31.23,
      name: 'Cairo',
    });
    const card = toInbound(msg({ message: { contactMessage: { displayName: 'Ali', vcard: 'BEGIN:VCARD\nTEL;type=CELL;waid=201012345678:+20 101 234 5678\nEND:VCARD' } } }));
    expect(card?.extras.contacts).toEqual([{ name: 'Ali', phone: '+201012345678' }]);
    const reaction = toInbound(msg({ message: { reactionMessage: { key: { id: 'TARGET' }, text: '👍' } } }));
    expect(reaction).toMatchObject({ type: 'reaction', text: '👍', extras: { reactTo: 'TARGET' } });
  });

  it('keeps the message a reply quotes', () => {
    const inbound = toInbound(
      msg({
        message: {
          extendedTextMessage: { text: 'yes', contextInfo: { stanzaId: 'Q1', participant: '201000000000@s.whatsapp.net', quotedMessage: { conversation: 'are you there?' } } },
        },
      }),
    );
    expect(inbound?.extras.quoted).toEqual({ id: 'Q1', type: 'text', text: 'are you there?', participant: '201000000000@s.whatsapp.net' });
  });
});

describe('toEcho', () => {
  it('turns a message sent from the phone into an echo, filed under the phone number', () => {
    const echo = toEcho(msg({ key: { remoteJid: '99999@lid', remoteJidAlt: '201012345678@s.whatsapp.net', id: 'E1', fromMe: true }, message: { conversation: 'hi from phone' } }));
    expect(echo).toMatchObject({ waMessageId: 'E1', chatJid: '201012345678@s.whatsapp.net', type: 'text', text: 'hi from phone' });
  });

  it('ignores messages from others', () => {
    expect(toEcho(msg({ message: { conversation: 'x' } }))).toBeNull();
  });
});

describe('readContacts', () => {
  it('takes the address-book name and a business name, and the LID pairs, never a masked number or a group', async () => {
    const { readContacts } = await import('../src');
    const found = readContacts([
      { id: '201012345678@s.whatsapp.net', name: 'Ahmed', lid: '99887766@lid' },
      { id: '99887755@lid', name: '+20∙∙∙∙∙∙∙∙16', phoneNumber: '201000000016@s.whatsapp.net' },
      { id: '201055500000:4@s.whatsapp.net', verifiedName: 'Shop LLC', notify: 'shop' },
      { id: '120363000000000077@g.us', name: 'Family' },
      { id: '201000000099@s.whatsapp.net', notify: 'only their own name' },
    ]);
    expect(found.contacts).toEqual([
      { jid: '201012345678@s.whatsapp.net', savedName: 'Ahmed' },
      { jid: '201055500000@s.whatsapp.net', verifiedName: 'Shop LLC' },
    ]);
    expect(found.pairs).toEqual([
      { lid: '99887766@lid', pn: '201012345678@s.whatsapp.net' },
      { lid: '99887755@lid', pn: '201000000016@s.whatsapp.net' },
    ]);
  });
});
