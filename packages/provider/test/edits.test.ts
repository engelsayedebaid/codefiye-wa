import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const makeWASocket = vi.hoisted(() => vi.fn());
vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>();
  return { ...actual, default: makeWASocket, fetchLatestWaWebVersion: async () => ({ version: [2, 3000, 1], isLatest: true }) };
});

const { aesEncryptGCM, BufferJSON, hmacSign, proto, WAMessageStubType } = await import('@whiskeysockets/baileys');
const { BaileysProvider, memoryAuthStore, readSecretEdit, readStoredSecretEdit, toInbound, useEncryptedAuthState } = await import('../src');

const SENDER_LID = '66825798844566@lid';
const SENDER_PN = '201154460380@s.whatsapp.net';
const GROUP = '120363048851911567@g.us';

/**
 * Encrypts an edit the way WhatsApp does (the derivation verified against real edits: HKDF over the
 * original's messageSecret, info = id + sender + sender + "Message Edit", AES-GCM without AAD).
 */
function encryptEdit(secret: Buffer, targetId: string, sender: string, text: string) {
  const info = Buffer.concat([Buffer.from(targetId), Buffer.from(sender), Buffer.from(sender), Buffer.from('Message Edit'), new Uint8Array([1])]);
  const key = hmacSign(info, hmacSign(secret, new Uint8Array(32), 'sha256'), 'sha256');
  const iv = randomBytes(12);
  const edit = proto.Message.encode({
    protocolMessage: {
      key: { remoteJid: GROUP, fromMe: true, id: targetId, participant: sender },
      type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
      editedMessage: { extendedTextMessage: { text } },
      timestampMs: 1_700_000_100_000,
    },
  }).finish();
  return {
    encPayload: aesEncryptGCM(edit, key, iv, Buffer.alloc(0)),
    encIv: iv,
    secretEncType: proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT,
    targetMessageKey: { id: targetId, fromMe: true, remoteJid: GROUP, participant: sender },
  };
}

const groupKey = (id: string) => ({ remoteJid: GROUP, id, fromMe: false, participant: SENDER_LID, participantAlt: SENDER_PN });
const original = (secret: Buffer) => ({
  key: groupKey('ORIG1'),
  message: { conversation: 'علت اي ه طمني', messageContextInfo: { messageSecret: secret } },
  messageTimestamp: 1_700_000_000,
});
const editEnvelope = (sem: ReturnType<typeof encryptEdit>) => ({ key: groupKey('EDIT1'), message: { secretEncryptedMessage: sem }, messageTimestamp: 1_700_000_100 });

describe('readSecretEdit', () => {
  it('decrypts an encrypted edit with the original message’s secret, under the sender’s LID or number', () => {
    const secret = randomBytes(32);
    for (const sender of [SENDER_LID, SENDER_PN]) {
      const sem = encryptEdit(secret, 'ORIG1', sender, 'عملت ايه طمني');
      const edit = readSecretEdit(sem, secret, [SENDER_LID, SENDER_PN]);
      expect(edit?.type).toBe(proto.Message.ProtocolMessage.Type.MESSAGE_EDIT);
      expect(edit?.editedMessage?.extendedTextMessage?.text).toBe('عملت ايه طمني');
    }
  });

  it('returns null with the wrong secret or the wrong sender (never guesses)', () => {
    const secret = randomBytes(32);
    const sem = encryptEdit(secret, 'ORIG1', SENDER_LID, 'x');
    expect(readSecretEdit(sem, randomBytes(32), [SENDER_LID])).toBeNull();
    expect(readSecretEdit(sem, secret, ['999@lid'])).toBeNull();
  });

  it('reads an envelope stored before edits were understood', () => {
    const secret = randomBytes(32);
    const stored = (v: unknown) => JSON.parse(JSON.stringify(v, BufferJSON.replacer));
    const read = readStoredSecretEdit(stored(editEnvelope(encryptEdit(secret, 'ORIG1', SENDER_LID, 'fixed'))), stored(original(secret)), []);
    expect(read).toEqual({ text: 'fixed', editedAt: 1_700_000_100 });
  });

  it('reads stored messages as they really are in messages.raw: bytes as base64 text, enums by name', () => {
    const secret = randomBytes(32);
    const sem = encryptEdit(secret, 'ORIG1', SENDER_LID, 'عملت ايه طمني');
    // The shape found in the database for the real edits (not BufferJSON's {type: 'Buffer'} objects).
    const editRaw = {
      key: groupKey('EDIT1'),
      message: {
        secretEncryptedMessage: {
          encIv: Buffer.from(sem.encIv).toString('base64'),
          encPayload: Buffer.from(sem.encPayload).toString('base64'),
          secretEncType: 'MESSAGE_EDIT',
          targetMessageKey: sem.targetMessageKey,
        },
      },
      messageTimestamp: 1_700_000_100,
    };
    const origRaw = { key: groupKey('ORIG1'), message: { conversation: 'علت اي ه طمني', messageContextInfo: { messageSecret: secret.toString('base64') } } };
    expect(readStoredSecretEdit(editRaw, origRaw, [])).toEqual({ text: 'عملت ايه طمني', editedAt: 1_700_000_100 });
    // Live path, same data: the original's secret also comes from storage as base64.
    expect(readSecretEdit(sem, secret.toString('base64'), [SENDER_LID])?.editedMessage?.extendedTextMessage?.text).toBe('عملت ايه طمني');
  });

  it('never turns an encrypted edit into a message of its own', () => {
    const secret = randomBytes(32);
    expect(toInbound(editEnvelope(encryptEdit(secret, 'ORIG1', SENDER_LID, 'x')) as never)).toBeNull();
  });
});

