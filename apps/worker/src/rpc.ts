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

  app.post('/sessions/:id/logout', async (req) => {
    await runnerFor(req.params).logout();
    return { ok: true };
  });

  return app;
}
