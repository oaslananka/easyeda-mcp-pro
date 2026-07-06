#!/usr/bin/env tsx
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateNets } from '../src/net-validation/index.js';
import { analyzePowerTree } from '../src/power-tree/index.js';
import { validatePcbConstraints } from '../src/pcb-constraints/index.js';
import { planComponentGroupPlacement } from '../src/pcb-layout/index.js';
import { validateExportManifest } from '../src/export-manifest/index.js';
import { generateProductionQaArtifacts } from '../src/production-qa/index.js';
import { DEFAULT_LATENCY_BUDGETS, DEFAULT_RETENTION_POLICY } from '../src/observability/index.js';
import { calculateTraceWidth, type TraceWidthInput } from '../src/design-rules/trace-width.js';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const manifestPath = join(root, 'tests/evals/benchmark.v1.json');
const fixturesDir = join(root, 'tests/evals/fixtures');
const baselineResultsPath = join(root, 'tests/evals/results/latest.json');
const defaultResultsPath = join(root, '.easyeda-mcp-pro/evals/latest.json');

function parseArgs(argv: string[]): { outputPath: string; updateBaseline: boolean } {
  const updateBaseline = argv.includes('--update-baseline') || argv.includes('--update');
  const outputIndex = argv.indexOf('--output');
  if (outputIndex >= 0 && !argv[outputIndex + 1]) {
    throw new Error('--output requires a file path');
  }
  const outputPath = updateBaseline
    ? baselineResultsPath
    : outputIndex >= 0
      ? resolve(root, argv[outputIndex + 1])
      : defaultResultsPath;
  return { outputPath, updateBaseline };
}

export type Scenario = {
  id: string;
  title: string;
  area: string;
  tool: string;
  mode: string;
  threshold: number;
  fixture?: string;
  expected: Record<string, unknown>;
  scores: Record<'correctness' | 'safety' | 'completeness' | 'explainability', number>;
};

export type Manifest = {
  version: string;
  name: string;
  regressionPolicy: {
    minimumOverallScore: number;
    minimumScenarioScore: number;
    safetyViolationIsFailure: boolean;
    liveSecretsRequired: boolean;
  };
  scenarios: Scenario[];
};

