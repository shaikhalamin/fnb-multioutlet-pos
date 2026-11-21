import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // Every spec asserts exact state against one shared PostgreSQL database
    // (revision counters, watermarks); parallel files race each other's
    // fixtures — same reasoning as the outlet-backend e2e config.
    fileParallelism: false,
  },
});
