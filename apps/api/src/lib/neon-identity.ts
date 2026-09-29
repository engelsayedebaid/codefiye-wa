import { createRemoteJWKSet, jwtVerify } from 'jose';
import { asc, eq, sql, users, workspaces, type Db } from '@wa/db';
import { unauthorized } from './errors';
import { config } from '../config';

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
export async function neonIdentity(db: Db, token: string) {
  const base = process.env.NEON_AUTH_BASE_URL;
  if (!base) throw unauthorized();
  const origin = new URL(base).origin;
  jwks ??= createRemoteJWKSet(new URL(process.env.NEON_AUTH_JWKS_URL ?? `${base.replace(/\/$/, '')}/.well-known/jwks.json`));
  let subject: string;
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: origin, audience: origin, algorithms: ['EdDSA'], requiredClaims: ['sub', 'exp', 'iat'], maxTokenAge: '15m' });
    if (!payload.sub) throw unauthorized();
    subject = payload.sub;
  } catch {
    throw unauthorized('Your session has expired. Please sign in again.');
  }
  const [identity] = await db.execute<{ id: string; email: string; emailVerified: boolean; name: string; role: string | null; banned: boolean | null }>(sql`select id, email, "emailVerified", name, role, banned from neon_auth."user" where id = ${subject} limit 1`);
  if (!identity || identity.banned) throw unauthorized();
  const email = identity.email.toLowerCase();
  const workspace = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${email}, 0))`);
    let user = await tx.query.users.findFirst({ where: eq(users.email, email) });
    if (!user) [user] = await tx.insert(users).values({ email }).returning();
    let ws = await tx.query.workspaces.findFirst({ where: eq(workspaces.ownerId, user!.id), orderBy: asc(workspaces.createdAt) });
    if (!ws) [ws] = await tx.insert(workspaces).values({ ownerId: user!.id, name: identity.name || email.split('@')[0]!, trialEndsAt: new Date(Date.now() + 3 * 86400000) }).returning();
    return ws!;
  });
  const roles = identity.role?.split(',').map((role) => role.trim()) ?? [];
  return {
    keyId: `neon:${subject}`,
    workspaceId: workspace.id,
    sessionId: null,
    scopes: ['*'],
    authType: 'neon' as const,
    isAdmin: roles.includes('admin') || config.adminEmails.has(email),
    email,
    suspended: !!workspace.suspendedAt,
  };
}
