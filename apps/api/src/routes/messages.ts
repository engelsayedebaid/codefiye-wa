import { randomInt } from 'node:crypto';
import { and, desc, eq, getTableColumns, lt, messages, messageTemplates, notify } from '@wa/db';
import {
  CHANNELS,
  DEFAULT_OTP_TEMPLATES,
  isUserJid,
  MESSAGE_DIRECTIONS,
  MESSAGE_STATUSES,
  ok,
  type OutboundContent,
  POLL_LIMITS,
  renderTemplateParts,
  SESSION_STATUSES,
  sendMessageBody,
  type SendMessageBody,
  successSchema,
  type TemplateParts,
  templateName,
  templateVariables,
  templateVariablesInput,
  type TemplateVariables,
  toJid,
  toOutboundContent,
} from '@wa/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps';
import { resolveSession } from '../lib/auth';
import { messageDto, toMessageDto } from '../lib/dto';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { assertActive, assertDailyQuota } from '../lib/limits';

const tags = ['Messages'];
/** Every column but `raw` (the original WAMessage: large, and never part of a response). */
const { raw: _raw, ...listColumns } = getTableColumns(messages);
const sessionHeader = z.object({
  'x-session-id': z.uuid().optional().describe('Required with a workspace access token; ignored with a session key'),
});

/** Statuses in which we accept new messages: connected, or briefly reconnecting. */
const SENDABLE = new Set(['connected', 'connecting']);

const queuedResponse = z.object({
  msgId: z.number(),
  jid: z.string(),
  status: z.enum(MESSAGE_STATUSES),
  pollMsgId: z.number().optional().describe("Set when the template has buttons: the poll sent right after the message"),
});

/**
 * Turns a template into the messages to queue: the text (or an image "card" with the text as
 * caption) and, when it has buttons, a poll right after. Media in the request (e.g. `imageUrl`)
 * replaces the template's own image.
 */
function templateContents(template: TemplateParts, variables: TemplateVariables | undefined, request?: SendMessageBody): OutboundContent[] {
  const result = renderTemplateParts(template, variables);
  if (!result.rendered) throw unprocessable('Missing template variables', { variables: result.missing.map((name) => `Missing "${name}"`) });
  const { text, imageUrl, poll } = result.rendered;
  const fromRequest = request ? toOutboundContent({ ...request, text }) : null;
  const main: OutboundContent =
    fromRequest && fromRequest.type !== 'text' ? fromRequest : imageUrl ? { type: 'image', url: imageUrl, caption: text } : { type: 'text', text };
  if (!poll) return [main];
  const tooLong = poll.name.length > POLL_LIMITS.question || poll.options.some((o) => o.length > POLL_LIMITS.option);
  if (tooLong || new Set(poll.options).size !== poll.options.length) {
    throw unprocessable('The buttons are invalid once filled in', {
      buttons: [`Titles are limited to ${POLL_LIMITS.question} characters, buttons to ${POLL_LIMITS.option}, and buttons must differ`],
    });
  }
  return [main, { type: 'poll', name: poll.name, options: poll.options, selectableCount: 1 }];
}

/** Cryptographically random digits, zero-padded. */
const generateCode = (length: number) => String(randomInt(0, 10 ** length)).padStart(length, '0');

