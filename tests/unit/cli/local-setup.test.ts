import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDoctorReport,
  evaluateNodeRuntime,
  evaluatePnpmRuntime,
  formatDoctorReport,
  formatHelp,
  formatSetupLocalReport,
  formatVersion,
  inspectUserServiceRuntime,
  parseCliArgs,
  pnpmExecutableForPlatform,
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

  it('accepts only Node 24 and exact pnpm 11.5.1 for repository automation', () => {
    expect(evaluateNodeRuntime('24.18.0')).toMatchObject({ supported: true });
    expect(evaluateNodeRuntime('24.99.0')).toMatchObject({ supported: true });
    expect(evaluateNodeRuntime('23.11.1')).toMatchObject({ supported: false });
    expect(evaluateNodeRuntime('26.0.0')).toMatchObject({ supported: false });
    expect(evaluatePnpmRuntime('11.5.1')).toMatchObject({ supported: true });
    expect(evaluatePnpmRuntime('11.5.2')).toMatchObject({ supported: false });
    expect(evaluatePnpmRuntime(null)).toMatchObject({ supported: false });
  });

  it('uses the platform-specific pnpm executable', () => {
    expect(pnpmExecutableForPlatform('win32')).toBe('pnpm.cmd');
    expect(pnpmExecutableForPlatform('linux')).toBe('pnpm');
  });

  it('resolves the default systemd unit path from XDG config or the user home', async () => {
    await withEnv({ XDG_CONFIG_HOME: '/tmp/easyeda-xdg' }, async () => {
      await expect(
        inspectUserServiceRuntime({ platform: 'linux', unitText: null }),
      ).resolves.toMatchObject({
        installed: false,
        unitPath: join('/tmp/easyeda-xdg', 'systemd', 'user', 'easyeda-mcp-pro.service'),
      });
    });

    await withEnv({ XDG_CONFIG_HOME: undefined }, async () => {
      const result = await inspectUserServiceRuntime({ platform: 'linux', unitText: null });
      expect(result.installed).toBe(false);
      expect(result.unitPath).toMatch(
        /[\\/]\.config[\\/]systemd[\\/]user[\\/]easyeda-mcp-pro\.service$/,
      );
    });
  });

  it('skips systemd inspection on non-Linux platforms', async () => {
    await expect(inspectUserServiceRuntime({ platform: 'win32' })).resolves.toMatchObject({
      applicable: false,
      installed: false,
      issues: [],
    });
  });

  it('reports missing and malformed systemd ExecStart commands', async () => {
    const missing = await inspectUserServiceRuntime({
      platform: 'linux',
      unitPath: '/home/test/.config/systemd/user/easyeda-mcp-pro.service',
      unitText: '[Service]\nRestart=on-failure',
    });
    expect(missing.issues).toEqual(['User service has no ExecStart command.']);

    const empty = await inspectUserServiceRuntime({
      platform: 'linux',
      unitPath: '/home/test/.config/systemd/user/easyeda-mcp-pro.service',
      unitText: '[Service]\nExecStart=   ',
    });
    expect(empty.issues).toEqual(['User service has no ExecStart command.']);

    const malformed = await inspectUserServiceRuntime({
      platform: 'linux',
      unitPath: '/home/test/.config/systemd/user/easyeda-mcp-pro.service',
      unitText: '[Service]\nExecStart="/unterminated node path',
    });
    expect(malformed.issues).toEqual(['User service ExecStart command could not be parsed.']);
  });

  it('reads an installed systemd unit from disk when no override is supplied', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'easyeda-mcp-pro-systemd-'));
    const unitPath = join(directory, 'easyeda-mcp-pro.service');
    writeFileSync(unitPath, '[Service]\nExecStart=/runtime/node /srv/easyeda/dist/index.js');

    try {
      await expect(
        inspectUserServiceRuntime({
          platform: 'linux',
          unitPath,
          executableExists: () => true,
          readNodeVersion: async () => '24.18.0',
        }),
      ).resolves.toMatchObject({
        installed: true,
        nodePath: '/runtime/node',
        nodeVersion: '24.18.0',
        nodeSupported: true,
        issues: [],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reads the service Node version and handles an unreadable executable', async () => {
    const healthy = await inspectUserServiceRuntime({
      platform: 'linux',
      unitPath: '/home/test/.config/systemd/user/easyeda-mcp-pro.service',
      unitText: `[Service]\nExecStart="${process.execPath}" /srv/easyeda/dist/index.js`,
    });
    expect(healthy).toMatchObject({
      nodePath: process.execPath,
      nodePathExists: true,
      nodeVersion: process.versions.node,
      nodeSupported: true,
      issues: [],
    });

    const unreadable = await inspectUserServiceRuntime({
      platform: 'linux',
      unitPath: '/home/test/.config/systemd/user/easyeda-mcp-pro.service',
      unitText:
        '[Service]\nExecStart=/missing-but-reported-present/node /srv/easyeda/dist/index.js',
      executableExists: () => true,
    });
    expect(unreadable).toMatchObject({
      nodePathExists: true,
      nodeVersion: null,
      nodeSupported: false,
    });
    expect(unreadable.issues.join(' ')).toContain('Unable to read Node.js version');
  });

  it('detects a stale systemd ExecStart Node path before service enablement', async () => {
    const service = await inspectUserServiceRuntime({
      platform: 'linux',
      unitPath: '/home/test/.config/systemd/user/easyeda-mcp-pro.service',
      unitText: [
        '[Service]',
        'ExecStart=/usr/local/bin/node /home/test/easyeda-mcp-pro/dist/index.js',
        'Restart=on-failure',
        'RestartSec=2',
      ].join('\n'),
      executableExists: () => false,
      readNodeVersion: async () => null,
    });

    expect(service).toMatchObject({
      installed: true,
      nodePath: '/usr/local/bin/node',
      nodePathExists: false,
      nodeSupported: false,
    });
    expect(service.issues.join(' ')).toContain('ExecStart Node executable does not exist');
    expect(service.issues.join(' ')).toContain('restart loop');

    const noRestartPolicy = await inspectUserServiceRuntime({
      platform: 'linux',
      unitPath: '/home/test/.config/systemd/user/easyeda-mcp-pro.service',
      unitText: '[Service]\nExecStart=/missing/node /srv/easyeda/dist/index.js',
      executableExists: () => false,
    });
    expect(noRestartPolicy.issues).toEqual([
      'ExecStart Node executable does not exist: /missing/node.',
    ]);
  });

  it('accepts a supported systemd runtime and rejects unsupported Node 26', async () => {
    const base = {
      platform: 'linux' as const,
      unitPath: '/home/test/.config/systemd/user/easyeda-mcp-pro.service',
      unitText: '[Service]\nExecStart="/home/test/node 24/bin/node" /srv/easyeda/dist/index.js',
      executableExists: () => true,
    };
    const supported = await inspectUserServiceRuntime({
      ...base,
      readNodeVersion: async () => '24.18.0',
    });
    expect(supported).toMatchObject({
      nodePath: '/home/test/node 24/bin/node',
      nodePathExists: true,
      nodeVersion: '24.18.0',
      nodeSupported: true,
      issues: [],
    });

    const unsupported = await inspectUserServiceRuntime({
      ...base,
      readNodeVersion: async () => '26.0.0',
    });
    expect(unsupported.nodeSupported).toBe(false);
    expect(unsupported.issues.join(' ')).toContain('requires Node.js 24.x');
  });

  it('formats MCP client auto-start setup instructions', () => {
    const report = formatSetupLocalReport(
      {
        packageName: 'easyeda-mcp-pro',
        packageVersion: '0.3.2',
        packageRoot: 'C:\\repo',
        serverEntryPath: 'C:\\repo\\dist\\index.js',
        extensionPackagePath: 'C:\\repo\\easyeda-bridge-extension.eext',
        serverEntryExists: true,
        extensionPackageExists: true,
      },
      'C:\\runtime\\node.exe',
    );

    expect(report).toContain('"command": "C:\\\\runtime\\\\node.exe"');
    expect(report).toContain('"C:\\\\repo\\\\dist\\\\index.js"');
    expect(report).toContain('"command": "npx"');
    expect(report).toContain('easyeda-bridge-extension.eext');
    expect(report).toContain('Rerun setup after replacing or moving this Node runtime');
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
      pnpmSupported: false,
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
      remoteBackend: {
        backend: 'local_bridge',
        transport: 'stdio',
        remoteSessionConfigured: false,
        oauthEnabled: false,
        httpAuthDisabled: false,
        warnings: [],
      },
    };

    expect(formatDoctorReport(report)).toContain('Bridge server: OK reachable on 127.0.0.1:18601');
    expect(formatDoctorReport(report)).toContain('EasyEDA extension package: MISSING');
    expect(formatDoctorReport(report)).toContain(
      'LCSC: enabled / configured / optional-missing / public-jlcsearch',
    );
    expect(formatDoctorReport(report)).toContain(
      'Remote backend: local_bridge / transport=stdio / session=per-request / oauth=disabled',
    );
    expect(formatDoctorReport(report)).not.toContain('Suggested fixes:');
    expect(formatDoctorReport(report, { fix: true })).toContain(
      'pnpm 9.0.0 is not supported (required: 11.5.1).',
    );
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
      pnpmSupported: false,
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
      remoteBackend: {
        backend: 'remote_relay',
        transport: 'stdio',
        remoteSessionConfigured: false,
        oauthEnabled: false,
        httpAuthDisabled: false,
        warnings: [
          'remote_relay backend needs TRANSPORT=http so /remote/* relay endpoints are mounted.',
          'No MCP_REMOTE_SESSION_ID configured; MCP clients must pass remoteSessionId per tool call.',
        ],
      },
    };

    const output = formatDoctorReport(report, { fix: true });

    expect(output).toContain('Suggested fixes:');
    expect(output).toContain('nvm install 24.18.0 && nvm use 24.18.0');
    expect(output).toContain('corepack prepare pnpm@11.5.1 --activate');
    expect(output).toContain('Fix: set/correct BRIDGE_PORT: Expected number, received string');
    expect(output).toContain('pnpm build');
    expect(output).toContain('pnpm build:extension');
    expect(output).toContain('Extension Manager and confirm the bridge extension is imported');
    expect(output).toContain('MOUSER is enabled but missing required credentials');
    expect(output).toContain('Remote Relay readiness warnings:');
    expect(output).toContain('remote_relay backend needs TRANSPORT=http');
    expect(output).toContain('Remote warning: remote_relay backend needs TRANSPORT=http');
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
      pnpmVersion: '11.5.1',
      pnpmSupported: true,
      envValid: true,
      envIssues: [],
      bridgeHost: '127.0.0.1',
      bridgePorts: [{ port: 49620, reachable: true }],
      toolCounts: { profile: 'core', enabled: 10, total: 20 },
      vendorsConfigured: {},
      vendorDiagnostics: {},
      remoteBackend: {
        backend: 'local_bridge',
        transport: 'stdio',
        remoteSessionConfigured: false,
        oauthEnabled: false,
        httpAuthDisabled: false,
        warnings: [],
      },
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

  it('formats stale user-service runtime diagnostics and recovery', () => {
    const report: DoctorReport = {
      setup: {
        packageName: 'easyeda-mcp-pro',
        packageVersion: '0.35.1',
        packageRoot: '/repo',
        serverEntryPath: '/repo/dist/index.js',
        extensionPackagePath: '/repo/easyeda-bridge-extension.eext',
        serverEntryExists: true,
        extensionPackageExists: true,
      },
      nodeVersion: '24.18.0',
      nodeSupported: true,
      pnpmVersion: '11.5.1',
      pnpmSupported: true,
      envValid: true,
      envIssues: [],
      bridgeHost: '127.0.0.1',
      bridgePorts: [{ port: 49620, reachable: false }],
      vendorsConfigured: {},
      userServiceRuntime: {
        applicable: true,
        installed: true,
        unitPath: '/home/test/.config/systemd/user/easyeda-mcp-pro.service',
        execStart: '/usr/local/bin/node /repo/dist/index.js',
        nodePath: '/usr/local/bin/node',
        nodePathExists: false,
        nodeVersion: null,
        nodeSupported: false,
        issues: ['ExecStart Node executable does not exist: /usr/local/bin/node.'],
      },
    };

    const output = formatDoctorReport(report, { fix: true });
    expect(output).toContain('pnpm: OK 11.5.1 (required: 11.5.1)');
    expect(output).toContain('User service runtime: BROKEN /usr/local/bin/node');
    expect(output).toContain('systemctl --user disable --now easyeda-mcp-pro.service');
    expect(output).toContain('Rerun your MCP client setup');

    const healthyServiceOutput = formatDoctorReport({
      ...report,
      userServiceRuntime: {
        applicable: true,
        installed: true,
        unitPath: '/home/test/.config/systemd/user/easyeda-mcp-pro.service',
        nodePath: '/runtime/node',
        issues: [],
      },
    });
    expect(healthyServiceOutput).toContain('User service runtime: OK /runtime/node');

    const execStartFallbackOutput = formatDoctorReport({
      ...report,
      userServiceRuntime: {
        applicable: true,
        installed: true,
        unitPath: '/home/test/.config/systemd/user/easyeda-mcp-pro.service',
        execStart: 'node /repo/dist/index.js',
        issues: [],
      },
    });
    expect(execStartFallbackOutput).toContain('User service runtime: OK node /repo/dist/index.js');

    const unitPathFallbackOutput = formatDoctorReport({
      ...report,
      userServiceRuntime: {
        applicable: true,
        installed: true,
        unitPath: '/home/test/.config/systemd/user/easyeda-mcp-pro.service',
        issues: [],
      },
    });
    expect(unitPathFallbackOutput).toContain(
      'User service runtime: OK /home/test/.config/systemd/user/easyeda-mcp-pro.service',
    );
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

    it('reports Remote Relay readiness warnings from environment configuration', async () => {
      await withEnv(
        {
          MCP_BRIDGE_BACKEND: 'remote_relay',
          TRANSPORT: 'stdio',
          MCP_REMOTE_SESSION_ID: '',
          OAUTH_ENABLED: 'false',
          BRIDGE_PORT_SCAN: '1',
        },
        async () => {
          const report = await createDoctorReport();

          expect(report.remoteBackend).toMatchObject({
            backend: 'remote_relay',
            transport: 'stdio',
            remoteSessionConfigured: false,
            oauthEnabled: false,
          });
          expect(report.remoteBackend?.warnings).toContain(
            'remote_relay backend needs TRANSPORT=http so /remote/* relay endpoints are mounted.',
          );
          expect(report.remoteBackend?.warnings).toContain(
            'No MCP_REMOTE_SESSION_ID configured; MCP clients must pass remoteSessionId per tool call.',
          );
          expect(formatDoctorReport(report)).toContain('Remote backend: remote_relay');
          expect(formatDoctorReport(report)).toContain('warnings=3');
        },
      );
    });

    it('reports Remote Relay as ready when http, OAuth, and fixed session are configured', async () => {
      await withEnv(
        {
          MCP_BRIDGE_BACKEND: 'remote_relay',
          TRANSPORT: 'http',
          MCP_REMOTE_SESSION_ID: 'sess_fixed',
          OAUTH_ENABLED: 'true',
          OAUTH_JWKS_URI: 'https://auth.example.test/.well-known/jwks.json',
          BRIDGE_PORT_SCAN: '1',
        },
        async () => {
          const report = await createDoctorReport();

          expect(report.remoteBackend).toMatchObject({
            backend: 'remote_relay',
            transport: 'http',
            remoteSessionConfigured: true,
            oauthEnabled: true,
            warnings: [],
          });
          expect(formatDoctorReport(report)).toContain(
            'Remote backend: remote_relay / transport=http / session=configured / oauth=enabled',
          );
        },
      );
    });

    it('reports an unreachable bridge port when nothing is listening', async () => {
      await withEnv({ BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT_SCAN: '1' }, async () => {
        const report = await createDoctorReport();
        expect(report.bridgePorts).toEqual([{ port: 1, reachable: false }]);
      });
    });

    it('reports a missing origin allowlist for non-loopback HTTP', async () => {
      await withEnv(
        {
          TRANSPORT: 'http',
          HTTP_HOST: '0.0.0.0',
          ALLOWED_ORIGINS: '',
          OAUTH_ENABLED: 'true',
          OAUTH_JWKS_URI: 'https://auth.example.test/.well-known/jwks.json',
          OAUTH_ISSUER: 'https://auth.example.test',
          OAUTH_AUDIENCE: 'easyeda-mcp-pro',
          BRIDGE_PORT_SCAN: '1',
        },
        async () => {
          const report = await createDoctorReport();

          expect(report.envValid).toBe(false);
          expect(report.envIssues.join(' ')).toContain('ALLOWED_ORIGINS');
          expect(report.toolCounts).toBeUndefined();
        },
      );
    });

    it('reports OAuth as required for non-loopback HTTP in development', async () => {
      await withEnv(
        {
          NODE_ENV: 'development',
          TRANSPORT: 'http',
          HTTP_HOST: '0.0.0.0',
          ALLOWED_ORIGINS: 'https://app.example.com',
          OAUTH_ENABLED: 'false',
          BRIDGE_PORT_SCAN: '1',
        },
        async () => {
          const report = await createDoctorReport();

          expect(report.envValid).toBe(false);
          expect(report.envIssues).toHaveLength(1);
          expect(report.envIssues[0]).toContain('OAUTH_ENABLED=true');
          expect(report.toolCounts).toBeUndefined();
        },
      );
    });

    it('reports every missing OAuth setting for non-loopback HTTP', async () => {
      await withEnv(
        {
          TRANSPORT: 'http',
          HTTP_HOST: '0.0.0.0',
          ALLOWED_ORIGINS: 'https://app.example.com',
          OAUTH_ENABLED: 'true',
          OAUTH_JWKS_URI: '',
          OAUTH_ISSUER: '',
          OAUTH_AUDIENCE: '',
          BRIDGE_PORT_SCAN: '1',
        },
        async () => {
          const report = await createDoctorReport();
          const issues = report.envIssues.join(' ');

          expect(report.envValid).toBe(false);
          expect(issues).toContain('OAUTH_JWKS_URI');
          expect(issues).toContain('OAUTH_ISSUER');
          expect(issues).toContain('OAUTH_AUDIENCE');
          expect(report.toolCounts).toBeUndefined();
        },
      );
    });

    it('reports a non-loopback bridge without a pairing token as unsafe', async () => {
      await withEnv(
        { BRIDGE_HOST: '0.0.0.0', BRIDGE_TOKEN: '', BRIDGE_PORT_SCAN: '1' },
        async () => {
          const report = await createDoctorReport();

          expect(report.envValid).toBe(false);
          expect(report.envIssues.join(' ')).toContain('BRIDGE_TOKEN');
          expect(report.toolCounts).toBeUndefined();
        },
      );
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
