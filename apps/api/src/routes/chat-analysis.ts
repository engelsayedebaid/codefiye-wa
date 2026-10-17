import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { jidToPhone, ok, successSchema } from '@wa/shared';
import type { Sql } from '@wa/db';
import type { FastifyBaseLogger } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Deps } from '../deps';
import { requireAdmin } from '../lib/auth';
import { conflict, notFound, unavailable, unprocessable } from '../lib/errors';

/**
 * AI analysis of the inbox (admins): exact figures per number from the database (each number is one
 * employee), then an AI model reads the most active conversations of the period and writes the report —
 * customers, how each number answers, what is waiting, what to do. A report takes minutes, longer than
 * a request may last, so it runs as a job in this process the page polls; the last ones stay a while.
 * Claude (ANTHROPIC_API_KEY) first; Gemini (GEMINI_API_KEY) when there is no Anthropic key, or when the
 * Anthropic API fails (refused key, no credit, overloaded).
 */

const schemaBase = { tags: ['Admin'], hide: true };
const MODEL = 'claude-opus-5-5';
/** `gemini-flash-latest` follows Google's newest Flash; a free-tier key has no quota for the Pro models. */
const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-flash-latest';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_TIMEOUT_MS = 10 * 60_000;
/** Conversations Claude reads, the messages per conversation, and the transcript budget (characters). */
const MAX_CHATS = 60;
const PER_CHAT = 40;
const MAX_CHARS = 180_000;
const MAX_TEXT = 400;
const UNANSWERED = 50;
const KEEP_MS = 3 * 3_600_000;

const STATUSES = ['hot', 'interested', 'waiting', 'complaint', 'done', 'cold'] as const;
const MOODS = ['positive', 'neutral', 'negative'] as const;
const PRIORITIES = ['high', 'medium', 'low'] as const;
/** A value from a fixed list; anything else (a translation, a typo) falls back rather than failing the report. */
const oneOf = <T extends string>(value: string, allowed: readonly T[], fallback: T): T => {
  const v = value.trim().toLowerCase();
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
};

/**
 * What Claude returns (structured output): refs (`n1`, `c7`) point back at numbers and chats. The fixed
 * lists are plain strings here (structured outputs carry enums as descriptions) and are checked after.
 */
const reportSchema = z.object({
  summary: z.string().describe('The overall picture of the period in 3-6 sentences'),
  highlights: z.array(z.string()).describe('The most important findings, one short sentence each'),
  sentiment: z
    .object({ positive: z.number(), neutral: z.number(), negative: z.number() })
    .describe('Share of the analyzed customers by mood, in percent (adds up to 100)'),
  topics: z.array(z.object({ topic: z.string(), count: z.number().describe('How many analyzed conversations raise it'), note: z.string() })),
  customers: z.array(
    z.object({
      ref: z.string().describe('The conversation id, e.g. c7'),
      status: z.string().describe(`One of: ${STATUSES.join(', ')} (in English, exactly)`),
      mood: z.string().describe(`One of: ${MOODS.join(', ')} (in English, exactly)`),
      summary: z.string(),
      need: z.string().describe('What the customer wants'),
      nextAction: z.string().describe('The concrete next step for the employee'),
    }),
  ),
  employees: z.array(
    z.object({
      ref: z.string().describe('The number id, e.g. n1'),
      score: z.number().describe('0-100'),
      verdict: z.string().describe('One line'),
      strengths: z.array(z.string()),
      weaknesses: z.array(z.string()),
      tone: z.string(),
      examples: z.array(z.string()).describe('Short concrete examples from the conversations, naming the customer'),
    }),
  ),
  risks: z.array(z.string()).describe('Customers or patterns at risk: lost sales, angry customers, slow replies'),
  recommendations: z.array(z.object({ title: z.string(), detail: z.string(), priority: z.string().describe(`One of: ${PRIORITIES.join(', ')} (in English, exactly)`) })),
});
type Report = Omit<z.infer<typeof reportSchema>, 'customers' | 'recommendations'> & {
  customers: (Omit<z.infer<typeof reportSchema>['customers'][number], 'status' | 'mood'> & { status: (typeof STATUSES)[number]; mood: (typeof MOODS)[number] })[];
  recommendations: (Omit<z.infer<typeof reportSchema>['recommendations'][number], 'priority'> & { priority: (typeof PRIORITIES)[number] })[];
};

