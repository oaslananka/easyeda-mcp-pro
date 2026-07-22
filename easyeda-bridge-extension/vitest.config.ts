import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      // Keep every executable runtime source in the denominator, including
      // index.ts and dispatcher-entry.ts. Only declaration files are excluded.
      exclude: ['src/**/*.d.ts'],
      thresholds: {
        lines: 52,
        statements: 51,
        functions: 61,
        branches: 46,
      },
    },
  },
});
