import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discard, enqueue, pendingFor } from '../src/app/chats/outbox';

const SESSION = '00000000-0000-4000-8000-000000000001';
const JID = '201012345678@s.whatsapp.net';
const sent = (id: number) => new Response(JSON.stringify({ success: true, data: { id, direction: 'out', type: 'text', status: 'queued', content: {} } }), { status: 200 });
const failure = (status: number, code: string) => new Response(JSON.stringify({ success: false, message: code, code }), { status });

async function until(check: () => boolean, ms = 8_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('outbox', () => {
  it('retries a temporary failure by itself, with the same Idempotency-Key', async () => {
    const keys: string[] = [];
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        keys.push((init.headers as Record<string, string>)['idempotency-key']!);
        calls += 1;
        if (calls === 1) throw new TypeError('Failed to fetch');
        if (calls === 2) return failure(503, 'db_unavailable');
        return sent(41);
      }),
    );
    const jid = `a-${JID}`;
    enqueue(new QueryClient(), SESSION, jid, { text: 'hello' });
    expect(pendingFor(SESSION, jid)[0]).toMatchObject({ state: 'sending' });
    await until(() => pendingFor(SESSION, jid)[0]?.realId === 41);
    expect(calls).toBe(3);
    expect(new Set(keys).size).toBe(1);
    expect(pendingFor(SESSION, jid)[0]?.state).toBe('sending');
  }, 15_000);

  it('fails at once on an answer that a retry cannot change', async () => {
    const fetch = vi.fn(async () => failure(409, 'session_not_connected'));
    vi.stubGlobal('fetch', fetch);
    const jid = `b-${JID}`;
    enqueue(new QueryClient(), SESSION, jid, { text: 'hello' });
    await until(() => pendingFor(SESSION, jid)[0]?.state === 'failed');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(pendingFor(SESSION, jid)[0]?.error).toBeTruthy();
    discard(SESSION, jid, pendingFor(SESSION, jid)[0]!.ref);
    expect(pendingFor(SESSION, jid)).toHaveLength(0);
  });

  it('can be given up while it waits between tries', async () => {
    const fetch = vi.fn(async () => failure(503, 'db_unavailable'));
    vi.stubGlobal('fetch', fetch);
    const jid = `c-${JID}`;
    enqueue(new QueryClient(), SESSION, jid, { text: 'hello' });
    await until(() => pendingFor(SESSION, jid)[0]?.waiting === 'retry');
    discard(SESSION, jid, pendingFor(SESSION, jid)[0]!.ref);
    expect(pendingFor(SESSION, jid)).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 1_800));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
