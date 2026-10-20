import { notify, type SessionSettings, type Sql } from '@wa/db';
import { CHANNELS, type ControlMessage, type RpcResult, type SessionStatus } from '@wa/shared';
import { describeRpcError, dispatch } from './rpc';
import { type RunnerContext, SessionRunner } from './runner';

export type SupervisorOptions = Omit<RunnerContext, 'onStopped'> & {
  /** Dedicated LISTEN connection (direct URL). */
  listener: Sql;
  url: string;
  capacity: number;
  tickMs?: number;
  /**
   * Whether this worker takes sessions (default true). A dev machine's worker on the production
   * database leaves them to the deployed one (WORKER_CLAIM in config.ts) and hands back any it held.
   */
  claim?: boolean;
};

/** A worker whose heartbeat is older than this loses its sessions to other workers (README §4.7). */
const HEARTBEAT_TIMEOUT = '60 seconds';
/**
 * A worker that couldn't heartbeat for this long closes its sockets itself (`fence`). Well under
 * HEARTBEAT_TIMEOUT: a session is only taken over after its old socket is closed, since WhatsApp
 * logs a linked device out when it sees it connected from two places at once.
 */
const SELF_FENCE_MS = 30_000;
const FENCE_CHECK_MS = 2_000;
/** A runner stalled this long (several ticks, not a passing moment) is restarted. */
const STALL_RESTART_MS = 15_000;
/** NOTIFY payloads are capped at 8000 bytes; a relayed answer above this is refused rather than lost. */
const RPC_RESULT_MAX_BYTES = 7_500;
/** How often the AI agent looks for quiet conversations to summarize. */
const SUMMARY_EVERY_MS = 60_000;

/**
 * Distributed supervisor: every worker runs one. Each tick it heartbeats, drops sessions it no
 * longer owns or that should stop, claims unowned/orphaned sessions up to capacity (SKIP LOCKED,
 * so workers never double-claim), and nudges sessions that have queued messages.
 */
export class Supervisor {
  private readonly runners = new Map<string, SessionRunner>();
  /** First tick each runner was seen stalled (see SessionRunner.stalled). */
  private readonly stalledSince = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private fenceTimer: NodeJS.Timeout | null = null;
  private beatTimer: NodeJS.Timeout | null = null;
  private summaryTimer: NodeJS.Timeout | null = null;
  private beating = false;
  /** When the last heartbeat that reached the database was sent (local clock). */
  private lastBeat = Date.now();
  private running: Promise<void> | null = null;
  private again = false;
  private stopping = false;

  constructor(private readonly options: SupervisorOptions) {}

  get size() {
    return this.runners.size;
  }

  runner(sessionId: string) {
    return this.runners.get(sessionId);
  }

  async start() {
    let subscribed = false;
    await this.options.listener.listen(
      CHANNELS.control,
      (payload) => this.onControl(payload),
      // After a reconnect, notifications sent in the gap are lost: reconcile now rather than at the next tick.
      () => {
        if (subscribed) void this.tick();
        subscribed = true;
      },
    );
    await this.heartbeat();
    await this.tick();
    const every = this.options.tickMs ?? 5_000;
    // On its own timer: a slow reconcile pass (a stop waiting on a credentials flush) must not look
    // like a lost database and fence every session.
    this.beatTimer = setInterval(() => void this.heartbeat(), every);
    this.timer = setInterval(() => void this.tick(), every);
    this.fenceTimer = setInterval(() => void this.fenceIfCutOff(), FENCE_CHECK_MS);
    // Conversation summaries for the numbers' owners, from the sessions this worker runs (connected only).
    this.summaryTimer = setInterval(() => {
      const connected = [...this.runners.values()].filter((r) => r.connected).map((r) => r.sessionId);
      void this.options.autoReply.summarize?.(connected, (id) => this.runners.get(id)?.requestDrain());
    }, SUMMARY_EVERY_MS);
    if (this.options.claim === false) {
      this.options.logger.warn('WORKER_CLAIM is off: this worker runs no sessions (they stay with the deployed worker)');
    }
  }