export function messageRoutes({ sql, db, workers }: Deps): FastifyPluginAsyncZod {
  const findTemplate = async (workspaceId: string, name: string) => {
    const [row] = await db
      .select()
      .from(messageTemplates)
      .where(and(eq(messageTemplates.workspaceId, workspaceId), eq(messageTemplates.name, name)));
    return row ?? null;
  };

  /**
   * Validates the session and recipient, honors Idempotency-Key, then queues the message for the
   * session's worker. `build` runs only when a new row is needed (not on an idempotent replay).
   */
  const enqueue = async (
    req: FastifyRequest,
    to: string,
    idempotencyKey: string | null,
    build: () => Promise<OutboundContent | OutboundContent[]>,
  ): Promise<{ msgId: number; jid: string; status: (typeof MESSAGE_STATUSES)[number]; pollMsgId?: number }> => {
    const session = await resolveSession(sql, req);
    assertActive(req.auth);
    const jid = toJid(to);
    if (!jid) throw unprocessable('Invalid recipient', { to: ['Use an E.164 number like +201012345678 or a WhatsApp JID'] });

    if (idempotencyKey) {
      const [existing] = await db
        .select({ id: messages.id, remoteJid: messages.remoteJid, status: messages.status })
        .from(messages)
        .where(and(eq(messages.sessionId, session.id), eq(messages.idempotencyKey, idempotencyKey)));
      if (existing) return { msgId: existing.id, jid: existing.remoteJid, status: existing.status };
    }

    if (session.desired_state !== 'running' || !SENDABLE.has(session.status)) {
      throw conflict(`Session is not connected (status: ${session.status})`, 'session_not_connected');
    }
    await assertDailyQuota(sql, req.auth);

    const contents = [await build()].flat();
    // One transaction so a card never goes out without its buttons; ids keep the send order.
    const rows = await sql.begin(async (tx) => {
      const inserted: { id: number; status: 'queued' }[] = [];
      for (const [i, content] of contents.entries()) {
        const [row] = await tx<{ id: number; status: 'queued' }[]>`
          insert into messages (workspace_id, session_id, direction, remote_jid, type, content, status, idempotency_key)
          values (${req.auth.workspaceId}, ${session.id}, 'out', ${jid}, ${content.type}, ${tx.json(content)}, 'queued', ${i === 0 ? idempotencyKey : null})
          on conflict (session_id, idempotency_key) do nothing
          returning id, status`;
        if (!row) return null;
        inserted.push(row);
      }
      return inserted;
    });
    const row = rows?.[0];
    if (!row) {
      // Lost a race with a concurrent request carrying the same Idempotency-Key.
      const [existing] = await db
        .select({ id: messages.id, remoteJid: messages.remoteJid, status: messages.status })
        .from(messages)
        .where(and(eq(messages.sessionId, session.id), eq(messages.idempotencyKey, idempotencyKey!)));
      return { msgId: existing!.id, jid: existing!.remoteJid, status: existing!.status };
    }
    await notify(sql, CHANNELS.control, { type: 'message.queued', sessionId: session.id });
    const poll = rows?.[1];
    return { msgId: row.id, jid, status: row.status, ...(poll ? { pollMsgId: poll.id } : {}) };
  };

  return async (app) => {
    app.post(
      '/send-message',
      {
        schema: {
          tags,
          summary: 'Send a message',
          description:
            'Type is inferred from the fields: `text` alone, or one of `imageUrl`, `videoUrl`, `audioUrl`, `documentUrl`, ' +
            '`stickerUrl`, `location`, `contact` (with `text` as caption where supported). Messages are queued and sent ' +
            'one at a time per session; track progress with GET /api/messages/{id}. Send an `Idempotency-Key` header to make retries safe. ' +
            'Instead of `text`, pass `template` (a saved template name) and `variables` to fill its `{{placeholders}}`.',
          headers: sessionHeader.extend({ 'idempotency-key': z.string().min(1).max(255).optional() }),
          body: sendMessageBody,
          response: { 200: successSchema(queuedResponse) },
        },
      },
      async (req) => {
        const result = await enqueue(req, req.body.to, req.headers['idempotency-key'] ?? null, async () => {
          if (!req.body.template) return toOutboundContent(req.body);
          const template = await findTemplate(req.auth.workspaceId, req.body.template);
          if (!template) throw unprocessable('Unknown template', { template: [`No template named "${req.body.template}"`] });
          return templateContents(template, req.body.variables, req.body);
        });
        return ok(result);
      },
    );

    app.post(
      '/send-otp',
      {
        schema: {
          tags,
          summary: 'Send a one-time code',
          description:
            'Sends a verification code as a text message and returns the code, so your app can verify what the user types. ' +
            'Pass your own `code`, or let us generate `length` random digits. The text comes from `template` (a saved template ' +
            'with a `{{code}}` placeholder), else your template named `otp`, else a built-in text in `lang`.',
          headers: sessionHeader,
          body: z.object({
            to: z.string().min(3).max(128).describe('E.164 number (+201012345678) or a JID'),
            code: z.string().regex(/^[0-9]{4,10}$/, 'Use 4-10 digits').optional(),
            length: z.number().int().min(4).max(10).default(6),
            template: templateName.optional(),
            lang: z.enum(['ar', 'en']).default('ar'),
            variables: templateVariablesInput.optional().describe('Extra placeholder values besides {{code}}'),
          }),
          response: { 200: successSchema(queuedResponse.extend({ code: z.string() })) },
        },
      },
      async (req) => {
        const code = req.body.code ?? generateCode(req.body.length);
        const result = await enqueue(req, req.body.to, null, async () => {
          let template: TemplateParts = { body: DEFAULT_OTP_TEMPLATES[req.body.lang] };
          if (req.body.template) {
            const saved = await findTemplate(req.auth.workspaceId, req.body.template);
            if (!saved) throw unprocessable('Unknown template', { template: [`No template named "${req.body.template}"`] });
            template = saved;
          } else {
            template = (await findTemplate(req.auth.workspaceId, 'otp')) ?? template;
          }
          if (!templateVariables(template.body).includes('code')) {
            throw unprocessable('The template has no {{code}} placeholder', { template: ['Add {{code}} where the code should appear'] });
          }
          return templateContents(template, { ...req.body.variables, code });
        });
        return ok({ ...result, code });
      },
    );

    app.get(
      '/messages',
      {
        schema: {
          tags,
          summary: 'List messages of a session',
          headers: sessionHeader,
          querystring: z.object({
            direction: z.enum(MESSAGE_DIRECTIONS).optional(),
            status: z.enum(MESSAGE_STATUSES).optional(),
            before: z.coerce.number().int().positive().optional().describe('Return messages with id lower than this (pagination cursor)'),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          }),
          response: { 200: successSchema(z.object({ messages: z.array(messageDto), nextBefore: z.number().nullable() })) },
        },
      },
      async (req) => {
        const session = await resolveSession(sql, req);
        const { direction, status, before, limit } = req.query;
        const rows = await db
          .select(listColumns)
          .from(messages)
          .where(
            and(
              eq(messages.sessionId, session.id),
              direction ? eq(messages.direction, direction) : undefined,
              status ? eq(messages.status, status) : undefined,
              before ? lt(messages.id, before) : undefined,
            ),
          )
          .orderBy(desc(messages.id))
          .limit(limit);
        return ok({ messages: rows.map(toMessageDto), nextBefore: rows.length === limit ? rows.at(-1)!.id : null });
      },
    );

    const findMessage = async (workspaceId: string, sessionId: string | null, id: number) => {
      const [row] = await db
        .select(listColumns)
        .from(messages)
        .where(and(eq(messages.id, id), eq(messages.workspaceId, workspaceId), sessionId ? eq(messages.sessionId, sessionId) : undefined));
      if (!row) throw notFound('Message not found');
      return row;
    };

    const messageParams = z.object({ id: z.coerce.number().int().positive() });

    app.get(
      '/messages/:id',
      { schema: { tags, summary: 'Get a message and its status', params: messageParams, response: { 200: successSchema(messageDto) } } },
      async (req) => ok(toMessageDto(await findMessage(req.auth.workspaceId, req.auth.keySessionId, req.params.id))),
    );

    app.post(
      '/messages/:id/resend',
      {
        schema: {
          tags,
          summary: 'Resend a failed message',
          params: messageParams,
          response: { 200: successSchema(messageDto) },
        },
      },
      async (req) => {
        assertActive(req.auth);
        const message = await findMessage(req.auth.workspaceId, req.auth.keySessionId, req.params.id);
        if (message.direction !== 'out' || message.status !== 'failed') throw conflict('Only failed outbound messages can be resent', 'not_resendable');
        const [updated] = await db
          .update(messages)
          .set({ status: 'queued', error: null, updatedAt: new Date() })
          .where(and(eq(messages.id, message.id), eq(messages.status, 'failed')))
          .returning(listColumns);
        if (!updated) throw conflict('Message is already being resent', 'not_resendable');
        await notify(sql, CHANNELS.control, { type: 'message.queued', sessionId: message.sessionId });
        return ok(toMessageDto(updated));
      },
    );

    app.get(
      '/on-whatsapp/:phone',
      {
        schema: {
          tags,
          summary: 'Check whether a number is on WhatsApp',
          headers: sessionHeader,
          params: z.object({ phone: z.string().max(32) }),
          response: { 200: successSchema(z.object({ exists: z.boolean(), jid: z.string().nullable() })) },
        },
      },
      async (req) => {
        const session = await resolveSession(sql, req);
        const jid = toJid(req.params.phone);
        if (!jid || !isUserJid(jid)) throw unprocessable('Invalid phone number', { phone: ['Use an E.164 number like +201012345678'] });
        const { results } = await workers.call<{ results: { exists: boolean; jid: string | null }[] }>(session.id, 'on-whatsapp', {
          phones: [jid.split('@')[0]],
        });
        return ok({ exists: results[0]?.exists ?? false, jid: results[0]?.jid ?? null });
      },
    );

    app.get(
      '/status',
      {
        schema: {
          tags: ['Sessions'],
          summary: 'Status of the current session',
          headers: sessionHeader,
          response: {
            200: successSchema(z.object({ sessionId: z.uuid(), status: z.enum(SESSION_STATUSES), phoneNumber: z.string().nullable() })),
          },
        },
      },
      async (req) => {
        const session = await resolveSession(sql, req);
        return ok({ sessionId: session.id, status: session.status as (typeof SESSION_STATUSES)[number], phoneNumber: session.phone });
      },
    );
  };
}
