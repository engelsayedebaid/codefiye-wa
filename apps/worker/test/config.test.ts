import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const base = { DATABASE_URL: 'postgres://x', AUTH_ENCRYPTION_KEY: 'k', WORKER_SECRET: 'x'.repeat(16) };

describe('worker address', () => {
  it('stays on loopback by default', () => {
    const c = loadConfig(base);
    expect(c.WORKER_HOST).toBe('127.0.0.1');
    expect(c.workerUrl).toBe('http://127.0.0.1:4100');
  });

  it('is reachable over the private network on Railway', () => {
    const c = loadConfig({ ...base, RAILWAY_PRIVATE_DOMAIN: 'worker.railway.internal' });
    expect(c.WORKER_HOST).toBe('::');
    expect(c.workerUrl).toBe('http://worker.railway.internal:4100');
  });

  it('lets explicit settings win', () => {
    const c = loadConfig({ ...base, RAILWAY_PRIVATE_DOMAIN: 'w.railway.internal', WORKER_HOST: '0.0.0.0', WORKER_URL: 'http://w:9' });
    expect(c.WORKER_HOST).toBe('0.0.0.0');
    expect(c.workerUrl).toBe('http://w:9');
  });
});