  /** Tells the other workers this one is alive; a failure only shows as silence (see fenceIfCutOff). */
  private async heartbeat() {
    if (this.beating || this.stopping) return;
    this.beating = true;
    const { sql, workerId, url, capacity, logger } = this.options;
    try {
      // Measured from when it was sent: the database's heartbeat_at is never earlier than this.
      const beat = Date.now();
      await sql`
        insert into workers (id, url, capacity, session_count, heartbeat_at)
        values (${workerId}, ${url}, ${capacity}, ${this.runners.size}, now())
        on conflict (id) do update set url = excluded.url, capacity = excluded.capacity,
          session_count = excluded.session_count, heartbeat_at = now()`;
      const silent = beat - this.lastBeat;
      // The machine slept (or the database was gone) and this ran before the fence check could:
      // those sockets may be someone else's sessions by now. Close them first.
      if (silent >= SELF_FENCE_MS) await this.fenceAll(silent);
      this.lastBeat = beat;
    } catch (err) {
      logger.warn({ err }, 'heartbeat failed');
    } finally {
      this.beating = false;
    }
  }

  /** No heartbeat for SELF_FENCE_MS (database unreachable, or the machine slept): close every socket now. */
  private async fenceIfCutOff() {
    const silent = Date.now() - this.lastBeat;
    if (silent >= SELF_FENCE_MS) await this.fenceAll(silent);
  }

  private async fenceAll(silentMs: number) {
    if (this.runners.size === 0) return;
    this.options.logger.warn({ silentMs, sessions: this.runners.size }, 'no heartbeat reached the database; closing sockets before another worker takes the sessions');
    await Promise.allSettled([...this.runners.values()].map((r) => r.fence()));
  }

  private onControl(payload: string) {
    let message: ControlMessage;
    try {
      message = JSON.parse(payload);
    } catch {
      return;
    }
    if (message.type === 'message.queued') {
      this.runners.get(message.sessionId)?.requestDrain();
      return;
    }
    if (message.type === 'sync.changed') {
      this.runners.get(message.sessionId)?.sync.interrupt();
      return;
    }
    if (message.type === 'rpc') {
      // Only the owner answers, so the API gets exactly one reply (or none: the session isn't running anywhere).
      if (this.runners.has(message.sessionId)) void this.answerRpc(message);
      return;
    }
    void this.tick();
  }

  /** An RPC call the API relayed through Postgres because it can't reach this worker's URL (see apps/api/src/lib/workers.ts). */
  private async answerRpc(message: Extract<ControlMessage, { type: 'rpc' }>) {
    const { sql, logger } = this.options;
    let result: RpcResult;
    try {
      const data = await dispatch(this, message.sessionId, message.action, message.body);
      result = { requestId: message.requestId, ok: true, data };
      if (Buffer.byteLength(JSON.stringify(result)) > RPC_RESULT_MAX_BYTES) {
        result = { requestId: message.requestId, ok: false, status: 500, code: 'too_large', message: 'The answer is too large to relay through Postgres' };
      }
    } catch (err) {
      const described = describeRpcError(err);
      if (described.status === 500) logger.error({ err, action: message.action, sessionId: message.sessionId }, 'relayed rpc error');
      result = { requestId: message.requestId, ok: false, ...described };
    }
    await notify(sql, CHANNELS.rpc, result).catch((err) => logger.warn({ err, action: message.action }, 'could not answer relayed rpc'));
  }

