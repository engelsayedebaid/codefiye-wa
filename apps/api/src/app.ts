import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import { hasZodFastifySchemaValidationErrors, jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { createPostgresBackend, setDefaultBackendFactory } from 'bullmq';
import { createDb, createEventBus } from '@wa/db';
import { API_VERSION, fail } from '@wa/shared';
import { config } from './config';
import { HttpError } from './lib/errors';
import { EventHub } from './lib/events';
import { refreshPlans } from './lib/plans';
import { WorkerBus } from './lib/workers';
import { registerAuth } from './plugins/auth';
import { messageRoutes } from './routes/messages';
import { sessionRoutes } from './routes/sessions';
import { consoleRoutes } from './routes/console';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers["x-api-key"]'],
    },
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
  });

  setDefaultBackendFactory(createPostgresBackend);
  const db = createDb();
  const events = createEventBus();
  const bus = new WorkerBus(db);
  const hub = new EventHub(events);
  await hub.start();
  app.decorate('db', db);
  await refreshPlans(db).catch((err) => app.log.warn({ err }, 'plans table not ready; using built-in defaults'));

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, { origin: config.corsOrigins, credentials: false });
  await app.register(swagger, {
    openapi: {
      info: { title: 'wa-platform API', version: API_VERSION },
      servers: [{ url: config.publicBaseUrl }],
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  // Serve the built dashboard (landing at /, app at /app) when dist exists — Railway single-service deploy.
  const dashDist = fileURLToPath(new URL('../../dashboard/dist', import.meta.url));
  const serveDashboard = existsSync(dashDist);
  if (serveDashboard) await app.register(fastifyStatic, { root: dashDist });

  app.setErrorHandler((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      const errors: Record<string, string[]> = {};
      for (const issue of err.validation) {
        const field = issue.instancePath.replace(/^\//, '').replace(/\//g, '.') || '_';
        (errors[field] ??= []).push(issue.message ?? 'Invalid value');
      }
      return reply.code(422).send(fail('Validation failed', errors));
    }
    if (err instanceof HttpError) return reply.code(err.statusCode).send(fail(err.message, err.errors));
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    return reply.code(status).send(fail(status >= 500 ? 'Internal server error' : (err as Error).message));
  });
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? '';
    const isApi = url.startsWith('/api') || url.startsWith('/docs') || url.startsWith('/health') || url.startsWith('/auth');
    if (serveDashboard && req.method === 'GET' && !isApi) return reply.sendFile('index.html');
    return reply.code(404).send(fail('Route not found'));
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-API-Version', API_VERSION);
  });

  app.get('/health', { schema: { hide: true } }, async () => {
    const [dbOk, workers] = await Promise.all([
      db.execute('select 1').then(() => true, () => false),
      bus.aliveWorkers().catch(() => []),
    ]);
    return { ok: dbOk, db: dbOk, workers: workers.length };
  });

  registerAuth(app);
  sessionRoutes(app, { db, bus, hub });
  messageRoutes(app, { db, bus });
  consoleRoutes(app);
  app.get('/auth/config', async () => ({ authUrl: process.env.NEON_AUTH_BASE_URL ?? null }));

  app.addHook('onClose', async () => {
    await Promise.allSettled([bus.close(), hub.close()]);
    await Promise.allSettled([events.close(), db.close()]);
  });

  return app;
}
