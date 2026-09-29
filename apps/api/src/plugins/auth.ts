import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, apiKeys, eq, isNull, sessions, users, workspaces, type Db } from '@wa/db';
import { hashKey } from '../lib/keys';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors';
import { neonIdentity } from '../lib/neon-identity';
import { config } from '../config';

export type AuthContext = { keyId: string; workspaceId: string; sessionId: string | null; scopes: string[]; authType?: 'key' | 'neon'; isAdmin?: boolean; email?: string | null; suspended?: boolean };

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
  interface FastifyInstance {
    db: Db;
  }
}

export function registerAuth(app: FastifyInstance) {
  app.decorateRequest('auth', null as unknown as AuthContext);

  app.addHook('onRequest', async (req) => {
    if (req.method === 'OPTIONS' || !req.url.startsWith('/api/')) return;
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!token) throw unauthorized();
    if (!token.startsWith('wa_')) {
      req.auth = await neonIdentity(app.db, token);
      return;
    }

    const key = await app.db.query.apiKeys.findFirst({
      where: and(eq(apiKeys.keyHash, hashKey(token)), isNull(apiKeys.revokedAt)),
    });
    if (!key) throw unauthorized();

    const ws = await app.db.query.workspaces.findFirst({
      where: eq(workspaces.id, key.workspaceId),
      columns: { planId: true, planExpiresAt: true, suspendedAt: true },
      with: {},
    });
    if (!ws) throw unauthorized();
    const owner = await app.db.query.workspaces
      .findFirst({ where: eq(workspaces.id, key.workspaceId), columns: { ownerId: true } })
      .then((w) => (w?.ownerId ? app.db.query.users.findFirst({ where: eq(users.id, w.ownerId), columns: { email: true } }) : undefined));
    const email = owner?.email?.toLowerCase() ?? null;
    req.auth = {
      keyId: key.id,
      workspaceId: key.workspaceId,
      sessionId: key.sessionId,
      scopes: key.scopes,
      authType: 'key',
      isAdmin: !!email && config.adminEmails.has(email),
      email,
      suspended: !!ws.suspendedAt,
    };
    void app.db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id)).catch(() => {});
  });
}

/**
 * Resolves the session a request acts on: implicit for session keys,
 * `X-Session-Id` (or route param) for workspace PATs. Always scoped to the caller's workspace.
 */
export async function resolveSession(app: FastifyInstance, req: FastifyRequest, explicitId?: string) {
  const id = explicitId ?? req.auth.sessionId ?? (req.headers['x-session-id'] as string | undefined);
  if (!id) throw badRequest('X-Session-Id header is required when using a workspace token');
  if (req.auth.sessionId && req.auth.sessionId !== id) throw notFound('Session not found');
  const session = await app.db.query.sessions.findFirst({
    where: and(eq(sessions.id, id), eq(sessions.workspaceId, req.auth.workspaceId)),
  });
  if (!session) throw notFound('Session not found');
  return session;
}

export function requirePat(req: FastifyRequest) {
  if (req.auth.sessionId) throw unauthorized('This endpoint requires a workspace token (PAT), not a session key');
}

/** Platform admin: owner email in PLATFORM_ADMIN_EMAILS, or Neon Auth role=admin. Server-enforced, never client-side. */
export function requireAdmin(req: FastifyRequest) {
  if (!req.auth.isAdmin) throw forbidden('Platform administrator access required');
}

/** Rejects operations that consume the subscription while the workspace is suspended. */
export function requireActive(req: FastifyRequest) {
  if (req.auth.suspended) throw forbidden('Workspace suspended. Contact support.');
}
