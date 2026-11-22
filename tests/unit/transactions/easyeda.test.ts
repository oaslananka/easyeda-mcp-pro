import { describe, expect, it, vi } from 'vitest';
import {
  extractCreatedPrimitiveId,
  recreatePrimitiveSnapshot,
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

describe('native Ground immediate compensation readback', () => {
  it('does not use the unscoped result of the create call as rollback evidence', async () => {
    const original = groundSnapshot('flag-old');
    const {
      nativeContext: _context,
      nativeIsolation: _isolation,
      ...unscoped
    } = groundSnapshot('flag-new');
    const restored = groundSnapshot('flag-new');
    const call = vi.fn(async (method: string) =>
      method === 'schematic.recreatePrimitiveSnapshot'
        ? { primitiveId: 'flag-new', snapshot: unscoped }
        : restored,
    );
    const bridge = { call } as unknown as TransactionBridgeCaller;
    await expect(recreatePrimitiveSnapshot(bridge, original)).resolves.toEqual({
      primitiveId: 'flag-new',
      snapshot: restored,
    });
    expect(call).toHaveBeenLastCalledWith('schematic.getPrimitiveSnapshot', {
      primitiveId: 'flag-new',
      expectedPrimitiveKind: 'netflag',
    });
  });

  it('refuses a different primitive in the independent typed readback', async () => {
    const call = vi.fn(async (method: string) =>
      method === 'schematic.recreatePrimitiveSnapshot'
        ? { primitiveId: 'flag-new', snapshot: groundSnapshot('flag-new') }
        : groundSnapshot('wrong-id'),
    );
    await expect(
      recreatePrimitiveSnapshot(
        { call } as unknown as TransactionBridgeCaller,
        groundSnapshot('flag-old'),
      ),
    ).rejects.toThrow(/identity/i);
  });
});

describe('independent drawing primitive compensation readback', () => {
  const deletedWire = {
    schemaVersion: 'schematic-primitive-snapshot/v1',
    primitiveId: 'wire-old',
    primitiveKind: 'wire',
    property: { line: [0, 0, 10, 0], net: 'N1', color: null },
  };
  const claimedWire = { ...deletedWire, primitiveId: 'wire-restored' };

  it('does not trust a recreation response when fresh native wire net differs', async () => {
    const actualWire = {
      ...claimedWire,
      property: { ...claimedWire.property, net: 'VCC' },
    };
    const call = vi.fn(async (method: string) =>
      method === 'schematic.recreatePrimitiveSnapshot'
        ? { primitiveId: 'wire-restored', snapshot: claimedWire }
        : actualWire,
    );
    const bridge = { call } as unknown as TransactionBridgeCaller;
    await expect(recreatePrimitiveSnapshot(bridge, deletedWire)).resolves.toEqual({
      primitiveId: 'wire-restored',
      snapshot: actualWire,
    });
    expect(call).toHaveBeenLastCalledWith('schematic.getPrimitiveSnapshot', {
      primitiveId: 'wire-restored',
    });
  });

  it('rejects a matching create response when native get returns another primitive ID', async () => {
    const call = vi.fn(async (method: string) =>
      method === 'schematic.recreatePrimitiveSnapshot'
        ? { primitiveId: 'wire-restored', snapshot: claimedWire }
        : { ...claimedWire, primitiveId: 'unrelated-id' },
    );
    await expect(
      recreatePrimitiveSnapshot({ call } as unknown as TransactionBridgeCaller, deletedWire),
    ).rejects.toThrow(/identity/i);
    expect(call).toHaveBeenCalledWith('schematic.getPrimitiveSnapshot', {
      primitiveId: 'wire-restored',
    });
  });

  it.each([
    { label: 'the native read is missing', native: undefined },
    {
      label: 'the native class changed',
      native: {
        ...{ schemaVersion: 'schematic-primitive-snapshot/v1', primitiveId: 'wire-restored' },
        primitiveKind: 'rectangle',
        property: { line: [0, 0, 10, 0], net: 'N1' },
      },
    },
  ])('refuses restoration when $label', async ({ native }) => {
    const call = vi.fn(async (method: string) =>
      method === 'schematic.recreatePrimitiveSnapshot'
        ? { primitiveId: 'wire-restored', snapshot: claimedWire }
        : native,
    );
    await expect(
      recreatePrimitiveSnapshot({ call } as unknown as TransactionBridgeCaller, deletedWire),
    ).rejects.toThrow(/identity|type/i);
    expect(call).toHaveBeenCalledWith('schematic.getPrimitiveSnapshot', {
      primitiveId: 'wire-restored',
    });
  });

  it('never marks failed-delete compensation restored solely from a claimed create snapshot', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'project-1' });
    const nativeWire = {
      ...claimedWire,
      property: { ...claimedWire.property, net: 'changed-after-recreate' },
    };
    const bridge = {
      call: vi.fn(async (method: string) =>
        method === 'schematic.recreatePrimitiveSnapshot'
          ? { primitiveId: 'wire-restored', snapshot: claimedWire }
          : nativeWire,
      ),
    } as unknown as TransactionBridgeCaller;
    let exists = true;
    await expect(
      manager.runDelete(transaction.id, deletedWire.primitiveId, {
        getSnapshot: async () => deletedWire,
        apply: async () => {
          exists = false;
          throw new Error('native response uncertain after successful deletion');
        },
        exists: async () => exists,
        recreate: async (snapshot) => {
          const recreated = await recreatePrimitiveSnapshot(bridge, snapshot);
          return { targetId: recreated.primitiveId, snapshot: recreated.snapshot };
        },
      }),
    ).rejects.toMatchObject({
      code: 'TRANSACTION_OPERATION_FAILED',
      details: expect.objectContaining({ compensation: 'failed' }),
    });
    expect(manager.get(transaction.id)).toMatchObject({
      state: 'failed',
      operations: [expect.objectContaining({ state: 'failed', compensation: 'failed' })],
    });
  });
});

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

