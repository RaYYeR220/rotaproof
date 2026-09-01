import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/web/test/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@rotaproof/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      '@rotaproof/registry': new URL('./packages/registry/src/index.ts', import.meta.url).pathname,
    },
  },
});
