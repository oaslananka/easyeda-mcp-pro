import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
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
import {
  evaluateNodeRuntime,
  evaluatePnpmRuntime,
  PINNED_NODE_VERSION,
  PINNED_PNPM_VERSION,
} from '../runtime/policy.js';

export { evaluateNodeRuntime, evaluatePnpmRuntime } from '../runtime/policy.js';

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

export type DoctorInstallationMode = 'source-checkout' | 'installed-package' | 'production-runtime';

export interface LocalSetupInfo {
  packageName: string;
  packageVersion: string;
  packageRoot: string;
  installationMode?: DoctorInstallationMode;
  serverEntryPath: string;
  extensionPackagePath: string;
  extensionChecksumPath?: string;
  serverEntryExists: boolean;
  extensionPackageExists: boolean;
  extensionChecksumExists?: boolean;
  serverEntryValid?: boolean;
  extensionPackageValid?: boolean;
  artifactIssues?: string[];
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

export interface UserServiceRuntimeStatus {
  applicable: boolean;
  installed: boolean;
  unitPath: string;
  execStart?: string;
  nodePath?: string;
  nodePathExists?: boolean;
  nodeVersion?: string | null;
  nodeSupported?: boolean;
  issues: string[];
}

export interface DoctorReport {
  setup: LocalSetupInfo;
  installationMode?: DoctorInstallationMode;
  nodeVersion: string;
  nodeSupported: boolean;
  pnpmVersion: string | null;
  pnpmSupported: boolean;
  pnpmRequired?: boolean;
  userServiceRuntime?: UserServiceRuntimeStatus;
  envValid: boolean;
  envIssues: string[];
  bridgeHost: string;
  bridgePorts: DoctorPortResult[];
  toolCounts?: { profile: string; enabled: number; total: number };
  vendorsConfigured: Record<string, boolean>;
  vendorDiagnostics?: Record<string, VendorDoctorStatus>;
  remoteBackend?: RemoteBackendDoctorStatus;
}

export interface CreateDoctorReportOptions {
  nodeEnv?: string;
  pnpmVersion?: string | null;
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

function detectDoctorInstallationMode(
  packageRoot: string,
  nodeEnv = process.env.NODE_ENV,
): DoctorInstallationMode {
  const sourceMarkers = ['src', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.build.json'];
  if (sourceMarkers.every((entry) => existsSync(join(packageRoot, entry)))) {
    return 'source-checkout';
  }
  return nodeEnv === 'production' ? 'production-runtime' : 'installed-package';
}

interface ArtifactInspection {
  exists: boolean;
  valid: boolean;
  issues: string[];
}

interface ExtensionArtifactInspection extends ArtifactInspection {
  checksumExists: boolean;
}

interface ExtensionChecksumManifest {
  schemaVersion?: unknown;
  package?: unknown;
  packageSize?: unknown;
  packageSha256?: unknown;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inspectServerEntry(serverEntryPath: string): ArtifactInspection {
  if (!existsSync(serverEntryPath)) {
    return {
      exists: false,
      valid: false,
      issues: [`MCP server entry is missing: ${serverEntryPath}.`],
    };
  }

  try {
    const serverEntry = readFileSync(serverEntryPath);
    if (serverEntry.byteLength === 0) {
      return {
        exists: true,
        valid: false,
        issues: [`MCP server entry is empty: ${serverEntryPath}.`],
      };
    }
    if (!serverEntry.toString('utf8', 0, 64).startsWith('#!/usr/bin/env node')) {
      return {
        exists: true,
        valid: false,
        issues: [`MCP server entry is missing the declared Node.js shebang: ${serverEntryPath}.`],
      };
    }
    return { exists: true, valid: true, issues: [] };
  } catch (error) {
    return {
      exists: true,
      valid: false,
      issues: [`MCP server entry could not be read: ${formatUnknownError(error)}.`],
    };
  }
}

function validateExtensionPackage(
  extensionPackagePath: string,
  manifest: ExtensionChecksumManifest,
): string[] {
  const issues: string[] = [];
  const extensionInfo = statSync(extensionPackagePath);
  const expectedSha256 = typeof manifest.packageSha256 === 'string' ? manifest.packageSha256 : '';
  const actualSha256 = sha256File(extensionPackagePath);

  if (extensionInfo.size <= 0) {
    issues.push(`EasyEDA extension package is empty: ${extensionPackagePath}.`);
  }
  if (manifest.schemaVersion !== 1) {
    issues.push('EasyEDA extension checksum manifest has an unsupported schema version.');
  }
  if (manifest.package !== 'easyeda-bridge-extension.eext') {
    issues.push('EasyEDA extension checksum manifest names an unexpected package.');
  }
  if (manifest.packageSize !== extensionInfo.size) {
    issues.push('EasyEDA extension package size does not match its checksum manifest.');
  }
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    issues.push('EasyEDA extension checksum manifest has an invalid SHA-256 value.');
  } else if (expectedSha256 !== actualSha256) {
    issues.push('EasyEDA extension package SHA-256 does not match its checksum manifest.');
  }
  return issues;
}

function inspectExtensionPackage(
  extensionPackagePath: string,
  extensionChecksumPath: string,
): ExtensionArtifactInspection {
  if (!existsSync(extensionPackagePath)) {
    return {
      exists: false,
      checksumExists: existsSync(extensionChecksumPath),
      valid: false,
      issues: [`EasyEDA extension package is missing: ${extensionPackagePath}.`],
    };
  }
  if (!existsSync(extensionChecksumPath)) {
    return {
      exists: true,
      checksumExists: false,
      valid: false,
      issues: [`EasyEDA extension checksum manifest is missing: ${extensionChecksumPath}.`],
    };
  }

  try {
    const manifest = JSON.parse(
      readFileSync(extensionChecksumPath, 'utf8'),
    ) as ExtensionChecksumManifest;
    const issues = validateExtensionPackage(extensionPackagePath, manifest);
    return { exists: true, checksumExists: true, valid: issues.length === 0, issues };
  } catch (error) {
    return {
      exists: true,
      checksumExists: true,
      valid: false,
      issues: [`EasyEDA extension checksum could not be verified: ${formatUnknownError(error)}.`],
    };
  }
}

function getLocalSetupInfo(
  packageRoot = resolvePackageRoot(),
  nodeEnv = process.env.NODE_ENV,
): LocalSetupInfo {
  const packageInfo = readPackageInfo(packageRoot);
  const installationMode = detectDoctorInstallationMode(packageRoot, nodeEnv);
  const serverEntryPath = join(packageRoot, 'dist', 'index.js');
  const extensionPackagePath = join(packageRoot, 'easyeda-bridge-extension.eext');
  const extensionChecksumPath = join(packageRoot, 'easyeda-bridge-extension.checksums.json');
  const serverEntry = inspectServerEntry(serverEntryPath);
  const extensionPackage = inspectExtensionPackage(extensionPackagePath, extensionChecksumPath);

  return {
    packageName: packageInfo.name,
    packageVersion: packageInfo.version,
    packageRoot,
    installationMode,
    serverEntryPath,
    extensionPackagePath,
    extensionChecksumPath,
    serverEntryExists: serverEntry.exists,
    extensionPackageExists: extensionPackage.exists,
    extensionChecksumExists: extensionPackage.checksumExists,
    serverEntryValid: serverEntry.valid,
    extensionPackageValid: extensionPackage.valid,
    artifactIssues: [...serverEntry.issues, ...extensionPackage.issues],
  };
}

export function formatSetupLocalReport(
  setup = getLocalSetupInfo(),
  nodeExecutablePath = process.execPath,
): string {
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
          command: nodeExecutablePath,
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
    `4. Rerun setup after replacing or moving this Node runtime: ${nodeExecutablePath}`,
  ].join('\n');
}

const execFileAsync = promisify(execFile);

export function pnpmExecutableForPlatform(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function parseSystemdExecStart(unitText: string): string | undefined {
  const line = unitText
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('ExecStart='));
  if (!line) return undefined;
  return line.slice('ExecStart='.length).trim() || undefined;
}

function firstCommandToken(command: string): string | undefined {
  if (command.startsWith('"')) {
    const end = command.indexOf('"', 1);
    return end > 1 ? command.slice(1, end) : undefined;
  }
  return /^\S+/.exec(command)?.[0];
}

export async function inspectUserServiceRuntime(
  options: {
    platform?: NodeJS.Platform;
    unitPath?: string;
    unitText?: string | null;
    executableExists?: (path: string) => boolean;
    readNodeVersion?: (path: string) => Promise<string | null>;
  } = {},
): Promise<UserServiceRuntimeStatus> {
  const platform = options.platform ?? process.platform;
  const unitPath =
    options.unitPath ??
    join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
      'systemd',
      'user',
      'easyeda-mcp-pro.service',
    );
  if (platform !== 'linux') {
    return { applicable: false, installed: false, unitPath, issues: [] };
  }

