import { existsSync, readFileSync } from 'node:fs';
import { connect as createConnection } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/register.js';
import { type ToolProfile } from '../config/profiles.js';
import {
  EnvSchema,
  getBridgePairingConfigIssue,
  getHttpSecurityConfigIssues,
  type EnvConfig,
} from '../config/env.js';
import { parsePortScanSpec } from '../bridge/manager.js';

type CliCommand =
  'server' | 'setup-local' | 'setup' | 'extension' | 'doctor' | 'help' | 'version' | 'init';

export interface ParsedCliArgs {
  command: CliCommand;
  setupClient?: string;
  setupProfile?: string;
  extensionOpen?: boolean;
  extensionCopy?: string;
  doctorFix?: boolean;
}

interface PackageInfo {
  name: string;
  version: string;
}

export interface LocalSetupInfo {
  packageName: string;
  packageVersion: string;
  packageRoot: string;
  serverEntryPath: string;
  extensionPackagePath: string;
  serverEntryExists: boolean;
  extensionPackageExists: boolean;
}

interface DoctorPortResult {
  port: number;
  reachable: boolean;
}

export interface VendorDoctorStatus {
  enabled: boolean;
  configured: boolean;
  mode: string;
  credentialStatus:
    'not-required' | 'optional-present' | 'optional-missing' | 'present' | 'missing';
}

export interface RemoteBackendDoctorStatus {
  backend: 'local_bridge' | 'remote_relay' | 'unknown';
  transport: string;
  remoteSessionConfigured: boolean;
  oauthEnabled: boolean;
  httpAuthDisabled: boolean;
  warnings: string[];
}

export interface DoctorReport {
  setup: LocalSetupInfo;
  nodeVersion: string;
  nodeSupported: boolean;
  pnpmVersion: string | null;
  envValid: boolean;
  envIssues: string[];
  bridgeHost: string;
  bridgePorts: DoctorPortResult[];
  toolCounts?: { profile: string; enabled: number; total: number };
  vendorsConfigured: Record<string, boolean>;
  vendorDiagnostics?: Record<string, VendorDoctorStatus>;
  remoteBackend?: RemoteBackendDoctorStatus;
}

function remoteBackendStatusFromConfig(
  config: EnvConfig | undefined,
): RemoteBackendDoctorStatus | undefined {
  if (!config) return undefined;
  const warnings: string[] = [];
  const backend = config.MCP_BRIDGE_BACKEND;
  const transport = config.TRANSPORT;
  const remoteSessionConfigured = config.MCP_REMOTE_SESSION_ID.trim().length > 0;
  const oauthEnabled = config.OAUTH_ENABLED;
  const httpAuthDisabled = config.HTTP_AUTH_DISABLED;

  if (backend === 'remote_relay') {
    if (transport !== 'http') {
      warnings.push(
        'remote_relay backend needs TRANSPORT=http so /remote/* relay endpoints are mounted.',
      );
    }
    if (!remoteSessionConfigured) {
      warnings.push(
        'No MCP_REMOTE_SESSION_ID configured; MCP clients must pass remoteSessionId per tool call.',
      );
    }
    if (!oauthEnabled) {
      warnings.push(
        'OAUTH_ENABLED=false; enable OAuth before exposing Remote Relay through a proxy, tunnel, VPN, or non-loopback listener.',
      );
    }
    if (httpAuthDisabled) {
      warnings.push('HTTP_AUTH_DISABLED=true is only appropriate for loopback/local development.');
    }
  }

  return { backend, transport, remoteSessionConfigured, oauthEnabled, httpAuthDisabled, warnings };
}

