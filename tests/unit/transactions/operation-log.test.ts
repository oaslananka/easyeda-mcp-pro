import { describe, expect, it } from 'vitest';
import {
  changedPrimitiveIds,
  deterministicOperations,
  operationId,
} from '../../../src/transactions/operation-log.js';
import type {
  OperationLogEntry,
  SchematicOperation,
} from '../../../src/transactions/operation-log.js';

function op(
  overrides: Partial<SchematicOperation> & Pick<SchematicOperation, 'kind'>,
): SchematicOperation {
  const input = overrides.input ?? {};
  return {
    operationId: operationId(overrides.kind, input),
    input,
    ...overrides,
  };
}

function entry(
  overrides: Partial<OperationLogEntry> & Pick<OperationLogEntry, 'operation' | 'result'>,
): OperationLogEntry {
  return {
    sequence: 0,
    groupPath: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

describe('operationId', () => {
  it('is deterministic for the same kind/input/index', () => {
    const input = { ref: 'U1' };
    expect(operationId('placeComponent', input, 2)).toBe(operationId('placeComponent', input, 2));
  });

  it('differs when the index changes', () => {
    const input = { ref: 'U1' };
    expect(operationId('placeComponent', input, 0)).not.toBe(
      operationId('placeComponent', input, 1),
    );
  });

  it('differs when the kind changes', () => {
    const input = { ref: 'U1' };
    expect(operationId('placeComponent', input)).not.toBe(operationId('modifyComponent', input));
  });

  it('is prefixed with op_', () => {
    expect(operationId('addWire', {})).toMatch(/^op_/);
  });
});

describe('deterministicOperations', () => {
  it('sorts operations by kind priority when no explicit order is given', () => {
    const ops = [
      op({ kind: 'deletePrimitive' }),
      op({ kind: 'placeComponent' }),
      op({ kind: 'addWire' }),
    ];
    const sorted = deterministicOperations(ops);
    expect(sorted.map((o) => o.kind)).toEqual(['placeComponent', 'addWire', 'deletePrimitive']);
  });

  it('honors an explicit order over the kind priority', () => {
    const ops = [
      op({ kind: 'deletePrimitive', order: 1 }),
      op({ kind: 'placeComponent', order: 2 }),
    ];
    const sorted = deterministicOperations(ops);
    expect(sorted.map((o) => o.kind)).toEqual(['deletePrimitive', 'placeComponent']);
  });

  it('preserves original relative order for equal priority', () => {
    const a = op({ kind: 'addWire', input: { a: 1 } });
    const b = op({ kind: 'addWire', input: { b: 2 } });
    const sorted = deterministicOperations([b, a]);
    expect(sorted).toEqual([b, a]);
  });

  it('returns an empty array for no operations', () => {
    expect(deterministicOperations([])).toEqual([]);
  });
});

describe('changedPrimitiveIds', () => {
  it('returns empty sets for an empty log', () => {
    expect(changedPrimitiveIds([])).toEqual({ created: [], modified: [], deleted: [] });
  });

  it('collects created ids from result.createdPrimitiveIds', () => {
    const log = [
      entry({
        operation: op({ kind: 'addWire' }),
        result: { success: true, createdPrimitiveIds: ['w2', 'w1'] },
      }),
    ];
    expect(changedPrimitiveIds(log).created).toEqual(['w1', 'w2']);
  });

  it('treats a placeComponent result.primitiveId as created', () => {
    const log = [
      entry({
        operation: op({ kind: 'placeComponent' }),
        result: { success: true, primitiveId: 'c1' },
      }),
    ];
    expect(changedPrimitiveIds(log).created).toEqual(['c1']);
  });

  it('does not treat a non-placeComponent result.primitiveId as created', () => {
    const log = [
      entry({
        operation: op({ kind: 'modifyComponent' }),
        result: { success: true, primitiveId: 'c1' },
      }),
    ];
    expect(changedPrimitiveIds(log).created).toEqual([]);
  });

  it('collects modified and deleted ids and sorts/dedupes across entries', () => {
    const log = [
      entry({
        operation: op({ kind: 'modifyComponent' }),
        result: { success: true, modifiedPrimitiveIds: ['m2'] },
      }),
      entry({
        operation: op({ kind: 'modifyComponent' }),
        result: { success: true, modifiedPrimitiveIds: ['m1', 'm2'] },
      }),
      entry({
        operation: op({ kind: 'deletePrimitive' }),
        result: { success: true, deletedPrimitiveIds: ['d1'] },
      }),
    ];
    const result = changedPrimitiveIds(log);
    expect(result.modified).toEqual(['m1', 'm2']);
    expect(result.deleted).toEqual(['d1']);
  });
});
