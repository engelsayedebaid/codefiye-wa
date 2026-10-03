import { asciiDigits } from '@wa/shared/phone';

/** One row of the audience as typed or imported: the number as written, and its column values. */
export type Entry = { raw: string; variables: Record<string, string> };
export type Recipient = { phone: string; variables: Record<string, string> };

/** Bidi marks that sneak in when numbers are copied from RTL text. */
const NOISE = /[\s().\-‎‏‪-‮⁦-⁩]/g;

/**
 * Normalises a number to E.164. A local number (single leading 0) needs `countryCode`: without
 * one it comes back as `'local'`, so the page can ask for it instead of calling it invalid.
 */
export function toE164(raw: string, countryCode: string): string | 'local' | null {
  let value = asciiDigits(raw).replace(NOISE, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  else if (!value.startsWith('+')) {
    if (value.startsWith('0')) {
      const cc = asciiDigits(countryCode).replace(/\D/g, '');
      if (!cc) return /^0\d{6,14}$/.test(value) ? 'local' : null;
      value = `+${cc}${value.slice(1)}`;
    } else value = `+${value}`;
  }
  return /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
}

export const looksLikePhone = (value: string) => /^\+?\d{7,16}$/.test(asciiDigits(value).replace(NOISE, ''));

/**
 * Typed or pasted lists: one number per line, optionally followed by a name (`+2010…, Sara`).
 * A line of several numbers separated by commas is read as several recipients.
 */
export function parseManual(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line
      .split(/[,;\t|،]/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) continue;
    if (parts.every(looksLikePhone)) {
      for (const raw of parts) entries.push({ raw, variables: {} });
      continue;
    }
    const at = parts.findIndex(looksLikePhone);
    if (at < 0) {
      entries.push({ raw: line.trim(), variables: {} });
      continue;
    }
    const name = parts.find((p, i) => i !== at && !looksLikePhone(p));
    entries.push({ raw: parts[at]!, variables: name ? { name } : {} });
  }
  return entries;
}

const PHONE_HEADER = /phone|mobile|number|whats|tel|cell|msisdn|رقم|جوال|هاتف|موبايل|واتس|تليفون|تلفون/i;
/** Arabic headers can't be placeholder names; map the usual ones, else fall back to `colN`. */
const ARABIC_HEADERS: [RegExp, string][] = [
  [/^(ال)?اسم/, 'name'],
  [/مدين/, 'city'],
  [/شرك/, 'company'],
  [/منتج/, 'product'],
  [/كود|كوبون/, 'coupon'],
  [/مبلغ|سعر/, 'amount'],
];

function variableName(header: string, column: number): string {
  for (const [re, name] of ARABIC_HEADERS) if (re.test(header.trim())) return name;
  const slug = header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, '_$1');
  return slug || `col${column + 1}`;
}

/**
 * Spreadsheet rows → entries. The first row is a header unless it already holds a number. The phone
 * column is the one whose header says so, else the one with the most number-like values. Other
 * columns become variables named after their header (`name`, `city`…); without a header, the first
 * one is `name` and the rest `col3`, `col4`…
 */
export function rowsToEntries(rows: string[][]): { entries: Entry[]; columns: string[] } | null {
  const first = rows[0] ?? [];
  const hasHeader = !first.some(looksLikePhone);
  const data = hasHeader ? rows.slice(1) : rows;
  const width = Math.max(0, ...rows.map((r) => r.length));

  let phoneColumn = hasHeader ? first.findIndex((h) => PHONE_HEADER.test(h)) : -1;
  if (phoneColumn < 0) {
    let best = 0;
    for (let c = 0; c < width; c++) {
      const score = data.filter((r) => looksLikePhone(r[c] ?? '')).length;
      if (score > best) {
        best = score;
        phoneColumn = c;
      }
    }
  }
  if (phoneColumn < 0) return null;

  const taken = new Set<string>();
  let unnamed = true;
  const names = Array.from({ length: width }, (_, c) => {
    if (c === phoneColumn) return null;
    let name: string;
    if (hasHeader) {
      if (!first[c]) return null;
      name = variableName(first[c], c);
    } else if (unnamed) {
      name = 'name';
      unnamed = false;
    } else name = `col${c + 1}`;
    let unique = name;
    for (let i = 2; taken.has(unique); i++) unique = `${name}_${i}`;
    taken.add(unique);
    return unique;
  });

  const entries = data.map((row) => ({
    raw: row[phoneColumn] ?? '',
    variables: Object.fromEntries(names.flatMap((name, c) => (name && row[c] ? [[name, row[c]!]] : []))),
  }));
  return { entries, columns: names.filter((n): n is string => n !== null) };
}

/** Valid recipients (first occurrence wins; later rows fill its missing values), plus what was left out. */
export function buildAudience(entries: Entry[], countryCode: string) {
  const index = new Map<string, number>();
  const recipients: Recipient[] = [];
  const invalid: string[] = [];
  const local: string[] = [];
  let duplicates = 0;
  for (const entry of entries) {
    if (!entry.raw) continue;
    const phone = toE164(entry.raw, countryCode);
    if (phone === 'local') {
      local.push(entry.raw);
      continue;
    }
    if (!phone) {
      invalid.push(entry.raw);
      continue;
    }
    const at = index.get(phone);
    if (at !== undefined) {
      duplicates++;
      recipients[at]!.variables = { ...entry.variables, ...recipients[at]!.variables };
      continue;
    }
    index.set(phone, recipients.length);
    recipients.push({ phone, variables: { ...entry.variables } });
  }
  return { recipients, invalid, local, duplicates };
}
