import type { MessageStatus, OutboundContent } from '@wa/shared';
import type { Sql } from './client';

export type QueuedMessage = {
  id: number;
  workspace_id: string;
  session_id: string;
  remote_jid: string;
  content: OutboundContent;
  attempts: number;
};

/**
 * Claims the oldest queued outbound message of a session that is due (`not_before` passed or unset).
 * SKIP LOCKED keeps two claimers from taking the same row; the caller sends one message at a time,
 * which serialises the session. Scheduled messages are picked up by the supervisor's next nudge
 * once due, so a paced broadcast never holds back regular API traffic.
 */
export async function claimNextOutbound(sql: Sql, sessionId: string): Promise<QueuedMessage | null> {
  const [row] = await sql<QueuedMessage[]>`
    update messages set status = 'sending', attempts = attempts + 1, updated_at = now()
    where id = (
      select id from messages
      where session_id = ${sessionId} and status = 'queued' and (not_before is null or not_before <= now())
      order by id
      limit 1
      for update skip locked
    )
    returning id, workspace_id, session_id, remote_jid, content, attempts`;
  return row ?? null;
}

/**
 * A message left in `sending` was interrupted mid-send; it may or may not have reached WhatsApp.
 * Fail it rather than risk a duplicate — the client can resend explicitly.
 */
export async function failInterrupted(sql: Sql, sessionId: string): Promise<number[]> {
  const rows = await sql<{ id: number }[]>`
    update messages set status = 'failed', error = 'Interrupted while sending; resend if needed', updated_at = now()
    where session_id = ${sessionId} and status = 'sending'
    returning id`;
  return rows.map((r) => r.id);
}

/** `raw`: the sent WAMessage (BufferJSON), kept for polls — votes can only be decrypted with it. */
export async function markSent(sql: Sql, id: number, waMessageId: string, raw?: unknown) {
  await sql`
    update messages set status = 'sent', wa_message_id = ${waMessageId}, sent_at = now(), error = null, updated_at = now(),
      raw = coalesce(${raw === undefined ? null : sql.json(raw as never)}::jsonb, raw)
    where id = ${id} and status = 'sending'`;
}

/** The stored WAMessage of an outbound message, e.g. a poll whose votes need decrypting after a restart. */
export async function loadOutboundRaw(sql: Sql, sessionId: string, waMessageId: string): Promise<unknown> {
  const [row] = await sql<{ raw: unknown }[]>`
    select raw from messages where session_id = ${sessionId} and wa_message_id = ${waMessageId} and direction = 'out'`;
  return row?.raw ?? undefined;
}

/** Records a voter's current choice on one of our polls (`content.votes[voter]`); returns the message id. */
export async function recordPollVote(sql: Sql, sessionId: string, waMessageId: string, voter: string, selected: string[]) {
  const [row] = await sql<{ id: number }[]>`
    update messages
    set content = jsonb_set(content, '{votes}', coalesce(content->'votes', '{}'::jsonb) || jsonb_build_object(${voter}::text, ${sql.json(selected)}::jsonb)),
      updated_at = now()
    where session_id = ${sessionId} and wa_message_id = ${waMessageId} and direction = 'out' and type = 'poll'
    returning id`;
  return row ?? null;
}

/** Puts a claimed message back when we know nothing reached WhatsApp (e.g. socket dropped before sending). */
export async function requeue(sql: Sql, id: number) {
  await sql`update messages set status = 'queued', updated_at = now() where id = ${id} and status = 'sending'`;
}

export async function markFailed(sql: Sql, id: number, error: string) {
  await sql`update messages set status = 'failed', error = ${error}, updated_at = now() where id = ${id}`;
}

const PROGRESS: MessageStatus[] = ['queued', 'sending', 'sent', 'delivered', 'read'];

/** Applies a delivery receipt, only ever moving forward (a late `delivered` never undoes `read`). */
export async function advanceStatus(
  sql: Sql,
  sessionId: string,
  waMessageId: string,
  status: 'sent' | 'delivered' | 'read',
): Promise<{ id: number; workspace_id: string } | null> {
  const [row] = await sql<{ id: number; workspace_id: string }[]>`
    update messages set status = ${status}, updated_at = now()
    where session_id = ${sessionId} and wa_message_id = ${waMessageId} and direction = 'out'
      and array_position(${PROGRESS}::text[], status) < array_position(${PROGRESS}::text[], ${status})
    returning id, workspace_id`;
  return row ?? null;
}