describe('scoped schematic deletion rollback', () => {
  async function scopedDeletedWire(bridgePage: string) {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'project-1' });
    const original = wireSnapshot('wire-old', [0, 0, 10, 0], 'N1');
    const restored = wireSnapshot('wire-new', [0, 0, 10, 0], 'N1');
    await manager.runDelete(transaction.id, 'wire-old', {
      nativeSchematicScope: { projectId: 'project-1', documentId: 'page-1' },
      getSnapshot: async () => original,
      apply: async () => ({ deleted: ['wire-old'] }),
      exists: async () => false,
      recreate: async () => {
        throw new Error('Rollback is caller-managed in this test');
      },
    });
    const call = vi.fn(async (method: string, params: any) => {
      if (method === 'api.read') {
        if (params.path === 'DMT_Project.getCurrentProjectInfo')
          return { result: { uuid: 'project-1' } };
        if (params.path === 'DMT_SelectControl.getCurrentDocumentInfo')
          return { result: { uuid: bridgePage, parentProjectUuid: 'project-1', documentType: 1 } };
      }
      if (method === 'schematic.recreatePrimitiveSnapshot')
        return { primitiveId: 'wire-new', snapshot: restored };
      if (method === 'schematic.getPrimitiveSnapshot') return restored;
      throw new Error('Unexpected bridge method ' + method);
    });
    return { manager, transaction, call, bridge: { call } as unknown as TransactionBridgeCaller };
  }

  it('does not recreate a deleted wire in a different focused page', async () => {
    const { manager, transaction, call, bridge } = await scopedDeletedWire('page-2');
    await expect(rollbackEasyedaTransaction(manager, transaction.id, bridge)).rejects.toMatchObject(
      {
        code: 'TRANSACTION_ROLLBACK_FAILED',
      },
    );
    expect(call).not.toHaveBeenCalledWith('schematic.recreatePrimitiveSnapshot', expect.anything());
    expect(manager.get(transaction.id)).toMatchObject({
      state: 'failed',
      rollbackComplete: false,
    });
  });

  it('recreates on the same page with a native-bound project/document target', async () => {
    const { manager, transaction, call, bridge } = await scopedDeletedWire('page-1');
    const result = await rollbackEasyedaTransaction(manager, transaction.id, bridge);
    expect(result.transaction).toMatchObject({ state: 'rolled-back', rollbackComplete: true });
    expect(call).toHaveBeenCalledWith('schematic.recreatePrimitiveSnapshot', {
      snapshot: wireSnapshot('wire-old', [0, 0, 10, 0], 'N1'),
      expectedProjectUuid: 'project-1',
      expectedSchematicPageUuid: 'page-1',
    });
  });
});

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
