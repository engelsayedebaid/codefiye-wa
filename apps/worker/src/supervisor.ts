import type { SessionSettings, Sql } from '@wa/db';
import { CHANNELS, type ControlMessage, type SessionStatus } from '@wa/shared';
import { type RunnerContext, SessionRunner } from './runner';

export type SupervisorOptions = Omit<RunnerContext, 'onStopped'> & {
  /** Dedicated LISTEN connection (direct URL). */
  listener: Sql;
  url: string;
  capacity: number;
  tickMs?: number;
};

/** A worker whose heartbeat is older than this loses its sessions to other workers (README §4.7). */
const HEARTBEAT_TIMEOUT = '30 seconds';
/** A runner stalled this long (several ticks, not a passing moment) is restarted. */
const STALL_RESTART_MS = 15_000;

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
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? 5_000);
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
    void this.tick();
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
    const { sql, workerId, url, capacity, logger } = this.options;

    await sql`
      insert into workers (id, url, capacity, session_count, heartbeat_at)
      values (${workerId}, ${url}, ${capacity}, ${this.runners.size}, now())
      on conflict (id) do update set url = excluded.url, capacity = excluded.capacity,
        session_count = excluded.session_count, heartbeat_at = now()`;

    // 1. Stop runners whose session was deleted, stopped by the user, or taken by another worker.
    const local = [...this.runners.keys()];
    if (local.length > 0) {
      const rows = await sql<{ id: string; desired_state: string; worker_id: string | null; settings: SessionSettings }[]>`
        select id, desired_state, worker_id, settings from sessions where id = any(${local}::uuid[])`;
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const [id, runner] of this.runners) {
        const row = byId.get(id);
        if (!row || row.desired_state !== 'running' || row.worker_id !== workerId) {
          logger.info({ sessionId: id }, 'stopping session');
          await runner.stop();
        } else if (this.stalledFor(runner) > STALL_RESTART_MS) {
          // Safety net: a runner that ended up neither connected nor retrying is restarted (released
          // here, claimed again below or on the next tick) instead of leaving the session dead.
          logger.warn({ sessionId: id }, 'session runner stalled; restarting it');
          await runner.stop();
        } else {
          runner.settings = row.settings;
        }
      }
      await sql`
        update sessions set last_seen_at = now()
        where id = any(${[...this.runners.values()].filter((r) => r.connected).map((r) => r.sessionId)}::uuid[])
          and worker_id = ${workerId}`;
    }

    // 2. Claim sessions that should run but have no live owner.
    const free = capacity - this.runners.size;
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
    await this.running;
    await Promise.allSettled([...this.runners.values()].map((r) => r.stop()));
    await this.options.sql`delete from workers where id = ${this.options.workerId}`;
  }
}
