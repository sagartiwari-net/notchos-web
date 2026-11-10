import { defineConfig } from 'vitest/config';

// The tests need the private MariaDB (scripts/dev-db.sh start). Every test file works in
// its own throwaway database named notchos_test_<time>_<random>, created and dropped by
// test/helpers/harness.ts, so files can run in parallel.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