  const installed =
    options.unitText !== undefined ? options.unitText !== null : existsSync(unitPath);
  if (!installed) return { applicable: true, installed: false, unitPath, issues: [] };

  const unitText = options.unitText ?? readFileSync(unitPath, 'utf8');
  const execStart = parseSystemdExecStart(unitText);
  const issues: string[] = [];
  if (!execStart) {
    issues.push('User service has no ExecStart command.');
    return { applicable: true, installed: true, unitPath, issues };
  }

  const nodePath = firstCommandToken(execStart);
  if (!nodePath) {
    issues.push('User service ExecStart command could not be parsed.');
    return { applicable: true, installed: true, unitPath, execStart, issues };
  }

  const executableExists = options.executableExists ?? existsSync;
  const nodePathExists = executableExists(nodePath);
  if (!nodePathExists) {
    issues.push(`ExecStart Node executable does not exist: ${nodePath}.`);
    if (/^Restart=on-failure$/m.test(unitText)) {
      issues.push('Restart=on-failure can turn this missing executable into a restart loop.');
    }
    return {
      applicable: true,
      installed: true,
      unitPath,
      execStart,
      nodePath,
      nodePathExists,
      nodeVersion: null,
      nodeSupported: false,
      issues,
    };
  }

  const readNodeVersion =
    options.readNodeVersion ??
    (async (path: string) => {
      try {
        const { stdout } = await execFileAsync(path, ['--version']);
        return stdout.trim().replace(/^v/, '');
      } catch {
        return null;
      }
    });
  const nodeVersion = await readNodeVersion(nodePath);
  const nodeSupported = nodeVersion ? evaluateNodeRuntime(nodeVersion).supported : false;
  if (!nodeVersion) issues.push(`Unable to read Node.js version from ${nodePath}.`);
  else if (!nodeSupported)
    issues.push(`User service requires Node.js 24.x but ${nodePath} reports ${nodeVersion}.`);

