import { describe, expect, it, vi } from 'vitest';
import {
  extractCreatedPrimitiveId,
  rollbackEasyedaTransaction,
  type TransactionBridgeCaller,
} from '../../../src/transactions/easyeda.js';
import { TransactionManager } from '../../../src/transactions/manager.js';
import { snapshotForHash, stableHash } from '../../../src/transactions/stable.js';

describe('extractCreatedPrimitiveId', () => {
  it('accepts a direct native UUID string', () => {
    expect(extractCreatedPrimitiveId('primitive-uuid')).toBe('primitive-uuid');
  });

  it('finds IDs in nested normalized bridge results', () => {
    expect(extractCreatedPrimitiveId({ result: { data: { PrimitiveId: 'nested-id' } } })).toBe(
      'nested-id',
    );
  });

  it('finds the first addressable result in arrays', () => {
    expect(extractCreatedPrimitiveId([null, { text: { uuid: 'text-id' } }])).toBe('text-id');
  });

  it('returns undefined for non-addressable create results', () => {
    expect(extractCreatedPrimitiveId({ ok: true })).toBeUndefined();
  });
});

const groundSnapshot = (id: string) => ({
  schemaVersion: 'schematic-primitive-snapshot/v1',
  primitiveId: id,
  primitiveKind: 'netflag',
  componentType: 'netflag',
  property: {
    identification: 'Ground',
    net: 'GND',
    name: 'GND',
    nativeSymbol: {
      name: 'Ground-GND',
      libraryUuid: '0819f05c4eef4c71ace90d822a990e87',
      uuid: 'af20086a8911a85a',
    },
    x: 240,
    y: 250,
    rotation: 0,
    mirror: false,
  },
  nativeContext: { projectId: 'project-1', documentId: 'page-1', editorVersion: '4.1.105' },
  nativeIsolation: {
    kind: 'verified-disconnected-ground/v2',
    markerId: id,
    componentCount: 2,
    wireCount: 0,
    pagePinCount: 0,
    embeddedPinCount: 1,
    attributeCount: 38,
    attributeFingerprint: 'a'.repeat(64),
  },
});

async function exerciseGroundRollback(after: ReturnType<typeof groundSnapshot>) {
  const manager = new TransactionManager();
  const transaction = manager.begin({ documentId: 'project-1' });
  const original = groundSnapshot('flag-old');
  let exists = true;
  await manager.runDelete(transaction.id, 'flag-old', {
    getSnapshot: async () => original,
    apply: async () => {
      exists = false;
      return { deleted: ['flag-old'] };
    },
    exists: async () => exists,
    recreate: async () => {
      throw new Error('not needed during apply');
    },
  });
  const calls: { method: string; params: unknown }[] = [];
  const bridge = {
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === 'schematic.recreatePrimitiveSnapshot') {
        return { primitiveId: 'flag-new', snapshot: after };
      }
      if (method === 'schematic.getPrimitiveSnapshot') return after;
      throw new Error('Unexpected bridge method ' + method);
    }),
  } as unknown as TransactionBridgeCaller;
  return {
    manager,
    transaction,
    calls,
    result: await rollbackEasyedaTransaction(manager, transaction.id, bridge),
  };
}

describe('native-scoped Ground rollback reconciliation', () => {
  it('does not normalize a forged isolation report bound to another marker', () => {
    const baseline = groundSnapshot('flag-old');
    const mismatched = {
      ...baseline,
      nativeIsolation: { ...baseline.nativeIsolation, markerId: 'unrelated-marker' },
    };
    expect(stableHash(snapshotForHash(mismatched, 'ignore-primitive-id'))).not.toBe(
      stableHash(snapshotForHash(baseline, 'ignore-primitive-id')),
    );
  });

  it('accepts a different restored primitive ID only with matching native context and isolation', async () => {
    const result = await exerciseGroundRollback(groundSnapshot('flag-new'));
    expect(result.result.transaction).toMatchObject({
      state: 'rolled-back',
      rollbackComplete: true,
      operations: [
        expect.objectContaining({
          kind: 'delete',
          restoredTargetId: 'flag-new',
          compensation: 'restored',
        }),
      ],
    });
    expect(result.calls).toContainEqual({
      method: 'schematic.getPrimitiveSnapshot',
      params: { primitiveId: 'flag-new', expectedPrimitiveKind: 'netflag' },
    });
  });

  it.each([
    {
      label: 'changed electrical net',
      replacement: { property: { ...groundSnapshot('flag-new').property, net: 'VCC' } },
    },
    {
      label: 'different native schematic',
      replacement: {
        nativeContext: {
          projectId: 'project-1',
          documentId: 'page-other',
          editorVersion: '4.1.105',
        },
      },
    },
    { label: 'missing native isolation evidence', replacement: { nativeIsolation: undefined } },
    {
      label: 'changed normalized native attributes despite matching counts',
      replacement: {
        nativeIsolation: {
          ...groundSnapshot('flag-new').nativeIsolation,
          attributeFingerprint: 'b'.repeat(64),
        },
      },
    },
    {
      label: 'connected native topology',
      replacement: {
        nativeIsolation: { ...groundSnapshot('flag-new').nativeIsolation, wireCount: 1 },
      },
    },
    {
      label: 'unrelated primitive returned by the exact-ID native read',
      replacement: { primitiveId: 'other-primitive' },
    },
  ])('does not declare rollback success with $label', async ({ replacement }) => {
    const after = { ...groundSnapshot('flag-new'), ...replacement } as ReturnType<
      typeof groundSnapshot
    >;
    await expect(exerciseGroundRollback(after)).rejects.toMatchObject({
      code: 'TRANSACTION_ROLLBACK_FAILED',
      details: expect.objectContaining({
        transaction: expect.objectContaining({ state: 'failed', rollbackComplete: false }),
      }),
    });
  });
});

