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
    kind: 'verified-disconnected-ground/v1',
    markerId: id,
    componentCount: 2,
    wireCount: 0,
    pagePinCount: 0,
    embeddedPinCount: 1,
    attributeCount: 38,
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
