import { describe, expect, it, vi } from 'vitest';
import { createPcbMutationOperations } from '../src/pcb-mutation-operations.js';

function fakePour(
  id: string,
  options: {
    net?: string;
    layer?: number;
    rebuildResult?: unknown;
    rebuildError?: Error;
  } = {},
) {
  const rebuildCopperRegion = vi.fn(async () => {
    if (options.rebuildError) throw options.rebuildError;
    return options.rebuildResult;
  });
  return {
    primitive: {
      getState_PrimitiveId: () => id,
      getState_Net: () => options.net ?? 'GND',
      getState_Layer: () => options.layer ?? 1,
      rebuildCopperRegion,
    },
    rebuildCopperRegion,
  };
}

function fakePoured(id: string, pourId: string) {
  return {
    getState_PrimitiveId: () => id,
    getState_PourPrimitiveId: () => pourId,
  };
}

function createOperations(
  options: {
    pourClass?: Record<string, unknown>;
    pouredClass?: Record<string, unknown>;
    activeError?: Error;
  } = {},
) {
  const callFirst = vi.fn(async (_paths: readonly string[], ...args: unknown[]) => ({ args }));
  const deletePrimitives = vi.fn(
    async (ids: string[]): Promise<{ deleted: string[]; notFound: string[] }> => ({
      deleted: ids.filter((id) => id !== 'missing'),
      notFound: ids.filter((id) => id === 'missing'),
    }),
  );
  const runtime: Record<string, unknown> = {
    PCB_PrimitivePour:
      options.pourClass ??
      ({
        get: vi.fn(async () => undefined),
        getAll: vi.fn(async () => []),
      } satisfies Record<string, unknown>),
    PCB_PrimitivePoured:
      options.pouredClass ??
      ({
        getAll: vi.fn(async () => []),
      } satisfies Record<string, unknown>),
  };
  const readFirstPath = <T>(paths: readonly string[]): T | undefined =>
    (runtime[paths[0] ?? ''] ?? runtime[paths[1] ?? '']) as T | undefined;
  const requireActivePcbContext = vi.fn(async () => {
    if (options.activeError) throw options.activeError;
    return { documentId: 'pcb-1' };
  });
  return {
    callFirst,
    deletePrimitives,
    requireActivePcbContext,
    operations: createPcbMutationOperations({
      callFirst,
      readFirstPath,
      requireActivePcbContext,
      deletePrimitives,
    }),
  };
}