const wireSnapshot = (id: string, line: number[], net = '') => ({
  schemaVersion: 'schematic-primitive-snapshot/v1',
  primitiveId: id,
  primitiveKind: 'wire',
  property: { line, net, color: null, lineWidth: null, lineType: null },
});

async function exerciseWireRollback(after: ReturnType<typeof wireSnapshot>) {
  const manager = new TransactionManager();
  const transaction = manager.begin({ documentId: 'disposable-v4-project' });
  const original = wireSnapshot('4d5afa64f162eaa5', [280, 250, 240, 250]);
  let exists = true;
  await manager.runDelete(transaction.id, original.primitiveId, {
    getSnapshot: async () => original,
    apply: async () => {
      exists = false;
      return { deleted: [original.primitiveId] };
    },
    exists: async () => exists,
    recreate: async () => {
      throw new Error('Only the later explicit rollback may recreate');
    },
  });
  const calls: Array<{ method: string; params: unknown }> = [];
  const bridge = {
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === 'schematic.recreatePrimitiveSnapshot')
        return { primitiveId: '88218eb202488086', snapshot: after };
      if (method === 'schematic.getPrimitiveSnapshot') return after;
      throw new Error('Unexpected native bridge method ' + method);
    }),
  } as unknown as TransactionBridgeCaller;
  return { result: await rollbackEasyedaTransaction(manager, transaction.id, bridge), calls };
}

describe('wire orientation after native rollback', () => {
  it('preserves the exact live V4 raw before-hash while comparing endpoint-reversed wires equally', () => {
    const original = wireSnapshot('4d5afa64f162eaa5', [280, 250, 240, 250]);
    const { primitiveId: _primitiveId, ...raw } = original;
    expect(stableHash(raw)).toBe(
      '4e9f04e391fb450d249e95e2ab311891658136d39e0a6ad4f2763924a20edbe1',
    );
    const restored = wireSnapshot('88218eb202488086', [240, 250, 280, 250]);
    expect(stableHash(snapshotForHash(original, 'ignore-primitive-id'))).toBe(
      stableHash(snapshotForHash(restored, 'ignore-primitive-id')),
    );
  });

  it('restores an identical two-point wire when native V4 reverses the line and rotates the ID', async () => {
    const restored = wireSnapshot('88218eb202488086', [240, 250, 280, 250]);
    const { result, calls } = await exerciseWireRollback(restored);
    expect(result.transaction).toMatchObject({
      state: 'rolled-back',
      rollbackComplete: true,
      operations: [
        expect.objectContaining({
          kind: 'delete',
          restoredTargetId: '88218eb202488086',
          compensation: 'restored',
        }),
      ],
    });
    expect(calls).toContainEqual({
      method: 'schematic.getPrimitiveSnapshot',
      params: { primitiveId: '88218eb202488086' },
    });
  });

  it.each([
    { label: 'a changed endpoint', property: { line: [241, 250, 280, 250] } },
    { label: 'a different net', property: { net: 'VCC' } },
    { label: 'a different color', property: { color: '#ff0000' } },
    { label: 'a different width', property: { lineWidth: 3 } },
    { label: 'a different line type', property: { lineType: 1 } },
  ])('refuses to report successful rollback with $label', async ({ property }) => {
    const base = wireSnapshot('88218eb202488086', [240, 250, 280, 250]);
    const after = { ...base, property: { ...base.property, ...property } };
    await expect(exerciseWireRollback(after)).rejects.toMatchObject({
      code: 'TRANSACTION_ROLLBACK_FAILED',
      details: expect.objectContaining({
        transaction: expect.objectContaining({ state: 'failed', rollbackComplete: false }),
      }),
    });
  });

  it('does not guess that a reversed multi-point route preserves segment topology', () => {
    const old = wireSnapshot('old', [10, 10, 20, 10, 20, 20]);
    const changed = wireSnapshot('new', [20, 20, 20, 10, 10, 10]);
    expect(stableHash(snapshotForHash(old, 'ignore-primitive-id'))).not.toBe(
      stableHash(snapshotForHash(changed, 'ignore-primitive-id')),
    );
  });

  it('does not accept a different exact native primitive ID even if the geometry matches', async () => {
    const different = wireSnapshot('wrong', [240, 250, 280, 250]);
    await expect(exerciseWireRollback(different)).rejects.toMatchObject({
      code: 'TRANSACTION_ROLLBACK_FAILED',
    });
  });
});
