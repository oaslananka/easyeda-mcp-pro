import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/**/*.d.ts',
        'src/bridge/*-manager.ts',
        'src/live/*spice-smoke.ts',
        // Scaffolding for a future auto-routing epic issue; not yet wired to any
        // caller, so behavior isn't settled enough to write meaningful tests against.
        'src/router/**',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
