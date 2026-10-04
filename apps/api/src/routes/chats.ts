import { loadUpload, markChatRead, notify, setChatName, type SqlFragment } from '@wa/db';
import {
  CHANNELS,
  CHAT_FILTERS,
  isTimeZone,
  jidToPhone,
  MESSAGE_DIRECTIONS,
  MESSAGE_STATUSES,
  MESSAGE_TYPES,
  type MessageDirection,
  type MessageStatus,
  type MessageType,
  ok,
  type OutboundContent,
  planHasFeature,
  successSchema,
  UPLOAD_MAX_BYTES,
  UPLOAD_SCHEME,
  type WaEvent,
} from '@wa/shared';
import type { GroupMember } from '@wa/provider';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps';
import { ownedSession, requirePat } from '../lib/auth';
import { chatSyncRoutes } from './chat-sync';
import { ApiError, conflict, notFound, paymentRequired, unprocessable } from '../lib/errors';
import { assertActive } from '../lib/limits';
import { type CachedMedia, MediaCache, sendMedia } from '../lib/media-cache';

// The inbox (dashboard `/chats`): conversations of the workspace's own numbers, for admins and plans with `chats`. Hidden from /docs.
const schemaBase = { tags: ['Admin'], hide: true };
const SENDABLE = new Set(['connected', 'connecting']);
/** What the chat message DTO reads from a `messages` row. */
const MESSAGE_COLUMNS = 'id, direction, type, status, content, error, wa_message_id, raw is not null as has_raw, broadcast_id, sent_at, created_at';
const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'];
const PROFILE_TTL_MS = 30 * 60_000;
/** List pictures: WhatsApp's links last days; a missing picture (hidden, none) is asked again sooner. */
const PICTURE_TTL_MS = 6 * 3_600_000;
const PICTURE_MISS_TTL_MS = 3_600_000;
const UPLOAD_KEEP = '3 days';
/** Chats a number-wide sync asks the phone about (the most recent ones). */
const SYNC_CHATS = 30;

const jidSchema = z.string().min(5).max(128).regex(/^[\w.:-]+@(s\.whatsapp\.net|g\.us|lid)$/, 'Invalid chat');
const sessionParams = z.object({ sessionId: z.uuid() });

const lastDto = z.object({
  id: z.number(),
  direction: z.enum(MESSAGE_DIRECTIONS),
  type: z.enum(MESSAGE_TYPES),
  status: z.enum(MESSAGE_STATUSES),
  text: z.string().nullable(),
  sender: z.string().nullable(),
  createdAt: z.string(),
  /** Deleted for everyone by its sender (`text` is then null). */
  revoked: z.boolean(),
});

const chatDto = z.object({
  jid: z.string(),
  altJid: z.string().nullable(),
  name: z.string().nullable(),
  phone: z.string().nullable(),
  isGroup: z.boolean(),
  unread: z.number(),
  pinned: z.boolean(),
  archived: z.boolean(),
  inbound: z.number(),
  outbound: z.number(),
  lastMessageAt: z.string(),
  lastInboundAt: z.string().nullable(),
  last: lastDto.nullable(),
});

const countsDto = z.object(Object.fromEntries(CHAT_FILTERS.map((f) => [f, z.number()])) as Record<(typeof CHAT_FILTERS)[number], z.ZodNumber>);

const chatMessageDto = z.object({
  id: z.number(),
  direction: z.enum(MESSAGE_DIRECTIONS),
  type: z.enum(MESSAGE_TYPES),
  status: z.enum(MESSAGE_STATUSES),
  content: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  waMessageId: z.string().nullable(),
  /** The file can be fetched from /api/chats/media/:id. */
  hasMedia: z.boolean(),
  /** Sent by a campaign. */
  broadcastId: z.uuid().nullable(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
});

/** Someone in a group: a name to show (null = none known) and their number (null for a hidden LID). */
const personDto = z.object({ name: z.string().nullable(), phone: z.string().nullable() });
type Person = z.infer<typeof personDto>;

type ChatRow = {
  jid: string;
  alt_jid: string | null;
  name: string | null;
  unread_count: number;
  pinned_at: Date | null;
  archived_at: Date | null;
  inbound_count: number;
  outbound_count: number;
  last_message_at: Date;
  last_inbound_at: Date | null;
  m_id: number | null;
  m_direction: MessageDirection | null;
  m_type: MessageType | null;
  m_status: MessageStatus | null;
  m_text: string | null;
  m_sender: string | null;
  m_revoked: boolean | null;
  m_at: Date | null;
};

const toChatDto = (r: ChatRow): z.infer<typeof chatDto> => ({
  jid: r.jid,
  altJid: r.alt_jid,
  name: r.name,
  phone: jidToPhone(r.jid),
  isGroup: r.jid.endsWith('@g.us'),
  unread: r.unread_count,
  pinned: r.pinned_at !== null,
  archived: r.archived_at !== null,
  inbound: r.inbound_count,
  outbound: r.outbound_count,
  lastMessageAt: r.last_message_at.toISOString(),
  lastInboundAt: r.last_inbound_at?.toISOString() ?? null,
  last:
    r.m_id !== null
      ? { id: r.m_id, direction: r.m_direction!, type: r.m_type!, status: r.m_status!, text: r.m_revoked ? null : r.m_text, sender: r.m_sender, createdAt: r.m_at!.toISOString(), revoked: r.m_revoked === true }
      : null,
});

type MessageRow = {
  id: number;
  direction: MessageDirection;
  type: MessageType;
  status: MessageStatus;
  content: Record<string, unknown>;
  error: string | null;
  wa_message_id: string | null;
  has_raw: boolean;
  broadcast_id: string | null;
  sent_at: Date | null;
  created_at: Date;
};

const toMessageDto = (m: MessageRow): z.infer<typeof chatMessageDto> => {
  const url = typeof m.content.url === 'string' ? m.content.url : null;
  return {
    id: m.id,
    direction: m.direction,
    type: m.type,
    status: m.status,
    content: m.content,
    error: m.error,
    waMessageId: m.wa_message_id,
    hasMedia: MEDIA_TYPES.includes(m.type) && (m.has_raw || Boolean(url)),
    broadcastId: m.broadcast_id,
    sentAt: m.sent_at?.toISOString() ?? null,
    createdAt: m.created_at.toISOString(),
  };
};

/** Opaque list cursor: the sort key of the last chat returned. */
type Cursor = { p: number; t: string; j: string };
const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(value: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(value, 'base64url').toString()) as Cursor;
    return typeof c.p === 'number' && typeof c.t === 'string' && typeof c.j === 'string' ? c : null;
  } catch {
    return null;
  }
}

