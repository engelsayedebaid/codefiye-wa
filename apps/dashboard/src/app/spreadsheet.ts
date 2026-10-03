/**
 * Reads the first sheet of an .xlsx file, or a .csv/.txt file, into rows of trimmed strings — no
 * dependency: an .xlsx is a zip of XML parts, unzipped here with the browser's DecompressionStream
 * and parsed with DOMParser.
 */

export type SheetErrorCode = 'unsupported' | 'corrupt' | 'empty';

export class SheetError extends Error {
  constructor(readonly code: SheetErrorCode) {
    super(code);
    this.name = 'SheetError';
  }
}

export async function readSheet(file: File): Promise<string[][]> {
  const name = file.name.toLowerCase();
  let rows: string[][];
  if (name.endsWith('.xlsx')) rows = await readXlsx(await file.arrayBuffer());
  else if (/\.(csv|tsv|txt)$/.test(name) || file.type.startsWith('text/')) rows = parseCsv(await file.text());
  else throw new SheetError('unsupported');
  rows = rows.filter((row) => row.some((cell) => cell !== ''));
  if (!rows.length) throw new SheetError('empty');
  return rows;
}

// --- CSV -----------------------------------------------------------------------------------------

/** RFC 4180-ish: quoted fields with "" escapes; the delimiter (`,` `;` or tab) is guessed from the first line. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best), ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field.trim());
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field.trim());
    rows.push(row);
  }
  return rows;
}

// --- XLSX ----------------------------------------------------------------------------------------

type ZipEntry = { method: number; size: number; offset: number };

/** File name → entry, from the zip's central directory. */
function zipEntries(buf: ArrayBuffer): Map<string, ZipEntry> {
  const view = new DataView(buf);
  let end = -1;
  // The end-of-central-directory record sits in the last 22 bytes, plus up to 64 KB of comment.
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new SheetError('corrupt');
  const entries = new Map<string, ZipEntry>();
  const decoder = new TextDecoder();
  let p = view.getUint32(end + 16, true);
  for (let n = view.getUint16(end + 10, true); n > 0; n--) {
    if (p + 46 > buf.byteLength || view.getUint32(p, true) !== 0x02014b50) throw new SheetError('corrupt');
    const nameLength = view.getUint16(p + 28, true);
    const name = decoder.decode(new Uint8Array(buf, p + 46, nameLength));
    entries.set(name, { method: view.getUint16(p + 10, true), size: view.getUint32(p + 20, true), offset: view.getUint32(p + 42, true) });
    p += 46 + nameLength + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return entries;
}

async function inflate(buf: ArrayBuffer, entry: ZipEntry): Promise<string> {
  const view = new DataView(buf);
  if (view.getUint32(entry.offset, true) !== 0x04034b50) throw new SheetError('corrupt');
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const data = new Uint8Array(buf, start, entry.size);
  if (entry.method === 0) return new TextDecoder().decode(data);
  if (entry.method !== 8) throw new SheetError('corrupt');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

const parseXml = (text: string) => new DOMParser().parseFromString(text, 'application/xml');
/** Descendants by local name, whatever namespace prefix the writer used. */
const byTag = (node: Document | Element, tag: string) => Array.from(node.getElementsByTagNameNS('*', tag));
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** `C12` → 2 (zero-based column). */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.toUpperCase()) {
    if (ch < 'A' || ch > 'Z') break;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

/** Numbers can come back as `2.01012345678E+11`; phone numbers must stay whole digits. */
const numberText = (v: string) => (/e/i.test(v) && Number.isFinite(Number(v)) ? String(Number(v)) : v);

async function readXlsx(buf: ArrayBuffer): Promise<string[][]> {
  const entries = zipEntries(buf);
  const read = (path: string) => {
    const entry = entries.get(path);
    return entry ? inflate(buf, entry) : Promise.resolve(null);
  };

  // The first sheet in workbook order, resolved through its relationship; else the lowest-numbered sheet file.
  let sheetPath: string | null = null;
  const [workbook, rels] = await Promise.all([read('xl/workbook.xml'), read('xl/_rels/workbook.xml.rels')]);
  if (workbook && rels) {
    const sheet = byTag(parseXml(workbook), 'sheet')[0];
    const id = sheet?.getAttributeNS(REL_NS, 'id') ?? sheet?.getAttribute('r:id');
    const target = byTag(parseXml(rels), 'Relationship')
      .find((r) => r.getAttribute('Id') === id)
      ?.getAttribute('Target');
    if (target) {
      const path = (target.startsWith('/') ? target.slice(1) : `xl/${target}`).replace(/\/\.\//g, '/');
      if (entries.has(path)) sheetPath = path;
    }
  }
  sheetPath ??=
    [...entries.keys()]
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
      .sort((a, b) => Number(/\d+/.exec(a.slice(14))?.[0]) - Number(/\d+/.exec(b.slice(14))?.[0]))[0] ?? null;
  if (!sheetPath) throw new SheetError('corrupt');

  const [sheetXml, sharedXml] = await Promise.all([read(sheetPath), read('xl/sharedStrings.xml')]);
  if (!sheetXml) throw new SheetError('corrupt');
  // Rich text is split into runs; phonetic guides (<rPh>) aren't part of the value.
  const shared = sharedXml
    ? byTag(parseXml(sharedXml), 'si').map((si) =>
        byTag(si, 't')
          .filter((t) => t.parentElement?.localName !== 'rPh')
          .map((t) => t.textContent ?? '')
          .join(''),
      )
    : [];

  const sheet = parseXml(sheetXml);
  if (sheet.getElementsByTagName('parsererror').length) throw new SheetError('corrupt');
  return byTag(sheet, 'row').map((row) => {
    const cells: string[] = [];
    let col = 0;
    for (const c of byTag(row, 'c')) {
      const ref = c.getAttribute('r');
      if (ref) col = columnIndex(ref);
      const type = c.getAttribute('t');
      const v = byTag(c, 'v')[0]?.textContent ?? '';
      let value: string;
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = byTag(c, 't').map((t) => t.textContent ?? '').join('');
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'str' || type === 'e') value = v;
      else value = numberText(v);
      cells[col] = value.trim();
      col++;
    }
    return Array.from(cells, (cell) => cell ?? '');
  });
}
