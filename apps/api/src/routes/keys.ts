import { and, apiKeys, arrayContains, desc, eq, isNull, not, sessions } from '@wa/db';
import { ok, successSchema } from '@wa/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps';
import { requirePat } from '../lib/auth';
import { apiKeyDto, toApiKeyDto } from '../lib/dto';
import { notFound } from '../lib/errors';
import { generateKey } from '../lib/keys';

const tags = ['API keys'];

/** Workspace access tokens and extra session keys (README §8: create, name, show once, revoke). */
export function keyRoutes({ db, auth }: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/api-keys',
      { schema: { tags, summary: 'List active keys', response: { 200: successSchema(z.array(apiKeyDto)) } } },
      async (req) => {
        requirePat(req);
        const rows = await db
          .select()
          .from(apiKeys)
          // Dashboard login tokens are an implementation detail of the console; don't list them.
          .where(and(eq(apiKeys.workspaceId, req.auth.workspaceId), isNull(apiKeys.revokedAt), not(arrayContains(apiKeys.scopes, ['console']))))
          .orderBy(desc(apiKeys.createdAt));
        return ok(rows.map(toApiKeyDto));
      },
    );

    app.post(
      '/api-keys',
      {
        schema: {
          tags,
          summary: 'Create a key',
          description: 'Without `sessionId` creates a workspace access token (`wap_…`); with it, a key bound to that session (`was_…`). The key is shown once.',
          body: z.object({ name: z.string().trim().min(1).max(100), sessionId: z.uuid().optional() }),
          response: { 201: successSchema(apiKeyDto.extend({ key: z.string() })) },
        },
      },
      async (req, reply) => {
        requirePat(req);
        const { name, sessionId } = req.body;
        if (sessionId) {
          const [owned] = await db
            .select({ id: sessions.id })
            .from(sessions)
            .where(and(eq(sessions.id, sessionId), eq(sessions.workspaceId, req.auth.workspaceId)));
          if (!owned) throw notFound('Session not found');
        }
        const key = generateKey(sessionId ? 'session' : 'pat');
        const [row] = await db
          .insert(apiKeys)
          .values({ workspaceId: req.auth.workspaceId, sessionId: sessionId ?? null, name, keyHash: key.hash, prefix: key.prefix })
          .returning();
        reply.code(201);
        return ok({ ...toApiKeyDto(row!), key: key.key });
      },
    );

    app.delete(
      '/api-keys/:id',
      {
        schema: {
          tags,
          summary: 'Revoke a key',
          params: z.object({ id: z.uuid() }),
          response: { 200: successSchema(z.object({ revoked: z.literal(true) })) },
        },
      },
      async (req) => {
        requirePat(req);
        const [row] = await db
          .update(apiKeys)
          .set({ revokedAt: new Date() })
          .where(and(eq(apiKeys.id, req.params.id), eq(apiKeys.workspaceId, req.auth.workspaceId), isNull(apiKeys.revokedAt)))
          .returning({ id: apiKeys.id });
        if (!row) throw notFound('Key not found');
        auth.invalidate((ctx) => ctx.keyId === row.id);
        return ok({ revoked: true as const });
      },
    );
  };
}
