import type { SyncChatStatus, SyncLogCode, SyncLogEntry, SyncLogLevel, SyncLogParams, SyncPauseReason, SyncProgress, SyncStatus } from '@wa/shared';
import type { Sql } from './client';

/** Lines kept per job: the panel shows the latest; older ones are trimmed as new ones come. */
const LOG_KEEP = 1_000;

type JobRow = {
  id: string;
  workspace_id: string;
  session_id: string;
  status: SyncStatus;
  pause_reason: SyncPauseReason | null;
  chats_total: number;
  chats_done: number;
  chats_failed: number;
  messages_added: number;
  current_jid: string | null;
  current_name: string | null;
  error: string | null;
  started_at: Date;
  updated_at: Date;
  finished_at: Date | null;
};

export type SyncJob = JobRow;

export function syncProgress(job: JobRow): SyncProgress {
  return {
    jobId: job.id,
    status: job.status,
    pauseReason: job.pause_reason,
    chatsTotal: job.chats_total,
    chatsDone: job.chats_done,
    chatsFailed: job.chats_failed,
    messagesAdded: job.messages_added,
    current: job.current_jid ? { jid: job.current_jid, name: job.current_name } : null,
    error: job.error,
    startedAt: job.started_at.toISOString(),
    updatedAt: job.updated_at.toISOString(),
    finishedAt: job.finished_at?.toISOString() ?? null,
  };
}

export async function loadSyncJob(sql: Sql, jobId: string): Promise<SyncJob | null> {
  const [row] = await sql<JobRow[]>`select * from sync_jobs where id = ${jobId}`;
  return row ?? null;
}

/** The number's newest job (active or not), for the dashboard. */
export async function latestSyncJob(sql: Sql, sessionId: string): Promise<SyncJob | null> {
  const [row] = await sql<JobRow[]>`select * from sync_jobs where session_id = ${sessionId} order by started_at desc limit 1`;
  return row ?? null;
}

/** The number's job in progress (queued, running or paused), if any. */
export async function activeSyncJob(sql: Sql, sessionId: string): Promise<SyncJob | null> {
  const [row] = await sql<JobRow[]>`select * from sync_jobs where session_id = ${sessionId} and status in ('queued', 'running', 'paused')`;
  return row ?? null;
}

/**
 * Starts a job for the number, or returns the one already in progress (`created: false`): the
 * unique index on active jobs makes two simultaneous starts end with one job.
 */
export async function createSyncJob(sql: Sql, workspaceId: string, sessionId: string): Promise<{ job: SyncJob; created: boolean }> {
  const [row] = await sql<JobRow[]>`
    insert into sync_jobs (workspace_id, session_id) values (${workspaceId}, ${sessionId})
    on conflict (session_id) where status in ('queued', 'running', 'paused') do nothing
    returning *`;
  if (row) return { job: row, created: true };
  const existing = await activeSyncJob(sql, sessionId);
  if (existing) return { job: existing, created: false };
  // Finished between the two statements: try once more.
  return createSyncJob(sql, workspaceId, sessionId);
}

/**
 * Moves a job to `to` if it is in one of `from`; returns the updated row, or null if it wasn't.
 * Terminal states stamp `finished_at`; leaving `paused` clears the reason.
 */
export async function setSyncStatus(
  sql: Sql,
  jobId: string,
  from: SyncStatus[],
  to: SyncStatus,
  extra: { pauseReason?: SyncPauseReason | null; error?: string | null } = {},
): Promise<SyncJob | null> {
  const terminal = to === 'completed' || to === 'cancelled' || to === 'failed';
  const [row] = await sql<JobRow[]>`
    update sync_jobs set status = ${to},
      pause_reason = ${to === 'paused' ? (extra.pauseReason ?? 'user') : null},
      error = ${extra.error === undefined ? sql`error` : extra.error},
      current_jid = ${terminal ? null : sql`current_jid`},
      current_name = ${terminal ? null : sql`current_name`},
      finished_at = ${terminal ? sql`now()` : null},
      updated_at = now()
    where id = ${jobId} and status = any(${from}::text[])
    returning *`;
  return row ?? null;
}

