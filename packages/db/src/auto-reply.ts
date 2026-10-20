import {
  DEFAULT_AUTO_REPLY_SETTINGS,
  DEFAULT_AUTO_REPLY_VARIABLES,
  type AutoReplyRule,
  type AutoReplySettings,
  type AutoReplyStatus,
  type AutoReplyVariables,
} from '@wa/shared';
import type { Sql } from './client';

/** A provider row as it is stored (the key is still encrypted). */
export type AiProviderRow = {
  id: string;
  enabled: boolean;
  baseUrl: string | null;
  model: string | null;
  hasKeys: boolean;
};

/** Loads one AI provider by its id; null when not found. */
export async function loadAiProvider(sql: Sql, id: string): Promise<AiProviderRow | null> {
  const [row] = await sql<AiProviderRow[]>`
    select id, enabled, base_url as "baseUrl", model,
      exists(select 1 from ai_provider_keys where provider_id = ai_providers.id) as "hasKeys"
    from ai_providers where id = ${id}`;
  return row ?? null;
}

/** The settings of one number, with the defaults filled in; null when the number has none. */
export async function loadAutoReplySettings(sql: Sql, sessionId: string): Promise<AutoReplySettings | null> {
  const [row] = await sql<
    {
      enabled: boolean;
      personality: AutoReplySettings['personality'];
      system_prompt: string;
      provider_id: AutoReplySettings['providerId'];
      model: string;
      fallback_provider_id: AutoReplySettings['fallbackProviderId'];
      fallback_model: string;
      temperature: number;
      max_tokens: number;
      delay_min_ms: number;
      delay_max_ms: number;
      business_hours_only: boolean;
      hours_start: number;
      hours_end: number;
      timezone: string;
      max_replies: number;
      ignore_list: string[];
      rules: AutoReplyRule[];
      language: AutoReplySettings['language'];
      variables: Partial<AutoReplyVariables>;
      summary_phone: string;
      summary_idle_minutes: number;
    }[]
  >`
    select enabled, personality, system_prompt, provider_id, model, fallback_provider_id, fallback_model,
      temperature, max_tokens, delay_min_ms, delay_max_ms, business_hours_only, hours_start, hours_end,
      timezone, max_replies, ignore_list, rules, language, variables, summary_phone, summary_idle_minutes
    from auto_reply_settings where session_id = ${sessionId}`;
  if (!row) return null;
  return {
    enabled: row.enabled,
    personality: row.personality,
    systemPrompt: row.system_prompt,
    providerId: row.provider_id,
    model: row.model,
    fallbackProviderId: row.fallback_provider_id,
    fallbackModel: row.fallback_model,
    temperature: row.temperature,
    maxTokens: row.max_tokens,
    delayMinMs: row.delay_min_ms,
    delayMaxMs: row.delay_max_ms,
    businessHoursOnly: row.business_hours_only,
    hoursStart: row.hours_start,
    hoursEnd: row.hours_end,
    timezone: row.timezone,
    maxReplies: row.max_replies,
    ignoreList: row.ignore_list,
    rules: row.rules ?? [],
    language: row.language,
    variables: { ...DEFAULT_AUTO_REPLY_VARIABLES, ...(row.variables ?? {}) },
    summaryPhone: row.summary_phone,
    summaryIdleMinutes: row.summary_idle_minutes,
  };
}

/**
 * The session that answers for this session's phone number. One WhatsApp number linked as two
 * sessions receives every message twice; with the agent on in both, the customer got two different
 * answers. The oldest connected session with the agent on answers; the others stay quiet (and take
 * over when it disconnects). Null when the number is unknown (the session answers for itself).
 */
export async function autoReplyOwner(sql: Sql, sessionId: string): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`
    select s.id from sessions s
    join auto_reply_settings a on a.session_id = s.id and a.enabled
    where s.phone = (select phone from sessions where id = ${sessionId})
      and s.status = 'connected'
    order by s.created_at, s.id
    limit 1`;
  return row?.id ?? null;
}

/** Every number of a workspace that has a row of its own. */
export async function listAutoReplySettings(sql: Sql, workspaceId: string) {
  const rows = await sql<{ session_id: string }[]>`
    select session_id from auto_reply_settings where workspace_id = ${workspaceId}`;
  const result: { sessionId: string; settings: AutoReplySettings }[] = [];
  for (const row of rows) {
    const settings = await loadAutoReplySettings(sql, row.session_id);
    if (settings) result.push({ sessionId: row.session_id, settings });
  }
  return result;
}

