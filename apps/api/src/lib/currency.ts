import type { Sql } from '@wa/db';
import { cleanRates, type CurrencyRates, type EgpQuote, egpQuote, type FxSource } from '@wa/shared';
import { getPaymentSettings } from './payments';

/**
 * Market rates, USD base, from two independent keyless sources (each refreshed daily):
 * ExchangeRate-API's open endpoint (attribution required) first, and the currency-api dataset
 * (fawazahmed0, served by jsDelivr) when it is down. Both track the interbank rates the Central Bank publishes.
 */
const SOURCES: { name: FxSource; url: string; parse: (body: unknown) => { rates: Record<string, number>; updatedAt: string } | null }[] = [
  {
    name: 'exchangerate-api',
    url: 'https://open.er-api.com/v6/latest/USD',
    parse: (body) => {
      const b = body as { result?: string; rates?: unknown; time_last_update_unix?: number };
      if (b.result !== 'success') return null;
      const updatedAt = typeof b.time_last_update_unix === 'number' ? new Date(b.time_last_update_unix * 1000).toISOString() : new Date().toISOString();
      return { rates: cleanRates(b.rates), updatedAt };
    },
  },
  {
    name: 'currency-api',
    url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json',
    parse: (body) => {
      const b = body as { date?: string; usd?: Record<string, unknown> };
      if (!b.usd || typeof b.usd !== 'object') return null;
      // Lower-case codes, and a few non-ISO entries (crypto, metals) that cleanRates drops.
      const upper = Object.fromEntries(Object.entries(b.usd).map(([code, rate]) => [code.toUpperCase(), rate]));
      const updatedAt = typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? new Date(`${b.date}T00:00:00Z`).toISOString() : new Date().toISOString();
      return { rates: cleanRates(upper), updatedAt };
    },
  },
];
/** The sources change once a day; a few refreshes a day are plenty. */
const FRESH_MS = 6 * 60 * 60_000;
/** After a failed refresh, keep serving what we have and try again this much later. */
const RETRY_MS = 10 * 60_000;

type Market = { rates: Record<string, number>; updatedAt: string | null; fetchedAt: number; source: FxSource | null };

let market: Market | null = null;
let nextAttempt = 0;
let refreshing: Promise<void> | null = null;

const isSource = (v: unknown): v is FxSource => SOURCES.some((s) => s.name === v);

/** The last good rates, kept in `settings` under `fx_rates` so a restart (or an outage at the sources) still has them. */
async function loadStored(sql: Sql): Promise<Market | null> {
  const [row] = await sql<{ value: { rates?: unknown; updatedAt?: unknown; fetchedAt?: unknown; source?: unknown } }[]>`select value from settings where key = 'fx_rates'`;
  if (!row) return null;
  const { rates, updatedAt, fetchedAt, source } = row.value;
  return {
    rates: cleanRates(rates),
    updatedAt: typeof updatedAt === 'string' ? updatedAt : null,
    fetchedAt: typeof fetchedAt === 'number' ? fetchedAt : 0,
    // Rates stored before the source was recorded came from ExchangeRate-API.
    source: isSource(source) ? source : 'exchangerate-api',
  };
}

async function fetchSource(s: (typeof SOURCES)[number]): Promise<Market> {
  const res = await fetch(s.url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${s.name}: HTTP ${res.status}`);
  const parsed = s.parse(await res.json());
  // A rate sheet without the pound is useless here, whatever else it has.
  if (!parsed || Object.keys(parsed.rates).length < 20 || !parsed.rates.EGP) throw new Error(`${s.name}: unexpected answer`);
  return { ...parsed, fetchedAt: Date.now(), source: s.name };
}

async function fetchMarket(sql: Sql, log?: (err: unknown) => void): Promise<void> {
  let fresh: Market | null = null;
  for (const s of SOURCES) {
    try {
      fresh = await fetchSource(s);
      break;
    } catch (err) {
      log?.(err);
    }
  }
  if (!fresh) throw new Error('exchange rates: every source failed');
  market = fresh;
  await sql`
    insert into settings (key, value, updated_at) values ('fx_rates', ${sql.json(market)}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

/** Market rates, refreshed in the background when stale; never waits on the sources except on the very first call. */
async function marketRates(sql: Sql, log?: (err: unknown) => void): Promise<Market | null> {
  if (!market) market = await loadStored(sql);
  const stale = !market || Date.now() - market.fetchedAt > FRESH_MS;
  if (stale && !refreshing && Date.now() >= nextAttempt) {
    refreshing = fetchMarket(sql, log)
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

/**
 * The EGP rate customers are charged at right now: the live market rate, never below the admin's floor
 * (`egpPerUsd`), and the floor alone while no market rate is loaded. Every EGP price (checkout, expected
 * transfer, the website) comes from this one place, so what is shown is what is charged.
 */
export async function getEgpQuote(sql: Sql, log?: (err: unknown) => void): Promise<EgpQuote> {
  const [m, payments] = await Promise.all([marketRates(sql, log), getPaymentSettings(sql)]);
  return egpQuote(payments.egpPerUsd, m?.rates.EGP ?? null, m?.updatedAt ?? null, m?.source ?? null);
}

/** Every currency the website can show prices in; EGP at the rate charged, so the price shown is the price paid. */
export async function getCurrencyRates(sql: Sql, log?: (err: unknown) => void): Promise<CurrencyRates> {
  const [m, egp] = await Promise.all([marketRates(sql, log), getEgpQuote(sql, log)]);
  const rates: Record<string, number> = { ...m?.rates, USD: 1 };
  if (egp.effective > 0) rates.EGP = egp.effective;
  else delete rates.EGP;
  return { rates, updatedAt: m?.updatedAt ?? null, egp };
}
