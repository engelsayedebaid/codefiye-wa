import { randomBytes } from 'node:crypto';
import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, parseKey } from '../src/crypto';

const key = randomBytes(32);

describe('AES-256-GCM auth encryption', () => {
  it('round-trips data', () => {
    const plain = Buffer.from('hello signal keys');
    expect(decrypt(key, encrypt(key, plain, 's1:creds'), 's1:creds').toString()).toBe('hello signal keys');
  });

  it('uses a fresh IV each time', () => {
    const plain = Buffer.from('same');
    expect(encrypt(key, plain, 'a').equals(encrypt(key, plain, 'a'))).toBe(false);
  });

  it('rejects a ciphertext moved to another row (AAD mismatch)', () => {
    const ct = encrypt(key, Buffer.from('x'), 'session-a:pre-key:1');
    expect(() => decrypt(key, ct, 'session-b:pre-key:1')).toThrow();
  });

  it('rejects tampering and the wrong key', () => {
    const ct = encrypt(key, Buffer.from('payload'), 'aad');
    const tampered = Buffer.from(ct);
    tampered[tampered.length - 1]! ^= 0xff;
    expect(() => decrypt(key, tampered, 'aad')).toThrow();
    expect(() => decrypt(randomBytes(32), ct, 'aad')).toThrow();
  });

  it('round-trips real Baileys creds including Buffers', () => {
    const creds = initAuthCreds();
    const ct = encrypt(key, Buffer.from(JSON.stringify(creds, BufferJSON.replacer)), 'c');
    const back = JSON.parse(decrypt(key, ct, 'c').toString(), BufferJSON.reviver);
    expect(Buffer.from(back.noiseKey.private).equals(Buffer.from(creds.noiseKey.private))).toBe(true);
    expect(back.registrationId).toBe(creds.registrationId);
  });

  it('validates key length', () => {
    expect(() => parseKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(parseKey(key.toString('base64')).equals(key)).toBe(true);
  });
});
