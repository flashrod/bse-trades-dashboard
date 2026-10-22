import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://bse:bse@localhost:5433/bse_test',
      PULL_MAX_ATTEMPTS: '3',
      PULL_REQUEST_TIMEOUT_MS: '5000'
    }
  }
});
