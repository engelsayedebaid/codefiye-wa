import type { QueuedMessage, Sql } from '@wa/db';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { SessionRunner } from '../src/runner';

const silent = pino({ level: 'silent' });
const base: QueuedMessage = { id: 1, workspace_id: 'w1', session_id: 's1', remote_jid: '201012345678@s.whatsapp.net', content: { type: 'text', text: 'hi' }, attempts: 0, broadcast_id: null, pace: null, late_ms: 0 };

/** Runs the runner's pacing for one job; returns how long it held the send and whether it showed "typing…". */
async function paced(job: QueuedMessage, lastSentAgoMs: number) {
  const runner = new SessionRunner('s1', 'w1', {}, {
    sql: (() => Promise.resolve([])) as unknown as Sql,
    workerId: 'worker',
    encryptionKey: Buffer.alloc(32),
    logger: silent,
    baileysLogger: silent,
    sendDelay: { min: 300, max: 300 },
    fetchMedia: () => Promise.reject(new Error('no media in this test')),
    onStopped: () => {},
  });
  let typing = false;
  const internals = runner as unknown as { lastSentAt: number; pace: (provider: unknown, job: QueuedMessage, recipient: boolean) => Promise<void> };
  internals.lastSentAt = Date.now() - lastSentAgoMs;
  const started = performance.now();
  await internals.pace({ setTyping: async () => void (typing = true) }, job, false);
  return { ms: performance.now() - started, typing };
}

describe('send pacing', () => {
  it('holds an API text message for "typing…" even when the queue is idle', async () => {
    const { ms, typing } = await paced(base, 60_000);
    expect(typing).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(280);
  });

  it('sends a reply typed on the chats page at once when the queue is idle', async () => {
    const { ms, typing } = await paced({ ...base, content: { type: 'text', text: 'hi', sentFrom: 'chats' } }, 60_000);
    expect(typing).toBe(false);
    expect(ms).toBeLessThan(100);
  });

  it('still keeps typed replies apart from the previous send', async () => {
    const { ms, typing } = await paced({ ...base, content: { type: 'text', text: 'hi', sentFrom: 'chats' } }, 0);
    expect(typing).toBe(false);
    expect(ms).toBeGreaterThanOrEqual(280);
  });
});