function vendorStatusFromConfig(config: EnvConfig | undefined): Record<string, VendorDoctorStatus> {
  const jlcpcbConfigured = Boolean(config?.JLCPCB_CLIENT_ID && config?.JLCPCB_CLIENT_SECRET);
  const lcscOfficialConfigured = Boolean(config?.LCSC_API_KEY);
  const mouserConfigured = Boolean(config?.MOUSER_API_KEY);
  const digikeyConfigured = Boolean(config?.DIGIKEY_CLIENT_ID && config?.DIGIKEY_CLIENT_SECRET);

  return {
    JLCPCB: {
      enabled: config?.JLCPCB_MODE === 'approved_api',
      configured: jlcpcbConfigured,
      mode: config?.JLCPCB_MODE ?? 'disabled',
      credentialStatus:
        config?.JLCPCB_MODE === 'approved_api'
          ? jlcpcbConfigured
            ? 'present'
            : 'missing'
          : 'not-required',
    },
    LCSC: {
      enabled: Boolean(config?.JLCSEARCH_ENABLED),
      configured: Boolean(config?.JLCSEARCH_ENABLED || lcscOfficialConfigured),
      mode: config?.JLCSEARCH_ENABLED
        ? 'public-jlcsearch'
        : lcscOfficialConfigured
          ? 'official-api'
          : 'disabled',
      credentialStatus: lcscOfficialConfigured ? 'optional-present' : 'optional-missing',
    },
    MOUSER: {
      enabled: Boolean(config?.MOUSER_ENABLED),
      configured: mouserConfigured,
      mode: config?.MOUSER_ENABLED ? 'api' : 'disabled',
      credentialStatus: config?.MOUSER_ENABLED
        ? mouserConfigured
          ? 'present'
          : 'missing'
        : 'not-required',
    },
    DIGIKEY: {
      enabled: Boolean(config?.DIGIKEY_ENABLED),
      configured: digikeyConfigured,
      mode: config?.DIGIKEY_ENABLED
        ? config?.DIGIKEY_SANDBOX
          ? 'sandbox'
          : 'production'
        : 'disabled',
      credentialStatus: config?.DIGIKEY_ENABLED
        ? digikeyConfigured
          ? 'present'
          : 'missing'
        : 'not-required',
    },
  };
}

export function parseCliArgs(args: string[]): ParsedCliArgs {
  const first = args[0];
  if (!first) return { command: 'server' };

  switch (first) {
    case '--setup-local':
    case 'setup-local':
      return { command: 'setup-local' };
    case '--setup':
    case 'setup': {
      const client = args[1] ?? 'list';
      const profileIdx = args.indexOf('--profile');
      const profile = profileIdx !== -1 ? args[profileIdx + 1] : undefined;
      return { command: 'setup', setupClient: client, setupProfile: profile };
    }
    case '--extension':
    case 'extension': {
      const open = args.includes('--open');
      const copyIdx = args.indexOf('--copy');
      const copy = copyIdx !== -1 ? args[copyIdx + 1] : undefined;
      return { command: 'extension', extensionOpen: open, extensionCopy: copy };
    }
    case '--doctor':
    case 'doctor':
      return { command: 'doctor', doctorFix: args.includes('--fix') };
    case '--init':
    case 'init':
      return { command: 'init' };
    case '--help':
    case '-h':
    case 'help':
      return { command: 'help' };
    case '--version':
    case '-v':
    case 'version':
      return { command: 'version' };
    default:
      return { command: 'server' };
  }
}

function resolvePackageRoot(metaUrl = import.meta.url): string {
  return fileURLToPath(new URL('../../', metaUrl));
}

function getLocalSetupInfo(packageRoot = resolvePackageRoot()): LocalSetupInfo {
  const packageInfo = readPackageInfo(packageRoot);
  const serverEntryPath = join(packageRoot, 'dist', 'index.js');
  const extensionPackagePath = join(packageRoot, 'easyeda-bridge-extension.eext');

  return {
    packageName: packageInfo.name,
    packageVersion: packageInfo.version,
    packageRoot,
    serverEntryPath,
    extensionPackagePath,
    serverEntryExists: existsSync(serverEntryPath),
    extensionPackageExists: existsSync(extensionPackagePath),
  };
}