/** A provider on a fake socket: Baileys events go in, provider events come out. */
async function harness(stored: Map<string, unknown> = new Map()) {
  const ev = new EventEmitter();
  makeWASocket.mockReturnValue({ ev, user: null, end: async () => {}, signalRepository: { lidMapping: { getPNForLID: async () => null } } });
  const auth = await useEncryptedAuthState(memoryAuthStore(), 's1', randomBytes(32));
  const provider = new BaileysProvider({
    sessionId: 's1',
    auth,
    fetchMedia: async () => ({ data: Buffer.alloc(0), mimetype: null }),
    loadOriginal: async (id) => stored.get(id),
  });
  const out: { event: string; payload: unknown }[] = [];
  for (const event of ['message', 'edit', 'revoke', 'receipt', 'echo'] as const) provider.on(event, (payload: unknown) => out.push({ event, payload }));
  await provider.connect();
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { ev, out, settle };
}

describe('BaileysProvider edits and deletes', () => {
  it('a normal message is one message', async () => {
    const h = await harness();
    h.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: groupKey('M1'), message: { conversation: 'hello' }, messageTimestamp: 1 }] });
    await h.settle();
    expect(h.out.map((o) => o.event)).toEqual(['message']);
  });

  it('one real message plus its encrypted edit: one message and one edit, never two messages', async () => {
    const secret = randomBytes(32);
    // Stored as messages.raw really holds it: the secret as base64 text.
    const stored = new Map<string, unknown>([['ORIG1', { key: groupKey('ORIG1'), message: { conversation: 'x', messageContextInfo: { messageSecret: secret.toString('base64') } } }]]);
    const h = await harness(stored);
    h.ev.emit('messages.upsert', { type: 'notify', messages: [original(secret)] });
    h.ev.emit('messages.upsert', { type: 'notify', messages: [editEnvelope(encryptEdit(secret, 'ORIG1', SENDER_LID, 'عملت ايه طمني'))] });
    await h.settle();
    expect(h.out.map((o) => o.event)).toEqual(['message', 'edit']);
    expect(h.out[1]!.payload).toMatchObject({ waMessageId: 'ORIG1', text: 'عملت ايه طمني', editedAt: 1_700_000_100 });
  });

  it('an edit that can’t be decrypted is dropped: no message, no edit', async () => {
    const h = await harness(new Map([['ORIG1', JSON.parse(JSON.stringify(original(randomBytes(32)), BufferJSON.replacer))]]));
    h.ev.emit('messages.upsert', { type: 'notify', messages: [editEnvelope(encryptEdit(randomBytes(32), 'ORIG1', SENDER_LID, 'x'))] });
    // …and one whose original we don't hold.
    h.ev.emit('messages.upsert', { type: 'notify', messages: [editEnvelope(encryptEdit(randomBytes(32), 'UNKNOWN', SENDER_LID, 'x'))] });
    await h.settle();
    expect(h.out).toEqual([]);
  });

  it('plain edits and deletes-for-everyone change the original; delivery receipts work as before', async () => {
    const h = await harness();
    h.ev.emit('messages.update', [
      { key: groupKey('M1'), update: { message: { editedMessage: { message: { conversation: 'new text' } } }, messageTimestamp: 1_700_000_200 } },
      { key: groupKey('M2'), update: { message: null, messageStubType: WAMessageStubType.REVOKE } },
      { key: { remoteJid: SENDER_PN, id: 'SENT1', fromMe: true }, update: { status: proto.WebMessageInfo.Status.DELIVERY_ACK } },
    ]);
    await h.settle();
    // Edits and deletes resolve the chat's address first (async), so order isn't fixed.
    expect(h.out).toHaveLength(3);
    expect(h.out).toEqual(
      expect.arrayContaining([
        { event: 'edit', payload: { waMessageId: 'M1', chatJid: GROUP, text: 'new text', editedAt: 1_700_000_200 } },
        { event: 'revoke', payload: { waMessageId: 'M2', chatJid: GROUP } },
        { event: 'receipt', payload: { waMessageId: 'SENT1', chatJid: SENDER_PN, status: 'delivered' } },
      ]),
    );
  });

  it('a revoke or edit sent as a protocol message is never a message itself', async () => {
    const h = await harness();
    h.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        { key: groupKey('P1'), message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { id: 'M2' } } }, messageTimestamp: 1 },
        { key: groupKey('P2'), message: { editedMessage: { message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, key: { id: 'M1' } } } } }, messageTimestamp: 1 },
      ],
    });
    await h.settle();
    expect(h.out).toEqual([]);
  });
});