/** Writes a number's settings (the fields given), leaving the rest as they are. */
export async function saveAutoReplySettings(
  sql: Sql,
  sessionId: string,
  workspaceId: string,
  patch: Partial<AutoReplySettings>,
): Promise<AutoReplySettings> {
  const current = (await loadAutoReplySettings(sql, sessionId)) ?? { ...DEFAULT_AUTO_REPLY_SETTINGS };
  const next: AutoReplySettings = { ...current, ...patch };
  await sql`
    insert into auto_reply_settings (session_id, workspace_id, enabled, personality, system_prompt, provider_id,
      model, fallback_provider_id, fallback_model, temperature, max_tokens, delay_min_ms, delay_max_ms,
      business_hours_only, hours_start, hours_end, timezone, max_replies, ignore_list, rules, language, variables,
      summary_phone, summary_idle_minutes)
    values (${sessionId}, ${workspaceId}, ${next.enabled}, ${next.personality}, ${next.systemPrompt}, ${next.providerId},
      ${next.model}, ${next.fallbackProviderId}, ${next.fallbackModel}, ${next.temperature}, ${next.maxTokens},
      ${next.delayMinMs}, ${next.delayMaxMs}, ${next.businessHoursOnly}, ${next.hoursStart}, ${next.hoursEnd},
      ${next.timezone}, ${next.maxReplies}, ${next.ignoreList}, ${sql.json(next.rules as never)}, ${next.language},
      ${sql.json(next.variables as never)}, ${next.summaryPhone}, ${next.summaryIdleMinutes})
    on conflict (session_id) do update set
      enabled = excluded.enabled,
      personality = excluded.personality,
      system_prompt = excluded.system_prompt,
      provider_id = excluded.provider_id,
      model = excluded.model,
      fallback_provider_id = excluded.fallback_provider_id,
      fallback_model = excluded.fallback_model,
      temperature = excluded.temperature,
      max_tokens = excluded.max_tokens,
      delay_min_ms = excluded.delay_min_ms,
      delay_max_ms = excluded.delay_max_ms,
      business_hours_only = excluded.business_hours_only,
      hours_start = excluded.hours_start,
      hours_end = excluded.hours_end,
      timezone = excluded.timezone,
      max_replies = excluded.max_replies,
      ignore_list = excluded.ignore_list,
      rules = excluded.rules,
      language = excluded.language,
      variables = excluded.variables,
      summary_phone = excluded.summary_phone,
      summary_idle_minutes = excluded.summary_idle_minutes,
      updated_at = now()`;
  return next;
}

/**
 * How many answers this conversation got in the last `windowMs` (the cap that stops a loop with
 * another bot). A window, not a lifetime total: a lifetime count silenced a customer for good after
 * their first few questions.
 */
