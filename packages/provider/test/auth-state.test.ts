import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, memoryAuthStore, parseKey, useEncryptedAuthState } from '../src';

const key = randomBytes(32);

describe('crypto', () => {
  it('round-trips', () => {
    const blob = encrypt(key, Buffer.from('secret'), 's1:creds:creds');
    expect(decrypt(key, blob, 's1:creds:creds').toString()).toBe('secret');
  });

  it('rejects a ciphertext moved to another session (AAD mismatch)', () => {
    const blob = encrypt(key, Buffer.from('secret'), 's1:creds:creds');
    expect(() => decrypt(key, blob, 's2:creds:creds')).toThrow();
  });

  it('rejects tampering', () => {
    const blob = encrypt(key, Buffer.from('secret'), 'aad');
    blob[blob.length - 1]! ^= 1;
    expect(() => decrypt(key, blob, 'aad')).toThrow();
  });

  it('parses base64 and hex keys, rejects wrong lengths', () => {
    expect(parseKey(key.toString('base64'))).toEqual(key);
    expect(parseKey(key.toString('hex'))).toEqual(key);
    expect(() => parseKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => parseKey(undefined)).toThrow(/not set/);
  });
});

describe('useEncryptedAuthState', () => {
  it('persists creds across restarts', async () => {
    const store = memoryAuthStore();
    const first = await useEncryptedAuthState(store, 's1', key);
    first.state.creds.me = { id: '201012345678:1@s.whatsapp.net', name: 'Test' };
    await first.saveCreds();

    const second = await useEncryptedAuthState(store, 's1', key);
    expect(second.state.creds.me?.id).toBe('201012345678:1@s.whatsapp.net');
    expect(Buffer.from(second.state.creds.noiseKey.private)).toEqual(Buffer.from(first.state.creds.noiseKey.private));
  });

  it('stores only ciphertext', async () => {
    const store = memoryAuthStore();
    const auth = await useEncryptedAuthState(store, 's1', key);
    auth.state.creds.me = { id: 'marker-201012345678@s.whatsapp.net' };
    await auth.saveCreds();
    for (const value of store.rows.values()) expect(value.toString('latin1')).not.toContain('marker-2010');
  });

  it('sets, gets and deletes signal keys', async () => {
    const store = memoryAuthStore();
    const { state } = await useEncryptedAuthState(store, 's1', key);
    const session = new Uint8Array([1, 2, 3]);
    await state.keys.set({ session: { a: session, b: session } });
    const got = await state.keys.get('session', ['a', 'b', 'missing']);
    expect(Buffer.from(got.a!)).toEqual(Buffer.from(session));
    expect(got.missing).toBeUndefined();

    await state.keys.set({ session: { a: null } });
    expect(Object.keys(await state.keys.get('session', ['a', 'b']))).toEqual(['b']);
  });

  it('cannot read another session with the same key', async () => {
    const store = memoryAuthStore();
    const s1 = await useEncryptedAuthState(store, 's1', key);
    await s1.saveCreds();
    // s2 sees s1's row under the shared memory store but AAD differs → decrypt fails.
    await expect(useEncryptedAuthState(store, 's2', key)).rejects.toThrow();
  });

  it('clear wipes everything', async () => {
    const store = memoryAuthStore();
    const auth = await useEncryptedAuthState(store, 's1', key);
    await auth.saveCreds();
    await auth.clear();
    expect(store.rows.size).toBe(0);
  });
});

describe('LID mappings', () => {
  it('reports the pairs Baileys stores, live and from storage', async () => {
    const store = memoryAuthStore();
    const seen: { lid: string; pn: string }[] = [];
    const auth = await useEncryptedAuthState(store, 's1', key, { onLidMappings: (pairs) => seen.push(...pairs) });
    // Baileys' layout: `<pnUser>` → lidUser and `<lidUser>_reverse` → pnUser.
    await auth.state.keys.set({ 'lid-mapping': { '201012345678': '99887766', '99887766_reverse': '201012345678' } });
    expect(seen).toEqual([{ lid: '99887766@lid', pn: '201012345678@s.whatsapp.net' }]);

    const later = await useEncryptedAuthState(store, 's1', key);
    expect(await later.lidMappings()).toEqual([{ lid: '99887766@lid', pn: '201012345678@s.whatsapp.net' }]);
  });
});