  return {
    applicable: true,
    installed: true,
    unitPath,
    execStart,
    nodePath,
    nodePathExists,
    nodeVersion,
    nodeSupported,
    issues,
  };
}

export async function createDoctorReport(
  packageRoot = resolvePackageRoot(),
  options: CreateDoctorReportOptions = {},
): Promise<DoctorReport> {
  const setup = getLocalSetupInfo(packageRoot, options.nodeEnv);
  const installationMode = setup.installationMode ?? 'source-checkout';
  const pnpmRequired = installationMode === 'source-checkout';
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

  let pnpmVersion: string | null = null;
  if (pnpmRequired) {
    if (Object.hasOwn(options, 'pnpmVersion')) {
      pnpmVersion = options.pnpmVersion ?? null;
    } else {
      try {
        const { stdout } = await execFileAsync(pnpmExecutableForPlatform(process.platform), [
          '--version',
        ]);
        pnpmVersion = stdout.trim();
      } catch {
        // A missing package manager is reported only for source-checkout workflows.
      }
    }
  }

  const nodeEvaluation = evaluateNodeRuntime(process.versions.node);
  const pnpmEvaluation = evaluatePnpmRuntime(pnpmVersion);
  const userServiceRuntime = await inspectUserServiceRuntime();

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
    installationMode,
    nodeVersion: process.versions.node,
    nodeSupported: nodeEvaluation.supported,
    pnpmVersion,
    pnpmSupported: !pnpmRequired || pnpmEvaluation.supported,
    pnpmRequired,
    userServiceRuntime,
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
    fixes.push(
      `Node.js ${report.nodeVersion} is not supported (required: 24.x; pinned: ${PINNED_NODE_VERSION}).`,
      `  Fix: nvm install ${PINNED_NODE_VERSION} && nvm use ${PINNED_NODE_VERSION}   (or install the pinned Node.js runtime from https://nodejs.org)`,
    );
  }

  const pnpmRequired = report.pnpmRequired ?? true;
  const installationMode = report.installationMode ?? 'source-checkout';

  if (pnpmRequired && !report.pnpmSupported) {
    fixes.push(
      report.pnpmVersion
        ? `pnpm ${report.pnpmVersion} is not supported (required: ${PINNED_PNPM_VERSION}).`
        : 'pnpm was not found on PATH.',
      '  Fix: corepack enable',
      `  Fix: corepack prepare pnpm@${PINNED_PNPM_VERSION} --activate`,
    );
  }

