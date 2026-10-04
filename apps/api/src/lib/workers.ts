import type { Sql } from '@wa/db';
import { ApiError, conflict, unprocessable } from './errors';

const LIVE = '30 seconds';

export type WorkerAction = 'on-whatsapp' | 'pairing-code' | 'logout' | 'send-text' | 'watch-chat' | 'chat-state' | 'read' | 'profile' | 'reupload-media' | 'fetch-history' | 'pictures';

/** Calls the worker that currently holds a session's socket (see apps/worker/src/rpc.ts). */
export class WorkerClient {
  constructor(
    private readonly sql: Sql,
    private readonly secret: string,
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

    let res: Response;
    try {
      res = await fetch(`${worker.url}/sessions/${sessionId}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-secret': this.secret },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ApiError(502, 'Session worker is unreachable', undefined, { code: 'worker_unreachable' });
    }
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    if (res.ok) return data as T;
    if (res.status === 409) throw conflict(data.message ?? 'Session is not connected', 'session_not_connected');
    if (res.status === 422) throw unprocessable(data.message ?? 'Invalid input');
    if (res.status === 504) throw new ApiError(504, 'WhatsApp did not respond in time. Try again.', undefined, { code: 'whatsapp_timeout' });
    throw new ApiError(502, 'Session worker request failed', undefined, { code: 'worker_failed' });
  }
}
