import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // All e2e files share one real outlet database (PRD §17); running them
    // sequentially keeps stock/receipt/counter assertions deterministic.
    fileParallelism: false,
  },
});
