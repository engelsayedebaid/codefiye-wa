/** Arabic-Indic (٠-٩) and Extended/Persian (۰-۹) digits → ASCII, so numbers typed on Arabic keyboards work. */
export function asciiDigits(value: string) {
  return value.replace(/[٠-٩۰-۹]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10));
}

/**
 * Normalises a phone number for accounts to E.164 (`+201012345678`). Accepts `+` or `00`
 * international prefixes and bare international digits; spaces, dashes, dots and brackets are
 * ignored. Local formats (a leading `0`) are rejected — the country code can't be guessed.
 */
export function normalizePhone(input: string): string | null {
  let value = asciiDigits(input.trim()).replace(/[\s().-]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  if (!value.startsWith('+')) {
    if (value.startsWith('0')) return null;
    value = `+${value}`;
  }
  return /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
}

/**
 * A national number plus the calling code the person picked (`+20`). A value that already starts
 * with `+` or `00` is an international number and the picked code is ignored. One leading `0` is
 * the trunk prefix and is dropped. Digits that already begin with that calling code are kept.
 */
export function phoneWithCountry(input: string, dial: string): string | null {
  const compact = asciiDigits(input.trim()).replace(/[\s().-]/g, '');
  if (!compact) return null;
  if (compact.startsWith('+') || compact.startsWith('00')) return normalizePhone(compact);
  const code = dial.replace(/^\+/, '');
  if (!/^[1-9]\d{0,3}$/.test(code)) return null;
  if (compact.startsWith('0')) return normalizePhone(`+${code}${compact.slice(1)}`);
  if (compact.startsWith(code) && compact.length - code.length >= 6) return normalizePhone(`+${compact}`);
  return normalizePhone(`+${code}${compact}`);
}

/** For showing which number a code went to: `+20•••••••678`. */
export function maskPhoneNumber(phone: string): string {
  const digits = phone.replace(/^\+/, '');
  const country = digits.length > 10 ? digits.slice(0, digits.length - 10) : digits.slice(0, 1);
  return `+${country}${'•'.repeat(Math.max(0, digits.length - country.length - 3))}${digits.slice(-3)}`;
}