  /** Runs a reconcile pass; calls made while one is in flight coalesce into one more pass. */
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.reconcile();
        } while (this.again && !this.stopping);
      } catch (err) {
        this.options.logger.error({ err }, 'supervisor tick failed');
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async reconcile() {
    const { sql, workerId, capacity, logger } = this.options;
    // Cut off from the database: our sockets are being fenced, and nothing is claimed until a heartbeat lands.
    if (Date.now() - this.lastBeat >= SELF_FENCE_MS) return;

    // 1. Stop runners whose session was deleted, stopped by the user, or taken by another worker.
    const local = [...this.runners.keys()];
    if (local.length > 0) {
      const rows = await sql<{ id: string; desired_state: string; worker_id: string | null; settings: SessionSettings }[]>`
        select id, desired_state, worker_id, settings from sessions where id = any(${local}::uuid[])`;
      const byId = new Map(rows.map((r) => [r.id, r]));
      const stopping: SessionRunner[] = [];
      for (const [id, runner] of this.runners) {
        const row = byId.get(id);
        if (!row || row.desired_state !== 'running' || row.worker_id !== workerId) {
          logger.info({ sessionId: id }, 'stopping session');
          stopping.push(runner);
        } else if (this.stalledFor(runner) > STALL_RESTART_MS) {
          // Safety net: a runner that ended up neither connected nor retrying is restarted (released
          // here, claimed again below or on the next tick) instead of leaving the session dead.
          logger.warn({ sessionId: id }, 'session runner stalled; restarting it');
          stopping.push(runner);
        } else {
          runner.settings = row.settings;
        }
      }
      // Side by side: a stop can wait seconds on a credentials flush.
      await Promise.allSettled(stopping.map((r) => r.stop()));
      await sql`
        update sessions set last_seen_at = now()
        where id = any(${[...this.runners.values()].filter((r) => r.connected).map((r) => r.sessionId)}::uuid[])
          and worker_id = ${workerId}`;
    }

    // 2. Claim sessions that should run but have no live owner. A worker that doesn't claim (a dev
    // machine) hands back any it still holds from before, so the deployed worker can take them now
    // instead of waiting for this one's heartbeat to stop.
    if (this.options.claim === false) {
      const released = await sql`
        update sessions set worker_id = null, updated_at = now()
        where worker_id = ${workerId} and not (id = any(${[...this.runners.keys()]}::uuid[]))
        returning id`;
      if (released.length > 0) logger.info({ released: released.length }, 'handed sessions back (WORKER_CLAIM is off)');
    }
    const free = this.options.claim === false ? 0 : capacity - this.runners.size;
    if (free > 0) {
      const claimed = await sql<{ id: string; workspace_id: string; settings: SessionSettings; status: SessionStatus }[]>`
        update sessions set worker_id = ${workerId}, updated_at = now()
        where id in (
          select id from sessions
          where desired_state = 'running'
            and not (id = any(${[...this.runners.keys()]}::uuid[]))
            and (worker_id is null or worker_id = ${workerId}
                 or worker_id not in (select id from workers where heartbeat_at > now() - ${HEARTBEAT_TIMEOUT}::interval))
          order by updated_at
          limit ${free}
          for update skip locked
        )
        returning id, workspace_id, settings, status`;
      for (const row of claimed) this.launch(row.id, row.workspace_id, row.settings, row.status);
    }

    // 3. Nudge connected sessions that have due queued messages: a fallback for missed NOTIFYs, and
    // how scheduled messages (paced broadcasts, `not_before`) get sent once their time comes.
    const connected = [...this.runners.values()].filter((r) => r.connected).map((r) => r.sessionId);
    if (connected.length > 0) {
      const pending = await sql<{ session_id: string }[]>`
        select distinct session_id from messages
        where status = 'queued' and session_id = any(${connected}::uuid[]) and (not_before is null or not_before <= now())`;
      for (const { session_id } of pending) this.runners.get(session_id)?.requestDrain();

      // Sync jobs waiting for a slot, or left running by a missed NOTIFY or a previous worker.
      const syncing = await sql<{ session_id: string }[]>`
        select session_id from sync_jobs where status in ('queued', 'running') and session_id = any(${connected}::uuid[])`;
      for (const { session_id } of syncing) {
        const runner = this.runners.get(session_id);
        if (runner && !runner.sync.busy) runner.sync.request();
      }
    }
  }

  /** How long a runner has been stalled, as seen by consecutive ticks (0 = it is not). */
  private stalledFor(runner: SessionRunner) {
    if (!runner.stalled) {
      this.stalledSince.delete(runner.sessionId);
      return 0;
    }
    const since = this.stalledSince.get(runner.sessionId) ?? Date.now();
    this.stalledSince.set(runner.sessionId, since);
    return Date.now() - since;
  }

  private launch(sessionId: string, workspaceId: string, settings: SessionSettings, status: SessionStatus) {
    const { logger } = this.options;
    logger.info({ sessionId }, 'starting session');
    const runner = new SessionRunner(sessionId, workspaceId, settings, {
      ...this.options,
      onStopped: (id) => {
        this.stalledSince.delete(id);
        if (this.runners.get(id) === runner) this.runners.delete(id);
      },
    });
    this.runners.set(sessionId, runner);
    runner.start(status).catch(async (err) => {
      logger.error({ err, sessionId }, 'session failed to start');
      await runner.stop();
    });
  }

  /** Graceful shutdown: close every socket (devices stay linked) and hand sessions back. */
  async shutdown() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.beatTimer) clearInterval(this.beatTimer);
    if (this.fenceTimer) clearInterval(this.fenceTimer);
    if (this.summaryTimer) clearInterval(this.summaryTimer);
    await this.running;
    await Promise.allSettled([...this.runners.values()].map((r) => r.stop()));
    await this.options.sql`delete from workers where id = ${this.options.workerId}`;
  }
}
