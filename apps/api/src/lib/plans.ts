import { asc, plans, type Db } from '@wa/db';
import { PLANS } from '@wa/shared';

export type PlanDef = {
  id: string;
  name: string;
  egp: number;
  sessions: number;
  dailyMessages: number | null;
  internal: boolean;
  enabled: boolean;
  sortOrder: number;
};

/** In-memory snapshot of the plans table (static PLANS as boot fallback). Refreshed on start and after admin edits. */
const TRIAL: PlanDef = { ...PLANS.trial, enabled: true, sortOrder: 0 };

let cache: Record<string, PlanDef> = Object.fromEntries(Object.values(PLANS).map((p) => [p.id, { ...p, enabled: true, sortOrder: 0 }]));

export async function refreshPlans(db: Db) {
  const rows = await db.select().from(plans).orderBy(asc(plans.sortOrder), asc(plans.egp));
  if (rows.length)
    cache = Object.fromEntries(
      rows.map((r) => [r.key, { id: r.key, name: r.name, egp: r.egp, sessions: r.sessions, dailyMessages: r.dailyMessages, internal: r.internal, enabled: r.enabled, sortOrder: r.sortOrder }]),
    );
}

export const getPlan = (id: string) => cache[id];
export const allPlans = () => Object.values(cache).sort((a, b) => a.sortOrder - b.sortOrder || a.egp - b.egp);
/** Plans a client can see and purchase. */
export const publicPlans = () => allPlans().filter((p) => !p.internal && p.enabled);

/** Effective plan: paid plans fall back to trial limits once planExpiresAt passes. */
export const effectivePlan = (w: { planId: string; planExpiresAt: Date | null }) => {
  const p = cache[w.planId];
  return p && w.planExpiresAt && w.planExpiresAt.getTime() > Date.now() ? p : (cache.trial ?? TRIAL);
};
