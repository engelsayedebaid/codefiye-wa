import { Queue, QueueEvents, type JobsOptions } from 'bullmq';
import { eq, gt, queueConnection, workers, type Db } from '@wa/db';
import { QUEUES, WORKER_HEARTBEAT_TTL_MS, type SendJob, type WorkerCommand } from '@wa/shared';
import { config } from '../config';
import { HttpError, unavailable } from './errors';

/** Talks to session workers over BullMQ (Postgres backend): RPC queue + send queue per worker. */
export class WorkerBus {
  private rpcQueues = new Map<string, { queue: Queue<WorkerCommand>; events: QueueEvents }>();
  private sendQueues = new Map<string, Queue<SendJob>>();

  constructor(private readonly db: Db) {}

  private cutoff = () => new Date(Date.now() - WORKER_HEARTBEAT_TTL_MS);

  aliveWorkers() {
    return this.db.select().from(workers).where(gt(workers.lastSeenAt, this.cutoff()));
  }

  async isAlive(workerId: string) {
    const w = await this.db.query.workers.findFirst({ where: eq(workers.id, workerId) });
    return !!w && w.lastSeenAt > this.cutoff();
  }

  /** Least-loaded live worker with free capacity. The Supervisor will take over this in phase 1. */
  async pickWorker(): Promise<string> {
    const candidates = (await this.aliveWorkers()).filter((w) => w.sessions < w.maxSessions).sort((a, b) => a.sessions - b.sessions);
    if (!candidates[0]) throw unavailable('No session workers available');
    return candidates[0].id;
  }

  private rpcFor(workerId: string) {
    let entry = this.rpcQueues.get(workerId);
    if (!entry) {
      const name = QUEUES.rpc(workerId);
      entry = {
        queue: new Queue<WorkerCommand>(name, { connection: queueConnection() }),
        events: new QueueEvents(name, { connection: queueConnection() }),
      };
      this.rpcQueues.set(workerId, entry);
    }
    return entry;
  }

  async rpc<T = unknown>(workerId: string, cmd: WorkerCommand, timeoutMs = config.rpcTimeoutMs): Promise<T> {
    if (!(await this.isAlive(workerId))) throw unavailable(`Worker ${workerId} is offline`);
    const { queue, events } = this.rpcFor(workerId);
    const job = await queue.add(cmd.op, cmd, { removeOnComplete: 100, removeOnFail: 100, attempts: 1 });
    try {
      return (await job.waitUntilFinished(events, timeoutMs)) as T;
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('SESSION_NOT_CONNECTED') || message.includes('is not connected')) throw new HttpError(409, 'Session is not connected');
      if (message.includes('timed out')) throw new HttpError(504, `Worker did not respond to ${cmd.op}`);
      throw new HttpError(502, message);
    }
  }

  async enqueueSend(workerId: string, job: SendJob, opts: JobsOptions = {}) {
    let queue = this.sendQueues.get(workerId);
    if (!queue) {
      queue = new Queue<SendJob>(QUEUES.send(workerId), { connection: queueConnection() });
      this.sendQueues.set(workerId, queue);
    }
    return queue.add('send', job, {
      jobId: job.messageId,
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
      ...opts,
    });
  }

  async close() {
    await Promise.allSettled([
      ...[...this.rpcQueues.values()].flatMap((e) => [e.queue.close(), e.events.close()]),
      ...[...this.sendQueues.values()].map((q) => q.close()),
    ]);
  }
}
