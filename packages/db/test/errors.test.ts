import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { isTransientDbError } from '../src/client';

const pgError = (code: string) => Object.assign(Object.create(postgres.PostgresError.prototype) as Error, { code });

describe('isTransientDbError', () => {
  it('retries outages, timeouts and lock conflicts', () => {
    for (const code of ['CONNECTION_CLOSED', 'CONNECT_TIMEOUT', 'ECONNREFUSED', 'ECONNRESET']) {
      expect(isTransientDbError(Object.assign(new Error('down'), { code }))).toBe(true);
    }
    for (const code of ['57014', '40001', '40P01']) expect(isTransientDbError(pgError(code))).toBe(true);
  });

  it('does not retry errors a retry cannot fix', () => {
    expect(isTransientDbError(pgError('23505'))).toBe(false); // unique violation
    expect(isTransientDbError(pgError('42P01'))).toBe(false); // missing table
    expect(isTransientDbError(new Error('bug'))).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
  });
});
