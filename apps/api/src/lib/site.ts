import type { Sql } from '@wa/db';
import { normalizeSiteSettings, type SiteSettings } from '@wa/shared';

/** The landing page's video and YouTube links, stored in `settings` under `site`. */
export async function getSiteSettings(sql: Sql): Promise<SiteSettings> {
  const [row] = await sql<{ value: unknown }[]>`select value from settings where key = 'site'`;
  return normalizeSiteSettings(row?.value);
}

export async function setSiteSettings(sql: Sql, site: SiteSettings): Promise<SiteSettings> {
  const saved = normalizeSiteSettings(site);
  await sql`
    insert into settings (key, value, updated_at) values ('site', ${sql.json(saved)}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
  return saved;
}
