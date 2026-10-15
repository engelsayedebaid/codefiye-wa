import type { Sql } from '@wa/db';
import { ProviderError } from '@wa/provider';
import type { ControlMessage, RpcResult } from '@wa/shared';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { describeRpcError, dispatch } from '../src/rpc';
import { Supervisor } from '../src/supervisor';
import { TimeoutError } from '../src/timeout';

/** Records `pg_notify` payloads (the relay's answers). */
function fakeSql() {
  const notified: { channel: string; payload: RpcResult }[] = [];
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (strings.join('?').includes('pg_notify')) notified.push({ channel: values[0] as string, payload: JSON.parse(values[1] as string) });
    return [];
  };
  return { sql: tag as unknown as Sql, notified };
}

const sessionId = '0f0f0f0f-0000-4000-8000-000000000001';

function makeSupervisor() {
  const db = fakeSql();
  const runner = {
    sendDirect: vi.fn(async (to: string) => ({ waMessageId: `wa:${to}` })),
    isOnWhatsAppLookup: vi.fn(async (phones: string[]) => phones.map((phone) => ({ phone, exists: true }))),
    groupMembers: vi.fn(async () => Array.from({ length: 400 }, (_, i) => ({ jid: `${i}@s.whatsapp.net`, name: 'x'.repeat(20) }))),
  };
  const supervisor = new Supervisor({ sql: db.sql, logger: pino({ level: 'silent' }) } as never);
  (supervisor as unknown as { runners: Map<string, unknown> }).runners.set(sessionId, runner);
  const control = (message: ControlMessage) => (supervisor as unknown as { onControl(payload: string): void }).onControl(JSON.stringify(message));
  const answer = async () => {
    await vi.waitFor(() => expect(db.notified.length).toBeGreaterThan(0));
    return db.notified.shift()!;
  };
  return { supervisor, runner, db, control, answer };
}

describe('rpc dispatch', () => {
  it('runs the same actions as the HTTP routes', async () => {
    const t = makeSupervisor();
    expect(await dispatch(t.supervisor, sessionId, 'send-text', { to: '201000000001', text: 'hi' })).toEqual({ waMessageId: 'wa:201000000001' });
    expect(await dispatch(t.supervisor, sessionId, 'on-whatsapp', { phones: ['+201000000001'] })).toEqual({ results: [{ phone: '+201000000001', exists: true }] });
    await expect(dispatch(t.supervisor, sessionId, 'send-text', { to: 'abc', text: 'hi' })).rejects.toMatchObject({ name: 'ZodError' });
    await expect(dispatch(t.supervisor, sessionId, 'no-such-action', {})).rejects.toMatchObject({ name: 'UnknownAction' });
    await expect(dispatch(t.supervisor, '0f0f0f0f-0000-4000-8000-000000000002', 'send-text', { to: '201000000001', text: 'hi' })).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('describes failures with the status the HTTP server would send', () => {
    expect(describeRpcError(new ProviderError('invalid_input', 'bad number'))).toMatchObject({ status: 422, code: 'invalid_input' });
    expect(describeRpcError(new ProviderError('not_connected', 'off'))).toMatchObject({ status: 409, code: 'not_connected' });
    expect(describeRpcError(new TimeoutError('slow'))).toMatchObject({ status: 504, code: 'timeout' });
    expect(describeRpcError(new Error('boom'))).toMatchObject({ status: 500, code: 'internal' });
  });
});

describe('rpc relayed over wa_control', () => {
  it('answers calls for sessions it owns on wa_rpc, in the HTTP shape', async () => {
    const t = makeSupervisor();
    t.control({ type: 'rpc', sessionId, requestId: 'r1', action: 'send-text', body: { to: '201000000001', text: 'code 123456' } });
    expect(await t.answer()).toEqual({ channel: 'wa_rpc', payload: { requestId: 'r1', ok: true, data: { waMessageId: 'wa:201000000001' } } });

    t.control({ type: 'rpc', sessionId, requestId: 'r2', action: 'send-text', body: { to: 'nope', text: 'x' } });
    expect((await t.answer()).payload).toMatchObject({ requestId: 'r2', ok: false, status: 422, code: 'invalid_input' });

    t.runner.sendDirect.mockRejectedValueOnce(new ProviderError('invalid_input', 'This number is not on WhatsApp'));
    t.control({ type: 'rpc', sessionId, requestId: 'r3', action: 'send-text', body: { to: '201000000001', text: 'x' } });
    expect((await t.answer()).payload).toMatchObject({ requestId: 'r3', ok: false, status: 422, message: 'This number is not on WhatsApp' });
  });

  it('stays silent for sessions another worker owns', async () => {
    const t = makeSupervisor();
    t.control({ type: 'rpc', sessionId: '0f0f0f0f-0000-4000-8000-000000000002', requestId: 'r4', action: 'send-text', body: { to: '201000000001', text: 'x' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(t.db.notified).toEqual([]);
    expect(t.runner.sendDirect).not.toHaveBeenCalled();
  });

  it('refuses answers that would not fit a NOTIFY payload', async () => {
    const t = makeSupervisor();
    t.control({ type: 'rpc', sessionId, requestId: 'r5', action: 'group-members', body: { jid: '1234567890@g.us' } });
    expect((await t.answer()).payload).toMatchObject({ requestId: 'r5', ok: false, code: 'too_large' });
  });
});
