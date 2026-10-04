import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import { CONNECTION_ERRORS, PG_ERRORS, pgErrorCode } from '@wa/db';
import { getPlan, type ApiFailure } from '@wa/shared';
import Fastify, { type FastifyError, type FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import type { Deps } from './deps';
import { ApiError, codeForStatus, notFound, tooMany } from './lib/errors';
import { accountRoutes, publicAccountRoutes } from './routes/account';
import { adminRoutes } from './routes/admin';
import { broadcastRoutes } from './routes/broadcasts';
import { chatRoutes } from './routes/chats';
import { eventRoutes } from './routes/events';
import { keyRoutes } from './routes/keys';
import { messageRoutes } from './routes/messages';
import { sessionRoutes } from './routes/sessions';
import { templateRoutes } from './routes/templates';

/** Floor for dashboard sessions, so browsing the console on a small plan doesn't trip the API limit. */
const CONSOLE_RPM = 240;
/** No request may hang: anything still running after this gets a 503 (SSE streams excepted). */
const HANDLER_TIMEOUT_MS = 60_000;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

export type AppOptions = {
  logger: Logger;
  corsOrigins: string[];
  publicUrl: string;
  dashboardDist?: string;
  /** See TRUST_PROXY in config.ts. */
  trustProxy?: boolean | number | string;
  /** Session cookie `Secure` flag: `auto` = when the request came over HTTPS. */
  cookieSecure?: 'auto' | 'true' | 'false';
};

/** CSP for the dashboard page: own scripts plus the hash of each inline script in index.html. */
function dashboardCsp(indexHtml: string) {
  const inline = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => `'sha256-${createHash('sha256').update(m[1] ?? '').digest('base64')}'`,
  );
  return [
    "default-src 'self'",
    `script-src 'self' ${inline.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    // Template previews show customer image URLs; QR codes are data: URLs.
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * Fastify fails closed on a bare hop count (a direct client could forge the hops), so a count is
 * turned into an explicit rule: trust the nearest N peers. Only correct when the API is reachable
 * solely through that proxy (Railway, Render, Fly…); otherwise list the proxy addresses instead.
 */
export function trustRule(value: AppOptions['trustProxy']) {
  if (typeof value !== 'number') return value ?? false;
  const hops = value;
  return (_address: string, hop: number) => hop < hops;
}

export async function buildApp(deps: Deps, options: AppOptions) {
  const app = Fastify({
    loggerInstance: options.logger,
    trustProxy: trustRule(options.trustProxy),
    bodyLimit: 1024 * 1024,
    // Accept a caller's correlation id when it looks like one; otherwise mint our own.
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && REQUEST_ID_RE.test(given) ? given : randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const cookieSecure = options.cookieSecure ?? 'auto';
  const isSecure = (req: FastifyRequest) => (cookieSecure === 'auto' ? req.protocol === 'https' : cookieSecure === 'true');
  app.decorateRequest('secureCookies', {
    getter(this: FastifyRequest) {
      return isSecure(this);
    },
  });

  const dist = options.dashboardDist && resolve(options.dashboardDist);
  const indexHtml = dist && existsSync(resolve(dist, 'index.html')) ? readFileSync(resolve(dist, 'index.html'), 'utf8') : null;
  const csp = indexHtml ? dashboardCsp(indexHtml) : null;

  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/events')) return;
    const timer = setTimeout(() => {
      if (reply.sent || reply.raw.headersSent) return;
      req.log.error({ route: req.routeOptions.url }, 'request timed out');
      void reply
        .code(503)
        .send({ success: false, message: 'The server took too long to respond. Please try again.', code: 'timeout', requestId: req.id } satisfies ApiFailure);
    }, HANDLER_TIMEOUT_MS);
    timer.unref();
    reply.raw.once('close', () => clearTimeout(timer));
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-request-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (req.protocol === 'https') reply.header('strict-transport-security', 'max-age=15552000; includeSubDomains');
    // Chat media sets its own (immutable per message); everything else under /api is never cached.
    if (req.url.startsWith('/api') && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    const type = reply.getHeader('content-type');
    if (csp && typeof type === 'string' && type.startsWith('text/html') && !req.url.startsWith('/docs') && !reply.hasHeader('content-security-policy')) {
      reply.header('content-security-policy', csp);
    }
    return payload;
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: options.corsOrigins,
    allowedHeaders: ['authorization', 'content-type', 'x-session-id', 'idempotency-key', 'x-request-id'],
    exposedHeaders: ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after', 'x-request-id'],
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'WA CodeFiye API',
        version: '2026-09-01',
        description:
          'WhatsApp REST API. Authenticate with `Authorization: Bearer <key>`: a session key (`was_…`) acts on its own ' +
          'session; a workspace access token (`wap_…`) manages sessions and keys, and selects a session with `X-Session-Id`. ' +
          'Errors look like `{ success: false, message, code, errors? }`; every response carries an `X-Request-Id`.',
      },
      servers: [{ url: options.publicUrl }],
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(scalar, { routePrefix: '/docs', configuration: { theme: 'default' } });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const send = (status: number, body: Omit<ApiFailure, 'success'>) =>
      reply.code(status).send({ success: false, ...body, ...(status >= 500 ? { requestId: req.id } : {}) } satisfies ApiFailure);

    if (err instanceof ApiError) {
      if (err.retryAfter !== undefined) reply.header('retry-after', String(err.retryAfter));
      return send(err.statusCode, {
        message: err.message,
        code: err.code,
        ...(err.errors ? { errors: err.errors } : {}),
        ...(err.details ? { details: err.details } : {}),
      });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      const errors: Record<string, string[]> = {};
      for (const issue of err.validation) {
        const field = issue.instancePath.replace(/^\//, '').replaceAll('/', '.') || err.validationContext || 'body';
        (errors[field] ??= []).push(issue.message ?? 'Invalid value');
      }
      return send(422, { message: 'Validation failed', code: 'validation_failed', errors });
    }
    const pg = pgErrorCode(err);
    if (pg === PG_ERRORS.uniqueViolation) return send(409, { message: 'This conflicts with an existing record', code: 'conflict' });
    if (pg === PG_ERRORS.queryCanceled) {
      req.log.warn({ route: req.routeOptions.url }, 'query timed out');
      return send(503, { message: 'The request took too long. Please try again.', code: 'timeout' });
    }
    if (pg === PG_ERRORS.serializationFailure || pg === PG_ERRORS.deadlockDetected) {
      return send(503, { message: 'The server is busy. Please try again.', code: 'busy' });
    }
    if (CONNECTION_ERRORS.has((err as { code?: string }).code ?? '')) {
      req.log.error({ err: { code: (err as { code?: string }).code, message: err.message } }, 'database unavailable');
      return send(503, { message: 'The service is temporarily unavailable. Please try again.', code: 'db_unavailable' });
    }
    if (err.statusCode && err.statusCode < 500) return send(err.statusCode, { message: err.message, code: codeForStatus(err.statusCode) });
    req.log.error({ err, route: req.routeOptions.url }, 'unhandled error');
    return send(500, { message: 'Internal server error', code: 'internal' });
  });

  app.get('/health', { schema: { hide: true } }, async () => ({ ok: true }));

  // Signup/login: no key yet, so outside the authenticated scope. A coarse per-IP limit here; the
  // routes add brute-force limits per account and per phone number that survive restarts.
  await app.register(
    async (open) => {
      await open.register(rateLimit, {
        max: 20,
        timeWindow: '1 minute',
        errorResponseBuilder: (_req, ctx) => tooMany(`Too many attempts. Retry in ${Math.ceil(ctx.ttl / 1000)}s.`, ctx.ttl / 1000),
      });
      await open.register(publicAccountRoutes(deps));
    },
    { prefix: '/api/auth' },
  );

  await app.register(
    async (api) => {
      api.addHook('onRequest', (req) => deps.auth.authenticate(req));
      // README §6: per plan, per session (session keys) or per workspace (workspace tokens) — not per
      // token, or minting more tokens would multiply the limit. The dashboard has its own bucket.
      await api.register(rateLimit, {
        hook: 'preHandler',
        keyGenerator: (req) =>
          req.auth.keySessionId ? `s:${req.auth.keySessionId}` : req.auth.console ? `c:${req.auth.workspaceId}` : `w:${req.auth.workspaceId}`,
        max: (req) => (req.auth.console ? Math.max(getPlan(req.auth.planId).rpm, CONSOLE_RPM) : getPlan(req.auth.planId).rpm),
        timeWindow: '1 minute',
        errorResponseBuilder: (_req, ctx) => tooMany(`Rate limit exceeded. Retry in ${Math.ceil(ctx.ttl / 1000)}s.`, ctx.ttl / 1000),
      });
      await api.register(sessionRoutes(deps));
      await api.register(messageRoutes(deps));
      await api.register(keyRoutes(deps));
      await api.register(templateRoutes(deps));
      await api.register(eventRoutes(deps));
      await api.register(accountRoutes(deps));
      await api.register(adminRoutes(deps), { prefix: '/admin' });
      await api.register(broadcastRoutes(deps), { prefix: '/broadcasts' });
      await api.register(chatRoutes(deps), { prefix: '/chats' });
      api.setNotFoundHandler(() => {
        throw notFound('Route not found', 'route_not_found');
      });
    },
    { prefix: '/api' },
  );

  if (dist && indexHtml) {
    await app.register(fastifyStatic, { root: dist, wildcard: false });
    // SPA fallback: unknown GETs outside /api render the dashboard.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api')) return reply.sendFile('index.html');
      return reply.code(404).send({ success: false, message: 'Not found', code: 'not_found' } satisfies ApiFailure);
    });
  }

  return app;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Whether the session cookie gets the `Secure` flag for this request (COOKIE_SECURE). */
    secureCookies: boolean;
  }
}