export async function countChatReplies(sql: Sql, sessionId: string, chatJid: string, windowMs: number): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from auto_reply_log
    where session_id = ${sessionId} and chat_jid = ${chatJid} and status = 'sent'
      and created_at > now() - (${windowMs}::int * interval '1 millisecond')`;
  return row?.count ?? 0;
}

/** One line of the conversation, as the model sees it. */
export type ChatLine = { role: 'user' | 'assistant'; content: string };

/**
 * The last messages of a conversation, oldest first, as the model sees them: what the contact wrote
 * and what we answered. Media without a caption shows as a marker, so the model knows a picture came.
 */
export async function recentChatLines(sql: Sql, sessionId: string, chatJid: string, limit: number, beforeId?: number): Promise<ChatLine[]> {
  const rows = await sql<{ direction: string; type: string; content: Record<string, unknown> }[]>`
    select direction, type, content from messages
    where session_id = ${sessionId} and remote_jid = ${chatJid} and type <> 'reaction'
      and not coalesce((content->>'history')::boolean, false)
      and (${beforeId ?? null}::bigint is null or id < ${beforeId ?? null}::bigint)
    order by id desc limit ${limit}`;
  return rows.reverse().map((row) => {
    const text = typeof row.content?.text === 'string' ? row.content.text.trim() : '';
    const content = text || `[${row.type}]`;
    return { role: row.direction === 'in' ? 'user' : 'assistant', content };
  });
}

/** One row in the agent's log: an answer that went out, or a message it stayed quiet about. */
export async function recordAutoReply(
  sql: Sql,
  row: {
    workspaceId: string;
    sessionId: string;
    messageId: number | null;
    chatJid: string;
    provider: string;
    model: string;
    language: 'ar' | 'en';
    reply: string;
    status: AutoReplyStatus;
    reason: string | null;
    latencyMs: number | null;
  },
) {
  await sql`
    insert into auto_reply_log (workspace_id, session_id, message_id, chat_jid, provider, model, language, reply, status, reason, latency_ms)
    values (${row.workspaceId}, ${row.sessionId}, ${row.messageId}, ${row.chatJid}, ${row.provider}, ${row.model},
      ${row.language}, ${row.reply}, ${row.status}, ${row.reason}, ${row.latencyMs})`;
}

/**
 * Puts the answer in the session's send queue, to go out after the pause (a human typing). The
 * queue paces it like any other message, so the number never sends two answers at once.
 * Returns the message id and the timestamp when it was queued (for latency tracking).
 */
export async function queueAutoReply(
  sql: Sql,
  row: { workspaceId: string; sessionId: string; chatJid: string; text: string; delayMs: number },
): Promise<{ id: number; queuedAt: Date }> {
  const [inserted] = await sql<{ id: number; queued_at: Date }[]>`
    insert into messages (workspace_id, session_id, direction, remote_jid, type, content, status, not_before, created_at)
    values (${row.workspaceId}, ${row.sessionId}, 'out', ${row.chatJid}, 'text',
      ${sql.json({ type: 'text', text: row.text, sentFrom: 'auto', reachable: true, queuedAt: Date.now() } as never)}, 'queued',
      now() + (${row.delayMs}::int * interval '1 millisecond'), now())
    returning id, created_at as queued_at`;
  return { id: inserted?.id ?? 0, queuedAt: inserted?.queued_at ?? new Date() };
}

/** A conversation ready to be summarized for the number's owner. */
export type DueSummary = {
  sessionId: string;
  workspaceId: string;
  chatJid: string;
  /** The last inbound message (what the summary covers up to). */
  lastMessageId: number;
  summaryPhone: string;
  /** The number's name in the dashboard, so the owner knows which line the customer wrote to. */
  sessionName: string;
};

/**
 * Conversations of these sessions that the agent answered in the last day and that have been quiet
 * for the number's `summary_idle_minutes`, with no summary covering their last inbound message yet.
 * The summary number's own chat is never summarized (it would summarize the summaries).
 */
export async function dueSummaries(sql: Sql, sessionIds: string[], limit = 10): Promise<DueSummary[]> {
  if (sessionIds.length === 0) return [];
  return await sql<DueSummary[]>`
    with answered as (
      select l.session_id, l.chat_jid
      from auto_reply_log l
      join auto_reply_settings s on s.session_id = l.session_id and s.enabled and s.summary_phone <> ''
      where l.session_id = any(${sessionIds}::uuid[]) and l.status = 'sent' and l.created_at > now() - interval '1 day'
      group by 1, 2
    )
    select a.session_id as "sessionId", s.workspace_id as "workspaceId", a.chat_jid as "chatJid",
      last.id as "lastMessageId", s.summary_phone as "summaryPhone", ss.name as "sessionName"
    from answered a
    join auto_reply_settings s on s.session_id = a.session_id
    join sessions ss on ss.id = a.session_id
    cross join lateral (
      select m.id, m.created_at from messages m
      where m.session_id = a.session_id and m.remote_jid = a.chat_jid and m.direction = 'in'
      order by m.id desc limit 1
    ) last
    where last.created_at < now() - make_interval(mins => s.summary_idle_minutes)
      and coalesce(
        (select l.pn from contact_lids l where l.session_id = a.session_id and l.lid = a.chat_jid),
        a.chat_jid
      ) <> regexp_replace(s.summary_phone, '[^0-9]', '', 'g') || '@s.whatsapp.net'
      and not exists (
        select 1 from auto_reply_summaries x
        where x.session_id = a.session_id and x.chat_jid = a.chat_jid and x.last_message_id >= last.id
      )
    order by last.created_at
    limit ${limit}`;
}

/** Takes a due summary for this worker; null when another pass took it first (the unique key decides). */
export async function claimSummary(sql: Sql, due: DueSummary): Promise<number | null> {
  const [row] = await sql<{ id: number }[]>`
    insert into auto_reply_summaries (session_id, chat_jid, last_message_id)
    values (${due.sessionId}, ${due.chatJid}, ${due.lastMessageId})
    on conflict (session_id, chat_jid, last_message_id) do nothing
    returning id`;
  return row?.id ?? null;
}

export async function finishSummary(sql: Sql, id: number, result: { status: 'sent' | 'failed'; summary: string; messageId: number | null }) {
  await sql`
    update auto_reply_summaries set status = ${result.status}, summary = ${result.summary}, message_id = ${result.messageId}
    where id = ${id}`;
}

/** Who the conversation is with: their WhatsApp name and phone number (a LID resolved through `contact_lids`). */
export async function summaryContact(sql: Sql, sessionId: string, chatJid: string): Promise<{ name: string | null; phone: string | null }> {
  const [row] = await sql<{ name: string | null; pn: string | null }[]>`
    select
      (select content->>'pushName' from messages
        where session_id = ${sessionId} and remote_jid = ${chatJid} and direction = 'in' and content->>'pushName' is not null
        order by id desc limit 1) as name,
      coalesce(
        (select pn from contact_lids where session_id = ${sessionId} and lid = ${chatJid}),
        case when ${chatJid} like '%@s.whatsapp.net' then ${chatJid} end
      ) as pn`;
  const digits = row?.pn?.split('@')[0]?.split(':')[0];
  return { name: row?.name?.trim() || null, phone: digits ? `+${digits}` : null };
}

/** Queues a summary to the owner's number, sent by the session's queue like any other message. */
export async function queueSummaryMessage(
  sql: Sql,
  row: { workspaceId: string; sessionId: string; to: string; text: string },
): Promise<number> {
  const [inserted] = await sql<{ id: number }[]>`
    insert into messages (workspace_id, session_id, direction, remote_jid, type, content, status)
    values (${row.workspaceId}, ${row.sessionId}, 'out', ${row.to}, 'text',
      ${sql.json({ type: 'text', text: row.text, sentFrom: 'auto', summary: true } as never)}, 'queued')
    returning id`;
  return inserted?.id ?? 0;
}
