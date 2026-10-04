import type { Sql } from '@wa/db';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRunner } from '../src/runner';

/** Records what the runner asks of Postgres; `failSessionWrites` makes session updates throw (database down). */
function fakeSql() {
  const log: { text: string; patch?: Record<string, unknown> }[] = [];
  const state = { failSessionWrites: false, owned: true };
  const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('update sessions set')) {
      if (state.failSessionWrites) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      log.push({ text, patch: (values[0] as { helper: Record<string, unknown> }).helper });
      return state.owned ? [{ id: 's1' }] : [];
    }
    log.push({ text });
    if (text.includes('from sessions where id') && text.includes('for share')) return state.owned ? [{ '?column?': 1 }] : [];
    return [];
  };
  const tag = (first: TemplateStringsArray | Record<string, unknown>, ...values: unknown[]) =>
    Array.isArray(first) ? query(first as TemplateStringsArray, ...values) : { helper: first };
  // Transactions run the callback on the same fake (enough for the fenced auth writes).
  const sql = Object.assign(tag, { begin: (fn: (tx: unknown) => unknown) => Promise.resolve(fn(tag)) }) as unknown as Sql;
  return { sql, log, state };
}

const silent = pino({ level: 'silent' });

function makeRunner() {
  const db = fakeSql();
  const onStopped = vi.fn();
  const runner = new SessionRunner('s1', 'w1', {}, {
    sql: db.sql,
    workerId: 'worker-A',
    encryptionKey: Buffer.alloc(32),
    logger: silent,
    baileysLogger: silent,
    sendDelay: { min: 0, max: 0 },
    fetchMedia: async () => ({ data: Buffer.alloc(0), mimetype: null }),
    onStopped,
  });
  // Never open a real WhatsApp socket in these tests.
  const connect = vi.fn(async () => {});
  (runner as unknown as { connect: typeof connect }).connect = connect;
  const internals = runner as unknown as {
    onClose: (c: { reason: string; statusCode: number | null; message: string }) => Promise<void>;
    confirmingLogout: boolean;
    reconnects: number;
    reconnectTimer: NodeJS.Timeout | null;
  };
  const wiped = () => db.log.some((q) => q.text.includes('delete from session_auth'));
  const lastPatch = () => db.log.filter((q) => q.patch).at(-1)?.patch;
  return { runner, internals, db, onStopped, connect, wiped, lastPatch };
}

describe('session lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps credentials on a first logout (401) and stops the session', async () => {
    const t = makeRunner();
    await t.internals.onClose({ reason: 'logged_out', statusCode: 401, message: 'Connection Failure' });
    expect(t.wiped()).toBe(false);
    expect(t.lastPatch()).toMatchObject({ status: 'logged_out', desired_state: 'stopped', worker_id: null });
    expect(t.onStopped).toHaveBeenCalledWith('s1');
  });

  it('wipes credentials only when a reconnect is refused with 401 again, then shows a QR', async () => {
    const t = makeRunner();
    t.internals.confirmingLogout = true; // started from logged_out (the user reconnected)
    await t.internals.onClose({ reason: 'logged_out', statusCode: 401, message: 'Connection Failure' });
    expect(t.wiped()).toBe(true);
    // The wipe is fenced on ownership like every other auth write.
    expect(t.db.log.some((q) => q.text.includes('for share'))).toBe(true);
    expect(t.connect).toHaveBeenCalledTimes(1);
    expect(t.onStopped).not.toHaveBeenCalled();
  });

  it('does not wipe when the confirming wipe is refused (another worker owns the session)', async () => {
    const t = makeRunner();
    t.internals.confirmingLogout = true;
    t.db.state.owned = false;
    await t.internals.onClose({ reason: 'logged_out', statusCode: 401, message: 'x' });
    expect(t.wiped()).toBe(false);
    expect(t.connect).not.toHaveBeenCalled();
  });

  it('keeps retrying when the database is down while recording a disconnect', async () => {
    const t = makeRunner();
    t.db.state.failSessionWrites = true;
    await t.internals.onClose({ reason: 'error', statusCode: 428, message: 'Connection Closed' });
    expect(t.internals.reconnectTimer).not.toBeNull();
    expect(t.runner.stalled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.connect).toHaveBeenCalledTimes(1);
    expect(t.wiped()).toBe(false);
  });

  it('never gives up on transient failures: after many attempts it shows needs_attention and retries slowly', async () => {
    const t = makeRunner();
    t.internals.reconnects = 20;
    await t.internals.onClose({ reason: 'error', statusCode: 408, message: 'timed out' });
    expect(t.lastPatch()).toMatchObject({ status: 'needs_attention' });
    expect(t.lastPatch()).not.toHaveProperty('desired_state');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(t.connect).toHaveBeenCalledTimes(1);
    expect(t.onStopped).not.toHaveBeenCalled();
  });

  it('stops for good on 403 (refused account) without touching credentials', async () => {
    const t = makeRunner();
    await t.internals.onClose({ reason: 'error', statusCode: 403, message: 'forbidden' });
    expect(t.wiped()).toBe(false);
    expect(t.lastPatch()).toMatchObject({ status: 'needs_attention', desired_state: 'stopped' });
  });

  it('halts without writing when another worker took the session', async () => {
    const t = makeRunner();
    t.db.state.owned = false;
    await t.internals.onClose({ reason: 'error', statusCode: 428, message: 'x' });
    expect(t.internals.reconnectTimer).toBeNull();
    expect(t.onStopped).toHaveBeenCalled();
    expect(t.wiped()).toBe(false);
  });

  it('reports a runner that ended up neither connected nor retrying as stalled', async () => {
    const t = makeRunner();
    expect(t.runner.stalled).toBe(true);
    await t.runner.stop();
    expect(t.runner.stalled).toBe(false);
  });
});
