import { defineConfig } from 'vitest/config';

// Integration tests read TEST_DATABASE_URL from .env / .env.local; they're skipped when it's unset.
for (const file of ['.env', '.env.local']) {
  try {
    process.loadEnvFile(file);
  } catch {
    // file is optional
  }
}

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration suites share one test database.
    fileParallelism: false,
  },
});