export function formatSetupLocalReport(setup = getLocalSetupInfo()): string {
  return [
    'easyeda-mcp-pro local setup',
    '',
    `Package: ${setup.packageName}@${setup.packageVersion}`,
    `MCP server entry: ${status(setup.serverEntryExists)} ${setup.serverEntryPath}`,
    `EasyEDA extension package: ${status(setup.extensionPackageExists)} ${setup.extensionPackagePath}`,
    '',
    'MCP client config (local build, auto-starts the server):',
    stringifyConfig({
      mcpServers: {
        'easyeda-mcp-pro': {
          command: 'node',
          args: [setup.serverEntryPath],
        },
      },
    }),
    '',
    'MCP client config (npm/npx, after package publish):',
    stringifyConfig({
      mcpServers: {
        'easyeda-mcp-pro': {
          command: 'npx',
          args: ['-y', `${setup.packageName}@latest`],
        },
      },
    }),
    '',
    'Next steps:',
    '1. Install or reload the EasyEDA extension package above.',
    '2. Add one MCP config block to your MCP client.',
    '3. Open an EasyEDA Pro project, then use MCP Bridge > Connect.',
    '4. Do not run node dist/index.js manually when your MCP client auto-starts it.',
  ].join('\n');
}

const execFileAsync = promisify(execFile);

export async function createDoctorReport(
  packageRoot = resolvePackageRoot(),
): Promise<DoctorReport> {
  const setup = getLocalSetupInfo(packageRoot);
  const env = parseCliEnv();
  const bridgeHost = env.config?.BRIDGE_HOST ?? '127.0.0.1';
  const ports = parsePortScanSpec(env.config?.BRIDGE_PORT_SCAN ?? '49620');
  const bridgePorts = [];

  for (const port of ports.slice(0, 20)) {
    bridgePorts.push({
      port,
      reachable: await checkTcpPort(bridgeHost, port),
    });
  }

  let pnpmVersion = null;
  try {
    const { stdout } = await execFileAsync('pnpm', ['--version']);
    pnpmVersion = stdout.trim();
  } catch {
    // Ignore if pnpm is not found
  }

  let toolCounts = undefined;
  if (env.config) {
    const registry = new ToolRegistry();
    registry.setProfile(env.config.TOOL_PROFILE as ToolProfile);
    registerBuiltinTools(registry, env.config);
    toolCounts = {
      profile: env.config.TOOL_PROFILE,
      enabled: registry.getEnabledTools().length,
      total: registry.getAllTools().length,
    };
  }

  const vendorDiagnostics = vendorStatusFromConfig(env.config);
  const remoteBackend = remoteBackendStatusFromConfig(env.config);
  const vendorsConfigured: Record<string, boolean> = Object.fromEntries(
    Object.entries(vendorDiagnostics).map(([name, status]) => [name, status.configured]),
  );

  return {
    setup,
    nodeVersion: process.versions.node,
    nodeSupported: isSupportedNodeVersion(process.versions.node),
    pnpmVersion,
    envValid: env.issues.length === 0,
    envIssues: env.issues,
    bridgeHost,
    bridgePorts,
    toolCounts,
    vendorsConfigured,
    vendorDiagnostics,
    remoteBackend,
  };
}