/**
 * Lists the conversations to sync (newest first), once per job: a resumed job keeps its list and
 * each conversation's progress. Returns the job's total.
 */
export async function seedSyncChats(sql: Sql, jobId: string, sessionId: string): Promise<number> {
  return sql.begin(async (tx) => {
    const [job] = await tx<{ chats_total: number }[]>`select chats_total from sync_jobs where id = ${jobId} for update`;
    const [seeded] = await tx<{ n: number }[]>`select count(*)::int as n from sync_job_chats where job_id = ${jobId}`;
    if (seeded!.n > 0) return job!.chats_total;
    const [listed] = await tx<{ n: number }[]>`
      with listed as (
        insert into sync_job_chats (job_id, jid, name, position)
        select ${jobId}, c.jid, c.name, (row_number() over (order by c.last_message_at desc, c.jid))::int
        from chats c where c.session_id = ${sessionId}
        returning 1
      )
      select count(*)::int as n from listed`;
    const n = listed!.n;
    await tx`update sync_jobs set chats_total = ${n}, updated_at = now() where id = ${jobId}`;
    return n;
  });
}

export type SyncChat = { jid: string; name: string | null; pages: number; added: number; attempts: number; status: SyncChatStatus };

/** The next conversation to work on: one left `running` by an interrupted run first, then in order. */
export async function nextSyncChat(sql: Sql, jobId: string): Promise<SyncChat | null> {
  const [row] = await sql<SyncChat[]>`
    select jid, name, pages, added, attempts, status from sync_job_chats
    where job_id = ${jobId} and status in ('running', 'pending')
    order by status = 'running' desc, position
    limit 1`;
  return row ?? null;
}

/** Marks a conversation as being synced and shows it as the job's current one. */
export async function startSyncChat(sql: Sql, jobId: string, chat: { jid: string; name: string | null }): Promise<SyncJob | null> {
  await sql`update sync_job_chats set status = 'running', updated_at = now() where job_id = ${jobId} and jid = ${chat.jid}`;
  const [row] = await sql<JobRow[]>`
    update sync_jobs set current_jid = ${chat.jid}, current_name = ${chat.name}, updated_at = now()
    where id = ${jobId} returning *`;
  return row ?? null;
}

/** One page of a conversation stored: its counters and the job's, together. */
export async function recordSyncPage(sql: Sql, jobId: string, jid: string, added: number): Promise<SyncJob | null> {
  const [row] = await sql<JobRow[]>`
    with chat as (
      update sync_job_chats set pages = pages + 1, added = added + ${added}, attempts = 0, error = null, updated_at = now()
      where job_id = ${jobId} and jid = ${jid}
    )
    update sync_jobs set messages_added = messages_added + ${added}, updated_at = now()
    where id = ${jobId} returning *`;
  return row ?? null;
}

/** A request for this conversation went unanswered; returns its attempts so far. */
export async function recordSyncAttempt(sql: Sql, jobId: string, jid: string, error: string): Promise<number> {
  const [row] = await sql<{ attempts: number }[]>`
    update sync_job_chats set attempts = attempts + 1, error = ${error}, updated_at = now()
    where job_id = ${jobId} and jid = ${jid} returning attempts`;
  return row?.attempts ?? 0;
}

/** Ends a conversation (`done` or `failed`) and counts it on the job — once, even if called again. */
export async function finishSyncChat(sql: Sql, jobId: string, jid: string, status: 'done' | 'failed', error: string | null = null): Promise<SyncJob | null> {
  const [row] = await sql<JobRow[]>`
    with chat as (
      update sync_job_chats set status = ${status}, error = ${error}, updated_at = now()
      where job_id = ${jobId} and jid = ${jid} and status in ('pending', 'running')
      returning 1
    )
    update sync_jobs set
      chats_done = chats_done + (select count(*)::int from chat where ${status} = 'done'),
      chats_failed = chats_failed + (select count(*)::int from chat where ${status} = 'failed'),
      updated_at = now()
    where id = ${jobId} returning *`;
  return row ?? null;
}

