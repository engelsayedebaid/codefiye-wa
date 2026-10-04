import type { BroadcastPace, MessageStatus, OutboundContent } from '@wa/shared';
import type { Sql } from './client';

export type QueuedMessage = {
  id: number;
  workspace_id: string;
  session_id: string;
  remote_jid: string;
  content: OutboundContent;
  attempts: number;
  /** Set for campaign messages, with the campaign's pace. */
  broadcast_id: string | null;
  pace: BroadcastPace | null;
  /** How long ago it was due (`not_before`), in ms; 0 when unscheduled. */
  late_ms: number;
};

/**
 * Claims the oldest queued outbound message of a session that is due (`not_before` passed or unset).
 * SKIP LOCKED keeps two claimers from taking the same row; the caller sends one message at a time,
 * which serialises the session. Scheduled messages are picked up by the supervisor's next nudge
 * once due, so a paced broadcast never holds back regular API traffic.
 */
export async function claimNextOutbound(sql: Sql, sessionId: string): Promise<QueuedMessage | null> {
  const [row] = await sql<QueuedMessage[]>`
    with claimed as (
      update messages set status = 'sending', attempts = attempts + 1, updated_at = now()
      where id = (
        select id from messages
        where session_id = ${sessionId} and status = 'queued' and (not_before is null or not_before <= now())
        order by id
        limit 1
        for update skip locked
      )
      returning id, workspace_id, session_id, remote_jid, content, attempts, broadcast_id, not_before
    )
    select c.id, c.workspace_id, c.session_id, c.remote_jid, c.content, c.attempts, c.broadcast_id, b.pace,
      coalesce(extract(epoch from now() - c.not_before) * 1000, 0)::float8 as late_ms
    from claimed c left join broadcasts b on b.id = c.broadcast_id`;
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

/** Any stored message's raw WAMessage (sent or received), e.g. the one an encrypted edit changes. */
export async function loadMessageRaw(sql: Sql, sessionId: string, waMessageId: string): Promise<unknown> {
  const [row] = await sql<{ raw: unknown }[]>`
    select raw from messages where session_id = ${sessionId} and wa_message_id = ${waMessageId}`;
  return row?.raw ?? undefined;
}

/**
 * The sender edited a message: the stored one (same row, same WhatsApp id) takes the new text and is
 * marked `edited`. An older edit never overwrites a newer one, and a deleted message stays deleted.
 * Returns the row changed, or null (not stored here, deleted, or already newer).
 */
export async function applyMessageEdit(sql: Sql, sessionId: string, waMessageId: string, text: string | null, editedAt: number) {
  const [row] = await sql<{ id: number; remote_jid: string }[]>`
    update messages set
      content = content || jsonb_build_object('text', ${text}::text, 'edited', true, 'editedAt', ${editedAt}::float8),
      updated_at = now()
    where session_id = ${sessionId} and wa_message_id = ${waMessageId}
      and not coalesce((content->>'revoked')::boolean, false)
      and coalesce((content->>'editedAt')::float8, 0) <= ${editedAt}
    returning id, remote_jid`;
  return row ?? null;
}

/**
 * The sender deleted a message for everyone: the stored row stays (same id, kept for the record) and
 * is marked `revoked`; the chats page shows it as deleted. Returns the row, or null (not stored, or
 * already marked).
 */
export async function applyMessageRevoke(sql: Sql, sessionId: string, waMessageId: string) {
  const [row] = await sql<{ id: number; remote_jid: string }[]>`
    update messages set
      content = content || jsonb_build_object('revoked', true, 'revokedAt', extract(epoch from now())),
      updated_at = now()
    where session_id = ${sessionId} and wa_message_id = ${waMessageId}
      and not coalesce((content->>'revoked')::boolean, false)
    returning id, remote_jid`;
  return row ?? null;
}

/**
 * Removes a row that was never a real message (an encrypted-edit envelope stored before edits were
 * understood), keeping its chat's counters and last message right.
 */
export async function dropStoredEnvelope(sql: Sql, id: number) {
  await sql`
    with gone as (delete from messages where id = ${id} returning session_id, remote_jid, direction, content)
    update chats c set
      inbound_count = greatest(0, c.inbound_count - (g.direction = 'in')::int),
      outbound_count = greatest(0, c.outbound_count - (g.direction = 'out')::int),
      unread_count = greatest(0, c.unread_count - (g.direction = 'in' and not coalesce((g.content->>'history')::boolean, false))::int),
      last_message_id = case when c.last_message_id = ${id} then (
        select m.id from messages m
        where m.session_id = c.session_id and m.remote_jid in (c.jid, coalesce(c.alt_jid, c.jid)) and m.type <> 'reaction' and m.id <> ${id}
        order by m.created_at desc, m.id desc limit 1
      ) else c.last_message_id end
    from gone g
    where c.session_id = g.session_id and (c.jid = g.remote_jid or c.alt_jid = g.remote_jid)`;
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
