import { Worker, createPostgresBackend, setDefaultBackendFactory } from 'bullmq';
import { and, createDb, createEventBus, eq, queueConnection, sessions, sql, workers } from '@wa/db';
import { QUEUES, type SendJob, type WorkerCommand } from '@wa/shared';
import { config, logger } from './config';
import { SessionManager } from './session-manager';

setDefaultBackendFactory(createPostgresBackend);

const db = createDb();
const bus = createEventBus();
const manager = new SessionManager(db, bus);

async function heartbeat() {
  await db
    .insert(workers)
    .values({ id: config.workerId, sessions: manager.size, maxSessions: config.maxSessions, lastSeenAt: new Date() })
    .onConflictDoUpdate({
      target: workers.id,
      set: { sessions: manager.size, maxSessions: config.maxSessions, lastSeenAt: sql`now()` },
    });
}

async function handle(cmd: WorkerCommand) {
  switch (cmd.op) {
    case 'connect':
      await manager.start(cmd.sessionId);
      return { status: manager.get(cmd.sessionId)?.status };
    case 'disconnect':
      await manager.stop(cmd.sessionId, 'disconnect');
      return { status: 'disconnected' };
    case 'logout':
      await manager.stop(cmd.sessionId, 'logout');
      return { status: 'logged_out' };
    case 'pairing-code': {
      const provider = manager.get(cmd.sessionId) ?? (await manager.start(cmd.sessionId));
      return { code: await provider.requestPairingCode(cmd.phone) };
    }
    case 'on-whatsapp': {
      const provider = manager.get(cmd.sessionId);
      if (!provider) throw new Error('SESSION_NOT_CONNECTED');
      return provider.isOnWhatsApp(cmd.jid);
    }
  }
}

async function main() {
  await heartbeat();
  const hb = setInterval(() => void heartbeat().catch((err) => logger.error({ err }, 'heartbeat failed')), config.heartbeatMs);

  const rpc = new Worker<WorkerCommand>(QUEUES.rpc(config.workerId), (job) => handle(job.data), {
    connection: queueConnection(),
    concurrency: 10,
  });
  rpc.on('failed', (job, err) => logger.warn({ op: job?.data.op, sessionId: job?.data.sessionId, err: err.message }, 'rpc failed'));

  // High concurrency is cheap: slots mostly await per-session chains in SessionManager.
  const send = new Worker<SendJob>(QUEUES.send(config.workerId), (job) => manager.processSend(job), {
    connection: queueConnection(),
    concurrency: Math.max(config.maxSessions * 2, 20),
  });
  send.on('failed', (job, err) => logger.warn({ sessionId: job?.data.sessionId, jobId: job?.id, err: err.message }, 'send failed'));

  const owned = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.workerId, config.workerId), eq(sessions.autoConnect, true)));
  logger.info({ count: owned.length }, 'resuming sessions');
  for (const { id } of owned) await manager.start(id).catch((err) => logger.error({ err, sessionId: id }, 'resume failed'));

  logger.info('worker ready');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    clearInterval(hb);
    await Promise.allSettled([rpc.close(), send.close()]);
    await manager.stopAll();
    await db.delete(workers).where(eq(workers.id, config.workerId)).catch(() => {});
    await Promise.allSettled([bus.close(), db.close()]);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