/**
 * Puts the failed conversations of a job back in line and reopens it (`queued`). Works on a
 * finished job too, so "retry failed" never needs a new one. Null if there was nothing to retry
 * or the number already has another job in progress.
 */
export async function retryFailedSyncChats(sql: Sql, jobId: string): Promise<SyncJob | null> {
  return sql.begin(async (tx) => {
    const reset = await tx`
      update sync_job_chats set status = 'pending', attempts = 0, error = null, updated_at = now()
      where job_id = ${jobId} and status = 'failed' returning 1`;
    if (reset.length === 0) return null;
    const [row] = await tx<JobRow[]>`
      update sync_jobs j set status = 'queued', pause_reason = null, error = null, finished_at = null,
        chats_failed = greatest(0, chats_failed - ${reset.length}), updated_at = now()
      where id = ${jobId} and status <> 'cancelled'
        and not exists (select 1 from sync_jobs o where o.session_id = j.session_id and o.id <> j.id and o.status in ('queued', 'running', 'paused'))
      returning *`;
    if (!row) throw new RetryRefused();
    return row;
  }).catch((err) => {
    if (err instanceof RetryRefused) return null;
    throw err;
  });
}
class RetryRefused extends Error {}

/** Appends a log line (trimming the oldest beyond LOG_KEEP now and then). */
export async function addSyncLog(sql: Sql, jobId: string, level: SyncLogLevel, code: SyncLogCode, params: SyncLogParams = {}): Promise<SyncLogEntry> {
  const [row] = await sql<{ id: number; created_at: Date }[]>`
    insert into sync_job_logs (job_id, level, code, params) values (${jobId}, ${level}, ${code}, ${sql.json(params as never)})
    returning id, created_at`;
  if (row!.id % 100 === 0) {
    await sql`
      delete from sync_job_logs where job_id = ${jobId}
        and id < (select id from sync_job_logs where job_id = ${jobId} order by id desc offset ${LOG_KEEP} limit 1)`;
  }
  return { id: row!.id, at: row!.created_at.toISOString(), level, code, params };
}

/** The latest lines of a job (oldest first), or those before `beforeId` when paging back. */
export async function syncLogs(sql: Sql, jobId: string, { beforeId, limit = 200 }: { beforeId?: number; limit?: number } = {}): Promise<SyncLogEntry[]> {
  const rows = await sql<{ id: number; level: SyncLogLevel; code: SyncLogCode; params: SyncLogParams; created_at: Date }[]>`
    select id, level, code, params, created_at from sync_job_logs
    where job_id = ${jobId} ${beforeId ? sql`and id < ${beforeId}` : sql``}
    order by id desc limit ${limit}`;
  return rows.reverse().map((r) => ({ id: r.id, at: r.created_at.toISOString(), level: r.level, code: r.code, params: r.params }));
}

/** Where older history of a conversation is asked from (structurally the provider's HistoryAnchor). */
export type SyncAnchor = { chatJid: string; id: string; fromMe: boolean; timestampMs: number };

/** The oldest message we hold of a conversation (under either of its addresses): where older history is asked from. */
export async function oldestAnchor(sql: Sql, sessionId: string, jids: string[]): Promise<SyncAnchor | null> {
  const [row] = await sql<{ remote_jid: string; wa_message_id: string; direction: string; ts: number }[]>`
    select remote_jid, wa_message_id, direction,
      coalesce((content->>'timestamp')::float8 * 1000, extract(epoch from created_at) * 1000)::float8 as ts
    from messages
    where session_id = ${sessionId} and remote_jid = any(${jids}) and wa_message_id is not null and status <> 'failed'
    order by created_at, id limit 1`;
  return row ? { chatJid: row.remote_jid, id: row.wa_message_id, fromMe: row.direction === 'out', timestampMs: Math.round(row.ts) } : null;
}
