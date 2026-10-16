import { and, apiKeys, arrayContains, type Db, eq, isNull, not, sessions, type Sql, workspaces } from '@wa/db';
import { getPlan } from '@wa/shared';
import type { AuthContext } from './auth';
import { ApiError, conflict, paymentRequired } from './errors';

type DrizzleTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** README §9: an expired trial or plan keeps sessions but stops sending/connecting with 402. */
export function assertActive(auth: AuthContext) {
  if (auth.planId === 'trial' && auth.trialEndsAt && auth.trialEndsAt.getTime() < Date.now()) {
    throw paymentRequired('Your trial has ended. Subscribe to a plan to continue.', 'trial_expired');
  }
  if (auth.planId !== 'trial' && auth.planExpiresAt && auth.planExpiresAt.getTime() < Date.now()) {
    throw paymentRequired('Your plan has expired. Renew it to continue.', 'plan_expired');
  }
}

/**
 * Call inside the transaction that creates the session: the workspace row is locked first, so two
 * concurrent creates can't both see room for one more session.
 */
export async function assertSessionQuota(tx: DrizzleTx, auth: AuthContext) {
  const plan = getPlan(auth.planId);
  await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, auth.workspaceId)).for('update');
  const used = await tx.$count(sessions, eq(sessions.workspaceId, auth.workspaceId));
  if (used >= plan.sessions) {
    throw paymentRequired(`The ${plan.name} plan allows ${plan.sessions} session(s). Upgrade to add more.`, 'session_quota');
  }
}

/** Keys a workspace may create beyond each session's own key (revoked and dashboard login keys don't count). */
export const EXTRA_KEYS_LIMIT = 20;

/**
 * Call inside the transaction that creates the key, like assertSessionQuota: the workspace row is
 * locked first, so concurrent creates can't overshoot. Every session's automatic key fits on top.
 */
export async function assertKeyQuota(tx: DrizzleTx, auth: AuthContext) {
  await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, auth.workspaceId)).for('update');
  const [keys, numbers] = await Promise.all([
    tx.$count(apiKeys, and(eq(apiKeys.workspaceId, auth.workspaceId), isNull(apiKeys.revokedAt), not(arrayContains(apiKeys.scopes, ['console'])))),
    tx.$count(sessions, eq(sessions.workspaceId, auth.workspaceId)),
  ]);
  const limit = EXTRA_KEYS_LIMIT + numbers;
  if (keys >= limit) {
    throw conflict(`This workspace has ${keys} active keys, the most it can have (${EXTRA_KEYS_LIMIT} plus one per number). Revoke one you no longer use first.`, 'key_limit');
  }
}

/** Soft daily cap: concurrent sends can overshoot by a few, never by a meaningful amount. */
export async function assertDailyQuota(sql: Sql, auth: AuthContext) {
  const plan = getPlan(auth.planId);
  if (plan.dailyMessages === null) return;
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from messages
    where workspace_id = ${auth.workspaceId} and direction = 'out' and created_at >= date_trunc('day', now())
      and content->>'sentFrom' is distinct from 'phone' and type <> 'reaction'`;
  if ((row?.n ?? 0) >= plan.dailyMessages) {
    throw new ApiError(429, `Daily limit of ${plan.dailyMessages} messages reached on the ${plan.name} plan`, undefined, { code: 'daily_limit' });
  }
}
