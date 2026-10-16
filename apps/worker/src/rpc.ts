import { timingSafeEqual } from 'node:crypto';
import { ProviderError } from '@wa/provider';
import Fastify from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Supervisor } from './supervisor';
import { TimeoutError } from './timeout';

const params = z.object({ id: z.uuid() });

/** A chat or contact address. */
const jid = z.string().min(5).max(128).regex(/^[\w.:-]+@(s\.whatsapp\.net|g\.us|lid)$/);

/**
 * The live-socket operations the API asks a worker for, by action name (the HTTP path and the
 * `wa_control` relay share them). Each validates its body and returns the JSON answer.
 */
export async function dispatch(supervisor: Supervisor, sessionId: string, action: string, body: unknown): Promise<unknown> {
  const { id } = params.parse({ id: sessionId });
  const runner = supervisor.runner(id);
  if (!runner) throw new ProviderError('not_connected', 'Session is not running on this worker');

  switch (action) {
    case 'on-whatsapp': {
      const { phones } = z.object({ phones: z.array(z.string()).min(1).max(50) }).parse(body);
      return { results: await runner.isOnWhatsAppLookup(phones) };
    }
    case 'pairing-code': {
      const { phone } = z.object({ phone: z.string() }).parse(body);
      return { code: await runner.requestPairingCode(phone) };
    }
    // The platform's verification codes: sent straight away, never queued or stored.
    case 'send-text': {
      const { to, text } = z.object({ to: z.string().regex(/^[1-9]\d{7,14}$/), text: z.string().min(1).max(1_000) }).parse(body);
      return runner.sendDirect(to, text);
    }

    // --- the admin chats page ---
    case 'watch-chat': {
      const parsed = z.object({ jid: jid.optional(), jids: z.array(jid).max(40).optional() }).parse(body);
      const jids = [...(parsed.jids ?? []), ...(parsed.jid ? [parsed.jid] : [])];
      if (jids.length === 0) throw new Error('jid or jids is required');
      await runner.watchChats(jids);
      return { ok: true };
    }
    case 'react': {
      const parsed = z
        .object({
          jid,
          target: z.object({ id: z.string().min(1).max(128), fromMe: z.boolean(), participant: z.string().max(128).optional() }),
          emoji: z.string().max(32),
        })
        .parse(body);
      return { id: await runner.react(parsed.jid, parsed.target, parsed.emoji) };
    }
    case 'edit-message': {
      const parsed = z.object({ jid, target: z.object({ id: z.string().min(1).max(128) }), text: z.string().min(1).max(4_096) }).parse(body);
      await runner.editMessage(parsed.jid, parsed.target, parsed.text);
      return { ok: true };
    }
    case 'delete-message': {
      const parsed = z
        .object({
          jid,
          target: z.object({ id: z.string().min(1).max(128), fromMe: z.boolean(), participant: z.string().max(128).optional() }),
          scope: z.enum(['everyone', 'me']),
          timestamp: z.number().int().positive(),
        })
        .parse(body);
      if (parsed.scope === 'everyone') await runner.revokeMessage(parsed.jid, parsed.target);
      else await runner.deleteForMe(parsed.jid, parsed.target, parsed.timestamp);
      return { ok: true };
    }
    case 'chat-state': {
      const parsed = z.object({ jid, state: z.enum(['composing', 'recording', 'paused']) }).parse(body);
      await runner.chatState(parsed.jid, parsed.state);
      return { ok: true };
    }
    case 'read': {
      const { messages } = z
        .object({ messages: z.array(z.object({ chatJid: jid, waMessageId: z.string().min(1).max(128), participant: z.string().max(128).optional() })).min(1).max(100) })
        .parse(body);
      await runner.readMessages(messages);
      return { ok: true };
    }
    case 'profile': {
      const parsed = z.object({ jid }).parse(body);
      return runner.profile(parsed.jid);
    }
    case 'group-members': {
      const parsed = z.object({ jid: jid.refine((j) => j.endsWith('@g.us'), 'not a group') }).parse(body);
      return { members: await runner.groupMembers(parsed.jid) };
    }
    case 'group-send-check': {
      const parsed = z.object({ jid: jid.refine((j) => j.endsWith('@g.us'), 'not a group') }).parse(body);
      return runner.groupSendCheck(parsed.jid);
    }
    case 'pictures': {
      const { jids } = z.object({ jids: z.array(jid).min(1).max(50) }).parse(body);
      return { pictures: await runner.pictures(jids) };
    }
    case 'fetch-history': {
      const { anchors } = z
        .object({
          anchors: z.array(z.object({ chatJid: jid, id: z.string().min(1).max(128), fromMe: z.boolean(), timestampMs: z.number().int().positive() })).min(1).max(50),
        })
        .parse(body);
      runner.fetchHistory(anchors);
      return { requested: anchors.length };
    }
    case 'reupload-media': {
      const { raw } = z.object({ raw: z.record(z.string(), z.unknown()) }).parse(body);
      return { raw: await runner.reuploadMedia(raw) };
    }
    case 'logout':
      await runner.logout();
      return { ok: true };
    default:
      throw new UnknownAction(action);
  }
}

export class UnknownAction extends Error {
  constructor(action: string) {
    super(`Unknown action: ${action}`);
    this.name = 'UnknownAction';
  }
}

/** The HTTP status, code and message a failed call answers with (same over HTTP and the relay). */
export function describeRpcError(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof ProviderError) return { status: err.code === 'invalid_input' ? 422 : 409, code: err.code, message: err.message };
  if (err instanceof z.ZodError) return { status: 422, code: 'invalid_input', message: err.message };
  if (err instanceof TimeoutError) return { status: 504, code: 'timeout', message: err.message };
  if (err instanceof UnknownAction) return { status: 404, code: 'not_found', message: err.message };
  return { status: 500, code: 'internal', message: 'Worker error' };
}

/**
 * Internal HTTP API the public API calls for operations that need the live socket. Protected by
 * WORKER_SECRET; never expose this port publicly.
 */
export function buildRpcServer(supervisor: Supervisor, secret: string, logger: Logger) {
  // Request logs are noise here (the API logs the public request); keep warnings and errors.
  const app = Fastify({ loggerInstance: logger.child({ component: 'rpc' }, { level: 'warn' }) });
  const expected = Buffer.from(secret);

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;
    const given = Buffer.from(String(req.headers['x-worker-secret'] ?? ''));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return reply.code(401).send({ code: 'unauthorized', message: 'Invalid worker secret' });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    const described = describeRpcError(err);
    if (described.status === 500) logger.error({ err, url: req.url }, 'rpc error');
    return reply.code(described.status).send({ code: described.code, message: described.message });
  });

  app.get('/health', async () => ({ ok: true, sessions: supervisor.size }));

  app.post<{ Params: { id: string; action: string } }>('/sessions/:id/:action', async (req) => dispatch(supervisor, req.params.id, req.params.action, req.body));

  return app;
}
