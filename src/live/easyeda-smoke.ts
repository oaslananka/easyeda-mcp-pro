import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type BridgeManager } from '../bridge/manager.js';
import { type BridgeHello } from '../bridge/protocol.js';

export type LiveSmokeStatus = 'skipped' | 'passed' | 'failed';
export type LiveSmokeCheckKind = 'bridge' | 'schematic' | 'bom' | 'design' | 'system';

export interface LiveSmokeConfig {
  enabled: boolean;
  projectId: string;
  writeEnabled: boolean;
  outputPath: string;
  timeoutMs: number;
}

export interface LiveSmokeCheck {
  id: string;
  title: string;
  kind: LiveSmokeCheckKind;
  method: string;
  params: Record<string, unknown>;
  mutates: boolean;
  requiredForReadOnly: boolean;
}

export interface LiveSmokeCheckResult {
  id: string;
  title: string;
  kind: LiveSmokeCheckKind;
  method: string;
  status: 'passed' | 'failed';
  durationMs: number;
  mutates: boolean;
  error?: string;
}

export interface LiveSmokeReport {
  status: LiveSmokeStatus;
  generatedAt: string;
  projectId: string;
  easyedaVersion?: string;
  bridgeVersion?: string;
  methodRegistryHash?: string;
  writeEnabled: boolean;
  checks: LiveSmokeCheckResult[];
  skippedReason?: string;
}

export function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function parseLiveSmokeConfig(env: Record<string, string | undefined>): LiveSmokeConfig {
  return {
    enabled: parseBooleanEnv(env.EASYEDA_LIVE_TESTS),
    projectId: env.EASYEDA_TEST_PROJECT_ID?.trim() ?? '',
    writeEnabled: parseBooleanEnv(env.EASYEDA_LIVE_WRITE_TESTS),
    outputPath: env.EASYEDA_LIVE_REPORT_PATH?.trim() || '.easyeda-mcp-pro/live-smoke-report.json',
    timeoutMs: Number.parseInt(env.EASYEDA_LIVE_TIMEOUT_MS ?? '30000', 10),
  };
}

export function validateLiveSmokeConfig(config: LiveSmokeConfig): string[] {
  const errors: string[] = [];
  if (config.enabled && !config.projectId) {
    errors.push('EASYEDA_TEST_PROJECT_ID is required when EASYEDA_LIVE_TESTS=true.');
  }
  if (
    !Number.isFinite(config.timeoutMs) ||
    config.timeoutMs < 1_000 ||
    config.timeoutMs > 120_000
  ) {
    errors.push('EASYEDA_LIVE_TIMEOUT_MS must be between 1000 and 120000.');
  }
  return errors;
}

export function buildLiveSmokeChecks(config: LiveSmokeConfig): LiveSmokeCheck[] {
  const projectParams = { projectId: config.projectId };
  const checks: LiveSmokeCheck[] = [
    {
      id: 'system_status',
      title: 'Read EasyEDA bridge system status',
      kind: 'system',
      method: 'system.getStatus',
      params: {},
      mutates: false,
      requiredForReadOnly: true,
    },
    {
      id: 'api_inventory',
      title: 'Read EasyEDA runtime API inventory',
      kind: 'system',
      method: 'system.apiInventory',
      params: {},
      mutates: false,
      requiredForReadOnly: true,
    },
    {
      id: 'schematic_nets',
      title: 'List schematic nets',
      kind: 'schematic',
      method: 'schematic.listNets',
      params: projectParams,
      mutates: false,
      requiredForReadOnly: true,
    },
    {
      id: 'schematic_components',
      title: 'List schematic components',
      kind: 'schematic',
      method: 'schematic.listComponents',
      params: projectParams,
      mutates: false,
      requiredForReadOnly: true,
    },
    {
      id: 'bom_generate',
      title: 'Generate BOM snapshot',
      kind: 'bom',
      method: 'bom.generate',
      params: { ...projectParams, format: 'json', groupBy: 'value' },
      mutates: false,
      requiredForReadOnly: true,
    },
    {
      id: 'erc_check',
      title: 'Run ERC check',
      kind: 'design',
      method: 'design.erc',
      params: projectParams,
      mutates: false,
      requiredForReadOnly: true,
    },
  ];

  if (config.writeEnabled) {
    checks.push({
      id: 'project_save',
      title: 'Save test project after explicit live write opt-in',
      kind: 'bridge',
      method: 'project.save',
      params: projectParams,
      mutates: true,
      requiredForReadOnly: false,
    });
  }

  return checks;
}

export function skippedLiveSmokeReport(reason: string, config: LiveSmokeConfig): LiveSmokeReport {
  return {
    status: 'skipped',
    generatedAt: new Date().toISOString(),
    projectId: config.projectId,
    writeEnabled: config.writeEnabled,
    checks: [],
    skippedReason: reason,
  };
}

export async function runLiveSmokeChecks(
  bridge: Pick<BridgeManager, 'connect' | 'disconnect' | 'call' | 'hello' | 'methodRegistryHash'>,
  config: LiveSmokeConfig,
): Promise<LiveSmokeReport> {
  const errors = validateLiveSmokeConfig(config);
  if (!config.enabled) return skippedLiveSmokeReport('EASYEDA_LIVE_TESTS is not enabled.', config);
  if (errors.length > 0) throw new Error(errors.join(' '));

  await bridge.connect();
  const hello = bridge.hello as BridgeHello | null;
  const results: LiveSmokeCheckResult[] = [];

  try {
    for (const check of buildLiveSmokeChecks(config)) {
      const startedAt = Date.now();
      try {
        await bridge.call(check.method, check.params, { timeoutMs: config.timeoutMs });
        results.push({
          id: check.id,
          title: check.title,
          kind: check.kind,
          method: check.method,
          status: 'passed',
          durationMs: Date.now() - startedAt,
          mutates: check.mutates,
        });
      } catch (error) {
        results.push({
          id: check.id,
          title: check.title,
          kind: check.kind,
          method: check.method,
          status: 'failed',
          durationMs: Date.now() - startedAt,
          mutates: check.mutates,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    bridge.disconnect('live smoke complete');
  }

  return {
    status: results.every((result) => result.status === 'passed') ? 'passed' : 'failed',
    generatedAt: new Date().toISOString(),
    projectId: config.projectId,
    easyedaVersion: hello?.easyedaVersion,
    bridgeVersion: hello?.bridgeVersion,
    methodRegistryHash: hello?.methodRegistryHash ?? bridge.methodRegistryHash,
    writeEnabled: config.writeEnabled,
    checks: results,
  };
}

export async function writeLiveSmokeReport(path: string, report: LiveSmokeReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
