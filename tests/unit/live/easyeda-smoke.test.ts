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
      waitForConnection: vi.fn(),
      call: vi.fn(),
      hello: null,
      methodRegistryHash: 'abc123',
    };

    const report = await runLiveSmokeChecks(bridge, baseConfig({ enabled: false }));

    expect(report.status).toBe('skipped');
    expect(bridge.connect).not.toHaveBeenCalled();
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it('should execute checks and report failures without throwing', async () => {
    let connected = false;
    const hello = {
      type: 'hello' as const,
      bridgeVersion: '0.5.3',
      contractVersion: 1 as const,
      supportedProtocolVersions: ['1.0.0' as const],
      easyedaVersion: '2026.1',
      capabilities: [],
      methodRegistryHash: 'hash123',
      devMode: false,
    };
    const bridge = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(),
      waitForConnection: vi.fn(async () => {
        connected = true;
      }),
      call: vi.fn(async (method: string) => {
        if (method === 'bom.generate') throw new Error('BOM unavailable');
        return { ok: true };
      }),
      get hello() {
        return connected ? hello : null;
      },
      methodRegistryHash: 'hash123',
    };

    const report = await runLiveSmokeChecks(bridge, baseConfig());

    expect(report.status).toBe('failed');
    expect(bridge.waitForConnection).toHaveBeenCalledWith(30_000);
    expect(report.easyedaVersion).toBe('2026.1');
    expect(report.bridgeVersion).toBe('0.5.3');
    expect(report.methodRegistryHash).toBe('hash123');
    expect(report.checks.find((check) => check.method === 'bom.generate')?.status).toBe('failed');
    expect(bridge.disconnect).toHaveBeenCalledWith('live smoke complete');
  });
});
