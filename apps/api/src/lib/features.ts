import type { Sql } from '@wa/db';
import type { PlanFeature } from '@wa/shared';

/** Runtime feature flags, stored in `settings` under the `features` key and toggled from /admin. */
export type Features = Record<PlanFeature, boolean>;

const DEFAULTS: Features = { ads: false };

export async function getFeatures(sql: Sql): Promise<Features> {
  const [row] = await sql<{ value: Partial<Features> }[]>`select value from settings where key = 'features'`;
  return { ...DEFAULTS, ...(row?.value ?? {}) };
}

export async function setFeature(sql: Sql, feature: PlanFeature, enabled: boolean): Promise<Features> {
  const [row] = await sql<{ value: Partial<Features> }[]>`
    insert into settings (key, value, updated_at)
    values ('features', ${sql.json({ [feature]: enabled })}, now())
    on conflict (key) do update
      set value = settings.value || ${sql.json({ [feature]: enabled })}, updated_at = now()
    returning value`;
  return { ...DEFAULTS, ...(row?.value ?? {}) };
}
