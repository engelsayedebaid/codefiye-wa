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

  it('claims sessions where deployed, not on a dev machine unless asked', () => {
    expect(loadConfig(base).claim).toBe(false);
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).claim).toBe(true);
    expect(loadConfig({ ...base, RAILWAY_ENVIRONMENT: 'production' }).claim).toBe(true);
    expect(loadConfig({ ...base, RAILWAY_PRIVATE_DOMAIN: 'w.railway.internal' }).claim).toBe(true);
    expect(loadConfig({ ...base, WORKER_CLAIM: 'true' }).claim).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: 'production', WORKER_CLAIM: 'false' }).claim).toBe(false);
  });

  it('lets explicit settings win', () => {
    const c = loadConfig({ ...base, RAILWAY_PRIVATE_DOMAIN: 'w.railway.internal', WORKER_HOST: '0.0.0.0', WORKER_URL: 'http://w:9' });
    expect(c.WORKER_HOST).toBe('0.0.0.0');
    expect(c.workerUrl).toBe('http://w:9');
  });
});