/** Build the "Suggested fixes" lines for `doctor --fix`, one block per detected failure. */
function buildSuggestedFixes(report: DoctorReport): string[] {
  const fixes: string[] = [];
  const reachable = report.bridgePorts.find((port) => port.reachable);

  if (!report.nodeSupported) {
    const major = Number(report.nodeVersion.split('.')[0]);
    fixes.push(
      `Node.js ${report.nodeVersion} is not supported (need >=24 <27, found major ${Number.isFinite(major) ? major : '?'}).`,
      '  Fix: nvm install 24 && nvm use 24   (or upgrade Node.js from https://nodejs.org)',
    );
  }

  if (!report.pnpmVersion) {
    fixes.push(
      'pnpm was not found on PATH.',
      '  Fix: npm install -g pnpm   (only needed for local development, not for npx usage)',
    );
  }

  if (!report.envValid) {
    fixes.push('Environment configuration is invalid:');
    for (const issue of report.envIssues) {
      fixes.push(`  Fix: set/correct ${issue}`);
    }
  }

  if (!report.setup.serverEntryExists) {
    fixes.push(
      `MCP server entry not found at ${report.setup.serverEntryPath}.`,
      '  Fix: pnpm build   (or reinstall via npx easyeda-mcp-pro if using the published package)',
    );
  }

  if (!report.setup.extensionPackageExists) {
    fixes.push(
      `Bridge extension package not found at ${report.setup.extensionPackagePath}.`,
      '  Fix: pnpm build:extension   (or reinstall the npm package, which bundles the .eext)',
    );
  }

  if (!reachable) {
    fixes.push(
      `Bridge server is not reachable on ${report.bridgeHost} (scanned ports: ${report.bridgePorts.map((p) => p.port).join(', ')}).`,
      '  This is expected until your MCP client starts easyeda-mcp-pro. If your MCP client is running and this persists:',
      '  Fix 1: In EasyEDA Pro, go to Settings > Extensions > Extension Manager and confirm the bridge extension is imported.',
      '  Fix 2: Enable "Allow External Interaction" for the extension, then click MCP Bridge > Connect in the menu bar.',
      '  Fix 3: If another process holds the configured port, set BRIDGE_PORT to a free port and update BRIDGE_PORT_SCAN to include it.',
    );
  } else if (reachable.port !== report.bridgePorts[0]?.port) {
    fixes.push(
      `Bridge is reachable on a fallback port (${reachable.port}) rather than the first scanned port (${report.bridgePorts[0]?.port}).`,
      `  Fix: set BRIDGE_PORT=${reachable.port} to pin it and avoid future port-scan ambiguity.`,
    );
  }

  if (report.remoteBackend?.warnings.length) {
    fixes.push('Remote Relay readiness warnings:');
    for (const warning of report.remoteBackend.warnings) {
      fixes.push(`  Fix: ${warning}`);
    }
  }

  if (report.vendorDiagnostics) {
    for (const [name, vendor] of Object.entries(report.vendorDiagnostics)) {
      if (vendor.credentialStatus === 'missing') {
        fixes.push(
          `${name} is enabled but missing required credentials (mode: ${vendor.mode}).`,
          `  Fix: set the ${name} credential environment variables documented in docs/vendor-api-hardening.md, or disable it.`,
        );
      }
    }
  }

  if (fixes.length === 0) {
    fixes.push('No issues detected — nothing to fix.');
  }

  return fixes;
}

export function formatDoctorReport(report: DoctorReport, options?: { fix?: boolean }): string {
  const reachable = report.bridgePorts.find((port) => port.reachable);
  const bridgeStatus = reachable
    ? `reachable on ${report.bridgeHost}:${reachable.port}`
    : `offline on ${report.bridgeHost}:${report.bridgePorts.map((port) => port.port).join(',')}`;

  const vendors = report.vendorDiagnostics
    ? Object.entries(report.vendorDiagnostics)
        .map(
          ([name, vendor]) =>
            `${name}: ${vendor.enabled ? 'enabled' : 'disabled'} / ${vendor.configured ? 'configured' : 'missing'} / ${vendor.credentialStatus} / ${vendor.mode}`,
        )
        .join(', ')
    : Object.entries(report.vendorsConfigured)
        .map(([name, isConfigured]) => `${name}: ${isConfigured ? 'configured' : 'missing'}`)
        .join(', ');

  const toolsStr = report.toolCounts
    ? `Profile '${report.toolCounts.profile}' with ${report.toolCounts.enabled} / ${report.toolCounts.total} tools enabled`
    : 'Unknown tool configuration';

  const remoteBackendStr = report.remoteBackend
    ? `${report.remoteBackend.backend} / transport=${report.remoteBackend.transport} / session=${report.remoteBackend.remoteSessionConfigured ? 'configured' : 'per-request'} / oauth=${report.remoteBackend.oauthEnabled ? 'enabled' : 'disabled'}${report.remoteBackend.warnings.length ? ` / warnings=${report.remoteBackend.warnings.length}` : ''}`
    : 'Unknown remote backend configuration';

  const lines = [
    'easyeda-mcp-pro doctor',
    '',
    `Node.js: ${status(report.nodeSupported)} ${report.nodeVersion} (supported: >=24 <27)`,
    `pnpm: ${report.pnpmVersion ? 'OK ' + report.pnpmVersion : 'MISSING'}`,
    `Environment: ${status(report.envValid)}${report.envIssues.length ? ` ${report.envIssues.join('; ')}` : ''}`,
    `MCP server entry: ${status(report.setup.serverEntryExists)} ${report.setup.serverEntryPath}`,
    `EasyEDA extension package: ${status(report.setup.extensionPackageExists)} ${report.setup.extensionPackagePath}`,
    `Bridge server: ${reachable ? 'OK' : 'INFO'} ${bridgeStatus}`,
    `Remote backend: ${remoteBackendStr}`,
    ...(report.remoteBackend?.warnings.length
      ? report.remoteBackend.warnings.map((warning) => `Remote warning: ${warning}`)
      : []),
    `Tools: ${toolsStr}`,
    `Vendors: ${vendors}`,
    '',
    reachable
      ? 'Bridge server is running. If EasyEDA is not connected, reload the extension and click MCP Bridge > Connect.'
      : 'Bridge server is not running yet. This is normal until your MCP client starts easyeda-mcp-pro.',
  ];

  if (options?.fix) {
    lines.push('', 'Suggested fixes:', ...buildSuggestedFixes(report));
  }

  return lines.join('\n');
}

