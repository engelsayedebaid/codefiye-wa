import type { QueuedMessage, Sql } from '@wa/db';
import type { ProviderEvents } from '@wa/provider';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { SessionRunner } from '../src/runner';

type Row = { id: number; status: string; waMessageId: string | null; error: string | null };
const PROGRESS = ['queued', 'sending', 'sent', 'delivered', 'read'];

/** A one-message stand-in for Postgres that answers the runner's queries, with a round-trip delay like Neon's. */
function fakeSql(row: Row, latencyMs = 40) {
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
    if (text.includes('pg_notify')) return [];
    if (text.includes("set status = 'sent', wa_message_id")) {
      if (row.status === 'sending') Object.assign(row, { status: 'sent', waMessageId: values[0], error: null });
      return [];
    }
    if (text.includes("set status = 'failed', error")) {
      const [error, , waMessageId] = values;
      if (row.waMessageId !== waMessageId || row.status !== 'sent') return [];
      Object.assign(row, { status: 'failed', error });
      return [{ id: row.id }];
    }
    if (text.includes('array_position')) {
      const [status, , waMessageId] = values as string[];
      if (row.waMessageId !== waMessageId || PROGRESS.indexOf(row.status) >= PROGRESS.indexOf(status!)) return [];
      row.status = status!;
      return [{ id: row.id, workspace_id: 'w1' }];
    }
    throw new Error(`unexpected query: ${text}`);
  }) as unknown as Sql;
  return sql;
}

const silent = pino({ level: 'silent' });
const job: QueuedMessage = { id: 1, workspace_id: 'w1', session_id: 's1', remote_jid: '201012345678@s.whatsapp.net', content: { type: 'text', text: 'hi' }, attempts: 0 };

/**
 * Sends one message whose receipt WhatsApp delivers `when` relative to the send returning:
 * 'before' (processed before sendMessage resolves) or 'during' (while markSent is in flight).
 */
async function sendWithReceipt(receipt: Omit<ProviderEvents['receipt'], 'waMessageId' | 'chatJid'>, when: 'before' | 'during') {
  const row: Row = { id: 1, status: 'sending', waMessageId: null, error: null };
  const runner = new SessionRunner('s1', 'w1', {}, {
    sql: fakeSql(row),
    workerId: 'worker',
    encryptionKey: Buffer.alloc(32),
    logger: silent,
    baileysLogger: silent,
    sendDelay: { min: 0, max: 0 },
    fetchMedia: () => Promise.reject(new Error('no media in this test')),
    onStopped: () => {},
  });
  const internals = runner as unknown as {
    provider: unknown;
    onReceipt: (r: ProviderEvents['receipt']) => Promise<void>;
    sendOne: (j: QueuedMessage) => Promise<void>;
  };
  let handled: Promise<void> = Promise.resolve();
  const fire = () => {
    handled = internals.onReceipt({ waMessageId: 'W1', chatJid: job.remote_jid, ...receipt });
  };
  internals.provider = {
    isOnWhatsApp: async () => [{ input: '201012345678', exists: true, jid: job.remote_jid }],
    setTyping: async () => {},
    send: async () => {
      if (when === 'before') fire();
      else setTimeout(fire, 10);
      return { waMessageId: 'W1' };
    },
  };
  await internals.sendOne(job);
  await handled;
  return row;
}

describe('receipts that beat the markSent write', () => {
  it.each(['before', 'during'] as const)('a rejection arriving %s the write still fails the message, with the reason', async (when) => {
    const row = await sendWithReceipt({ status: 'failed', error: '463' }, when);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/may not start new chats/);
  });

  it.each(['before', 'during'] as const)('a delivery receipt arriving %s the write is kept', async (when) => {
    const row = await sendWithReceipt({ status: 'delivered' }, when);
    expect(row.status).toBe('delivered');
  });

  it('names unknown rejection codes', async () => {
    const row = await sendWithReceipt({ status: 'failed', error: '999' }, 'during');
    expect(row.error).toBe('Rejected by WhatsApp (error 999)');
  });
});