type NumberStats = {
  sessionId: string;
  name: string;
  phone: string | null;
  status: string;
  customers: number;
  newCustomers: number;
  inbound: number;
  outbound: number;
  fromPhone: number;
  fromDashboard: number;
  fromApi: number;
  campaign: number;
  turns: number;
  answered: number;
  medianReplySeconds: number | null;
  avgReplySeconds: number | null;
  waiting: number;
  groups: number;
};
type Waiting = { sessionId: string; jid: string; name: string | null; phone: string | null; lastText: string | null; lastType: string; since: string };
type ChatRef = { sessionId: string; jid: string; name: string | null; phone: string | null };
type Result = {
  stats: NumberStats[];
  unanswered: Waiting[];
  report: Report | null;
  /** `c7` → the chat, `n1` → the number. */
  chats: Record<string, ChatRef>;
  numbers: Record<string, string>;
  meta: { days: number; since: string; chatsAnalyzed: number; messagesAnalyzed: number; model: string; inputTokens: number; outputTokens: number; generatedAt: string | null };
};
type Job = { id: string; workspaceId: string; status: 'running' | 'done' | 'failed'; phase: 'collecting' | 'analyzing' | 'done'; startedAt: string; finishedAt: string | null; error: string | null; result: Result | null };

const jobDto = z.object({
  id: z.uuid(),
  status: z.enum(['running', 'done', 'failed']),
  phase: z.enum(['collecting', 'analyzing', 'done']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
});
const toJobDto = (j: Job) => ({ id: j.id, status: j.status, phase: j.phase, startedAt: j.startedAt, finishedAt: j.finishedAt, error: j.error, result: j.result as Record<string, unknown> | null });

const SYSTEM = `You analyze the WhatsApp inbox of a business for its owner. Each WhatsApp number (n1, n2, …) is run by one employee, so judging a number is judging that employee.

You get exact figures computed from the database, then the most active one-to-one conversations of the period. In a transcript, CUSTOMER is the customer; AGENT is the employee (from the phone app, the dashboard, or the API); CAMPAIGN is an automated bulk message, not the employee's own writing. Times are UTC.

Write a report the owner can act on:
- Base every statement on the figures and transcripts; never invent customers, numbers or quotes. When the data is thin, say so.
- Name customers by their name or phone as given, and say which number handled them.
- Customers: one entry per conversation you read, with its status — hot (ready to buy / close to closing), interested, waiting (asked something and is waiting for us), complaint, done (served, nothing pending), cold (no real interest).
- Employees: one entry per number that has conversations. Score 0-100 on speed (use the reply-time figures), accuracy and completeness of answers, tone and politeness, and closing/follow-up. Give concrete examples.
- Recommendations: specific and prioritized (who should do what), not generic advice.
- Keep each text field short and direct.`;

/** A failure worded for the admin (shown as the job's error). */
class AiError extends Error {}

type Answer = { text: string; model: string; inputTokens: number; outputTokens: number };
type Analyst = { name: string; analyze: (system: string, prompt: string) => Promise<Answer> };

function claudeAnalyst(client: Anthropic): Analyst {
  return {
    name: MODEL,
    async analyze(system, prompt) {
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 64_000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'high', format: betaZodOutputFormat(reportSchema) },
        system,
        messages: [{ role: 'user', content: prompt }],
      });
      const message = await stream.finalMessage();
      if (message.stop_reason === 'refusal') throw new AiError('The model declined to analyze these conversations');
      if (message.stop_reason === 'max_tokens') throw new AiError('The report was cut off (too long); try fewer numbers or a shorter period');
      return {
        text: message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''),
        model: message.model,
        inputTokens: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0),
        outputTokens: message.usage.output_tokens,
      };
    },
  };
}

/** The report's JSON Schema for Gemini's structured output (it takes no `$schema` key). */
const geminiSchema = (() => {
  const { $schema: _, ...schema } = z.toJSONSchema(reportSchema) as Record<string, unknown>;
  return schema;
})();

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
  error?: { code?: number; message?: string; status?: string };
};

