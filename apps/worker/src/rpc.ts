import { timingSafeEqual } from 'node:crypto';
import { ProviderError } from '@wa/provider';
import Fastify from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Supervisor } from './supervisor';
import { TimeoutError } from './timeout';

const params = z.object({ id: z.uuid() });

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

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ProviderError) {
      const status = err.code === 'invalid_input' ? 422 : 409;
      return reply.code(status).send({ code: err.code, message: err.message });
    }
    if (err instanceof z.ZodError) return reply.code(422).send({ code: 'invalid_input', message: err.message });
    if (err instanceof TimeoutError) return reply.code(504).send({ code: 'timeout', message: err.message });
    logger.error({ err }, 'rpc error');
    return reply.code(500).send({ code: 'internal', message: 'Worker error' });
  });

  const runnerFor = (raw: unknown) => {
    const { id } = params.parse(raw);
    const runner = supervisor.runner(id);
    if (!runner) throw new ProviderError('not_connected', 'Session is not running on this worker');
    return runner;
  };

  app.get('/health', async () => ({ ok: true, sessions: supervisor.size }));

  app.post('/sessions/:id/on-whatsapp', async (req) => {
    const { phones } = z.object({ phones: z.array(z.string()).min(1).max(50) }).parse(req.body);
    return { results: await runnerFor(req.params).isOnWhatsAppLookup(phones) };
  });

  app.post('/sessions/:id/pairing-code', async (req) => {
    const { phone } = z.object({ phone: z.string() }).parse(req.body);
    return { code: await runnerFor(req.params).requestPairingCode(phone) };
  });

  // The platform's verification codes: sent straight away, never queued or stored.
  app.post('/sessions/:id/send-text', async (req) => {
    const { to, text } = z.object({ to: z.string().regex(/^[1-9]\d{7,14}$/), text: z.string().min(1).max(1_000) }).parse(req.body);
    return runnerFor(req.params).sendDirect(to, text);
  });

  // --- the admin chats page ---
  const jid = z.string().min(5).max(128).regex(/^[\w.:-]+@(s\.whatsapp\.net|g\.us|lid)$/);

  app.post('/sessions/:id/watch-chat', async (req) => {
    const body = z.object({ jid: jid.optional(), jids: z.array(jid).max(40).optional() }).parse(req.body);
    const jids = [...(body.jids ?? []), ...(body.jid ? [body.jid] : [])];
    if (jids.length === 0) throw new Error('jid or jids is required');
    await runnerFor(req.params).watchChats(jids);
    return { ok: true };
  });

  app.post('/sessions/:id/chat-state', async (req) => {
    const body = z.object({ jid, state: z.enum(['composing', 'recording', 'paused']) }).parse(req.body);
    await runnerFor(req.params).chatState(body.jid, body.state);
    return { ok: true };
  });

  app.post('/sessions/:id/read', async (req) => {
    const { messages } = z
      .object({ messages: z.array(z.object({ chatJid: jid, waMessageId: z.string().min(1).max(128), participant: z.string().max(128).optional() })).min(1).max(100) })
      .parse(req.body);
    await runnerFor(req.params).readMessages(messages);
    return { ok: true };
  });

  app.post('/sessions/:id/profile', async (req) => {
    const body = z.object({ jid }).parse(req.body);
    return runnerFor(req.params).profile(body.jid);
  });

  app.post('/sessions/:id/pictures', async (req) => {
    const { jids } = z.object({ jids: z.array(jid).min(1).max(50) }).parse(req.body);
    return { pictures: await runnerFor(req.params).pictures(jids) };
  });

  app.post('/sessions/:id/fetch-history', async (req) => {
    const { anchors } = z
      .object({
        anchors: z.array(z.object({ chatJid: jid, id: z.string().min(1).max(128), fromMe: z.boolean(), timestampMs: z.number().int().positive() })).min(1).max(50),
      })
      .parse(req.body);
    runnerFor(req.params).fetchHistory(anchors);
    return { requested: anchors.length };
  });

  app.post('/sessions/:id/reupload-media', async (req) => {
    const { raw } = z.object({ raw: z.record(z.string(), z.unknown()) }).parse(req.body);
    return { raw: await runnerFor(req.params).reuploadMedia(raw) };
  });

  app.post('/sessions/:id/logout', async (req) => {
    await runnerFor(req.params).logout();
    return { ok: true };
  });

  return app;
}
