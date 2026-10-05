import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    globalSetup: ['./vitest.global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // many tests spawn real git processes; keep parallelism modest
    pool: 'forks',
    maxWorkers: 4,
  },
});
