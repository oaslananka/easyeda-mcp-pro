import * as net from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  createDoctorReport,
  formatDoctorReport,
  formatHelp,
  formatSetupLocalReport,
  formatVersion,
  parseCliArgs,
  type DoctorReport,
} from '../../../src/cli/local-setup.js';

function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

describe('local setup CLI helpers', () => {
  it('parses setup and doctor commands', () => {
    expect(parseCliArgs(['--setup-local']).command).toBe('setup-local');
    expect(parseCliArgs(['doctor']).command).toBe('doctor');
    expect(parseCliArgs(['--help']).command).toBe('help');
    expect(parseCliArgs([]).command).toBe('server');
  });

  it('parses the setup command with a client and profile', () => {
    const result = parseCliArgs(['setup', 'cursor', '--profile', 'full']);
    expect(result).toEqual({ command: 'setup', setupClient: 'cursor', setupProfile: 'full' });
  });

  it('defaults the setup client to "list" when omitted', () => {
    expect(parseCliArgs(['--setup'])).toEqual({
      command: 'setup',
      setupClient: 'list',
      setupProfile: undefined,
    });
  });

  it('parses the extension command with --open and --copy', () => {
    expect(parseCliArgs(['extension', '--open'])).toEqual({
      command: 'extension',
      extensionOpen: true,
      extensionCopy: undefined,
    });
    expect(parseCliArgs(['--extension', '--copy', '/tmp/dest'])).toEqual({
      command: 'extension',
      extensionOpen: false,
      extensionCopy: '/tmp/dest',
    });
  });

  it('parses init and version commands', () => {
    expect(parseCliArgs(['init']).command).toBe('init');
    expect(parseCliArgs(['--init']).command).toBe('init');
    expect(parseCliArgs(['version']).command).toBe('version');
    expect(parseCliArgs(['-v']).command).toBe('version');
    expect(parseCliArgs(['-h']).command).toBe('help');
  });

  it('falls back to the server command for unknown arguments', () => {
    expect(parseCliArgs(['--not-a-real-flag']).command).toBe('server');
  });

  it('parses the doctor --fix flag', () => {
    expect(parseCliArgs(['doctor', '--fix'])).toEqual({ command: 'doctor', doctorFix: true });
    expect(parseCliArgs(['--doctor'])).toEqual({ command: 'doctor', doctorFix: false });
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
    expect(formatDoctorReport(report)).not.toContain('Suggested fixes:');
  });

  it('doctor --fix prints suggested fixes for each detected failure', () => {
    const report: DoctorReport = {
      setup: {
        packageName: 'easyeda-mcp-pro',
        packageVersion: '0.3.2',
        packageRoot: '/repo',
        serverEntryPath: '/repo/dist/index.js',
        extensionPackagePath: '/repo/easyeda-bridge-extension.eext',
        serverEntryExists: false,
        extensionPackageExists: false,
      },
      nodeVersion: '18.19.0',
      nodeSupported: false,
      pnpmVersion: null,
      envValid: false,
      envIssues: ['BRIDGE_PORT: Expected number, received string'],
      bridgeHost: '127.0.0.1',
      bridgePorts: [
        { port: 49620, reachable: false },
        { port: 49621, reachable: false },
      ],
      toolCounts: { profile: 'core', enabled: 10, total: 20 },
      vendorsConfigured: { MOUSER: false },
      vendorDiagnostics: {
        MOUSER: { enabled: true, configured: false, mode: 'api', credentialStatus: 'missing' },
      },
    };

    const output = formatDoctorReport(report, { fix: true });

    expect(output).toContain('Suggested fixes:');
    expect(output).toContain('nvm install 24 && nvm use 24');
    expect(output).toContain('npm install -g pnpm');
    expect(output).toContain('Fix: set/correct BRIDGE_PORT: Expected number, received string');
    expect(output).toContain('pnpm build');
    expect(output).toContain('pnpm build:extension');
    expect(output).toContain('Extension Manager and confirm the bridge extension is imported');
    expect(output).toContain('MOUSER is enabled but missing required credentials');
  });

  it('doctor --fix reports a fallback port and no issues when everything is healthy', () => {
    const healthyReport: DoctorReport = {
      setup: {
        packageName: 'easyeda-mcp-pro',
        packageVersion: '0.3.2',
        packageRoot: '/repo',
        serverEntryPath: '/repo/dist/index.js',
        extensionPackagePath: '/repo/easyeda-bridge-extension.eext',
        serverEntryExists: true,
        extensionPackageExists: true,
      },
      nodeVersion: '24.16.0',
      nodeSupported: true,
      pnpmVersion: '11.0.0',
      envValid: true,
      envIssues: [],
      bridgeHost: '127.0.0.1',
      bridgePorts: [{ port: 49620, reachable: true }],
      toolCounts: { profile: 'core', enabled: 10, total: 20 },
      vendorsConfigured: {},
      vendorDiagnostics: {},
    };

    expect(formatDoctorReport(healthyReport, { fix: true })).toContain(
      'No issues detected — nothing to fix.',
    );

    const fallbackReport: DoctorReport = {
      ...healthyReport,
      bridgePorts: [
        { port: 49620, reachable: false },
        { port: 49621, reachable: true },
      ],
    };

    const fallbackOutput = formatDoctorReport(fallbackReport, { fix: true });
    expect(fallbackOutput).toContain('reachable on a fallback port (49621)');
    expect(fallbackOutput).toContain('BRIDGE_PORT=49621');
  });

  it('prints concise help', () => {
    expect(formatHelp()).toContain('easyeda-mcp-pro --setup-local');
    expect(formatHelp()).toContain('easyeda-mcp-pro --doctor');
  });

  it('formats the package version from the real package.json', () => {
    expect(formatVersion()).toMatch(/^easyeda-mcp-pro@\d+\.\d+\.\d+/);
  });

  describe('createDoctorReport', () => {
    it('reports a reachable bridge port and vendor diagnostics', async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      try {
        await withEnv(
          {
            BRIDGE_HOST: '127.0.0.1',
            BRIDGE_PORT_SCAN: String(port),
            JLCPCB_MODE: 'approved_api',
            JLCPCB_CLIENT_ID: 'id',
            JLCPCB_CLIENT_SECRET: 'secret',
            MOUSER_ENABLED: 'true',
            MOUSER_API_KEY: '',
          },
          async () => {
            const report = await createDoctorReport();

            expect(report.bridgePorts).toEqual([{ port, reachable: true }]);
            expect(report.envValid).toBe(true);
            expect(report.toolCounts?.total).toBeGreaterThan(0);
            expect(report.vendorDiagnostics?.JLCPCB).toMatchObject({
              enabled: true,
              configured: true,
              credentialStatus: 'present',
            });
            expect(report.vendorDiagnostics?.MOUSER).toMatchObject({
              enabled: true,
              configured: false,
              credentialStatus: 'missing',
            });
            expect(report.nodeVersion).toBe(process.versions.node);
          },
        );
      } finally {
        server.close();
      }
    });

    it('reports an unreachable bridge port when nothing is listening', async () => {
      await withEnv({ BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT_SCAN: '1' }, async () => {
        const report = await createDoctorReport();
        expect(report.bridgePorts).toEqual([{ port: 1, reachable: false }]);
      });
    });

    it('surfaces environment validation issues and omits tool counts', async () => {
      await withEnv({ HTTP_PORT: 'not-a-number', BRIDGE_PORT_SCAN: '1' }, async () => {
        const report = await createDoctorReport();
        expect(report.envValid).toBe(false);
        expect(report.envIssues.length).toBeGreaterThan(0);
        expect(report.toolCounts).toBeUndefined();
      });
    });
  });
});
