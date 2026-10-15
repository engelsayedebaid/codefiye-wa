import type { Sql } from '@wa/db';
import { DEFAULT_PAYMENT_SETTINGS, type PaymentSettings } from '@wa/shared';

/** The admin's receiving accounts and the USD→EGP rate, stored in `settings` under `payment_methods`. */
export async function getPaymentSettings(sql: Sql): Promise<PaymentSettings> {
  const [row] = await sql<{ value: Partial<PaymentSettings> }[]>`select value from settings where key = 'payment_methods'`;
  const v = row?.value ?? {};
  return {
    ...DEFAULT_PAYMENT_SETTINGS,
    ...v,
    vodafone_cash: { ...DEFAULT_PAYMENT_SETTINGS.vodafone_cash, ...v.vodafone_cash },
    instapay: { ...DEFAULT_PAYMENT_SETTINGS.instapay, ...v.instapay },
    bank_transfer: { ...DEFAULT_PAYMENT_SETTINGS.bank_transfer, ...v.bank_transfer },
  };
}

export async function setPaymentSettings(sql: Sql, settings: PaymentSettings): Promise<PaymentSettings> {
  await sql`
    insert into settings (key, value, updated_at) values ('payment_methods', ${sql.json(settings)}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
  return settings;
}
