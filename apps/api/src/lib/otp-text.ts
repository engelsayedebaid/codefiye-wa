import type { Sql } from '@wa/db';

/** Per-language overrides for the platform's verification-code message, edited from /admin. */
export type OtpTexts = { ar: string | null; en: string | null };

const EMPTY: OtpTexts = { ar: null, en: null };

export async function getOtpTexts(sql: Sql): Promise<OtpTexts> {
  const [row] = await sql<{ value: Partial<OtpTexts> }[]>`select value from settings where key = 'otp_text'`;
  return { ...EMPTY, ...(row?.value ?? {}) };
}

export async function setOtpTexts(sql: Sql, texts: OtpTexts): Promise<OtpTexts> {
  await sql`
    insert into settings (key, value, updated_at)
    values ('otp_text', ${sql.json(texts)}, now())
    on conflict (key) do update set value = ${sql.json(texts)}, updated_at = now()`;
  return texts;
}