function geminiAnalyst(key: string): Analyst {
  return {
    name: GEMINI_MODEL,
    async analyze(system, prompt) {
      const body = JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: geminiSchema, maxOutputTokens: 65_536 },
      });
      // A busy model (500/503) is tried again a couple of times before giving up.
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await fetch(`${GEMINI_URL}/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
            body,
            signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
          });
        } catch (err) {
          throw new AiError((err as Error).name === 'TimeoutError' ? 'The AI service took too long; try a shorter period' : 'Could not reach the AI service (Gemini)');
        }
        const data = (await res.json().catch(() => ({}))) as GeminiResponse;
        if ((res.status === 500 || res.status === 503) && attempt < 2) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 8_000));
          continue;
        }
        if (res.status === 401 || res.status === 403 || (res.status === 400 && data.error?.status === 'INVALID_ARGUMENT' && /api key/i.test(data.error.message ?? '')))
          throw new AiError('The AI key (GEMINI_API_KEY) was refused');
        if (res.status === 429) throw new AiError('The Gemini quota is used up for now; try again later (or use a paid Gemini key)');
        if (!res.ok) throw new AiError(`AI service error (Gemini ${res.status}${data.error?.message ? `: ${data.error.message.slice(0, 160)}` : ''})`);
        if (data.promptFeedback?.blockReason) throw new AiError('The model declined to analyze these conversations');
        const candidate = data.candidates?.[0];
        if (candidate?.finishReason === 'MAX_TOKENS') throw new AiError('The report was cut off (too long); try fewer numbers or a shorter period');
        if (candidate?.finishReason && candidate.finishReason !== 'STOP') throw new AiError('The model declined to analyze these conversations');
        const usage = data.usageMetadata ?? {};
        return {
          text: (candidate?.content?.parts ?? []).flatMap((p) => (p.text && !p.thought ? [p.text] : [])).join(''),
          model: data.modelVersion ?? GEMINI_MODEL,
          inputTokens: usage.promptTokenCount ?? 0,
          outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
        };
      }
    },
  };
}

function clip(text: string | null, max = MAX_TEXT) {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
const stamp = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');

/** The figures, the waiting customers and the transcripts of the period, all from the database. */
export async function collectInbox(sql: Sql, workspaceId: string, sessionIds: string[] | null, days: number) {
  const since = new Date(Date.now() - days * 86_400_000);
  const sessions = await sql<{ id: string; name: string; phone: string | null; status: string }[]>`
    select id, name, phone, status from sessions
    where workspace_id = ${workspaceId} ${sessionIds ? sql`and id = any(${sessionIds}::uuid[])` : sql``}
    order by created_at`;
  const ids = sessions.map((s) => s.id);
  if (ids.length === 0) return null;
  // One-to-one conversations only: groups are counted, not analyzed.
  const direct = sql`m.remote_jid not like '%@g.us' and m.remote_jid <> 'status@broadcast' and m.type <> 'reaction'`;

  const [counts, fresh, replies, waitingCounts, groups, unanswered, top] = await Promise.all([
    sql<{ session_id: string; inbound: number; outbound: number; from_phone: number; from_dashboard: number; from_api: number; campaign: number; customers: number }[]>`
      select m.session_id,
        count(*) filter (where m.direction = 'in')::int as inbound,
        count(*) filter (where m.direction = 'out' and m.broadcast_id is null)::int as outbound,
        count(*) filter (where m.direction = 'out' and m.broadcast_id is null and m.content->>'sentFrom' = 'phone')::int as from_phone,
        count(*) filter (where m.direction = 'out' and m.broadcast_id is null and m.content->>'sentFrom' = 'chats')::int as from_dashboard,
        count(*) filter (where m.direction = 'out' and m.broadcast_id is null and coalesce(m.content->>'sentFrom', '') not in ('phone', 'chats'))::int as from_api,
        count(*) filter (where m.direction = 'out' and m.broadcast_id is not null)::int as campaign,
        count(distinct m.remote_jid) filter (where m.direction = 'in')::int as customers
      from messages m
      where m.workspace_id = ${workspaceId} and m.session_id = any(${ids}::uuid[]) and m.created_at >= ${since} and ${direct}
      group by m.session_id`,
    sql<{ session_id: string; n: number }[]>`
      select session_id, count(*)::int as n from (
        select m.session_id, m.remote_jid, min(m.created_at) as first_at from messages m
        where m.workspace_id = ${workspaceId} and m.session_id = any(${ids}::uuid[]) and m.direction = 'in' and ${direct}
        group by 1, 2) x
      where first_at >= ${since}
      group by session_id`,
    // A customer's turn starts at an incoming message after one of ours (or the first); the reply is our next own message.
    sql<{ session_id: string; turns: number; answered: number; median: number | null; avg: number | null }[]>`
      with m as (
        select m.session_id, m.remote_jid, m.direction, m.created_at, lag(m.direction) over (partition by m.session_id, m.remote_jid order by m.created_at, m.id) as prev
        from messages m
        where m.workspace_id = ${workspaceId} and m.session_id = any(${ids}::uuid[]) and m.created_at >= ${since} and ${direct}
          and (m.direction = 'in' or m.broadcast_id is null)),
      turns as (select session_id, remote_jid, created_at from m where direction = 'in' and (prev is null or prev = 'out')),
      answered as (
        select t.session_id, extract(epoch from r.at - t.created_at)::float8 as secs
        from turns t
        left join lateral (
          select min(x.created_at) as at from messages x
          where x.session_id = t.session_id and x.remote_jid = t.remote_jid and x.direction = 'out' and x.broadcast_id is null and x.created_at > t.created_at) r on true)
      select session_id, count(*)::int as turns, count(secs)::int as answered,
        percentile_cont(0.5) within group (order by secs) as median, avg(secs)::float8 as avg
      from answered group by session_id`,
    sql<{ session_id: string; n: number }[]>`
      select c.session_id, count(*)::int as n
      from chats c join messages m on m.id = c.last_message_id
      where c.session_id = any(${ids}::uuid[]) and c.jid not like '%@g.us' and c.archived_at is null and m.direction = 'in' and m.type <> 'reaction'
      group by c.session_id`,
    sql<{ session_id: string; n: number }[]>`
      select session_id, count(*)::int as n from chats
      where session_id = any(${ids}::uuid[]) and jid like '%@g.us' and last_message_at >= ${since}
      group by session_id`,
    sql<{ session_id: string; jid: string; name: string | null; last_text: string | null; last_type: string; at: Date }[]>`
      select c.session_id, c.jid, chat_display_name(c.session_id, c.jid, c.alt_jid, c.name) as name,
        coalesce(m.content->>'text', m.content->>'caption', m.content->>'name') as last_text, m.type as last_type, m.created_at as at
      from chats c join messages m on m.id = c.last_message_id
      where c.session_id = any(${ids}::uuid[]) and c.jid not like '%@g.us' and c.archived_at is null and m.direction = 'in' and m.type <> 'reaction'
        and m.created_at >= ${since}
      order by m.created_at asc
      limit ${UNANSWERED}`,
    sql<{ session_id: string; remote_jid: string; n: number; chat_jid: string | null; name: string | null }[]>`
      select x.session_id, x.remote_jid, x.n, c.jid as chat_jid, case when c.jid is not null then chat_display_name(c.session_id, c.jid, c.alt_jid, c.name) end as name
      from (
        select m.session_id, m.remote_jid, count(*)::int as n from messages m
        where m.workspace_id = ${workspaceId} and m.session_id = any(${ids}::uuid[]) and m.created_at >= ${since} and ${direct}
        group by 1, 2 having count(*) filter (where m.direction = 'in') > 0
        order by 3 desc limit ${MAX_CHATS * 2}) x
      left join lateral (
        select session_id, jid, alt_jid, name from chats
        where session_id = x.session_id and (jid = x.remote_jid or alt_jid = x.remote_jid) limit 1) c on true
      order by x.n desc`,
  ]);

  const by = <T extends { session_id: string }>(rows: T[]) => new Map(rows.map((r) => [r.session_id, r]));
  const [countsBy, freshBy, repliesBy, waitingBy, groupsBy] = [by(counts), by(fresh), by(replies), by(waitingCounts), by(groups)];
  const stats: NumberStats[] = sessions.map((s) => {
    const c = countsBy.get(s.id);
    const r = repliesBy.get(s.id);
    return {
      sessionId: s.id,
      name: s.name,
      phone: s.phone,
      status: s.status,
      customers: c?.customers ?? 0,
      newCustomers: freshBy.get(s.id)?.n ?? 0,
      inbound: c?.inbound ?? 0,
      outbound: c?.outbound ?? 0,
      fromPhone: c?.from_phone ?? 0,
      fromDashboard: c?.from_dashboard ?? 0,
      fromApi: c?.from_api ?? 0,
      campaign: c?.campaign ?? 0,
      turns: r?.turns ?? 0,
      answered: r?.answered ?? 0,
      medianReplySeconds: r?.median ?? null,
      avgReplySeconds: r?.avg ?? null,
      waiting: waitingBy.get(s.id)?.n ?? 0,
      groups: groupsBy.get(s.id)?.n ?? 0,
    };
  });

  // The busiest conversations; a contact written to under both its phone and LID address is one chat.
  const picked = new Map<string, { sessionId: string; jid: string; name: string | null; addresses: string[] }>();
  for (const t of top) {
    const jid = t.chat_jid ?? t.remote_jid;
    const key = `${t.session_id}\n${jid}`;
    const known = picked.get(key);
    if (known) known.addresses.push(t.remote_jid);
    else if (picked.size < MAX_CHATS) picked.set(key, { sessionId: t.session_id, jid, name: t.name, addresses: [t.remote_jid] });
  }
  const pairs = [...picked.values()].flatMap((p) => p.addresses.map((a) => [p.sessionId, a] as const));
  type Line = { session_id: string; remote_jid: string; direction: 'in' | 'out'; type: string; created_at: Date; campaign: boolean; sent_from: string | null; text: string | null };
  const rows: Line[] = pairs.length
    ? await sql<Line[]>`
        select session_id, remote_jid, direction, type, created_at, campaign, sent_from, text from (
          select m.session_id, m.remote_jid, m.direction, m.type, m.created_at, m.broadcast_id is not null as campaign, m.content->>'sentFrom' as sent_from,
            coalesce(m.content->>'text', m.content->>'caption', m.content->>'name', m.content->'poll'->>'name', m.content->'media'->>'fileName') as text,
            row_number() over (partition by m.session_id, m.remote_jid order by m.created_at desc, m.id desc) as rn
          from messages m
          where m.workspace_id = ${workspaceId} and m.created_at >= ${since} and m.type <> 'reaction'
            and (m.session_id, m.remote_jid) in (select * from unnest(${pairs.map((p) => p[0])}::uuid[], ${pairs.map((p) => p[1])}::text[]))
        ) x where rn <= ${PER_CHAT}
        order by created_at`
    : [];
  const lines = new Map<string, Line[]>();
  const chatOf = new Map(pairs.map(([sid, address]) => [`${sid}\n${address}`, [...picked.entries()].find(([, p]) => p.sessionId === sid && p.addresses.includes(address))![0]]));
  for (const r of rows) {
    const key = chatOf.get(`${r.session_id}\n${r.remote_jid}`);
    if (key) lines.set(key, [...(lines.get(key) ?? []), r]);
  }

  const numbers: Record<string, string> = {};
  const numberRef = new Map<string, string>();
  sessions.forEach((s, i) => {
    numbers[`n${i + 1}`] = s.id;
    numberRef.set(s.id, `n${i + 1}`);
  });
  const chats: Record<string, ChatRef> = {};
  const transcripts: string[] = [];
  let chars = 0;
  let messages = 0;
  let i = 0;
  for (const [key, p] of picked) {
    const msgs = (lines.get(key) ?? []).slice(-PER_CHAT);
    if (msgs.length === 0) continue;
    const ref = `c${++i}`;
    const phone = jidToPhone(p.jid);
    const who = (m: (typeof msgs)[number]) =>
      m.direction === 'in' ? 'CUSTOMER' : m.campaign ? 'CAMPAIGN' : m.sent_from === 'phone' ? 'AGENT (phone)' : m.sent_from === 'chats' ? 'AGENT (dashboard)' : 'AGENT (api)';
    const body = msgs.map((m) => `[${stamp(m.created_at)}] ${who(m)}: ${m.type !== 'text' ? `[${m.type}] ` : ''}${clip(m.text)}`).join('\n');
    const block = `### ${ref} · customer: ${p.name ?? phone ?? p.jid.split('@')[0]}${phone && p.name ? ` (${phone})` : ''} · number: ${numberRef.get(p.sessionId)}\n${body}`;
    if (chars + block.length > MAX_CHARS) break;
    chars += block.length;
    messages += msgs.length;
    chats[ref] = { sessionId: p.sessionId, jid: p.jid, name: p.name, phone };
    transcripts.push(block);
  }

  const fmtSecs = (s: number | null) => (s === null ? 'n/a' : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
  const figures = stats
    .map(
      (s) =>
        `${numberRef.get(s.sessionId)} "${s.name}" (${s.phone ?? 'no phone'}, ${s.status}): customers ${s.customers} (new ${s.newCustomers}), messages in ${s.inbound} / out ${s.outbound} ` +
        `(phone ${s.fromPhone}, dashboard ${s.fromDashboard}, api ${s.fromApi}), campaign ${s.campaign}, customer turns ${s.turns} answered ${s.answered}, ` +
        `reply time median ${fmtSecs(s.medianReplySeconds)} avg ${fmtSecs(s.avgReplySeconds)}, chats waiting for a reply now ${s.waiting}, active groups ${s.groups}`,
    )
    .join('\n');

  return {
    since,
    stats,
    numbers,
    chats,
    messages,
    prompt: `Period: the last ${days} days (since ${stamp(since)} UTC).\n\n## Figures per number\n${figures}\n\n## Conversations (${transcripts.length} of the most active)\n\n${transcripts.join('\n\n')}`,
    unanswered: unanswered.map((u) => ({ sessionId: u.session_id, jid: u.jid, name: u.name, phone: jidToPhone(u.jid), lastText: clip(u.last_text, 160) || null, lastType: u.last_type, since: u.at.toISOString() })),
  };
}

