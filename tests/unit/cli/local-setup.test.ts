import { describe, expect, it } from 'vitest';
import {
  formatDoctorReport,
  formatHelp,
  formatSetupLocalReport,
  parseCliArgs,
  type DoctorReport,
} from '../../../src/cli/local-setup.js';

describe('local setup CLI helpers', () => {
  it('parses setup and doctor commands', () => {
    expect(parseCliArgs(['--setup-local']).command).toBe('setup-local');
    expect(parseCliArgs(['doctor']).command).toBe('doctor');
    expect(parseCliArgs(['--help']).command).toBe('help');
    expect(parseCliArgs([]).command).toBe('server');
  });

  it('formats MCP client auto-start setup instructions', () => {
    const report = formatSetupLocalReport({
      packageName: 'easyeda-mcp-pro',
      packageVersion: '0.3.2',
      packageRoot: 'C:\\repo',
      serverEntryPath: 'C:\\repo\\dist\\index.js',
      extensionPackagePath: 'C:\\repo\\easyeda-bridge-extension.eext',
      serverEntryExists: true,
      extensionPackageExists: true,
    });

    expect(report).toContain('"command": "node"');
    expect(report).toContain('"C:\\\\repo\\\\dist\\\\index.js"');
    expect(report).toContain('"command": "npx"');
    expect(report).toContain('easyeda-bridge-extension.eext');
    expect(report).toContain('Do not run node dist/index.js manually');
  });

  it('formats doctor output with bridge status', () => {
    const report: DoctorReport = {
      setup: {
        packageName: 'easyeda-mcp-pro',
        packageVersion: '0.3.2',
        packageRoot: 'C:\\repo',
        serverEntryPath: 'C:\\repo\\dist\\index.js',
        extensionPackagePath: 'C:\\repo\\easyeda-bridge-extension.eext',
        serverEntryExists: true,
        extensionPackageExists: false,
      },
      nodeVersion: '24.16.0',
      nodeSupported: true,
      envValid: true,
      envIssues: [],
      bridgeHost: '127.0.0.1',
      bridgePorts: [{ port: 18601, reachable: true }],
      pnpmVersion: '9.0.0',
      toolCounts: { profile: 'core', enabled: 10, total: 20 },
      vendorsConfigured: { JLCPCB: false, LCSC: true },
      vendorDiagnostics: {
        JLCPCB: {
          enabled: false,
          configured: false,
          mode: 'disabled',
          credentialStatus: 'not-required',
        },
        LCSC: {
          enabled: true,
          configured: true,
          mode: 'public-jlcsearch',
          credentialStatus: 'optional-missing',
        },
      },
    };

    expect(formatDoctorReport(report)).toContain('Bridge server: OK reachable on 127.0.0.1:18601');
    expect(formatDoctorReport(report)).toContain('EasyEDA extension package: MISSING');
    expect(formatDoctorReport(report)).toContain(
      'LCSC: enabled / configured / optional-missing / public-jlcsearch',
    );
  });

  it('prints concise help', () => {
    expect(formatHelp()).toContain('easyeda-mcp-pro --setup-local');
    expect(formatHelp()).toContain('easyeda-mcp-pro --doctor');
  });
});
