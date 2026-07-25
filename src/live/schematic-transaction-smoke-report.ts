import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface SchematicTransactionFixtureIdentity {
  project: string;
  schematic: string;
  page: string;
  disposable: true;
}

export interface SchematicTransactionStateDigest {
  primitiveInventoryHash: string;
  componentHash: string;
  netHash: string;
  ercAvailable: boolean;
  ercHash?: string;
}

export interface SchematicTransactionOutcome {
  passed: boolean;
  rolledBack: boolean;
  stateRestored: boolean;
  details?: Record<string, unknown>;
}

export interface SchematicTransactionSmokeInput {
  generatedAt?: string;
  environment: {
    operatingSystem: string;
    architecture: string;
    nodeVersion: string;
  };
  fixture: SchematicTransactionFixtureIdentity;
  bridge: {
    easyedaVersion?: string;
    bridgeVersion?: string;
    dispatcherBuildId?: string;
    methodRegistryHash?: string;
    activePort?: number;
  };
  outcomes: {
    createRollback: SchematicTransactionOutcome;
    modifyRollback: SchematicTransactionOutcome;
    deleteRollback: SchematicTransactionOutcome;
  };
  cleanup: {
    remainingIds: string[];
    errors: string[];
  };
  baseline: SchematicTransactionStateDigest;
  finalState: SchematicTransactionStateDigest;
  error?: string;
}

export type SchematicTransactionSmokeCheckId =
  'create-rollback' | 'modify-rollback' | 'delete-rollback' | 'final-state-restored';

export interface SchematicTransactionSmokeCheck {
  id: SchematicTransactionSmokeCheckId;
  status: 'passed' | 'failed';
  details: Record<string, unknown>;
}

export interface SchematicTransactionSmokeReport {
  schemaVersion: 1;
  status: 'passed' | 'failed';
  generatedAt: string;
  environment: SchematicTransactionSmokeInput['environment'];
  fixture: SchematicTransactionFixtureIdentity;
  bridge: SchematicTransactionSmokeInput['bridge'];
  checks: SchematicTransactionSmokeCheck[];
  cleanup: {
    clean: boolean;
    remainingIds: string[];
    errors: string[];
  };
  baseline: SchematicTransactionStateDigest;
  finalState: SchematicTransactionStateDigest;
  error?: string;
}

function outcomeCheck(
  id: Exclude<SchematicTransactionSmokeCheckId, 'final-state-restored'>,
  outcome: SchematicTransactionOutcome,
): SchematicTransactionSmokeCheck {
  const passed = outcome.passed && outcome.rolledBack && outcome.stateRestored;
  return {
    id,
    status: passed ? 'passed' : 'failed',
    details: {
      passed: outcome.passed,
      rolledBack: outcome.rolledBack,
      stateRestored: outcome.stateRestored,
      ...(outcome.details ?? {}),
    },
  };
}

export function compareSchematicTransactionState(
  baseline: SchematicTransactionStateDigest,
  finalState: SchematicTransactionStateDigest,
): Record<string, boolean> {
  const ercComparable = baseline.ercAvailable && finalState.ercAvailable;
  return {
    primitiveInventoryHashEqual:
      baseline.primitiveInventoryHash === finalState.primitiveInventoryHash,
    componentHashEqual: baseline.componentHash === finalState.componentHash,
    netHashEqual: baseline.netHash === finalState.netHash,
    ercComparable,
    ercStateEqual: !ercComparable || baseline.ercHash === finalState.ercHash,
  };
}

export function buildSchematicTransactionSmokeReport(
  input: SchematicTransactionSmokeInput,
): SchematicTransactionSmokeReport {
  const finalComparison = compareSchematicTransactionState(input.baseline, input.finalState);
  const finalStatePassed =
    finalComparison.primitiveInventoryHashEqual &&
    finalComparison.componentHashEqual &&
    finalComparison.netHashEqual &&
    finalComparison.ercStateEqual;
  const checks: SchematicTransactionSmokeCheck[] = [
    outcomeCheck('create-rollback', input.outcomes.createRollback),
    outcomeCheck('modify-rollback', input.outcomes.modifyRollback),
    outcomeCheck('delete-rollback', input.outcomes.deleteRollback),
    {
      id: 'final-state-restored',
      status: finalStatePassed ? 'passed' : 'failed',
      details: finalComparison,
    },
  ];
  const cleanup = {
    clean: input.cleanup.remainingIds.length === 0 && input.cleanup.errors.length === 0,
    remainingIds: [...input.cleanup.remainingIds],
    errors: [...input.cleanup.errors],
  };
  const status =
    checks.every((check) => check.status === 'passed') && cleanup.clean && !input.error
      ? 'passed'
      : 'failed';

  return {
    schemaVersion: 1,
    status,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    environment: input.environment,
    fixture: input.fixture,
    bridge: input.bridge,
    checks,
    cleanup,
    baseline: input.baseline,
    finalState: input.finalState,
    ...(input.error ? { error: input.error } : {}),
  };
}

export async function writeSchematicTransactionSmokeReport(
  path: string,
  report: SchematicTransactionSmokeReport,
): Promise<void> {
  const absolutePath = resolve(path);
  await mkdir(dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, absolutePath);
}
