import {
  addSyncLog,
  createSyncJob,
  latestSyncJob,
  notify,
  retryFailedSyncChats,
  type SyncJob,
  setSyncStatus,
  syncLogs,
  syncProgress,
} from '@wa/db';
import {
  CHANNELS,
  ok,
  SYNC_LOG_CODES,
  SYNC_LOG_LEVELS,
  SYNC_PAUSE_REASONS,
  SYNC_STATUSES,
  type SyncLogCode,
  type SyncLogLevel,
  successSchema,
  type WaEvent,
} from '@wa/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps';
import { ownedSession } from '../lib/auth';
import { conflict, notFound } from '../lib/errors';

const schemaBase = { tags: ['Admin'], hide: true };
const sessionParams = z.object({ sessionId: z.uuid() });

const progressDto = z.object({
  jobId: z.uuid(),
  status: z.enum(SYNC_STATUSES),
  pauseReason: z.enum(SYNC_PAUSE_REASONS).nullable(),
  chatsTotal: z.number(),
  chatsDone: z.number(),
  chatsFailed: z.number(),
  messagesAdded: z.number(),
  current: z.object({ jid: z.string(), name: z.string().nullable() }).nullable(),
  error: z.string().nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
});

const logDto = z.object({
  id: z.number(),
  at: z.string(),
  level: z.enum(SYNC_LOG_LEVELS),
  code: z.enum(SYNC_LOG_CODES),
  params: z.record(z.string(), z.unknown()),
});

/** What each control does: the states it applies from, the state it leads to, and the log line it leaves. */
const ACTIONS = {
  pause: { from: ['queued', 'running'], to: 'paused', log: ['info', 'paused'] },
  resume: { from: ['paused'], to: 'queued', log: null },
  cancel: { from: ['queued', 'running', 'paused'], to: 'cancelled', log: ['warning', 'cancelled'] },
} as const satisfies Record<string, { from: SyncJob['status'][]; to: SyncJob['status']; log: readonly [SyncLogLevel, SyncLogCode] | null }>;

/**
 * Conversation sync (dashboard `/chats`): start a job for a number, follow it, and control it. The
 * number's worker runs the job (apps/worker/src/sync.ts); these routes only change its state and
 * wake the worker. Registered inside the chats routes, so the plan gate applies.
 */
export function chatSyncRoutes({ sql }: Deps): FastifyPluginAsyncZod {
  const publish = (event: WaEvent) => notify(sql, CHANNELS.events, event);
  const wake = (sessionId: string) => notify(sql, CHANNELS.control, { type: 'sync.changed', sessionId });
  const announce = async (job: SyncJob, line?: readonly [SyncLogLevel, SyncLogCode]) => {
    const base = { workspaceId: job.workspace_id, sessionId: job.session_id };
    if (line) {
      const entry = await addSyncLog(sql, job.id, line[0], line[1]);
      await publish({ ...base, type: 'sync.log', data: { ...entry, jobId: job.id } });
    }
    await publish({ ...base, type: 'sync.progress', data: syncProgress(job) });
    await wake(job.session_id);
  };

  return async (app) => {
    app.get(
      '/:sessionId/sync-job',
      {
        schema: {
          ...schemaBase,
          summary: "The number's latest conversation sync, with its latest log lines",
          params: sessionParams,
          response: { 200: successSchema(z.object({ job: progressDto.nullable(), logs: z.array(logDto) })) },
        },
      },
      async (req) => {
        const session = await ownedSession(sql, req, req.params.sessionId);
        const job = await latestSyncJob(sql, session.id);
        return ok({ job: job ? syncProgress(job) : null, logs: job ? await syncLogs(sql, job.id, { limit: 300 }) : [] });
      },
    );

    app.get(
      '/:sessionId/sync-job/:jobId/logs',
      {
        schema: {
          ...schemaBase,
          summary: 'Older log lines of a sync job',
          params: sessionParams.extend({ jobId: z.uuid() }),
          querystring: z.object({ before: z.coerce.number().int().positive(), limit: z.coerce.number().int().min(1).max(500).default(200) }),
          response: { 200: successSchema(z.array(logDto)) },
        },
      },
      async (req) => {
        const session = await ownedSession(sql, req, req.params.sessionId);
        const [owned] = await sql`select 1 from sync_jobs where id = ${req.params.jobId} and session_id = ${session.id}`;
        if (!owned) throw notFound('Sync not found');
        return ok(await syncLogs(sql, req.params.jobId, { beforeId: req.query.before, limit: req.query.limit }));
      },
    );

    app.post(
      '/:sessionId/sync-job',
      {
        schema: {
          ...schemaBase,
          summary: "Start syncing the number's conversations (or return the sync already in progress)",
          description: 'Progress and log lines arrive as `sync.progress` and `sync.log` events.',
          params: sessionParams,
          response: { 200: successSchema(z.object({ job: progressDto, created: z.boolean() })) },
        },
      },
      async (req) => {
        const session = await ownedSession(sql, req, req.params.sessionId);
        if (session.desired_state !== 'running') throw conflict('Connect the number to sync its chats', 'session_not_connected');
        const { job, created } = await createSyncJob(sql, session.workspace_id, session.id);
        if (created) await announce(job);
        return ok({ job: syncProgress(job), created });
      },
    );

    app.post(
      '/:sessionId/sync-job/:jobId/:action',
      {
        schema: {
          ...schemaBase,
          summary: 'Pause, resume, cancel a sync, or retry its failed conversations',
          params: sessionParams.extend({ jobId: z.uuid(), action: z.enum(['pause', 'resume', 'cancel', 'retry']) }),
          response: { 200: successSchema(progressDto) },
        },
      },
      async (req) => {
        const session = await ownedSession(sql, req, req.params.sessionId);
        const { jobId, action } = req.params;
        const [owned] = await sql<{ status: SyncJob['status'] }[]>`select status from sync_jobs where id = ${jobId} and session_id = ${session.id}`;
        if (!owned) throw notFound('Sync not found');

        if (action === 'retry') {
          const job = await retryFailedSyncChats(sql, jobId);
          if (!job) throw conflict('Nothing to retry, or another sync of this number is in progress', 'sync_retry_unavailable');
          await announce(job, ['info', 'retrying_failed']);
          return ok(syncProgress(job));
        }
        const { from, to, log } = ACTIONS[action];
        const job = await setSyncStatus(sql, jobId, [...from], to, to === 'paused' ? { pauseReason: 'user' } : {});
        if (!job) throw conflict(`This sync can't be ${action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'cancelled'} now (it is ${owned.status})`, 'sync_state');
        await announce(job, log ?? undefined);
        return ok(syncProgress(job));
      },
    );
  };
}
