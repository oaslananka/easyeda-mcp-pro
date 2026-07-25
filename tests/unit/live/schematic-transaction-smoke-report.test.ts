import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSchematicTransactionSmokeReport,
  writeSchematicTransactionSmokeReport,
  type SchematicTransactionSmokeInput,
} from '../../../src/live/schematic-transaction-smoke-report.js';

function passingInput(): SchematicTransactionSmokeInput {
  return {
    generatedAt: '2026-07-25T03:00:00.000Z',
    environment: {
      operatingSystem: 'Ubuntu 24.04.4 LTS',
      architecture: 'x86_64',
      nodeVersion: '24.18.0',
    },
    fixture: {
      project: 'TestMcp',
      schematic: 'Schematic1',
      page: 'P1',
      disposable: true,
    },
    bridge: {
      easyedaVersion: '3.2.149.88089769',
      bridgeVersion: '0.35.4',
      dispatcherBuildId: 'build-1',
      methodRegistryHash: 'hash-1',
      activePort: 49620,
    },
    outcomes: {
      createRollback: { passed: true, rolledBack: true, stateRestored: true },
      modifyRollback: { passed: true, rolledBack: true, stateRestored: true },
      deleteRollback: { passed: true, rolledBack: true, stateRestored: true },
    },
    cleanup: { remainingIds: [], errors: [] },
    baseline: {
      primitiveInventoryHash: 'primitive-hash',
      componentHash: 'component-hash',
      netHash: 'net-hash',
      ercAvailable: true,
      ercHash: 'erc-hash',
    },
    finalState: {
      primitiveInventoryHash: 'primitive-hash',
      componentHash: 'component-hash',
      netHash: 'net-hash',
      ercAvailable: true,
      ercHash: 'erc-hash',
    },
  };
}

describe('schematic transaction smoke report', () => {
  it('builds a passing report for the disposable fixture and four checks', () => {
    const report = buildSchematicTransactionSmokeReport(passingInput());

    expect(report.schemaVersion).toBe(1);
    expect(report.status).toBe('passed');
    expect(report.fixture).toEqual({
      project: 'TestMcp',
      schematic: 'Schematic1',
      page: 'P1',
      disposable: true,
    });
    expect(report.checks.map((check) => check.id)).toEqual([
      'create-rollback',
      'modify-rollback',
      'delete-rollback',
      'final-state-restored',
    ]);
    expect(report.checks.every((check) => check.status === 'passed')).toBe(true);
    expect(report.cleanup.clean).toBe(true);
    expect(report.cleanup.remainingIds).toEqual([]);
  });

  it('fails final-state restoration when any required hash changes', () => {
    const input = passingInput();
    input.finalState.netHash = 'changed-net-hash';

    const report = buildSchematicTransactionSmokeReport(input);

    expect(report.status).toBe('failed');
    expect(report.checks.find((check) => check.id === 'final-state-restored')).toMatchObject({
      status: 'failed',
      details: { netHashEqual: false },
    });
  });

  it('serializes cleanup errors without hiding the original failure', () => {
    const input = passingInput();
    input.cleanup = {
      remainingIds: ['temporary-1'],
      errors: ['temporary-1: delete failed'],
    };
    input.error = 'Modify rollback smoke failed';

    const report = buildSchematicTransactionSmokeReport(input);

    expect(report.status).toBe('failed');
    expect(report.error).toBe('Modify rollback smoke failed');
    expect(report.cleanup).toEqual({
      clean: false,
      remainingIds: ['temporary-1'],
      errors: ['temporary-1: delete failed'],
    });
  });

  it('writes the report atomically to the requested path', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'easyeda-transaction-report-'));
    const outputPath = join(directory, 'report.json');
    const report = buildSchematicTransactionSmokeReport(passingInput());

    await writeSchematicTransactionSmokeReport(outputPath, report);

    expect(existsSync(outputPath)).toBe(true);
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual(report);
    expect(readdirSync(directory)).toEqual(['report.json']);
  });
});
