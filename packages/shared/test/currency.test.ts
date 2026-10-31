import { describe, expect, it } from 'vitest';
import { cleanRates, convertUsd } from '../src/currency';

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
});