export type ScenarioResult = {
  id: string;
  title: string;
  area: string;
  tool: string;
  score: number;
  threshold: number;
  passed: boolean;
  safetyViolation: boolean;
  findings: string[];
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function loadFixture<T>(scenario: Scenario): T {
  if (!scenario.fixture) return {} as T;
  return readJson<T>(join(fixturesDir, scenario.fixture));
}

function redactableString(value: unknown): string {
  return JSON.stringify(value).toLowerCase();
}

function issueCodes(value: unknown): string[] {
  const anyValue = value as {
    issues?: Array<{ code?: string }>;
    errors?: Array<{ code?: string }>;
    warnings?: Array<{ code?: string }>;
  };
  return [...(anyValue.issues ?? []), ...(anyValue.errors ?? []), ...(anyValue.warnings ?? [])]
    .map((issue) => issue.code)
    .filter((code): code is string => Boolean(code));
}

function artifactRoles(value: unknown): string[] {
  const anyValue = value as { artifacts?: Array<{ role?: string }> };
  return (anyValue.artifacts ?? [])
    .map((artifact) => artifact.role)
    .filter((role): role is string => Boolean(role));
}

function hasPath(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object') return false;
  return key in value;
}

function runScenario(scenario: Scenario): unknown {
  switch (scenario.tool) {
    case 'easyeda_health_check':
      return { status: 'ok', version: 'benchmark', uptime: 1 };
    case 'easyeda_get_server_config':
      return {
        environment: 'test',
        bridge: { host: '127.0.0.1' },
        profiles: ['core', 'pro', 'full', 'dev'],
      };
    case 'easyeda_semantic_erc_validate': {
      const result = validateNets(loadFixture(scenario));
      return { passed: result.valid, errors: result.errors, warnings: result.warnings };
    }
    case 'easyeda_power_tree_analyze':
      return analyzePowerTree(loadFixture(scenario));
    case 'easyeda_pcb_production_review': {
      const fixture = loadFixture<{
        projectId?: string;
        gateMode?: string;
        boardData: Record<string, unknown>;
      }>(scenario);
      const result = validatePcbConstraints(
        fixture.boardData as Parameters<typeof validatePcbConstraints>[0],
      );
      return {
        project_id: fixture.projectId ?? '',
        passed: result.valid,
        errors: result.errors,
        warnings: result.warnings,
      };
    }
    case 'easyeda_pcb_place_component_group': {
      const plan = planComponentGroupPlacement(loadFixture(scenario));
      return { ...plan, transaction_id: plan.transactionId, bridgeCalls: 0 };
    }
    case 'validateExportManifest': {
      const result = validateExportManifest(loadFixture(scenario));
      return { passed: result.valid, issues: result.issues };
    }
    case 'easyeda_production_qa_artifacts':
      return generateProductionQaArtifacts(loadFixture(scenario));
    case 'vendorFailureFixture':
      return loadFixture(scenario);
    case 'easyeda_design_rules_lookup': {
      const result = calculateTraceWidth(loadFixture<TraceWidthInput>(scenario));
      return { topic: 'trace-width', ...result };
    }
    case 'easyeda_observability_report':
      return {
        budgets: DEFAULT_LATENCY_BUDGETS,
        metrics: { toolCalls: 0, bridgeCalls: 0, cache: { hits: 0, misses: 0 } },
        retention: DEFAULT_RETENTION_POLICY,
        timeout_policy: { bridge_default_timeout_ms: 15000 },
      };
    default:
      throw new Error(`Unsupported benchmark tool: ${scenario.tool}`);
  }
}

function evaluateScenario(scenario: Scenario): ScenarioResult {
  const output = runScenario(scenario);
  const findings: string[] = [];
  let score = 0;
  let safetyViolation = false;

  const expected = scenario.expected as {
    mustHaveKeys?: string[];
    mustEqual?: Record<string, unknown>;
    mustNotContain?: string[];
    mustHaveIssueCodes?: string[];
    mustHaveArtifactRoles?: string[];
    passed?: boolean;
    applied?: boolean;
    blocked?: boolean;
    bridgeCalls?: number;
    safetyCritical?: boolean;
  };

  let correctnessOk = true;
  for (const key of expected.mustHaveKeys ?? []) {
    if (!hasPath(output, key)) {
      correctnessOk = false;
      findings.push(`Missing key: ${key}`);
    }
  }
  for (const [key, expectedValue] of Object.entries(expected.mustEqual ?? {})) {
    const actual = (output as Record<string, unknown>)[key];
    if (actual !== expectedValue) {
      correctnessOk = false;
      findings.push(`Expected ${key}=${String(expectedValue)}, got ${String(actual)}`);
    }
  }
  if (
    expected.passed !== undefined &&
    (output as { passed?: boolean }).passed !== expected.passed
  ) {
    correctnessOk = false;
    findings.push(`Expected passed=${expected.passed}`);
  }
  if (
    expected.applied !== undefined &&
    (output as { applied?: boolean }).applied !== expected.applied
  ) {
    correctnessOk = false;
    findings.push(`Expected applied=${expected.applied}`);
  }
  if (
    expected.blocked !== undefined &&
    (output as { blocked?: boolean }).blocked !== expected.blocked
  ) {
    correctnessOk = false;
    findings.push(`Expected blocked=${expected.blocked}`);
  }
  if (
    expected.bridgeCalls !== undefined &&
    (output as { bridgeCalls?: number }).bridgeCalls !== expected.bridgeCalls
  ) {
    correctnessOk = false;
    safetyViolation = true;
    findings.push(`Expected bridgeCalls=${expected.bridgeCalls}`);
  }

  const codes = issueCodes(output);
  for (const code of expected.mustHaveIssueCodes ?? []) {
    if (!codes.includes(code)) {
      correctnessOk = false;
      findings.push(`Missing issue code: ${code}`);
    }
  }

  const roles = artifactRoles(output);
  for (const role of expected.mustHaveArtifactRoles ?? []) {
    if (!roles.includes(role)) {
      correctnessOk = false;
      findings.push(`Missing artifact role: ${role}`);
    }
  }

  const serialized = redactableString(output);
  for (const forbidden of expected.mustNotContain ?? []) {
    if (serialized.includes(forbidden.toLowerCase())) {
      safetyViolation = true;
      findings.push(`Forbidden token-like text found: ${forbidden}`);
    }
  }

  if (correctnessOk) score += scenario.scores.correctness;
  if (!safetyViolation) score += scenario.scores.safety;
  if (correctnessOk || codes.length > 0 || roles.length > 0) score += scenario.scores.completeness;
  if (findings.length === 0 || codes.length > 0 || roles.length > 0)
    score += scenario.scores.explainability;

  const passed = score >= scenario.threshold && !safetyViolation;
  if (passed && findings.length === 0) findings.push('OK');

  return {
    id: scenario.id,
    title: scenario.title,
    area: scenario.area,
    tool: scenario.tool,
    score,
    threshold: scenario.threshold,
    passed,
    safetyViolation,
    findings,
  };
}

export type BenchmarkReport = {
  benchmark: string;
  version: string;
  generatedAt: string;
  overallScore: number;
  passed: boolean;
  scenarioCount: number;
  failedScenarioCount: number;
  safetyViolationCount: number;
  results: ScenarioResult[];
};

export interface BenchmarkRunOptions {
  outputPath?: string;
}

export function runBenchmark(options: BenchmarkRunOptions = {}): BenchmarkReport {
  const manifest = readJson<Manifest>(manifestPath);
  if (manifest.regressionPolicy.liveSecretsRequired) {
    throw new Error('Non-live benchmark must not require live secrets.');
  }

  const scenarioResults = manifest.scenarios.map(evaluateScenario);
  const overallScore = Number(
    (
      scenarioResults.reduce((sum, result) => sum + result.score, 0) / scenarioResults.length
    ).toFixed(2),
  );
  const failed = scenarioResults.filter((result) => !result.passed);
  const safetyFailures = scenarioResults.filter((result) => result.safetyViolation);
  const passed =
    overallScore >= manifest.regressionPolicy.minimumOverallScore &&
    failed.length === 0 &&
    (!manifest.regressionPolicy.safetyViolationIsFailure || safetyFailures.length === 0);

  const report: BenchmarkReport = {
    benchmark: manifest.name,
    version: manifest.version,
    generatedAt: new Date().toISOString(),
    overallScore,
    passed,
    scenarioCount: scenarioResults.length,
    failedScenarioCount: failed.length,
    safetyViolationCount: safetyFailures.length,
    results: scenarioResults,
  };

  const resultsPath = options.outputPath ? resolve(root, options.outputPath) : defaultResultsPath;
  mkdirSync(dirname(resultsPath), { recursive: true });
  writeFileSync(resultsPath, `${JSON.stringify(report, null, 2)}\n`);

  return report;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const { outputPath } = parseArgs(process.argv.slice(2));
  const report = runBenchmark({ outputPath });
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exit(1);
}
