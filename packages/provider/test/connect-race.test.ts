import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

/** The WA Web version lookup is held open so a close can land while connect waits on it. */
const version = vi.hoisted(() => {
  let release: (v: { version: [number, number, number]; isLatest: boolean }) => void = () => {};
  const pending = new Promise<{ version: [number, number, number]; isLatest: boolean }>((resolve) => (release = resolve));
  return { pending, release: () => release({ version: [2, 3000, 1], isLatest: true }) };
});
const makeWASocket = vi.hoisted(() => vi.fn());

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>();
  return { ...actual, default: makeWASocket, fetchLatestWaWebVersion: () => version.pending };
});

const { BaileysProvider, memoryAuthStore, useEncryptedAuthState } = await import('../src');

describe('BaileysProvider.connect', () => {
  it('opens no socket when the session was closed while connect was still starting', async () => {
    const auth = await useEncryptedAuthState(memoryAuthStore(), 's1', randomBytes(32));
    const provider = new BaileysProvider({ sessionId: 's1', auth, fetchMedia: async () => ({ data: Buffer.alloc(0), mimetype: null }) });

    const connecting = provider.connect();
    await provider.close(); // the runner stopped (supervisor, logout) mid-connect
    version.release();
    await connecting;

    expect(makeWASocket).not.toHaveBeenCalled();
    expect(provider.connected).toBe(false);
  });
});