/** What an uploaded file is sent as. */
function kindOf(mimetype: string): 'image' | 'video' | 'audio' | 'document' {
  if (/^image\/(jpeg|png|webp|gif)$/.test(mimetype)) return 'image';
  if (/^video\/(mp4|3gpp|quicktime)$/.test(mimetype)) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'document';
}

export function chatRoutes(deps: Deps): FastifyPluginAsyncZod {
  const { sql, workers } = deps;
  const media = new MediaCache();
  const pictures = new Map<string, { url: string | null; at: number }>();
  const profiles = new Map<string, { at: number; value: { pictureUrl: string | null; about: string | null; name: string | null } }>();

  const publish = (event: WaEvent) => notify(sql, CHANNELS.events, event);

  const findChat = async (sessionId: string, jid: string) => {
    const [chat] = await sql<{ jid: string; alt_jid: string | null; unread_count: number; inbound_count: number; name: string | null }[]>`
      select jid, alt_jid, unread_count, inbound_count, name from chats where session_id = ${sessionId} and (jid = ${jid} or alt_jid = ${jid})`;
    return chat ?? null;
  };
  /** Both addresses a conversation's messages may be stored under. */
  const jidsOf = (chat: { jid: string; alt_jid: string | null } | null, jid: string) => (chat ? [chat.jid, ...(chat.alt_jid ? [chat.alt_jid] : [])] : [jid]);
  /**
   * People in groups, by address (phone number or LID): their phone number when known, and a name —
   * saved on the phone, else a business's verified name, else the latest WhatsApp name they wrote under.
   */
  const peopleOf = async (sessionId: string, addresses: string[]): Promise<Record<string, Person>> => {
    if (!addresses.length) return {};
    const rows = await sql<{ jid: string; pn: string | null; name: string | null }[]>`
      with x as (
        select a.jid,
          case when a.jid like '%@lid' then (select pn from contact_lids where session_id = ${sessionId} and lid = a.jid) else a.jid end as pn,
          case when a.jid like '%@lid' then a.jid else (select lid from contact_lids where session_id = ${sessionId} and pn = a.jid limit 1) end as lid
        from (select distinct unnest(${addresses}::text[]) as jid) a)
      select x.jid, x.pn, coalesce(
        (select coalesce(n.saved_name, n.verified_name) from contact_names n
         where n.session_id = ${sessionId} and n.jid in (x.pn, x.lid) and coalesce(n.saved_name, n.verified_name) is not null
         order by (n.saved_name is not null) desc limit 1),
        (select m.content->>'pushName' from messages m
         where m.session_id = ${sessionId} and m.direction = 'in' and m.content->>'from' in (x.pn, x.lid) and usable_contact_name(m.content->>'pushName')
         order by m.id desc limit 1)) as name
      from x`;
    return Object.fromEntries(rows.map((r) => [r.jid, { name: r.name, phone: jidToPhone(r.pn) }]));
  };

  return async (app) => {
    // Admins always get in; customers need a plan that bundles `chats` (Business and up).
    app.addHook('onRequest', async (req) => {
      requirePat(req);
      if (!req.auth.isAdmin && !planHasFeature(req.auth.planId, 'chats')) {
        throw paymentRequired('Chats are not included in your plan. Upgrade to Business to unlock them.', 'feature_not_in_plan');
      }
    });

    // Conversation sync jobs: a child plugin, so the plan gate above applies to it too.
    await app.register(chatSyncRoutes(deps));

    // Uploads are raw bytes (no multipart): the file name and type travel in headers.
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: UPLOAD_MAX_BYTES }, (_req, body, done) => done(null, body));

    app.get(
      '/numbers',
      {
        schema: {
          ...schemaBase,
          summary: 'The numbers of the workspace, with their unread conversations',
          response: {
            200: successSchema(
              z.array(
                z.object({ id: z.uuid(), name: z.string(), phone: z.string().nullable(), status: z.string(), chats: z.number(), unreadChats: z.number(), unread: z.number() }),
              ),
            ),
          },
        },
      },
      async (req) => {
        const rows = await sql<{ id: string; name: string; phone: string | null; status: string; chats: number; unread_chats: number; unread: number }[]>`
          select s.id, s.name, s.phone, s.status,
            count(c.jid)::int as chats,
            count(c.jid) filter (where c.unread_count > 0 and c.archived_at is null)::int as unread_chats,
            coalesce(sum(c.unread_count) filter (where c.archived_at is null), 0)::int as unread
          from sessions s left join chats c on c.session_id = s.id
          where s.workspace_id = ${req.auth.workspaceId}
          group by s.id
          order by s.created_at`;
        return ok(rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, status: r.status, chats: r.chats, unreadChats: r.unread_chats, unread: r.unread })));
      },
    );

    app.get(
      '/:sessionId/list',
      {
        schema: {
          ...schemaBase,
          summary: 'Conversations of a number, pinned first then newest',
          params: sessionParams,
          querystring: z.object({
            filter: z.enum(CHAT_FILTERS).default('all'),
            q: z.string().trim().max(100).optional(),
            cursor: z.string().max(400).optional(),
            limit: z.coerce.number().int().min(1).max(100).default(40),
          }),
          response: { 200: successSchema(z.object({ chats: z.array(chatDto), next: z.string().nullable(), counts: countsDto.nullable() })) },
        },
      },
      async (req) => {
        const session = await ownedSession(sql, req, req.params.sessionId);
        const { filter, q, cursor: rawCursor, limit } = req.query;
        const cursor = rawCursor ? decodeCursor(rawCursor) : null;

        const filters: Record<(typeof CHAT_FILTERS)[number], SqlFragment> = {
          all: sql`c.archived_at is null`,
          unread: sql`c.unread_count > 0 and c.archived_at is null`,
          contacts: sql`c.jid not like '%@g.us' and c.archived_at is null`,
          groups: sql`c.jid like '%@g.us' and c.archived_at is null`,
          replied: sql`c.inbound_count > 0 and c.outbound_count > 0 and c.archived_at is null`,
          noReply: sql`c.inbound_count = 0 and c.archived_at is null`,
          pinned: sql`c.pinned_at is not null`,
          archived: sql`c.archived_at is not null`,
        };
        const digits = q?.replace(/\D/g, '') ?? '';
        const search = q
          ? digits.length >= 3
            ? sql`and (chat_display_name(c.session_id, c.jid, c.alt_jid, c.name) ilike ${`%${q}%`} or c.jid like ${`%${digits}%`})`
            : sql`and chat_display_name(c.session_id, c.jid, c.alt_jid, c.name) ilike ${`%${q}%`}`
          : sql``;
        const after = cursor
          ? sql`and ((c.pinned_at is not null)::int, c.last_message_at, c.jid) < (${cursor.p}, ${cursor.t}::timestamptz, ${cursor.j})`
          : sql``;

        const rows = await sql<(ChatRow & { pinned: number })[]>`
          select c.jid, c.alt_jid, chat_display_name(c.session_id, c.jid, c.alt_jid, c.name) as name, c.unread_count, c.pinned_at, c.archived_at, c.inbound_count, c.outbound_count,
            c.last_message_at, c.last_inbound_at, (c.pinned_at is not null)::int as pinned,
            m.id as m_id, m.direction as m_direction, m.type as m_type, m.status as m_status,
            coalesce(m.content->>'text', m.content->>'caption', m.content->>'name', m.content->'poll'->>'name') as m_text,
            coalesce((m.content->>'revoked')::boolean, false) as m_revoked,
            case when m.direction = 'in' and c.jid like '%@g.us' then coalesce(m.content->>'pushName', m.content->>'fromPhone') end as m_sender,
            m.created_at as m_at
          from chats c left join messages m on m.id = c.last_message_id
          where c.session_id = ${session.id} and ${filters[filter]} ${search} ${after}
          order by (c.pinned_at is not null) desc, c.last_message_at desc, c.jid desc
          limit ${limit + 1}`;
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        const next = rows.length > limit && last ? encodeCursor({ p: last.pinned, t: last.last_message_at.toISOString(), j: last.jid }) : null;

        let counts: z.infer<typeof countsDto> | null = null;
        if (!cursor) {
          const [c] = await sql<z.infer<typeof countsDto>[]>`
            select
              count(*) filter (where archived_at is null)::int as "all",
              count(*) filter (where unread_count > 0 and archived_at is null)::int as unread,
              count(*) filter (where jid not like '%@g.us' and archived_at is null)::int as contacts,
              count(*) filter (where jid like '%@g.us' and archived_at is null)::int as groups,
              count(*) filter (where inbound_count > 0 and outbound_count > 0 and archived_at is null)::int as replied,
              count(*) filter (where inbound_count = 0 and archived_at is null)::int as "noReply",
              count(*) filter (where pinned_at is not null)::int as pinned,
              count(*) filter (where archived_at is not null)::int as archived
            from chats where session_id = ${session.id}`;
          counts = c ?? null;
        }
        return ok({ chats: page.map(toChatDto), next, counts });
      },
    );

    app.get(
      '/:sessionId/chat',
      {
        schema: {
          ...schemaBase,
          summary: 'One conversation and its numbers (contact panel)',
          params: sessionParams,
          querystring: z.object({ jid: jidSchema }),
          response: {
            200: successSchema(
              z.object({
                chat: chatDto.nullable(),
                stats: z.object({
                  firstAt: z.string().nullable(),
                  total: z.number(),
                  campaign: z.number(),
                  media: z.number(),
                  delivered: z.number(),
                  read: z.number(),
                  failed: z.number(),
                  outbound: z.number(),
                  byType: z.record(z.string(), z.number()),
                }),
                optedOut: z.boolean(),
              }),
            ),
          },
        },
      },
      async (req) => {
        const session = await ownedSession(sql, req, req.params.sessionId);
        const found = await findChat(session.id, req.query.jid);
        const jids = jidsOf(found, req.query.jid);
        const [row] = await sql<ChatRow[]>`
          select c.jid, c.alt_jid, chat_display_name(c.session_id, c.jid, c.alt_jid, c.name) as name, c.unread_count, c.pinned_at, c.archived_at, c.inbound_count, c.outbound_count,
            c.last_message_at, c.last_inbound_at,
            m.id as m_id, m.direction as m_direction, m.type as m_type, m.status as m_status,
            coalesce(m.content->>'text', m.content->>'caption', m.content->>'name') as m_text, null as m_sender, m.created_at as m_at,
            coalesce((m.content->>'revoked')::boolean, false) as m_revoked
          from chats c left join messages m on m.id = c.last_message_id
          where c.session_id = ${session.id} and c.jid = ${found?.jid ?? req.query.jid}`;
        const [stats] = await sql<{ first_at: Date | null; total: number; campaign: number; media: number; delivered: number; read: number; failed: number; outbound: number; by_type: Record<string, number> | null }[]>`
          select min(created_at) as first_at, count(*)::int as total,
            count(*) filter (where broadcast_id is not null)::int as campaign,
            count(*) filter (where type = any(${MEDIA_TYPES}))::int as media,
            count(*) filter (where direction = 'out' and status in ('delivered', 'read'))::int as delivered,
            count(*) filter (where direction = 'out' and status = 'read')::int as "read",
            count(*) filter (where direction = 'out' and status = 'failed')::int as failed,
            count(*) filter (where direction = 'out')::int as outbound,
            (select jsonb_object_agg(type, n) from (
              select type, count(*)::int as n from messages
              where session_id = ${session.id} and remote_jid = any(${jids}) group by type) t) as by_type
          from messages where session_id = ${session.id} and remote_jid = any(${jids}) and type <> 'reaction'`;
        const phone = jidToPhone(found?.jid ?? req.query.jid);
        const [optOut] = phone ? await sql`select 1 from opt_outs where workspace_id = ${req.auth.workspaceId} and phone = ${phone}` : [];
        return ok({
          chat: row ? toChatDto(row) : null,
          stats: {
            firstAt: stats?.first_at?.toISOString() ?? null,
            total: stats?.total ?? 0,
            campaign: stats?.campaign ?? 0,
            media: stats?.media ?? 0,
            delivered: stats?.delivered ?? 0,
            read: stats?.read ?? 0,
            failed: stats?.failed ?? 0,
            outbound: stats?.outbound ?? 0,
            byType: stats?.by_type ?? {},
          },
          optedOut: Boolean(optOut),
        });
      },
    );

    app.get(
      '/:sessionId/messages',
      {
        schema: {
          ...schemaBase,
          summary: 'A conversation, newest first',
          params: sessionParams,
          querystring: z.object({
            jid: jidSchema,
            before: z.coerce.number().int().positive().optional().describe('Older than this message (by time)'),
            after: z.coerce.number().int().nonnegative().optional().describe('Newer than this message (catching up)'),
            q: z.string().trim().min(1).max(100).optional(),
            kind: z.enum(['media', 'documents', 'audio']).optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          }),
          response: {
            200: successSchema(
              z.object({
                messages: z.array(chatMessageDto),
                nextBefore: z.number().nullable(),
                /** Groups: who sent the page's incoming messages, by their `content.from`. */
                senders: z.record(z.string(), personDto),
              }),
            ),
          },
        },
      },
      async (req) => {
        const session = await ownedSession(sql, req, req.params.sessionId);
        const { jid, before, after, q, kind, limit } = req.query;
        const jids = jidsOf(await findChat(session.id, jid), jid);
        const kinds = { media: ['image', 'video'], documents: ['document'], audio: ['audio'] };
        const rows = await sql<MessageRow[]>`
          select id, direction, type, status, content, error, wa_message_id, raw is not null as has_raw, broadcast_id, sent_at, created_at
          from messages
          where session_id = ${session.id} and remote_jid = any(${jids})
            ${before ? sql`and (created_at, id) < (select created_at, id from messages where id = ${before})` : sql``}
            ${after ? sql`and (created_at, id) > (select created_at, id from messages where id = ${after})` : sql``}
            ${q ? sql`and coalesce(content->>'text', content->>'caption', content->>'name', '') ilike ${`%${q}%`}` : sql``}
            ${kind ? sql`and type = any(${kinds[kind]})` : sql``}
          order by created_at desc, id desc
          limit ${limit}`;
        const froms = jid.endsWith('@g.us') ? rows.flatMap((m) => (m.direction === 'in' && typeof m.content.from === 'string' && !m.content.from.endsWith('@g.us') ? [m.content.from] : [])) : [];
        return ok({ messages: rows.map(toMessageDto), nextBefore: rows.length === limit ? rows.at(-1)!.id : null, senders: await peopleOf(session.id, froms) });
      },
    );

    app.post(
      '/:sessionId/send',
      {
        schema: {
          ...schemaBase,
          summary: 'Send a message in a conversation',
          description: 'Send an `Idempotency-Key` header (the page sends one per message) to make retries safe.',
          params: sessionParams,
          headers: z.object({ 'idempotency-key': z.string().min(1).max(255).optional() }),
          body: z
            .object({
              jid: jidSchema,
              text: z.string().trim().min(1).max(65_536).optional(),
              uploadId: z.uuid().optional(),
              /** WhatsApp id of the message replied to. */
              quoteId: z.string().min(1).max(128).optional(),
              ptt: z.boolean().optional(),
              /** Length of a voice note, shown by WhatsApp before it is played. */
              seconds: z.number().int().min(1).max(3600).optional(),
            })
            .refine((b) => b.text || b.uploadId, { message: 'Write a message or attach a file', path: ['text'] }),
          response: { 200: successSchema(chatMessageDto) },
        },
      },
      async (req) => {
        const { text, uploadId, quoteId, ptt, seconds } = req.body;
        const key = req.headers['idempotency-key'] ?? null;
        const sessionId = req.params.sessionId;
        // Every round trip to the database is felt on Send, so the lookups that don't depend on each
        // other run alongside the ownership check. Nothing they read is used unless that check passes.
        const lookups = Promise.all([
          findChat(sessionId, req.body.jid),
          uploadId
            ? sql<{ mimetype: string; file_name: string | null }[]>`
                select mimetype, file_name from media_uploads where id = ${uploadId} and workspace_id = ${req.auth.workspaceId}`
            : [],
          quoteId
            ? sql<{ direction: MessageDirection; text: string | null; participant: string | null }[]>`
                select direction, coalesce(content->>'text', content->>'caption', content->>'name') as text, raw->'key'->>'participant' as participant
                from messages where session_id = ${sessionId} and wa_message_id = ${quoteId}`
            : [],
          key ? sql<MessageRow[]>`select ${sql.unsafe(MESSAGE_COLUMNS)} from messages where session_id = ${sessionId} and idempotency_key = ${key}` : [],
        ]);
        lookups.catch(() => {}); // awaited below, once the session is known to be the caller's
        const session = await ownedSession(sql, req, sessionId);
        const [found, [upload], [quoted], [repeat]] = await lookups;
        // A retry of a message that already went through gets that message back, not a second one.
        if (repeat) return ok(toMessageDto(repeat));
        assertActive(req.auth);
        if (session.desired_state !== 'running' || !SENDABLE.has(session.status)) {
          throw conflict(`Session is not connected (status: ${session.status})`, 'session_not_connected');
        }
        const jid = found?.jid ?? req.body.jid;

        let content: OutboundContent;
        if (uploadId) {
          if (!upload) throw unprocessable('The attachment expired', { uploadId: ['Attach the file again'] });
          const url = `${UPLOAD_SCHEME}${uploadId}`;
          const kind = kindOf(upload.mimetype);
          content =
            kind === 'audio'
              ? { type: 'audio', url, ptt, ...(ptt && seconds ? { seconds } : {}) }
              : kind === 'document'
                ? { type: 'document', url, fileName: upload.file_name ?? undefined, mimetype: upload.mimetype, caption: text }
                : { type: kind, url, caption: text };
        } else {
          content = { type: 'text', text: text! };
        }
        if (quoteId && quoted) content.quote = { id: quoteId, fromMe: quoted.direction === 'out', participant: quoted.participant ?? undefined, text: quoted.text };
        // Typed by a person on the chats page: the worker skips the artificial "typing…" pause.
        // A contact who has written to this number is on WhatsApp: the worker can skip asking again.
        const stored = { ...content, sentFrom: 'chats' as const, ...(found && found.inbound_count > 0 ? { reachable: true as const } : {}) };

        // One round trip: the row, the worker's wake-up and the page's event (both sent on commit).
        const created = (id: SqlFragment) =>
          sql`jsonb_build_object('type', 'messages.created', 'workspaceId', ${req.auth.workspaceId}::text, 'sessionId', ${session.id}::text,
            'data', jsonb_build_object('id', ${id}, 'chatJid', ${jid}::text, 'direction', 'out', 'type', ${content.type}::text, 'ref', ${key}::text))::text`;
        let [row] = await sql<MessageRow[]>`
          with ins as (
            insert into messages (workspace_id, session_id, direction, remote_jid, type, content, status, idempotency_key)
            values (${req.auth.workspaceId}, ${session.id}, 'out', ${jid}, ${content.type}, ${sql.json(stored as never)}, 'queued', ${key})
            on conflict (session_id, idempotency_key) do nothing
            returning ${sql.unsafe(MESSAGE_COLUMNS)}
          )
          select ins.*, pg_notify(${CHANNELS.control}, ${JSON.stringify({ type: 'message.queued', sessionId: session.id })}), pg_notify(${CHANNELS.events}, ${created(sql`ins.id`)})
          from ins`;
        // Lost a race with a concurrent retry carrying the same key.
        if (!row) [row] = await sql<MessageRow[]>`select ${sql.unsafe(MESSAGE_COLUMNS)} from messages where session_id = ${session.id} and idempotency_key = ${key}`;

        // Answering a chat reads it, as on WhatsApp. Not worth holding the reply for.
        void markChatRead(sql, session.id, jid)
          .then(async (read) => {
            if (read) await publish({ type: 'chat.read', workspaceId: req.auth.workspaceId, sessionId: session.id, data: { chatJid: read } });
          })
          .catch((err: unknown) => req.log.warn({ err }, 'could not mark the chat read after sending'));
        return ok(toMessageDto(row!));
      },
    );

    app.post(
      '/:sessionId/sync',
      {
        schema: {
          ...schemaBase,
          summary: 'Fetch older messages from the phone (one chat, or the most recent ones)',
          description: 'The phone answers asynchronously; a `chats.synced` event follows when messages arrive.',
          params: sessionParams,
          body: z.object({ jid: jidSchema.optional() }),
          response: { 200: successSchema(z.object({ requested: z.number() })) },
        },
      },
      async (req) => {
        const session = await ownedSession(sql, req, req.params.sessionId);
        if (session.status !== 'connected') throw conflict('Connect the number to sync its chats', 'session_not_connected');
        const { jid } = req.body;
        // History is fetched from before the oldest message we hold of each chat.
        const anchors = await sql<{ remote_jid: string; wa_message_id: string; direction: MessageDirection; ts: number }[]>`
          select m.remote_jid, m.wa_message_id, m.direction,
            coalesce((m.content->>'timestamp')::float8 * 1000, extract(epoch from m.created_at) * 1000)::float8 as ts
          from chats c
          cross join lateral (
            select remote_jid, wa_message_id, direction, created_at, content from messages
            where session_id = c.session_id and remote_jid in (c.jid, coalesce(c.alt_jid, c.jid))
              and wa_message_id is not null and status <> 'failed'
            order by created_at, id limit 1
          ) m
          where c.session_id = ${session.id} ${jid ? sql`and (c.jid = ${jid} or c.alt_jid = ${jid})` : sql`and c.archived_at is null`}
          order by c.last_message_at desc
          limit ${SYNC_CHATS}`;
        if (anchors.length === 0) return ok({ requested: 0 });
        const result = await workers.call<{ requested: number }>(session.id, 'fetch-history', {
          anchors: anchors.map((a) => ({ chatJid: a.remote_jid, id: a.wa_message_id, fromMe: a.direction === 'out', timestampMs: Math.round(a.ts) })),
        });
        return ok({ requested: result.requested });
      },
    );

    app.post(
      '/:sessionId/read',
      {
        schema: {
          ...schemaBase,
          summary: 'Mark a conversation read (and send blue ticks)',
          params: sessionParams,
          body: z.object({ jid: jidSchema, receipts: z.boolean().default(true) }),
          response: { 200: successSchema(z.object({ read: z.number() })) },
        },
      },
      async (req) => {
        const session = await ownedSession(sql, req, req.params.sessionId);
        const chat = await findChat(session.id, req.body.jid);
        if (!chat || chat.unread_count === 0) return ok({ read: 0 });
        const unread = Math.min(chat.unread_count, 100);
        await markChatRead(sql, session.id, chat.jid);
        await publish({ type: 'chat.read', workspaceId: req.auth.workspaceId, sessionId: session.id, data: { chatJid: chat.jid } });
        if (req.body.receipts) {
          const rows = await sql<{ chat_jid: string; wa_message_id: string; participant: string | null }[]>`
            select remote_jid as chat_jid, wa_message_id, raw->'key'->>'participant' as participant
            from messages
            where session_id = ${session.id} and remote_jid = any(${jidsOf(chat, chat.jid)}) and direction = 'in' and wa_message_id is not null
            order by id desc limit ${unread}`;
          const messages = rows.map((r) => ({ chatJid: r.chat_jid, waMessageId: r.wa_message_id, ...(r.participant ? { participant: r.participant } : {}) }));
          // Best effort: the chat is read here either way; the ticks follow when the number is connected.
          if (messages.length) await workers.call(session.id, 'read', { messages }).catch((err) => req.log.info({ err: (err as Error).message }, 'read receipts not sent'));
        }
        return ok({ read: unread });
      },
    );

    app.post(
      '/:sessionId/flags',
      {
        schema: {
          ...schemaBase,
          summary: 'Pin, archive or mark a conversation unread',
          params: sessionParams,
          body: z.object({ jid: jidSchema, pinned: z.boolean().optional(), archived: z.boolean().optional(), unread: z.boolean().optional() }),
          response: { 200: successSchema(z.object({ ok: z.boolean() })) },
        },
      },
      async (req) => {
        const session = await ownedSession(sql, req, req.params.sessionId);
        const { pinned, archived, unread } = req.body;
        const chat = await findChat(session.id, req.body.jid);
        if (!chat) throw notFound('Conversation not found');
        await sql`
          update chats set
            pinned_at = ${pinned === undefined ? sql`pinned_at` : pinned ? sql`coalesce(pinned_at, now())` : null},
            archived_at = ${archived === undefined ? sql`archived_at` : archived ? sql`coalesce(archived_at, now())` : null},
            unread_count = ${unread === undefined ? sql`unread_count` : unread ? sql`greatest(unread_count, 1)` : 0}
          where session_id = ${session.id} and jid = ${chat.jid}`;
        return ok({ ok: true });
      },
    );

    app.post(
      '/:sessionId/watch',
      {
        schema: {
          ...schemaBase,
          summary: "Follow contacts' presence (online, typing…): the open chat and the top of the list",
          params: sessionParams,
          body: z
            .object({ jid: jidSchema.optional(), jids: z.array(jidSchema).max(40).optional() })
            .refine((b) => b.jid || b.jids?.length, { message: 'jid or jids is required', path: ['jid'] }),
          response: { 200: successSchema(z.object({ live: z.boolean() })) },
        },
      },
      async (req) => {
        const session = await ownedSession(sql, req, req.params.sessionId);
        if (session.status !== 'connected') return ok({ live: false });
        try {
          const jids = [...new Set([...(req.body.jid ? [req.body.jid] : []), ...(req.body.jids ?? [])])];
          await workers.call(session.id, 'watch-chat', { jids }, { timeoutMs: 20_000 });
          return ok({ live: true });
        } catch (err) {
          req.log.info({ err: (err as Error).message }, 'presence watch failed');
          return ok({ live: false });
        }
      },
    );

    app.post(
      '/:sessionId/typing',
      {
        schema: {
          ...schemaBase,
          summary: 'Show "typing…" to the contact',
          params: sessionParams,
          body: z.object({ jid: jidSchema, state: z.enum(['composing', 'recording', 'paused']) }),
          response: { 200: successSchema(z.object({ ok: z.boolean() })) },
        },
      },
      async (req) => {
        const session = await ownedSession(sql, req, req.params.sessionId);
        if (session.status !== 'connected') return ok({ ok: false });
        const sent = await workers
          .call(session.id, 'chat-state', req.body, { timeoutMs: 10_000 })
          .then(() => true)
          .catch(() => false);
        return ok({ ok: sent });
      },
    );

    app.get(
      '/:sessionId/profile',
      {
        schema: {
          ...schemaBase,
          summary: "A contact's picture and about text",
          params: sessionParams,
          querystring: z.object({ jid: jidSchema }),
          response: { 200: successSchema(z.object({ pictureUrl: z.string().nullable(), about: z.string().nullable(), name: z.string().nullable() })) },
        },
      },
      async (req) => {
        const session = await ownedSession(sql, req, req.params.sessionId);
        const key = `${session.id}:${req.query.jid}`;
        const cached = profiles.get(key);
        if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return ok(cached.value);
        if (session.status !== 'connected') return ok(cached?.value ?? { pictureUrl: null, about: null, name: null });
        const value = await workers
          .call<{ pictureUrl: string | null; about: string | null; name: string | null }>(session.id, 'profile', { jid: req.query.jid }, { timeoutMs: 20_000 })
          .catch(() => null);
        if (!value) return ok(cached?.value ?? { pictureUrl: null, about: null, name: null });
        if (profiles.size > 2_000) profiles.clear();
        profiles.set(key, { at: Date.now(), value });
        if (value.name && req.query.jid.endsWith('@g.us')) await setChatName(sql, session.id, req.query.jid, value.name);
        return ok(value);
      },
    );

    app.get(
      '/:sessionId/group-members',
      {
        schema: {
          ...schemaBase,
          summary: "A group's members (live from WhatsApp): admins first, then by name",
          params: sessionParams,
          querystring: z.object({ jid: jidSchema.refine((j) => j.endsWith('@g.us'), 'Not a group') }),
          response: {
            200: successSchema(
              z.object({
                members: z.array(
                  personDto.extend({ jid: z.string(), role: z.enum(['superadmin', 'admin', 'member']), isMe: z.boolean() }),
                ),
              }),
            ),
          },
        },
      },
      async (req) => {
        const session = await ownedSession(sql, req, req.params.sessionId);
        if (session.status !== 'connected') throw conflict('Connect the number to see the group members', 'session_not_connected');
        const { members } = await workers.call<{ members: GroupMember[] }>(session.id, 'group-members', { jid: req.query.jid }, { timeoutMs: 25_000 });
        const people = await peopleOf(session.id, members.flatMap((m) => [m.phoneJid ?? m.jid, ...(m.lid ? [m.lid] : [])]));
        const me = session.phone?.replace(/\D/g, '');
        const rank = { superadmin: 0, admin: 1, member: 2 };
        const list = members.map((m) => {
          const person = people[m.phoneJid ?? m.jid];
          const viaLid = m.lid ? people[m.lid] : undefined;
          const phone = person?.phone ?? viaLid?.phone ?? null;
          return { jid: m.jid, role: m.role, name: person?.name ?? viaLid?.name ?? null, phone, isMe: Boolean(me && phone?.replace(/\D/g, '') === me) };
        });
        list.sort((a, b) => Number(b.isMe) - Number(a.isMe) || rank[a.role] - rank[b.role] || Number(!a.name) - Number(!b.name) || (a.name ?? a.phone ?? a.jid).localeCompare(b.name ?? b.phone ?? b.jid));
        return ok({ members: list });
      },
    );

    app.get(
      '/:sessionId/pictures',
      {
        schema: {
          ...schemaBase,
          summary: 'Small profile pictures for the chat list',
          params: sessionParams,
          querystring: z.object({ jids: z.string().max(8_000) }),
          response: { 200: successSchema(z.record(z.string(), z.string().nullable())) },
        },
      },
      async (req) => {
        const session = await ownedSession(sql, req, req.params.sessionId);
        const jids = [...new Set(req.query.jids.split(','))].filter((j) => jidSchema.safeParse(j).success).slice(0, 50);
        const result: Record<string, string | null> = {};
        const missing: string[] = [];
        const now = Date.now();
        for (const jid of jids) {
          const hit = pictures.get(`${session.id}:${jid}`);
          if (hit && now - hit.at < (hit.url ? PICTURE_TTL_MS : PICTURE_MISS_TTL_MS)) result[jid] = hit.url;
          else missing.push(jid);
        }
        if (missing.length && session.status === 'connected') {
          const fetched = await workers
            .call<{ pictures: Record<string, string | null> }>(session.id, 'pictures', { jids: missing }, { timeoutMs: 30_000 })
            .catch(() => null);
          if (pictures.size > 20_000) pictures.clear();
          for (const jid of missing) {
            if (!fetched || !(jid in fetched.pictures)) continue;
            const url = fetched.pictures[jid] ?? null;
            pictures.set(`${session.id}:${jid}`, { url, at: now });
            result[jid] = url;
          }
        }
        return ok(result);
      },
    );

    app.get(
      '/media/:id',
      {
        config: { rateLimit: false },
        schema: {
          ...schemaBase,
          summary: 'The file of a chat message (images, video, voice notes, documents)',
          params: z.object({ id: z.coerce.number().int().positive() }),
          querystring: z.object({ download: z.coerce.boolean().optional() }),
        },
      },
      async (req, reply) => {
        const [m] = await sql<{ id: number; session_id: string; type: MessageType; content: Record<string, unknown>; raw: object | null }[]>`
          select id, session_id, type, content, raw from messages where id = ${req.params.id} and workspace_id = ${req.auth.workspaceId}`;
        if (!m || !MEDIA_TYPES.includes(m.type)) throw notFound('No media for this message');
        const info = (m.content.media ?? {}) as { mimetype?: string; fileName?: string };
        const url = typeof m.content.url === 'string' ? m.content.url : null;
        if (!m.raw && url && !url.startsWith(UPLOAD_SCHEME)) return reply.redirect(url);

        const file: CachedMedia = await media.get(String(m.id), async () => {
          const fileName = info.fileName ?? (typeof m.content.fileName === 'string' ? m.content.fileName : null);
          if (m.raw) {
            const { downloadMedia, isMediaExpired } = await import('@wa/provider');
            let raw: unknown = m.raw;
            const result = await downloadMedia(raw).catch(async (err: unknown) => {
              if (!isMediaExpired(err)) throw err;
              // WhatsApp dropped the file from its servers: the phone uploads it again.
              const fresh = await workers.call<{ raw: unknown }>(m.session_id, 'reupload-media', { raw }, { timeoutMs: 40_000 });
              raw = fresh.raw;
              await sql`update messages set raw = ${sql.json(raw as never)} where id = ${m.id}`;
              return downloadMedia(raw);
            });
            return { data: result.data, mimetype: info.mimetype ?? result.mimetype ?? 'application/octet-stream', fileName };
          }
          const upload = url ? await loadUpload(sql, url.slice(UPLOAD_SCHEME.length)) : null;
          if (!upload) throw new ApiError(410, 'This file is no longer available', undefined, { code: 'media_gone' });
          return { data: upload.data, mimetype: upload.mimetype, fileName: upload.fileName ?? fileName };
        }).catch((err: unknown) => {
          if (err instanceof ApiError) throw err;
          req.log.warn({ err, messageId: m.id }, 'media download failed');
          throw new ApiError(502, 'Could not download this file from WhatsApp', undefined, { code: 'media_unavailable' });
        });
        return sendMedia(req, reply, file, req.query.download === true);
      },
    );

    app.post(
      '/uploads',
      {
        bodyLimit: UPLOAD_MAX_BYTES,
        schema: {
          ...schemaBase,
          summary: 'Upload a file to attach to a message (raw bytes; name and type in X-File-Name / X-Mime-Type)',
          headers: z.object({ 'x-file-name': z.string().max(600).optional(), 'x-mime-type': z.string().regex(/^[\w.+-]+\/[\w.+-]+$/).max(120) }),
          response: { 200: successSchema(z.object({ id: z.uuid(), kind: z.enum(['image', 'video', 'audio', 'document']), size: z.number() })) },
        },
      },
      async (req) => {
        const data = req.body as Buffer;
        if (!Buffer.isBuffer(data) || data.length === 0) throw unprocessable('Empty file', { file: ['Choose a file'] });
        const mimetype = req.headers['x-mime-type'].toLowerCase();
        let fileName: string | null = null;
        try {
          fileName = req.headers['x-file-name'] ? decodeURIComponent(req.headers['x-file-name']).slice(0, 255) : null;
        } catch {
          fileName = null;
        }
        await sql`delete from media_uploads where created_at < now() - ${UPLOAD_KEEP}::interval`;
        const [row] = await sql<{ id: string }[]>`
          insert into media_uploads (workspace_id, file_name, mimetype, size, data)
          values (${req.auth.workspaceId}, ${fileName}, ${mimetype}, ${data.length}, ${data})
          returning id`;
        return ok({ id: row!.id, kind: kindOf(mimetype), size: data.length });
      },
    );

    app.get(
      '/:sessionId/insights',
      {
        schema: {
          ...schemaBase,
          summary: 'Conversation analytics of a number',
          params: sessionParams,
          querystring: z.object({
            days: z.coerce.number().int().min(1).max(90).default(14),
            tz: z.string().max(64).refine(isTimeZone, 'Unknown time zone').default('UTC'),
          }),
          response: {
            200: successSchema(
              z.object({
                totals: z.object({
                  inbound: z.number(),
                  outbound: z.number(),
                  delivered: z.number(),
                  read: z.number(),
                  failed: z.number(),
                  activeChats: z.number(),
                  newChats: z.number(),
                  contacted: z.number(),
                  replied: z.number(),
                  unread: z.number(),
                  medianResponseSec: z.number().nullable(),
                  responses: z.number(),
                }),
                daily: z.array(z.object({ day: z.string(), inbound: z.number(), outbound: z.number() })),
                /** Inbound messages by weekday (1 = Monday … 7) and hour, in `tz`. */
                hours: z.array(z.object({ dow: z.number(), hour: z.number(), n: z.number() })),
                types: z.array(z.object({ type: z.string(), n: z.number() })),
                top: z.array(z.object({ jid: z.string(), name: z.string().nullable(), phone: z.string().nullable(), inbound: z.number(), outbound: z.number() })),
              }),
            ),
          },
        },
      },
      async (req) => {
        const session = await ownedSession(sql, req, req.params.sessionId);
        const { days, tz } = req.query;
        const since = new Date(Date.now() - days * 86_400_000);
        const scope = sql`session_id = ${session.id} and created_at >= ${since} and type <> 'reaction'`;

        const [[totals], [chatsRow], [response], [reach], daily, hours, types, top] = await Promise.all([
          sql<{ inbound: number; outbound: number; delivered: number; read: number; failed: number; active_chats: number }[]>`
            select count(*) filter (where direction = 'in')::int as inbound,
              count(*) filter (where direction = 'out')::int as outbound,
              count(*) filter (where direction = 'out' and status in ('delivered', 'read'))::int as delivered,
              count(*) filter (where direction = 'out' and status = 'read')::int as "read",
              count(*) filter (where direction = 'out' and status = 'failed')::int as failed,
              count(distinct chat_jid_for(session_id, direction, remote_jid, content))::int as active_chats
            from messages where ${scope}`,
          sql<{ new_chats: number; unread: number }[]>`
            select count(*) filter (where created_at >= ${since})::int as new_chats, coalesce(sum(unread_count), 0)::int as unread
            from chats where session_id = ${session.id}`,
          // How fast we answer: from a contact's message to our next reply (campaign sends excluded).
          sql<{ median: number | null; n: number }[]>`
            select percentile_cont(0.5) within group (order by extract(epoch from created_at - prev_at))::float8 as median, count(*)::int as n
            from (
              select direction, created_at, broadcast_id,
                lag(direction) over w as prev_dir, lag(created_at) over w as prev_at
              from messages where ${scope}
              window w as (partition by chat_jid_for(session_id, direction, remote_jid, content) order by id)
            ) t
            where direction = 'out' and prev_dir = 'in' and broadcast_id is null`,
          // Reply rate: conversations we wrote to in the period, and how many wrote back afterwards.
          sql<{ contacted: number; replied: number }[]>`
            select count(*) filter (where first_out is not null)::int as contacted,
              count(*) filter (where first_out is not null and last_in > first_out)::int as replied
            from (
              select min(created_at) filter (where direction = 'out') as first_out, max(created_at) filter (where direction = 'in') as last_in
              from messages where ${scope} and remote_jid not like '%@g.us'
              group by chat_jid_for(session_id, direction, remote_jid, content)
            ) t`,
          sql<{ day: string; inbound: number; outbound: number }[]>`
            select to_char(date_trunc('day', created_at at time zone ${tz}), 'YYYY-MM-DD') as day,
              count(*) filter (where direction = 'in')::int as inbound, count(*) filter (where direction = 'out')::int as outbound
            from messages where ${scope} group by 1 order by 1`,
          sql<{ dow: number; hour: number; n: number }[]>`
            select extract(isodow from created_at at time zone ${tz})::int as dow, extract(hour from created_at at time zone ${tz})::int as hour, count(*)::int as n
            from messages where ${scope} and direction = 'in' group by 1, 2`,
          sql<{ type: string; n: number }[]>`
            select type, count(*)::int as n from messages where ${scope} group by type order by n desc`,
          sql<{ jid: string; inbound: number; outbound: number; name: string | null }[]>`
            select t.jid, t.inbound, t.outbound, chat_display_name(c.session_id, c.jid, c.alt_jid, c.name) as name
            from (
              select chat_jid_for(session_id, direction, remote_jid, content) as jid,
                count(*) filter (where direction = 'in')::int as inbound, count(*) filter (where direction = 'out')::int as outbound
              from messages where ${scope} group by 1
              order by count(*) filter (where direction = 'in') desc, count(*) desc limit 8
            ) t left join chats c on c.session_id = ${session.id} and c.jid = t.jid`,
        ]);

        return ok({
          totals: {
            inbound: totals?.inbound ?? 0,
            outbound: totals?.outbound ?? 0,
            delivered: totals?.delivered ?? 0,
            read: totals?.read ?? 0,
            failed: totals?.failed ?? 0,
            activeChats: totals?.active_chats ?? 0,
            newChats: chatsRow?.new_chats ?? 0,
            contacted: reach?.contacted ?? 0,
            replied: reach?.replied ?? 0,
            unread: chatsRow?.unread ?? 0,
            medianResponseSec: response?.median ?? null,
            responses: response?.n ?? 0,
          },
          daily,
          hours,
          types,
          top: top.map((r) => ({ ...r, phone: jidToPhone(r.jid) })),
        });
      },
    );
  };
}
