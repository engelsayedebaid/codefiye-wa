import type { Sql } from '@wa/db';
import { normalizePlanPricing, type PlanPricing } from '@wa/shared/plan-pricing';

/** Operator-edited plan prices, stored in `settings` under `plan_pricing`. */
export async function getPlanPricing(sql: Sql): Promise<PlanPricing> {
  const [row] = await sql<{ value: unknown }[]>`select value from settings where key = 'plan_pricing'`;
  return normalizePlanPricing(row?.value);
}

export async function setPlanPricing(sql: Sql, pricing: PlanPricing): Promise<PlanPricing> {
  const saved = normalizePlanPricing(pricing);
  await sql`
    insert into settings (key, value, updated_at) values ('plan_pricing', ${sql.json(saved)}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
  return saved;
}
