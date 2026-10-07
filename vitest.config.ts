import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'apps/*/test/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      'tests/engine/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 20_000,
    pool: 'forks',
  },
});