  if (report.userServiceRuntime?.installed && report.userServiceRuntime.issues.length > 0) {
    fixes.push(
      ...report.userServiceRuntime.issues,
      '  Fix: systemctl --user disable --now easyeda-mcp-pro.service',
      '  Fix: Rerun your MCP client setup under the supported Node.js runtime; do not preserve a stale absolute ExecStart path.',
    );
  }

  if (!report.envValid) {
    fixes.push('Environment configuration is invalid:');
    for (const issue of report.envIssues) {
      fixes.push(`  Fix: set/correct ${issue}`);
    }
  }

  for (const issue of report.setup.artifactIssues ?? []) {
    fixes.push(`Runtime artifact issue: ${issue}`);
  }

  const serverEntryValid = report.setup.serverEntryValid ?? report.setup.serverEntryExists;
  if (!serverEntryValid) {
    fixes.push(
      pnpmRequired
        ? '  Fix: pnpm build'
        : `  Fix: reinstall the npm package or container image for the ${installationMode}.`,
    );
  }

  const extensionPackageValid =
    report.setup.extensionPackageValid ?? report.setup.extensionPackageExists;
  if (!extensionPackageValid) {
    fixes.push(
      pnpmRequired
        ? '  Fix: pnpm build:extension'
        : `  Fix: reinstall the npm package or container image for the ${installationMode}.`,
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

export function doctorExitCode(report: DoctorReport): 0 | 1 {
  const pnpmRequired = report.pnpmRequired ?? true;
  const serverEntryValid = report.setup.serverEntryValid ?? report.setup.serverEntryExists;
  const extensionPackageValid =
    report.setup.extensionPackageValid ?? report.setup.extensionPackageExists;

  return report.nodeSupported &&
    (!pnpmRequired || report.pnpmSupported) &&
    report.envValid &&
    serverEntryValid &&
    extensionPackageValid
    ? 0
    : 1;
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
  const installationMode = report.installationMode ?? 'source-checkout';
  const pnpmRequired = report.pnpmRequired ?? true;
  let pnpmLine = `pnpm: NOT REQUIRED (${installationMode})`;
  if (pnpmRequired) {
    let pnpmStatus = 'MISSING';
    if (report.pnpmVersion) pnpmStatus = report.pnpmSupported ? 'OK' : 'UNSUPPORTED';
    const pnpmVersionSuffix = report.pnpmVersion ? ` ${report.pnpmVersion}` : '';
    pnpmLine = `pnpm: ${pnpmStatus}${pnpmVersionSuffix} (required for source workflows: ${PINNED_PNPM_VERSION})`;
  }
  const serverEntryValid = report.setup.serverEntryValid ?? report.setup.serverEntryExists;
  const extensionPackageValid =
    report.setup.extensionPackageValid ?? report.setup.extensionPackageExists;

  const lines = [
    'easyeda-mcp-pro doctor',
    '',
    `Runtime mode: ${installationMode}`,
    `Node.js: ${report.nodeSupported ? 'OK' : 'UNSUPPORTED'} ${report.nodeVersion} (required: 24.x; pinned: ${PINNED_NODE_VERSION})`,
    pnpmLine,
    `Environment: ${status(report.envValid)}${report.envIssues.length ? ` ${report.envIssues.join('; ')}` : ''}`,
    `MCP server entry: ${artifactStatus(report.setup.serverEntryExists, serverEntryValid)} ${report.setup.serverEntryPath}`,
    `EasyEDA extension package: ${artifactStatus(report.setup.extensionPackageExists, extensionPackageValid)} ${report.setup.extensionPackagePath}`,
    ...(report.setup.artifactIssues ?? []).map((issue) => `Runtime artifact warning: ${issue}`),
    ...(report.userServiceRuntime?.installed
      ? [
          `User service runtime: ${report.userServiceRuntime.issues.length === 0 ? 'OK' : 'BROKEN'} ${report.userServiceRuntime.nodePath ?? report.userServiceRuntime.execStart ?? report.userServiceRuntime.unitPath}`,
          ...report.userServiceRuntime.issues.map((issue) => `User service warning: ${issue}`),
        ]
      : []),
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

function status(ok: boolean): string {
  return ok ? 'OK' : 'MISSING';
}

function artifactStatus(exists: boolean, valid: boolean): string {
  if (!exists) return 'MISSING';
  return valid ? 'OK' : 'BROKEN';
}

function stringifyConfig(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