describe('createPcbMutationOperations', () => {
  it('fails closed for zone creation without invoking a native method', async () => {
    const { callFirst, operations } = createOperations();

    await expect(
      operations.addZone({
        points: [0, 0, 10, 0, 10, 10],
        layer: 1,
        netName: 'GND',
        clearance: 0.2,
      }),
    ).rejects.toThrow(
      'PCB copper-zone creation is unavailable until the complete native contract is verified.',
    );
    expect(callFirst).not.toHaveBeenCalled();
  });

  it('rebuilds filtered existing pours and verifies them through poured read-back', async () => {
    const poured1 = fakePoured('poured-1', 'pour-1');
    const poured2 = fakePoured('poured-2', 'pour-2');
    const pour1 = fakePour('pour-1', { net: 'GND', layer: 1, rebuildResult: poured1 });
    const pour2 = fakePour('pour-2', { net: 'GND', layer: 1, rebuildResult: poured2 });
    const getAllPours = vi.fn(async () => [pour1.primitive, pour2.primitive]);
    const getAllPoured = vi
      .fn<() => Promise<unknown[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([poured1, poured2]);
    const { operations } = createOperations({
      pourClass: {
        get: vi.fn(async () => undefined),
        getAll: getAllPours,
      },
      pouredClass: { getAll: getAllPoured },
    });

    await expect(operations.rebuildCopper({ net: 'GND', layer: 1 })).resolves.toEqual({
      success: true,
      matchedCount: 2,
      attemptedCount: 2,
      rebuiltCount: 2,
      noCopperCount: 0,
      transactionCovered: false,
      planeZonesSupported: false,
      results: [
        {
          pourId: 'pour-1',
          pouredId: 'poured-1',
          status: 'rebuilt',
          verified: true,
        },
        {
          pourId: 'pour-2',
          pouredId: 'poured-2',
          status: 'rebuilt',
          verified: true,
        },
      ],
    });
    expect(getAllPours).toHaveBeenCalledWith('GND', 1);
    expect(pour1.rebuildCopperRegion).toHaveBeenCalledOnce();
    expect(pour2.rebuildCopperRegion).toHaveBeenCalledOnce();
    expect(getAllPoured).toHaveBeenCalledTimes(2);
  });

  it('resolves every requested id before writing and rejects missing ids with zero rebuilds', async () => {
    const pour1 = fakePour('pour-1', { rebuildResult: fakePoured('poured-1', 'pour-1') });
    const get = vi.fn(async (id: unknown) => (id === 'pour-1' ? pour1.primitive : undefined));
    const { operations } = createOperations({
      pourClass: {
        get,
        getAll: vi.fn(async () => []),
      },
      pouredClass: { getAll: vi.fn(async () => []) },
    });

    await expect(operations.rebuildCopper({ pourIds: ['pour-1', 'missing-pour'] })).rejects.toThrow(
      'missing-pour',
    );
    expect(get).toHaveBeenCalledTimes(2);
    expect(pour1.rebuildCopperRegion).not.toHaveBeenCalled();
  });

  it('reports native undefined as verified no-copper rather than success', async () => {
    const pour = fakePour('pour-empty', { rebuildResult: undefined });
    const get = vi.fn(async () => pour.primitive);
    const getAllPoured = vi.fn(async () => []);
    const { operations } = createOperations({
      pourClass: {
        get,
        getAll: vi.fn(async () => [pour.primitive]),
      },
      pouredClass: { getAll: getAllPoured },
    });

    const result = await operations.rebuildCopper({ pourIds: ['pour-empty'] });

    expect(result).toMatchObject({
      success: false,
      matchedCount: 1,
      attemptedCount: 1,
      rebuiltCount: 0,
      noCopperCount: 1,
      transactionCovered: false,
      planeZonesSupported: false,
      results: [
        {
          pourId: 'pour-empty',
          pouredId: null,
          status: 'no-copper',
          verified: true,
        },
      ],
    });
    expect(result.error).toContain('produced no copper');
  });

  it('fails verification when native and persisted poured ids disagree', async () => {
    const nativePoured = fakePoured('poured-native', 'pour-1');
    const persistedPoured = fakePoured('poured-persisted', 'pour-1');
    const pour = fakePour('pour-1', { rebuildResult: nativePoured });
    const getAllPoured = vi
      .fn<() => Promise<unknown[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([persistedPoured]);
    const { operations } = createOperations({
      pourClass: {
        get: vi.fn(async () => pour.primitive),
        getAll: vi.fn(async () => [pour.primitive]),
      },
      pouredClass: { getAll: getAllPoured },
    });

    const result = await operations.rebuildCopper({ pourIds: ['pour-1'] });

    expect(result).toMatchObject({
      success: false,
      rebuiltCount: 0,
      results: [
        {
          pourId: 'pour-1',
          pouredId: 'poured-persisted',
          status: 'readback-mismatch',
          verified: false,
        },
      ],
    });
    expect(result.results[0]?.error).toContain('poured-native');
    expect(result.results[0]?.error).toContain('poured-persisted');
  });

  it('stops after a native rebuild error and reports already-attempted work only', async () => {
    const poured1 = fakePoured('poured-1', 'pour-1');
    const pour1 = fakePour('pour-1', { rebuildResult: poured1 });
    const pour2 = fakePour('pour-2', { rebuildError: new Error('native rebuild failed') });
    const pour3 = fakePour('pour-3', { rebuildResult: fakePoured('poured-3', 'pour-3') });
    const getAllPoured = vi
      .fn<() => Promise<unknown[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([poured1]);
    const { operations } = createOperations({
      pourClass: {
        get: vi.fn(async () => undefined),
        getAll: vi.fn(async () => [pour1.primitive, pour2.primitive, pour3.primitive]),
      },
      pouredClass: { getAll: getAllPoured },
    });

    const result = await operations.rebuildCopper({ net: 'GND' });

    expect(result.success).toBe(false);
    expect(result.matchedCount).toBe(3);
    expect(result.attemptedCount).toBe(2);
    expect(result.results[0]).toMatchObject({
      pourId: 'pour-1',
      status: 'rebuilt',
      verified: true,
    });
    expect(result.results[1]).toMatchObject({
      pourId: 'pour-2',
      status: 'error',
      verified: false,
      error: 'native rebuild failed',
    });
    expect(pour3.rebuildCopperRegion).not.toHaveBeenCalled();
  });

  it('fails before runtime lookup when there is no active PCB context', async () => {
    const { operations, requireActivePcbContext } = createOperations({
      activeError: new Error('Focus a PCB document before rebuilding copper.'),
    });

    await expect(operations.rebuildCopper({ net: 'GND' })).rejects.toThrow(
      'Focus a PCB document before rebuilding copper.',
    );
    expect(requireActivePcbContext).toHaveBeenCalledOnce();
  });

  it('modifies components with the existing primitive id and property order', async () => {
    const { callFirst, operations } = createOperations();
    const property = { x: 12, y: 34, rotation: 90, layer: 2, primitiveLock: false };

    await operations.modifyComponent({ primitiveId: 'component-1', property });

    expect(callFirst).toHaveBeenCalledWith(
      ['PCB_PrimitiveComponent.modify', 'pcb_PrimitiveComponent.modify'],
      'component-1',
      property,
    );
  });

  it('rejects component fields outside the verified transform allowlist', async () => {
    const { callFirst, operations } = createOperations();

    await expect(
      operations.modifyComponent({
        primitiveId: 'component-1',
        property: { x: 12, manufacturer: 'not-a-transform-field' },
      }),
    ).rejects.toThrow('Unsupported PCB component transform field: manufacturer');
    await expect(
      operations.modifyComponent({ primitiveId: 'component-1', property: { layer: 12 } }),
    ).rejects.toThrow('PCB component layer must be 1 (top) or 2 (bottom)');
    expect(callFirst).not.toHaveBeenCalled();
  });

  it('rejects malformed values for every verified component transform field class', async () => {
    const { callFirst, operations } = createOperations();

    await expect(
      operations.modifyComponent({ primitiveId: 'component-1', property: [] }),
    ).rejects.toThrow('PCB component transform property must be an object');
    await expect(
      operations.modifyComponent({
        primitiveId: 'component-1',
        property: { primitiveLock: 'false' },
      }),
    ).rejects.toThrow('PCB component primitiveLock must be a boolean');
    await expect(
      operations.modifyComponent({ primitiveId: 'component-1', property: { x: Number.NaN } }),
    ).rejects.toThrow('PCB component x must be a finite number');
    await expect(
      operations.modifyComponent({ primitiveId: 'component-1', property: {} }),
    ).rejects.toThrow('PCB component transform must change at least one supported field');
    expect(callFirst).not.toHaveBeenCalled();
  });

  it('normalizes complete and partial deletion results without throwing', async () => {
    const { deletePrimitives, operations } = createOperations();

    await expect(
      operations.deleteComponents({ primitiveIds: ['component-1', 'missing'] }),
    ).resolves.toEqual({
      success: false,
      deletedCount: 1,
      deleted: ['component-1'],
      notFound: ['missing'],
    });
    expect(deletePrimitives).toHaveBeenCalledWith(['component-1', 'missing']);
  });

  it('treats a non-array primitiveIds value as an empty deletion request', async () => {
    const { deletePrimitives, operations } = createOperations();

    await expect(operations.deleteComponents({ primitiveIds: 'component-1' })).resolves.toEqual({
      success: true,
      deletedCount: 0,
      deleted: [],
      notFound: [],
    });
    expect(deletePrimitives).toHaveBeenCalledWith([]);
  });
});
