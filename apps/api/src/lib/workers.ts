import { randomUUID } from 'node:crypto';
import { notify, type Sql } from '@wa/db';
import { CHANNELS, type ControlMessage, type RpcResult } from '@wa/shared';
import { ApiError, conflict, unprocessable } from './errors';

const LIVE = '30 seconds';
/** A worker URL that refused the connection is not retried over HTTP for this long; calls go through the relay. */
const UNREACHABLE_FOR_MS = 60_000;
/** Connection-level failures: the worker's address can't be reached from here (DNS, routing, refused). */
const UNREACHABLE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);

export type WorkerAction = 'on-whatsapp' | 'pairing-code' | 'logout' | 'send-text' | 'watch-chat' | 'chat-state' | 'react' | 'read' | 'profile' | 'group-members' | 'reupload-media' | 'fetch-history' | 'pictures';

/** Where relayed answers arrive (the EventBus listens on `wa_rpc`). */
export type RpcRelay = { waitRpc(requestId: string, timeoutMs: number): Promise<RpcResult | null> };

/**
 * Calls the worker that currently holds a session's socket (see apps/worker/src/rpc.ts).
 *
 * Normally over HTTP to the URL the worker registered. When that address isn't reachable from this
 * API — the worker runs on another network, e.g. a dev API while the session lives on Railway, or
 * the other way round — the call is relayed through Postgres instead: `NOTIFY wa_control` carries
 * the request, the owning worker answers on `wa_rpc`. Only connection failures trigger the relay;
 * a worker that was reached but is slow never gets the same call twice.
 */
export class WorkerClient {
  private readonly unreachableUntil = new Map<string, number>();

  constructor(
    private readonly sql: Sql,
    private readonly secret: string,
    private readonly relay?: RpcRelay,
  ) {}

  async liveWorkers(): Promise<number> {
    const [row] = await this.sql<{ n: number }[]>`
      select count(*)::int as n from workers where heartbeat_at > now() - ${LIVE}::interval`;
    return row?.n ?? 0;
  }

  async call<T>(sessionId: string, action: WorkerAction, body: unknown = {}, { timeoutMs = 20_000 } = {}): Promise<T> {
    const [worker] = await this.sql<{ url: string }[]>`
      select w.url from sessions s join workers w on w.id = s.worker_id
      where s.id = ${sessionId} and w.heartbeat_at > now() - ${LIVE}::interval`;
    if (!worker) throw conflict('Session is not running. Connect it first.', 'session_not_running');

    if ((this.unreachableUntil.get(worker.url) ?? 0) > Date.now()) return this.relayed<T>(sessionId, action, body, timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${worker.url}/sessions/${sessionId}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-secret': this.secret },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (!this.relay || !isUnreachable(err)) throw new ApiError(502, 'Session worker is unreachable', undefined, { code: 'worker_unreachable' });
      this.unreachableUntil.set(worker.url, Date.now() + UNREACHABLE_FOR_MS);
      return this.relayed<T>(sessionId, action, body, timeoutMs);
    }
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    if (res.ok) return data as T;
    throw failure(res.status, data.message);
  }

  private async relayed<T>(sessionId: string, action: WorkerAction, body: unknown, timeoutMs: number): Promise<T> {
    if (!this.relay) throw new ApiError(502, 'Session worker is unreachable', undefined, { code: 'worker_unreachable' });
    const requestId = randomUUID();
    // Subscribe before publishing: the answer can't slip through in between.
    const answer = this.relay.waitRpc(requestId, timeoutMs);
    const message: ControlMessage = { type: 'rpc', sessionId, requestId, action, body };
    try {
      await notify(this.sql, CHANNELS.control, message);
    } catch {
      throw new ApiError(502, 'Session worker is unreachable', undefined, { code: 'worker_unreachable' });
    }
    const result = await answer;
    if (!result) throw new ApiError(502, 'Session worker did not answer', undefined, { code: 'worker_unreachable' });
    if (result.ok) return result.data as T;
    throw failure(result.status, result.message);
  }
}

/** The API error for a worker answer that isn't a success, over HTTP or the relay alike. */
function failure(status: number, message: string | undefined): ApiError {
  if (status === 409) return conflict(message ?? 'Session is not connected', 'session_not_connected');
  if (status === 422) return unprocessable(message ?? 'Invalid input');
  if (status === 504) return new ApiError(504, 'WhatsApp did not respond in time. Try again.', undefined, { code: 'whatsapp_timeout' });
  return new ApiError(502, 'Session worker request failed', undefined, { code: 'worker_failed' });
}

function isUnreachable(err: unknown): boolean {
  // undici wraps the socket error: `TypeError: fetch failed` with the cause underneath (an AbortSignal
  // timeout is a plain `TimeoutError` with no cause — the worker may well have done the work).
  const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
  return typeof cause?.code === 'string' && UNREACHABLE_CODES.has(cause.code);
}
