import { describe, expect, it } from 'vitest';
import { TimeoutError, withTimeout } from '../src/timeout';

describe('withTimeout', () => {
  it('passes a result through when it arrives in time', async () => {
    await expect(withTimeout(Promise.resolve(42), 50, 'late')).resolves.toBe(42);
  });

  it('passes errors through unchanged', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 50, 'late')).rejects.toThrow('boom');
  });

  it('rejects with TimeoutError when the operation hangs', async () => {
    const hang = new Promise<never>(() => {});
    const result = withTimeout(hang, 20, 'socket stalled');
    await expect(result).rejects.toBeInstanceOf(TimeoutError);
    await expect(result).rejects.toThrow('socket stalled');
  });
});
