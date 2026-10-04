import { type BroadcastPace, planSends, type SendingWindow, SHIELD_STOPS, type ShieldStop } from '@wa/shared';
import type { Sql } from './client';

/**
 * Campaign recipients each number reached in the last 24 hours and, with `queued`, the ones it has
 * scheduled (epoch ms, ascending): what `planSends` needs for the gap, the bursts and the daily cap.
 * A buttons poll rides with its card and isn't counted.
 */
export async function campaignHistory(sql: Sql, sessionIds: string[], { queued = true } = {}): Promise<Map<string, number[]>> {
  const history = new Map<string, number[]>(sessionIds.map((id) => [id, []]));
  if (!sessionIds.length) return history;
  const rows = await sql<{ session_id: string; at: number }[]>`
    select session_id, floor(extract(epoch from at) * 1000)::float8 as at from (
      select session_id, sent_at as at from messages
      where session_id = any(${sessionIds}::uuid[]) and broadcast_id is not null and type <> 'poll' and sent_at > now() - interval '24 hours'
      ${queued ? sql`union all
      select session_id, coalesce(not_before, now()) from messages
      where session_id = any(${sessionIds}::uuid[]) and status = 'queued' and broadcast_id is not null and type <> 'poll'` : sql``}
    ) x
    order by at`;
  for (const row of rows) history.get(row.session_id)?.push(row.at);
  return history;
}

/**
 * Re-plans a number's queued campaign messages from now. Used when it fell behind schedule (offline,
 * restarted): sending the overdue backlog at once is exactly the burst pacing exists to prevent.
 * Each campaign keeps its pace and window; campaigns stay in the order they were queued.
 * Returns how many recipients were re-planned.
 */
export async function replanCampaigns(sql: Sql, sessionId: string, random?: (min: number, max: number) => number): Promise<number> {
  const rows = await sql<{ id: number; broadcast_id: string; remote_jid: string; pace: BroadcastPace; sending_window: SendingWindow | null }[]>`
    select m.id, m.broadcast_id, m.remote_jid, b.pace, b.sending_window
    from messages m join broadcasts b on b.id = m.broadcast_id
    where m.session_id = ${sessionId} and m.status = 'queued'
    order by m.id`;
  const [session] = await sql<{ now: Date; created_at: Date }[]>`select now() as now, created_at from sessions where id = ${sessionId}`;
  if (!rows.length || !session) return 0;
  const history = (await campaignHistory(sql, [sessionId], { queued: false })).get(sessionId)!;

  // A card and its buttons poll share one slot: same campaign and recipient, queued back to back.
  type Slot = { ids: number[]; broadcast: string; jid: string; pace: BroadcastPace; window: SendingWindow | null };
  const slots: Slot[] = [];
  for (const row of rows) {
    const prev = slots.at(-1);
    if (prev && prev.broadcast === row.broadcast_id && prev.jid === row.remote_jid) prev.ids.push(row.id);
    else slots.push({ ids: [row.id], broadcast: row.broadcast_id, jid: row.remote_jid, pace: row.pace, window: row.sending_window });
  }

  const ids: number[] = [];
  const times: string[] = [];
  for (let start = 0; start < slots.length; ) {
    let end = start;
    while (end < slots.length && slots[end]!.broadcast === slots[start]!.broadcast) end++;
    const campaign = slots.slice(start, end);
    const planned = planSends({
      count: campaign.length,
      pace: campaign[0]!.pace,
      window: campaign[0]!.window,
      addedAt: session.created_at.getTime(),
      now: session.now.getTime(),
      history,
      random,
    });
    campaign.forEach((slot, i) => {
      for (const id of slot.ids) {
        ids.push(id);
        times.push(new Date(planned[i]!).toISOString());
      }
      history.push(planned[i]!);
    });
    start = end;
  }
  await sql`
    update messages m set not_before = x.at::timestamptz
    from unnest(${ids}::bigint[], ${times}::text[]) as x(id, at)
    where m.id = x.id and m.status = 'queued'`;
  return slots.length;
}

/** Fails a number's queued campaign messages with the shield's reason; returns their ids. */
export async function stopCampaigns(sql: Sql, sessionId: string, reason: ShieldStop): Promise<number[]> {
  const rows = await sql<{ id: number }[]>`
    update messages set status = 'failed', error = ${SHIELD_STOPS[reason]}, updated_at = now()
    where session_id = ${sessionId} and status = 'queued' and broadcast_id is not null
    returning id`;
  return rows.map((r) => r.id);
}

/**
 * Records a recipient's "stop" (`out`: later campaigns skip them, queued ones are dropped) or
 * "start" (`in`: they can be reached again). `phone` in E.164.
 */
export async function recordOptOut(sql: Sql, workspaceId: string, phone: string, intent: 'out' | 'in'): Promise<number[]> {
  if (intent === 'in') {
    await sql`delete from opt_outs where workspace_id = ${workspaceId} and phone = ${phone}`;
    return [];
  }
  await sql`insert into opt_outs (workspace_id, phone) values (${workspaceId}, ${phone}) on conflict do nothing`;
  const rows = await sql<{ id: number }[]>`
    update messages set status = 'failed', error = ${SHIELD_STOPS.optedOut}, updated_at = now()
    where session_id in (select id from sessions where workspace_id = ${workspaceId})
      and status = 'queued' and broadcast_id is not null and remote_jid = ${`${phone.slice(1)}@s.whatsapp.net`}
    returning id`;
  return rows.map((r) => r.id);
}
