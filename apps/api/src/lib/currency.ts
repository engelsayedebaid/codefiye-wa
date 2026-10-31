import type { Sql } from '@wa/db';
import { cleanRates, type CurrencyRates } from '@wa/shared';
import { getPaymentSettings } from './payments';

/** ExchangeRate-API's open endpoint: no key, ~160 currencies, refreshed once a day (attribution required). */
const SOURCE_URL = 'https://open.er-api.com/v6/latest/USD';
/** The source changes once a day; a few refreshes a day are plenty. */
const FRESH_MS = 6 * 60 * 60_000;
/** After a failed refresh, keep serving what we have and try again this much later. */
const RETRY_MS = 10 * 60_000;

type Market = { rates: Record<string, number>; updatedAt: string | null; fetchedAt: number };

let market: Market | null = null;
let nextAttempt = 0;
let refreshing: Promise<void> | null = null;

/** The last good rates, kept in `settings` under `fx_rates` so a restart (or an outage at the source) still has them. */
async function loadStored(sql: Sql): Promise<Market | null> {
  const [row] = await sql<{ value: { rates?: unknown; updatedAt?: unknown; fetchedAt?: unknown } }[]>`select value from settings where key = 'fx_rates'`;
  if (!row) return null;
  const { rates, updatedAt, fetchedAt } = row.value;
  return { rates: cleanRates(rates), updatedAt: typeof updatedAt === 'string' ? updatedAt : null, fetchedAt: typeof fetchedAt === 'number' ? fetchedAt : 0 };
}

async function fetchMarket(sql: Sql): Promise<void> {
  const res = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`exchange rates: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: string; rates?: unknown; time_last_update_unix?: number };
  const rates = cleanRates(body.rates);
  if (body.result !== 'success' || Object.keys(rates).length < 20) throw new Error('exchange rates: unexpected answer');
  const updatedAt = typeof body.time_last_update_unix === 'number' ? new Date(body.time_last_update_unix * 1000).toISOString() : new Date().toISOString();
  market = { rates, updatedAt, fetchedAt: Date.now() };
  await sql`
    insert into settings (key, value, updated_at) values ('fx_rates', ${sql.json(market)}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

/** Market rates, refreshed in the background when stale; never waits on the source except on the very first call. */
async function marketRates(sql: Sql, log?: (err: unknown) => void): Promise<Market | null> {
  if (!market) market = await loadStored(sql);
  const stale = !market || Date.now() - market.fetchedAt > FRESH_MS;
  if (stale && !refreshing && Date.now() >= nextAttempt) {
    refreshing = fetchMarket(sql)
      .catch((err) => {
        nextAttempt = Date.now() + RETRY_MS;
        log?.(err);
      })
      .finally(() => {
        refreshing = null;
      });
  }
  if (!market && refreshing) await refreshing;
  return market;
}

/** Every currency the website can show prices in. EGP is the admin's rate, so the price shown is the price charged. */
export async function getCurrencyRates(sql: Sql, log?: (err: unknown) => void): Promise<CurrencyRates> {
  const [m, payments] = await Promise.all([marketRates(sql, log), getPaymentSettings(sql)]);
  const rates: Record<string, number> = { ...m?.rates, USD: 1 };
  if (payments.egpPerUsd > 0) rates.EGP = payments.egpPerUsd;
  return { rates, updatedAt: m?.updatedAt ?? null };
}
