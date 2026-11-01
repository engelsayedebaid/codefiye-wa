/**
 * Plans are priced in USD; the website shows them in the currency the visitor picks, and the customer
 * is charged in EGP (`GET /api/currency-rates`). The EGP rate is the day's market rate, never below the
 * admin's floor (`PaymentSettings.egpPerUsd`); the other currencies are the market rate as published.
 * Zod-free so the dashboard can import it.
 */
export type CurrencyRates = {
  /** Units of each currency (ISO 4217 code) per 1 USD. Always has USD. */
  rates: Record<string, number>;
  /** When the market rates were published (ISO time); null = none loaded yet, only USD and EGP. */
  updatedAt: string | null;
  /** How the EGP rate (what the customer pays) was set. */
  egp: EgpQuote;
};

/** Where the market rates came from. */
export const FX_SOURCES = ['exchangerate-api', 'currency-api'] as const;
export type FxSource = (typeof FX_SOURCES)[number];

/** The EGP-per-USD rate a customer is charged at, and how it was reached. */
export type EgpQuote = {
  /** EGP per 1 USD applied to every price: the live rate, or the floor when it is higher or no rate is loaded. 0 = none. */
  effective: number;
  /** The market rate (null until one has been loaded). */
  live: number | null;
  /** When the market rate was published (ISO time). */
  liveAt: string | null;
  source: FxSource | null;
  /** The admin's floor applied instead of the live rate (live below it, or missing). */
  floored: boolean;
};

export const DEFAULT_EGP_QUOTE: EgpQuote = { effective: 0, live: null, liveAt: null, source: null, floored: false };
export const DEFAULT_CURRENCY_RATES: CurrencyRates = { rates: { USD: 1 }, updatedAt: null, egp: DEFAULT_EGP_QUOTE };

/** The customer's EGP rate: the market rate, never below the admin's floor (and the floor alone when no rate is loaded). */
export function egpQuote(floor: number, live: number | null, liveAt: string | null, source: FxSource | null): EgpQuote {
  const market = live !== null && live > 0 ? live : null;
  const floored = market === null || market < floor;
  return { effective: floored ? Math.max(floor, 0) : market, live: market, liveAt: market === null ? null : liveAt, source: market === null ? null : source, floored };
}

/** Listed first in the currency picker: Egypt, the dollar, the Gulf and nearby, then the big ones. */
export const POPULAR_CURRENCIES = ['EGP', 'USD', 'SAR', 'AED', 'KWD', 'QAR', 'BHD', 'OMR', 'JOD', 'EUR', 'GBP'] as const;

export const CURRENCY_CODE = /^[A-Z]{3}$/;

/** Only well-formed codes with a positive rate; USD is always 1. */
export function cleanRates(raw: unknown): Record<string, number> {
  const rates: Record<string, number> = {};
  if (raw && typeof raw === 'object') {
    for (const [code, rate] of Object.entries(raw)) {
      if (CURRENCY_CODE.test(code) && typeof rate === 'number' && Number.isFinite(rate) && rate > 0) rates[code] = rate;
    }
  }
  rates.USD = 1;
  return rates;
}

/**
 * A USD amount in `code`, or null when there is no rate for it. Amounts of 100 and more are
 * rounded to whole units (as EGP plan prices are), smaller ones to cents.
 */
export function convertUsd(usd: number, code: string, rates: Record<string, number>): number | null {
  const rate = code === 'USD' ? 1 : rates[code];
  if (!rate) return null;
  const amount = usd * rate;
  return Math.abs(amount) >= 100 ? Math.round(amount) : Math.round(amount * 100) / 100;
}
