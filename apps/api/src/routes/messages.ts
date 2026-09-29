import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, messages, sessions, sql, workspaces, type Db } from '@wa/db';
import { ok, sendMessageSchema, toJid, type SendMessageInput } from '@wa/shared';
import type { OutboundContent } from '@wa/provider';
import { requireActive, resolveSession } from '../plugins/auth';
import { forbidden, notConnected, notFound } from '../lib/errors';
import { effectivePlan } from '../lib/plans';
import type { WorkerBus } from '../lib/workers';

function toContent(b: SendMessageInput): OutboundContent {
  const caption = b.text;
  if (b.imageUrl) return { type: 'image', url: b.imageUrl, caption, mimetype: b.mimetype };
  if (b.videoUrl) return { type: 'video', url: b.videoUrl, caption, mimetype: b.mimetype };
  if (b.audioUrl) return { type: 'audio', url: b.audioUrl, mimetype: b.mimetype };
  if (b.documentUrl) return { type: 'document', url: b.documentUrl, fileName: b.fileName, mimetype: b.mimetype, caption };
  if (b.stickerUrl) return { type: 'sticker', url: b.stickerUrl };
  if (b.location) return { type: 'location', ...b.location };
  if (b.contact) return { type: 'contact', ...b.contact };
  return { type: 'text', text: b.text! };
}

const publicMessage = (m: typeof messages.$inferSelect) => ({
  id: m.id,
  direction: m.direction,
  to: m.remoteJid,
  type: m.type,
  status: m.status,
  waMessageId: m.waMessageId,
  error: m.error,
  createdAt: m.createdAt,
});

export function messageRoutes(app: FastifyInstance, deps: { db: Db; bus: WorkerBus }) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, bus } = deps;
  const tags = ['Messages'];

  r.post(
    '/api/send-message',
    {
      schema: {
        tags,
        summary: 'Send text, image, video, audio, document, sticker, location, or contact',
        body: sendMessageSchema,
        headers: z.object({ 'idempotency-key': z.string().max(255).optional() }).loose(),
      },
    },
    async (req, reply) => {
      requireActive(req);
      const session = await resolveSession(app, req);
      if (session.status !== 'connected' || !session.workerId) throw notConnected();
      const idempotencyKey = req.headers['idempotency-key'];

      const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, req.auth.workspaceId), columns: { planId: true, planExpiresAt: true } });
      const dailyCap = effectivePlan(ws ?? { planId: 'trial', planExpiresAt: null }).dailyMessages;
      if (dailyCap != null) {
        const [today] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(messages)
          .where(and(eq(messages.sessionId, session.id), eq(messages.direction, 'out'), sql`${messages.createdAt} >= current_date`));
        if ((today?.count ?? 0) >= dailyCap) throw forbidden(`وصلت للحد اليومي للباقة التجريبية (${dailyCap} رسالة). رقّي باقتك للمتابعة.`);
      }

      if (idempotencyKey) {
        const existing = await db.query.messages.findFirst({
          where: and(eq(messages.sessionId, session.id), eq(messages.idempotencyKey, idempotencyKey)),
        });
        if (existing) return ok(publicMessage(existing));
      }

      const content = toContent(req.body);
      const [msg] = await db
        .insert(messages)
        .values({
          sessionId: session.id,
          direction: 'out',
          remoteJid: toJid(req.body.to),
          type: content.type,
          body: content,
          idempotencyKey,
        })
        .returning();
      await bus.enqueueSend(session.workerId, { messageId: msg!.id, sessionId: session.id });
      reply.code(202);
      return ok(publicMessage(msg!));
    },
  );

  r.get('/api/messages/:id', { schema: { tags, summary: 'Message status', params: z.object({ id: z.uuid() }) } }, async (req) => {
    const session = await resolveSession(app, req);
    const msg = await db.query.messages.findFirst({ where: and(eq(messages.id, req.params.id), eq(messages.sessionId, session.id)) });
    if (!msg) throw notFound('Message not found');
    return ok(publicMessage(msg));
  });

  r.get(
    '/api/on-whatsapp/:id',
    { schema: { tags, summary: 'Check if a number/JID is on WhatsApp', params: z.object({ id: z.string().min(3).max(64) }) } },
    async (req) => {
      const session = await resolveSession(app, req);
      if (session.status !== 'connected' || !session.workerId) throw notConnected();
      return ok(await bus.rpc(session.workerId, { op: 'on-whatsapp', sessionId: session.id, jid: toJid(req.params.id) }));
    },
  );

  r.get('/api/status', { schema: { tags: ['Sessions'], summary: 'Status of the current session' } }, async (req) => {
    const session = await resolveSession(app, req);
    return ok({ id: session.id, status: session.status, phone: session.phone, lastSeenAt: session.lastSeenAt });
  });
}
