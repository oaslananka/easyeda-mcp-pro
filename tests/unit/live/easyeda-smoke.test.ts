import { describe, expect, it, vi } from 'vitest';
import {
  buildLiveSmokeChecks,
  parseBooleanEnv,
  parseLiveSmokeConfig,
  runLiveSmokeChecks,
  validateLiveSmokeConfig,
  type LiveSmokeConfig,
} from '../../../src/live/easyeda-smoke.js';

function baseConfig(overrides: Partial<LiveSmokeConfig> = {}): LiveSmokeConfig {
  return {
    enabled: true,
    projectId: 'demo-project',
    writeEnabled: false,
    outputPath: '.easyeda-mcp-pro/live-smoke-report.json',
    timeoutMs: 30_000,
    ...overrides,
  };
}

describe('easyeda live smoke plan', () => {
  it('should parse boolean environment values', () => {
    expect(parseBooleanEnv('true')).toBe(true);
    expect(parseBooleanEnv('1')).toBe(true);
    expect(parseBooleanEnv('yes')).toBe(true);
    expect(parseBooleanEnv('on')).toBe(true);
    expect(parseBooleanEnv('false')).toBe(false);
    expect(parseBooleanEnv(undefined)).toBe(false);
  });

  it('should default to an opt-in disabled configuration', () => {
    const config = parseLiveSmokeConfig({});

    expect(config.enabled).toBe(false);
    expect(config.writeEnabled).toBe(false);
    expect(config.projectId).toBe('');
    expect(config.outputPath).toBe('.easyeda-mcp-pro/live-smoke-report.json');
  });

  it('should require a project id only when live smoke is enabled', () => {
    expect(validateLiveSmokeConfig(baseConfig({ enabled: false, projectId: '' }))).toEqual([]);
    expect(validateLiveSmokeConfig(baseConfig({ enabled: true, projectId: '' }))).toContain(
      'EASYEDA_TEST_PROJECT_ID is required when EASYEDA_LIVE_TESTS=true.',
    );
  });

  it('should build a read-only smoke plan by default', () => {
    const checks = buildLiveSmokeChecks(baseConfig());

    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((check) => check.mutates === false)).toBe(true);
    expect(checks.map((check) => check.method)).toEqual([
      'system.getStatus',
      'system.apiInventory',
      'schematic.listNets',
      'schematic.listComponents',
      'bom.generate',
      'design.erc',
    ]);
  });

  it('should include project save only after explicit live write opt-in', () => {
    const checks = buildLiveSmokeChecks(baseConfig({ writeEnabled: true }));

    expect(checks.some((check) => check.method === 'project.save' && check.mutates)).toBe(true);
  });

  it('should skip execution when EASYEDA_LIVE_TESTS is disabled', async () => {
    const bridge = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      call: vi.fn(),
      hello: null,
      methodRegistryHash: 'abc123',
    };

    const report = await runLiveSmokeChecks(bridge, baseConfig({ enabled: false }));

    expect(report.status).toBe('skipped');
    expect(bridge.connect).not.toHaveBeenCalled();
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it('should capture hello metadata after the first bridge call completes the handshake', async () => {
    const bridge = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(),
      call: vi.fn(async () => {
        bridge.hello = {
          type: 'hello' as const,
          bridgeVersion: '1.0.0',
          easyedaVersion: '3.2.149.88089769',
          capabilities: [],
          methodRegistryHash: 'live-hash',
          devMode: false,
        };
        return { ok: true };
      }),
      hello: null as {
        type: 'hello';
        bridgeVersion: string;
        easyedaVersion: string;
        capabilities: string[];
        methodRegistryHash: string;
        devMode: boolean;
      } | null,
      methodRegistryHash: 'live-hash',
    };

    const report = await runLiveSmokeChecks(bridge, baseConfig());

    expect(report.status).toBe('passed');
    expect(report.easyedaVersion).toBe('3.2.149.88089769');
    expect(report.bridgeVersion).toBe('1.0.0');
    expect(report.methodRegistryHash).toBe('live-hash');
  });

  it('should execute checks and report failures without throwing', async () => {
    const bridge = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(),
      call: vi.fn(async (method: string) => {
        if (method === 'bom.generate') throw new Error('BOM unavailable');
        return { ok: true };
      }),
      hello: {
        type: 'hello' as const,
        bridgeVersion: '0.5.3',
        easyedaVersion: '2026.1',
        capabilities: [],
        methodRegistryHash: 'hash123',
        devMode: false,
      },
      methodRegistryHash: 'hash123',
    };

    const report = await runLiveSmokeChecks(bridge, baseConfig());

    expect(report.status).toBe('failed');
    expect(report.easyedaVersion).toBe('2026.1');
    expect(report.methodRegistryHash).toBe('hash123');
    expect(report.checks.find((check) => check.method === 'bom.generate')?.status).toBe('failed');
    expect(bridge.disconnect).toHaveBeenCalledWith('live smoke complete');
  });
});
