import type { Sql } from '@wa/db';
import type { InboundMessage } from '@wa/provider';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { SessionRunner } from '../src/runner';

/** Postgres refuses NOTIFY payloads of 8000 bytes or more. */
const NOTIFY_LIMIT = 8000;

/** Records queries; `pg_notify` behaves like Postgres (payload cap) or fails outright with `notifyDown`. */
function fakeSql() {
  const queries: string[] = [];
  const payloads: string[] = [];
  const state = { notifyDown: false };
  const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    queries.push(text);
    if (text.includes('pg_notify')) {
      const payload = String(values[1]);
      if (state.notifyDown || Buffer.byteLength(payload) >= NOTIFY_LIMIT) throw new Error('payload string too long');
      payloads.push(payload);
      return [];
    }
    if (text.includes('insert into messages')) return [{ id: 7 }];
    return [];
  };
  const sql = Object.assign(query, { json: (v: unknown) => v }) as unknown as Sql;
  return { sql, queries, payloads, state };
}

function makeRunner() {
  const db = fakeSql();
  const silent = pino({ level: 'silent' });
  const runner = new SessionRunner('s1', 'w1', { autoRead: true }, {
    sql: db.sql,
    workerId: 'worker-A',
    encryptionKey: Buffer.alloc(32),
    logger: silent,
    baileysLogger: silent,
    sendDelay: { min: 0, max: 0 },
    fetchMedia: async () => ({ data: Buffer.alloc(0), mimetype: null }),
    onStopped: vi.fn(),
  });
  const onMessage = (m: InboundMessage) => (runner as unknown as { onMessage: (m: InboundMessage) => Promise<void> }).onMessage(m);
  return { db, onMessage };
}

const inbound = (text: string): InboundMessage => ({
  waMessageId: 'ABC',
  chatJid: '201012345678@s.whatsapp.net',
  from: '201012345678@s.whatsapp.net',
  isGroup: false,
  type: 'text',
  text,
  extras: {},
  timestamp: 1_700_000_000,
  raw: {},
  pushName: 'Sara',
});

describe('inbound events', () => {
  it('keeps the event of a very long Arabic message under the NOTIFY limit, and stores it whole', async () => {
    const t = makeRunner();
    const text = 'مرحبا '.repeat(3_000); // 18k chars, ~33 KB in UTF-8
    await t.onMessage(inbound(text));
    expect(t.db.payloads).toHaveLength(1);
    const event = JSON.parse(t.db.payloads[0]!);
    expect(event).toMatchObject({ type: 'messages.received', workspaceId: 'w1', sessionId: 's1' });
    expect(event.data.text.length).toBeLessThan(text.length);
    expect(Buffer.byteLength(t.db.payloads[0]!)).toBeLessThan(NOTIFY_LIMIT);
    // Handling went on after the event: the chat was marked read (autoRead).
    expect(t.db.queries.some((q) => q.includes('update chats set unread_count = 0'))).toBe(true);
  });

  it('finishes handling a message even when its event cannot be published', async () => {
    const t = makeRunner();
    t.db.state.notifyDown = true;
    await expect(t.onMessage(inbound('stop'))).resolves.toBeUndefined();
    expect(t.db.queries.some((q) => q.includes('insert into messages'))).toBe(true);
    expect(t.db.queries.some((q) => q.includes('update chats set unread_count = 0'))).toBe(true);
  });
});
