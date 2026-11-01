import { describe, expect, it } from 'vitest';
import { cleanRates, convertUsd, egpQuote } from '../src/currency';

describe('currency rates', () => {
  it('keeps only well-formed codes with a positive rate, and USD is always 1', () => {
    expect(cleanRates({ EGP: 50, eur: 0.9, SAR: -1, AED: 'x', JPY: Number.POSITIVE_INFINITY, USD: 2 })).toEqual({ EGP: 50, USD: 1 });
    expect(cleanRates(null)).toEqual({ USD: 1 });
  });

  it('converts USD prices, whole units from 100 up and cents below', () => {
    const rates = { EGP: 49.5, EUR: 0.917, KWD: 0.3071 };
    expect(convertUsd(15, 'EGP', rates)).toBe(743);
    expect(convertUsd(15, 'EUR', rates)).toBe(13.76);
    expect(convertUsd(15, 'KWD', rates)).toBe(4.61);
    expect(convertUsd(15, 'USD', {})).toBe(15);
    expect(convertUsd(15, 'XYZ', rates)).toBeNull();
  });

  it('charges EGP at the live rate, never below the floor, and at the floor alone without a rate', () => {
    const at = '2026-11-01T00:00:00.000Z';
    expect(egpQuote(48, 50.25, at, 'exchangerate-api')).toEqual({ effective: 50.25, live: 50.25, liveAt: at, source: 'exchangerate-api', floored: false });
    expect(egpQuote(52, 50.25, at, 'currency-api')).toEqual({ effective: 52, live: 50.25, liveAt: at, source: 'currency-api', floored: true });
    expect(egpQuote(50, null, null, null)).toEqual({ effective: 50, live: null, liveAt: null, source: null, floored: true });
    // A broken rate (0 or negative) counts as none; a floor of 0 with no rate means "no EGP price".
    expect(egpQuote(50, 0, at, 'exchangerate-api').effective).toBe(50);
    expect(egpQuote(0, null, null, null)).toMatchObject({ effective: 0, floored: true });
  });
});
