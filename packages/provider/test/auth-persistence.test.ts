import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { type AuthStore, decrypt, memoryAuthStore, useEncryptedAuthState } from '../src';

const key = randomBytes(32);

/** Wraps a store so each write can be delayed or made to fail, and records what landed in which order. */
function controllableStore() {
  const inner = memoryAuthStore();
  const landed: string[] = [];
  let failures: Error[] = [];
  let delays: number[] = [];
  const store: AuthStore = {
    get: (type, ids) => inner.get(type, ids),
    async set(entries) {
      const delay = delays.shift() ?? 0;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const failure = failures.shift();
      if (failure) throw failure;
      for (const e of entries) {
        if (e.type === 'creds' && e.value) landed.push(JSON.parse(decrypt(key, e.value, 's1:creds:creds').toString()).me?.name ?? '');
      }
      await inner.set(entries);
    },
    clear: () => inner.clear(),
  };
  return {
    store,
    inner,
    landed,
    failNext: (...errors: Error[]) => (failures = errors),
    delayNext: (...ms: number[]) => (delays = ms),
  };
}

describe('creds persistence', () => {
  it('never lets an older creds snapshot land after a newer one', async () => {
    const s = controllableStore();
    const auth = await useEncryptedAuthState(s.store, 's1', key);
    s.delayNext(60, 0, 0);
    auth.state.creds.me = { id: 'x@s.whatsapp.net', name: 'v1' };
    const first = auth.saveCreds();
    auth.state.creds.me = { id: 'x@s.whatsapp.net', name: 'v2' };
    const second = auth.saveCreds();
    auth.state.creds.me = { id: 'x@s.whatsapp.net', name: 'v3' };
    const third = auth.saveCreds();
    await Promise.all([first, second, third]);
    // The slow first write captured v3 (sealed at write time); the queued saves coalesced into one more.
    expect(s.landed.at(-1)).toBe('v3');
    expect(s.landed.length).toBeLessThanOrEqual(2);
    const reloaded = await useEncryptedAuthState(s.inner, 's1', key);
    expect(reloaded.state.creds.me?.name).toBe('v3');
  });

  it('retries a creds write that failed for a transient reason', async () => {
    vi.useFakeTimers();
    try {
      const s = controllableStore();
      const auth = await useEncryptedAuthState(s.store, 's1', key);
      auth.state.creds.me = { id: 'x@s.whatsapp.net', name: 'paired' };
      s.failNext(new Error('connection reset'), new Error('connection reset'));
      const saving = auth.saveCreds();
      await vi.runAllTimersAsync();
      await saving;
      expect(s.landed).toEqual(['paired']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never retries a write refused for lost ownership', async () => {
    const s = controllableStore();
    const auth = await useEncryptedAuthState(s.store, 's1', key);
    s.failNext(Object.assign(new Error('not owner'), { name: 'AuthFenceError' }));
    await expect(auth.saveCreds()).rejects.toThrow('not owner');
    expect(s.landed).toEqual([]);
  });

  it('flush waits for every pending save', async () => {
    const s = controllableStore();
    const auth = await useEncryptedAuthState(s.store, 's1', key);
    s.delayNext(50);
    auth.state.creds.me = { id: 'x@s.whatsapp.net', name: 'before-shutdown' };
    void auth.saveCreds();
    await auth.flush();
    expect(s.landed).toEqual(['before-shutdown']);
  });

  it('a failed load throws instead of minting new credentials, and deletes nothing', async () => {
    const s = controllableStore();
    const first = await useEncryptedAuthState(s.store, 's1', key);
    first.state.creds.me = { id: 'x@s.whatsapp.net', name: 'linked' };
    await first.saveCreds();
    const broken: AuthStore = { ...s.store, get: async () => Promise.reject(new Error('database unreachable')) };
    await expect(useEncryptedAuthState(broken, 's1', key)).rejects.toThrow('database unreachable');
    // A wrong encryption key (or a corrupt row) fails too, rather than looking like "no session".
    await expect(useEncryptedAuthState(s.store, 's1', randomBytes(32))).rejects.toThrow();
    expect((await useEncryptedAuthState(s.store, 's1', key)).state.creds.me?.name).toBe('linked');
  });
});