export function chatAnalysisRoutes(deps: Deps): FastifyPluginAsyncZod {
  const { sql } = deps;
  const jobs = new Map<string, Job>();
  let client: Anthropic | null = null;
  /**
   * The models to ask, in order, from the environment: Claude (ANTHROPIC_API_KEY), then Gemini
   * (GEMINI_API_KEY). Neither key = the feature is off.
   */
  const analysts = (): Analyst[] => {
    const out: Analyst[] = [];
    if (process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim()) out.push(claudeAnalyst((client ??= new Anthropic())));
    const gemini = process.env.GEMINI_API_KEY?.trim();
    if (gemini) out.push(geminiAnalyst(gemini));
    return out;
  };
  const prune = () => {
    const cutoff = Date.now() - KEEP_MS;
    for (const [id, j] of jobs) if (j.status !== 'running' && new Date(j.finishedAt ?? j.startedAt).getTime() < cutoff) jobs.delete(id);
  };

  async function run(job: Job, ais: Analyst[], sessionIds: string[] | null, days: number, lang: 'ar' | 'en', log: FastifyBaseLogger) {
    try {
      const data = await collectInbox(sql, job.workspaceId, sessionIds, days);
      if (!data) throw new Error('No numbers to analyze');
      const result: Result = {
        stats: data.stats,
        unanswered: data.unanswered,
        report: null,
        chats: data.chats,
        numbers: data.numbers,
        meta: { days, since: data.since.toISOString(), chatsAnalyzed: Object.keys(data.chats).length, messagesAnalyzed: data.messages, model: ais[0]!.name, inputTokens: 0, outputTokens: 0, generatedAt: null },
      };
      job.result = result;
      if (result.meta.chatsAnalyzed === 0) {
        job.status = 'done';
        job.phase = 'done';
        job.finishedAt = new Date().toISOString();
        return;
      }
      job.phase = 'analyzing';
      const language = lang === 'ar' ? 'Arabic (clear Modern Standard Arabic an Egyptian business owner reads easily)' : 'English';
      const system = `${SYSTEM}\n\nWrite every text field in ${language}. Keep refs (n1, c7) and the status, mood and priority values exactly as given (in English).`;
      let answer: Answer | null = null;
      for (const [i, ai] of ais.entries()) {
        result.meta.model = ai.name;
        try {
          answer = await ai.analyze(system, data.prompt);
          break;
        } catch (err) {
          // The Anthropic API failed (key refused, no credit, overloaded): the next model takes over.
          if (!(err instanceof Anthropic.APIError) || i === ais.length - 1) throw err;
          log.warn({ err: err.message, status: err.status }, 'chat analysis: Claude failed, trying the next model');
        }
      }
      const report = reportSchema.parse(JSON.parse(answer!.text));
      // Only refs that exist: a customer or number the model made up is dropped.
      result.report = {
        ...report,
        customers: report.customers.filter((c) => data.chats[c.ref]).map((c) => ({ ...c, status: oneOf(c.status, STATUSES, 'interested'), mood: oneOf(c.mood, MOODS, 'neutral') })),
        employees: report.employees.filter((e) => data.numbers[e.ref]),
        recommendations: report.recommendations.map((r) => ({ ...r, priority: oneOf(r.priority, PRIORITIES, 'medium') })),
      };
      result.meta.model = answer!.model;
      result.meta.inputTokens = answer!.inputTokens;
      result.meta.outputTokens = answer!.outputTokens;
      result.meta.generatedAt = new Date().toISOString();
      job.status = 'done';
      job.phase = 'done';
    } catch (err) {
      log.warn({ err }, 'chat analysis failed');
      job.status = 'failed';
      job.error =
        err instanceof AiError
          ? err.message
          : err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError
            ? 'The AI key (ANTHROPIC_API_KEY) was refused'
            : err instanceof Anthropic.RateLimitError
              ? 'The AI service is busy; try again in a minute'
              : err instanceof Anthropic.APIError
                ? `AI service error (${err.status ?? 'network'})`
                : err instanceof SyntaxError || err instanceof z.ZodError
                  ? 'The AI answer could not be read; try again'
                  : (err as Error).message;
    } finally {
      job.finishedAt ??= new Date().toISOString();
    }
  }

  return async (app) => {
    app.post(
      '/analysis',
      {
        schema: {
          ...schemaBase,
          summary: 'Start an AI analysis of the conversations (admins)',
          body: z.object({
            sessionIds: z.array(z.uuid()).min(1).max(50).optional(),
            days: z.number().int().min(1).max(90).default(30),
            lang: z.enum(['ar', 'en']).default('ar'),
          }),
          response: { 200: successSchema(jobDto) },
        },
      },
      async (req) => {
        requireAdmin(req);
        const ai = analysts();
        if (ai.length === 0) throw unavailable('AI analysis is not configured: set ANTHROPIC_API_KEY (or GEMINI_API_KEY) on the API server', 'ai_unavailable');
        prune();
        const running = [...jobs.values()].find((j) => j.workspaceId === req.auth.workspaceId && j.status === 'running');
        if (running) throw conflict('An analysis is already running', 'analysis_running');
        const { sessionIds, days, lang } = req.body;
        if (sessionIds) {
          const [found] = await sql<{ n: number }[]>`select count(*)::int as n from sessions where workspace_id = ${req.auth.workspaceId} and id = any(${sessionIds}::uuid[])`;
          if (found?.n !== new Set(sessionIds).size) throw unprocessable('Unknown number', { sessionIds: ['Pick numbers of this workspace'] });
        }
        const job: Job = { id: randomUUID(), workspaceId: req.auth.workspaceId, status: 'running', phase: 'collecting', startedAt: new Date().toISOString(), finishedAt: null, error: null, result: null };
        jobs.set(job.id, job);
        void run(job, ai, sessionIds ?? null, days, lang, req.log);
        return ok(toJobDto(job));
      },
    );

    app.get(
      '/analysis/latest',
      { schema: { ...schemaBase, summary: 'The latest analysis of the workspace, if any (admins)', response: { 200: successSchema(jobDto.nullable()) } } },
      async (req) => {
        requireAdmin(req);
        prune();
        const latest = [...jobs.values()].filter((j) => j.workspaceId === req.auth.workspaceId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
        return ok(latest ? toJobDto(latest) : null);
      },
    );

    app.get(
      '/analysis/:id',
      { schema: { ...schemaBase, summary: 'One analysis and its report (admins)', params: z.object({ id: z.uuid() }), response: { 200: successSchema(jobDto) } } },
      async (req) => {
        requireAdmin(req);
        const job = jobs.get(req.params.id);
        if (!job || job.workspaceId !== req.auth.workspaceId) throw notFound('Analysis not found');
        return ok(toJobDto(job));
      },
    );
  };
}