export function formatHelp(): string {
  return [
    'easyeda-mcp-pro',
    '',
    'Usage:',
    '  easyeda-mcp-pro                             Start the MCP server (stdio/http)',
    '',
    '  easyeda-mcp-pro init                        Start interactive setup wizard',
    '',
    '  easyeda-mcp-pro setup [client]               Auto-configure an MCP client',
    '    Clients: claude, cursor, vscode, windsurf, cline, gemini, zed, amazonq, continue, all',
    '    Options: --profile <core|pro|full|dev>',
    '',
    '  easyeda-mcp-pro extension                    Show bridge extension path and install guide',
    '    Options: --open    Open file location in file manager',
    '             --copy <dir>  Copy .eext to the specified directory',
    '',
    '  easyeda-mcp-pro --setup-local                Print MCP client config (legacy)',
    '  easyeda-mcp-pro --doctor [--fix]              Check runtime, package, and bridge status',
    '    --fix     Print suggested fixes for each detected failure (no files are changed)',
    '  easyeda-mcp-pro --version                    Print package version',
    '',
    'Examples:',
    '  npx easyeda-mcp-pro init                     Run interactive setup wizard',
    '  npx easyeda-mcp-pro setup claude             Configure Claude Desktop',
    '  npx easyeda-mcp-pro setup all --profile full Configure all detected clients',
    '  npx easyeda-mcp-pro extension --open         Open extension file location',
  ].join('\n');
}

export function formatVersion(packageRoot = resolvePackageRoot()): string {
  const packageInfo = readPackageInfo(packageRoot);
  return `${packageInfo.name}@${packageInfo.version}`;
}

async function checkTcpPort(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;

    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function parseCliEnv(): { config?: EnvConfig; issues: string[] } {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    return {
      issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    };
  }

  const issues = getHttpSecurityConfigIssues(result.data);
  const bridgePairingIssue = getBridgePairingConfigIssue(result.data);
  if (bridgePairingIssue) issues.unshift(bridgePairingIssue);
  if (issues.length > 0) return { issues };

  return { config: result.data, issues: [] };
}

function readPackageInfo(packageRoot: string): PackageInfo {
  const raw = readFileSync(join(packageRoot, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as Partial<PackageInfo>;
  return {
    name: parsed.name ?? 'easyeda-mcp-pro',
    version: parsed.version ?? '0.0.0',
  };
}

function isSupportedNodeVersion(version: string): boolean {
  const major = Number(version.split('.')[0]);
  return Number.isInteger(major) && major >= 24 && major < 27;
}

function status(ok: boolean): string {
  return ok ? 'OK' : 'MISSING';
}

function stringifyConfig(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
