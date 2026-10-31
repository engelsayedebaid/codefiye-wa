/**
 * Plans are priced in USD; the website shows them in the currency the visitor picks.
 * EGP uses the admin's rate (`PaymentSettings.egpPerUsd`, what Paymob charges), every other
 * currency a daily market rate (`GET /api/currency-rates`). Zod-free so the dashboard can import it.
 */
export type CurrencyRates = {
  /** Units of each currency (ISO 4217 code) per 1 USD. Always has USD. */
  rates: Record<string, number>;
  /** When the market rates were published (ISO time); null = none loaded yet, only USD and EGP. */
  updatedAt: string | null;
};

export const DEFAULT_CURRENCY_RATES: CurrencyRates = { rates: { USD: 1 }, updatedAt: null };

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
