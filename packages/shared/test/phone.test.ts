import { describe, expect, it } from 'vitest';
import { asciiDigits, maskPhoneNumber, normalizePhone } from '../src';

describe('normalizePhone', () => {
  it.each([
    ['+201012345678', '+201012345678'],
    ['00201012345678', '+201012345678'],
    ['201012345678', '+201012345678'],
    ['+20 (101) 234-5678', '+201012345678'],
    ['+20.101.234.5678', '+201012345678'],
    ['+٢٠١٠١٢٣٤٥٦٧٨', '+201012345678'],
    ['۰۰۲۰۱۰۱۲۳۴۵۶۷۸', '+201012345678'],
    ['+14155550123', '+14155550123'],
  ])('%s → %s', (input, phone) => expect(normalizePhone(input)).toBe(phone));

  it.each(['', '01012345678', '+0123456789', '12345', '+1234567890123456', 'phone', '+20 10 abc 5678'])('rejects %j', (input) =>
    expect(normalizePhone(input)).toBeNull(),
  );
});

describe('maskPhoneNumber', () => {
  it('keeps the country code and the last three digits', () => expect(maskPhoneNumber('+201012345678')).toBe('+20•••••••678'));
  it('works for one-digit country codes', () => expect(maskPhoneNumber('+14155550123')).toBe('+1•••••••123'));
});

describe('asciiDigits', () => {
  it('converts Arabic-Indic and Persian digits', () => expect(asciiDigits('٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789 0123456789'));
  it('leaves other text alone', () => expect(asciiDigits('abc 123')).toBe('abc 123'));
});
