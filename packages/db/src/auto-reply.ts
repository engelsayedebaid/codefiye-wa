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
  api_key: Buffer | null;
  base_url: string | null;
  model: string | null;
};

/** Loads one AI provider by its id; null when not found. */
export async function loadAiProvider(sql: Sql, id: string): Promise<AiProviderRow | null> {
  const [row] = await sql<{ id: string; enabled: boolean; api_key: Buffer | null; base_url: string | null; model: string | null }[]>`
    select id, enabled, api_key, base_url, model from ai_providers where id = ${id}`;
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
    }[]
  >`
    select enabled, personality, system_prompt, provider_id, model, fallback_provider_id, fallback_model,
      temperature, max_tokens, delay_min_ms, delay_max_ms, business_hours_only, hours_start, hours_end,
      timezone, max_replies, ignore_list, rules, language, variables
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
  };
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
      business_hours_only, hours_start, hours_end, timezone, max_replies, ignore_list, rules, language, variables)
    values (${sessionId}, ${workspaceId}, ${next.enabled}, ${next.personality}, ${next.systemPrompt}, ${next.providerId},
      ${next.model}, ${next.fallbackProviderId}, ${next.fallbackModel}, ${next.temperature}, ${next.maxTokens},
      ${next.delayMinMs}, ${next.delayMaxMs}, ${next.businessHoursOnly}, ${next.hoursStart}, ${next.hoursEnd},
      ${next.timezone}, ${next.maxReplies}, ${next.ignoreList}, ${sql.json(next.rules as never)}, ${next.language},
      ${sql.json(next.variables as never)})
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
      updated_at = now()`;
  return next;
}

/** How many answers this conversation already got (the cap that stops a loop with another bot). */
export async function countChatReplies(sql: Sql, sessionId: string, chatJid: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from auto_reply_log
    where session_id = ${sessionId} and chat_jid = ${chatJid} and status = 'sent'`;
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
 */
export async function queueAutoReply(
  sql: Sql,
  row: { workspaceId: string; sessionId: string; chatJid: string; text: string; delayMs: number },
): Promise<number> {
  const [inserted] = await sql<{ id: number }[]>`
    insert into messages (workspace_id, session_id, direction, remote_jid, type, content, status, not_before)
    values (${row.workspaceId}, ${row.sessionId}, 'out', ${row.chatJid}, 'text',
      ${sql.json({ type: 'text', text: row.text, sentFrom: 'auto', reachable: true } as never)}, 'queued',
      now() + (${row.delayMs}::int * interval '1 millisecond'))
    returning id`;
  return inserted?.id ?? 0;
}
