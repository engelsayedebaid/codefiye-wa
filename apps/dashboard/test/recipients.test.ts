import { describe, expect, it } from 'vitest';
import { buildAudience, parseManual, rowsToEntries, toE164 } from '../src/app/recipients';
import { parseCsv } from '../src/app/spreadsheet';

describe('toE164', () => {
  it.each([
    ['+20 101 234 5678', '', '+201012345678'],
    ['00966501234567', '', '+966501234567'],
    ['201012345678', '', '+201012345678'],
    ['٠١٠١٢٣٤٥٦٧٨', '20', '+201012345678'],
    ['01012345678', '+20', '+201012345678'],
    ['‎+201012345678‏', '', '+201012345678'],
  ])('%j (country %j) → %s', (raw, cc, expected) => expect(toE164(raw, cc)).toBe(expected));

  it('asks for a country code for local numbers instead of rejecting them', () => {
    expect(toE164('01012345678', '')).toBe('local');
    expect(toE164('abc', '')).toBeNull();
    expect(toE164('+123', '')).toBeNull();
  });
});

describe('parseManual', () => {
  it('reads one number per line with an optional name, or several numbers on a line', () => {
    expect(parseManual('+201012345678, Sara\n\n201011111111;201022222222\nأحمد ، 00966501234567\nnot a number')).toEqual([
      { raw: '+201012345678', variables: { name: 'Sara' } },
      { raw: '201011111111', variables: {} },
      { raw: '201022222222', variables: {} },
      { raw: '00966501234567', variables: { name: 'أحمد' } },
      { raw: 'not a number', variables: {} },
    ]);
  });
});

describe('rowsToEntries', () => {
  it('finds the phone column by header and names the others', () => {
    const result = rowsToEntries([
      ['الاسم', 'Mobile Number', 'City', ''],
      ['Sara', '201012345678', 'Cairo'],
      ['Omar', '201011111111', ''],
    ]);
    expect(result).toEqual({
      columns: ['name', 'city'],
      entries: [
        { raw: '201012345678', variables: { name: 'Sara', city: 'Cairo' } },
        { raw: '201011111111', variables: { name: 'Omar' } },
      ],
    });
  });

  it('works without a header row', () => {
    expect(rowsToEntries([['Sara', '201012345678', 'VIP']])).toEqual({
      columns: ['name', 'col3'],
      entries: [{ raw: '201012345678', variables: { name: 'Sara', col3: 'VIP' } }],
    });
  });

  it('gives up when no column holds numbers', () => expect(rowsToEntries([['a', 'b'], ['c', 'd']])).toBeNull());
});

describe('buildAudience', () => {
  it('dedupes, keeps local numbers apart and reports invalid ones', () => {
    const result = buildAudience(
      [
        { raw: '+201012345678', variables: {} },
        { raw: '201012345678', variables: { name: 'Sara' } },
        { raw: '01011111111', variables: {} },
        { raw: 'nope', variables: {} },
        { raw: '', variables: {} },
      ],
      '',
    );
    expect(result).toEqual({
      recipients: [{ phone: '+201012345678', variables: { name: 'Sara' } }],
      invalid: ['nope'],
      local: ['01011111111'],
      duplicates: 1,
    });
  });
});

describe('parseCsv', () => {
  it('handles quotes, BOM, CRLF and semicolons', () => {
    expect(parseCsv('﻿phone;name\r\n"+201012345678";"Doe; ""Jo"""\r\n201011111111;Omar')).toEqual([
      ['phone', 'name'],
      ['+201012345678', 'Doe; "Jo"'],
      ['201011111111', 'Omar'],
    ]);
  });
});
