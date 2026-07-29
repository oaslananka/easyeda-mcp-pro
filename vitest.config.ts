import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/**/*.ts', 'scripts/check-complexity-ratchet.mjs'],
      exclude: [
        // The process entrypoint is exercised through CLI/subprocess tests, but V8
        // cannot attribute child-process execution back to this source module.
        'src/index.ts',
        'src/**/*.d.ts',
        // This opt-in integration path requires a real ngspice binary; its pure
        // parser/runner behavior is covered separately by ordinary unit tests.
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
        'src/remote/gateway.ts': {
          lines: 80,
          branches: 70,
        },
        'src/bridge/manager.ts': {
          lines: 79,
          branches: 64,
        },
        'src/bridge/cdp-manager.ts': {
          lines: 70,
          branches: 50,
        },
      },
    },
  },
});
