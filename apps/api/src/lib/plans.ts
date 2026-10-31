import { eq, workspaces, type Db } from '@wa/db';
import { TRIAL_DAYS } from '@wa/shared';
import { notFound } from './errors';

export type Tx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export function addMonths(from: Date, n: number) {
  const d = new Date(from);
  d.setMonth(d.getMonth() + n);
  return d;
}

/**
 * Moves a workspace to a plan. Renewing the same plan extends from its current expiry, so paying
 * early never loses days; any other change starts counting today.
 */
export async function applyPlan(db: Tx, workspaceId: string, planId: string, durationMonths: number | null) {
  const [current] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for('update');
  if (!current) throw notFound('Workspace not found');
  const now = new Date();
  const values =
    planId === 'trial'
      ? { planId, trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * 86_400_000), planExpiresAt: null }
      : {
          planId,
          planExpiresAt:
            durationMonths === null
              ? null
              : addMonths(current.planId === planId && current.planExpiresAt && current.planExpiresAt > now ? current.planExpiresAt : now, durationMonths),
        };
  const [updated] = await db.update(workspaces).set(values).where(eq(workspaces.id, workspaceId)).returning();
  return { before: current, after: updated! };
}
