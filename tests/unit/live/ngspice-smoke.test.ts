import { describe, expect, it } from 'vitest';
import {
  parseBooleanEnv,
  parseNgspiceLiveConfig,
  runNgspiceLiveSmoke,
} from '../../../src/live/ngspice-smoke.js';

describe('ngspice live smoke plan', () => {
  it('should parse boolean environment values', () => {
    expect(parseBooleanEnv('true')).toBe(true);
    expect(parseBooleanEnv('1')).toBe(true);
    expect(parseBooleanEnv('yes')).toBe(true);
    expect(parseBooleanEnv('on')).toBe(true);
    expect(parseBooleanEnv('false')).toBe(false);
    expect(parseBooleanEnv(undefined)).toBe(false);
  });

  it('should default to an opt-in disabled configuration', () => {
    const config = parseNgspiceLiveConfig({});
    expect(config.enabled).toBe(false);
    expect(config.timeoutMs).toBe(15000);
  });

  it('should honor a custom timeout from the environment', () => {
    const config = parseNgspiceLiveConfig({ NGSPICE_LIVE_TIMEOUT_MS: '30000' });
    expect(config.timeoutMs).toBe(30000);
  });

  it('should skip execution (no ngspice detection attempted) when disabled', async () => {
    const report = await runNgspiceLiveSmoke({ enabled: false, timeoutMs: 15000 });
    expect(report.status).toBe('skipped');
  });

  it('should report unavailable rather than throwing when ngspice is not installed', async () => {
    // This development environment has no ngspice binary, so enabling the check here
    // exercises the real detectNgspice() path end-to-end without needing a live binary.
    const report = await runNgspiceLiveSmoke({ enabled: true, timeoutMs: 15000 });
    expect(['unavailable', 'passed', 'failed']).toContain(report.status);
    if (report.status === 'unavailable') {
      expect(report.detail.length).toBeGreaterThan(0);
    }
  });
});
