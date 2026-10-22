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

function fakePouredWithFills(id: string, pourId: string, offset = 1) {
  return {
    ...fakePoured(id, pourId),
    getState_PourFills: () => [
      {
        id: 'fill-1',
        lineWidth: 0.2,
        fill: true,
        path: { getSource: () => ['R', offset, -100, 25, 20, 0, 0] },
      },
    ],
  };
}

function createOperations(
  options: {
    pourClass?: Record<string, unknown>;
    pouredClass?: Record<string, unknown>;
    activeError?: Error;
    identityDocuments?: string[] | null;
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
  let identityReads = 0;
  if (options.identityDocuments !== null) {
    const documents = options.identityDocuments ?? ['pcb-one'];
    runtime.DMT_Project = {
      getCurrentProjectInfo: vi.fn(async () => ({ uuid: 'project-1' })),
    };
    runtime.DMT_SelectControl = {
      getCurrentDocumentInfo: vi.fn(async () => ({
        uuid: documents[Math.min(identityReads++, documents.length - 1)],
        parentProjectUuid: 'project-1',
        documentType: 3,
      })),
    };
  }
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
    const poured1 = fakePouredWithFills('poured-1', 'pour-1');
    const poured2 = fakePouredWithFills('poured-2', 'pour-2');
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

  it.each(['object', 'array'] as const)(
    'rejects a mismatched native get() %s before rebuilding any copper',
    async (shape) => {
      const unrelated = fakePour('other-pour', {
        rebuildResult: fakePoured('other-poured', 'other-pour'),
      });
      const get = vi.fn(async () =>
        shape === 'array' ? [unrelated.primitive] : unrelated.primitive,
      );
      const readPoured = vi.fn(async () => []);
      const { operations } = createOperations({
        pourClass: { get, getAll: vi.fn(async () => [unrelated.primitive]) },
        pouredClass: { getAll: readPoured },
      });

      await expect(
        operations.rebuildCopper({ pourIds: ['requested-pour'], net: 'GND', layer: 1 }),
      ).rejects.toThrow('requested-pour');
      expect(get).toHaveBeenCalledExactlyOnceWith('requested-pour');
      expect(unrelated.rebuildCopperRegion).not.toHaveBeenCalled();
      expect(readPoured).not.toHaveBeenCalled();
    },
  );
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

  it('verifies no-copper only when unrelated existing copper stays identical', async () => {
    const pour = fakePour('pour-empty', { rebuildResult: undefined });
    const prior = fakePouredWithFills('existing-poured', 'existing-pour', 8);
    const { operations } = createOperations({
      pourClass: {
        get: vi.fn(async () => pour.primitive),
        getAll: vi.fn(async () => [pour.primitive]),
      },
      pouredClass: { getAll: vi.fn(async () => [prior]) },
    });
    const result = await operations.rebuildCopper({ pourIds: ['pour-empty'] });
    expect(result).toMatchObject({
      success: false,
      noCopperCount: 1,
      results: [{ pourId: 'pour-empty', status: 'no-copper', verified: true }],
    });
    expect(pour.rebuildCopperRegion).toHaveBeenCalledOnce();
  });

  it.each(['changed', 'unexpected', 'unreadable'] as const)(
    'rejects a no-copper return with %s collateral Poured read-back',
    async (mode) => {
      const pour = fakePour('pour-empty', { rebuildResult: undefined });
      const prior = fakePouredWithFills('existing-poured', 'existing-pour', 8);
      const after =
        mode === 'changed'
          ? [fakePouredWithFills('existing-poured', 'existing-pour', 21)]
          : mode === 'unexpected'
            ? [prior, fakePouredWithFills('new-unrelated', 'unrelated-pour', 5)]
            : [fakePoured('existing-poured', 'existing-pour')];
      const { operations } = createOperations({
        pourClass: {
          get: vi.fn(async () => pour.primitive),
          getAll: vi.fn(async () => [pour.primitive]),
        },
        pouredClass: {
          getAll: vi
            .fn<() => Promise<unknown[]>>()
            .mockResolvedValueOnce([prior])
            .mockResolvedValueOnce(after),
        },
      });
      const result = await operations.rebuildCopper({ pourIds: ['pour-empty'] });
      expect(result).toMatchObject({
        success: false,
        attemptedCount: 1,
        rebuiltCount: 0,
        noCopperCount: 0,
        results: [{ pourId: 'pour-empty', status: 'readback-mismatch', verified: false }],
      });
      expect(result.results[0]?.error).toContain('unrelated Poured geometry');
      expect(pour.rebuildCopperRegion).toHaveBeenCalledOnce();
    },
  );

  it('keeps verified no-copper when another batch target rebuilds its own copper', async () => {
    const rebuilt = fakePouredWithFills('poured-first', 'pour-first');
    const pourFirst = fakePour('pour-first', { rebuildResult: rebuilt });
    const pourEmpty = fakePour('pour-empty', { rebuildResult: undefined });
    const { operations } = createOperations({
      pourClass: {
        get: vi.fn(async (id: unknown) =>
          id === 'pour-first' ? pourFirst.primitive : pourEmpty.primitive,
        ),
        getAll: vi.fn(async () => [pourFirst.primitive, pourEmpty.primitive]),
      },
      pouredClass: {
        getAll: vi
          .fn<() => Promise<unknown[]>>()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([rebuilt]),
      },
    });
    const result = await operations.rebuildCopper({
      pourIds: ['pour-first', 'pour-empty'],
    });
    expect(result).toMatchObject({
      success: false,
      attemptedCount: 2,
      rebuiltCount: 1,
      noCopperCount: 1,
      results: [
        { pourId: 'pour-first', status: 'rebuilt', verified: true },
        { pourId: 'pour-empty', status: 'no-copper', verified: true },
      ],
    });
    expect(pourFirst.rebuildCopperRegion).toHaveBeenCalledOnce();
    expect(pourEmpty.rebuildCopperRegion).toHaveBeenCalledOnce();
  });

  it('does not call an id-only Poured readback a successful copper rebuild', async () => {
    const poured = fakePoured('target-id', 'target-id');
    const item = fakePour('target-id', { rebuildResult: poured });
    const { operations } = createOperations({
      pourClass: {
        get: vi.fn(async () => item.primitive),
        getAll: vi.fn(async () => [item.primitive]),
      },
      pouredClass: {
        getAll: vi
          .fn<() => Promise<unknown[]>>()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([poured]),
      },
    });
    const result = await operations.rebuildCopper({ pourIds: ['target-id'] });
    expect(result).toMatchObject({
      success: false,
      rebuiltCount: 0,
      results: [{ pourId: 'target-id', status: 'readback-mismatch', verified: false }],
    });
    expect(result.results[0]?.error).toContain('validated fill geometry');
  });

  it('rejects collateral copper changes even when the native return matches the target', async () => {
    const original = fakePouredWithFills('e336', 'e336', 10);
    const changedOriginal = fakePouredWithFills('e336', 'e336', 11);
    const target = fakePouredWithFills('target-id', 'target-id', 42);
    const pour = fakePour('target-id', { rebuildResult: target });
    const { operations } = createOperations({
      pourClass: {
        get: vi.fn(async () => pour.primitive),
        getAll: vi.fn(async () => [pour.primitive]),
      },
      pouredClass: {
        getAll: vi
          .fn<() => Promise<unknown[]>>()
          .mockResolvedValueOnce([original])
          .mockResolvedValueOnce([changedOriginal, target]),
      },
    });
    const result = await operations.rebuildCopper({ pourIds: ['target-id'] });
    expect(result).toMatchObject({
      success: false,
      rebuiltCount: 0,
      results: [{ status: 'readback-mismatch', verified: false }],
    });
    expect(result.results[0]?.error).toContain('unrelated Poured');
  });

  it('rejects an unexpected new Poured even when the target rebuild is correct', async () => {
    const target = fakePouredWithFills('target-id', 'target-id', 42);
    const pour = fakePour('target-id', { rebuildResult: target });
    const { operations } = createOperations({
      pourClass: {
        get: vi.fn(async () => pour.primitive),
        getAll: vi.fn(async () => [pour.primitive]),
      },
      pouredClass: {
        getAll: vi
          .fn<() => Promise<unknown[]>>()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([target, fakePouredWithFills('surprise', 'surprise', 99)]),
      },
    });
    const result = await operations.rebuildCopper({ pourIds: ['target-id'] });
    expect(result).toMatchObject({
      success: false,
      rebuiltCount: 0,
      results: [{ status: 'readback-mismatch', verified: false }],
    });
  });

  it('fails closed if previous copper geometry cannot be snapshotted', async () => {
    const target = fakePouredWithFills('target-id', 'target-id', 42);
    const pour = fakePour('target-id', { rebuildResult: target });
    const { operations } = createOperations({
      pourClass: {
        get: vi.fn(async () => pour.primitive),
        getAll: vi.fn(async () => [pour.primitive]),
      },
      pouredClass: {
        getAll: vi
          .fn<() => Promise<unknown[]>>()
          .mockResolvedValueOnce([fakePoured('e336', 'e336')])
          .mockResolvedValueOnce([fakePouredWithFills('e336', 'e336'), target]),
      },
    });
    await expect(operations.rebuildCopper({ pourIds: ['target-id'] })).rejects.toThrow(
      'Existing Poured geometry cannot be snapshotted; no copper was rebuilt.',
    );
    expect(pour.rebuildCopperRegion).not.toHaveBeenCalled();
  });

  it('does not write if a pre-existing native fill getter throws', async () => {
    const prior = {
      ...fakePoured('e336', 'e336'),
      getState_PourFills: () => {
        throw new Error('unreadable polygon');
      },
    };
    const target = fakePouredWithFills('target-id', 'target-id', 42);
    const pour = fakePour('target-id', { rebuildResult: target });
    const { operations } = createOperations({
      pourClass: {
        get: vi.fn(async () => pour.primitive),
        getAll: vi.fn(async () => [pour.primitive]),
      },
      pouredClass: { getAll: vi.fn(async () => [prior]) },
    });
    await expect(operations.rebuildCopper({ pourIds: ['target-id'] })).rejects.toThrow(
      'Existing Poured geometry cannot be snapshotted; no copper was rebuilt.',
    );
    expect(pour.rebuildCopperRegion).not.toHaveBeenCalled();
  });

  it('rejects mutation of the same unrelated native object instance on a direct return', async () => {
    let coordinate = 12;
    const original = {
      ...fakePoured('e336', 'e336'),
      getState_PourFills: () => [
        {
          id: 'fill-1',
          lineWidth: 0.2,
          fill: true,
          path: { getSource: () => ['R', coordinate, -90, 32, 20, 0, 0] },
        },
      ],
    };
    const target = fakePouredWithFills('target-id', 'target-id', 42);
    const pour = fakePour('target-id', { rebuildResult: target });
    pour.rebuildCopperRegion.mockImplementation(async () => {
      coordinate = 99;
      return target;
    });
    const { operations } = createOperations({
      pourClass: {
        get: vi.fn(async () => pour.primitive),
        getAll: vi.fn(async () => [pour.primitive]),
      },
      pouredClass: {
        getAll: vi
          .fn<() => Promise<unknown[]>>()
          .mockResolvedValueOnce([original])
          .mockResolvedValueOnce([original, target]),
      },
    });
    const result = await operations.rebuildCopper({ pourIds: ['target-id'] });
    expect(result).toMatchObject({
      success: false,
      rebuiltCount: 0,
      results: [{ status: 'readback-mismatch', verified: false }],
    });
    expect(pour.rebuildCopperRegion).toHaveBeenCalledOnce();
  });

  it('permits unchanged geometry when rebuilding an existing exact target', async () => {
    const target = fakePouredWithFills('target-id', 'target-id', 42);
    const pour = fakePour('target-id', { rebuildResult: target });
    const { operations } = createOperations({
      pourClass: {
        get: vi.fn(async () => pour.primitive),
        getAll: vi.fn(async () => [pour.primitive]),
      },
      pouredClass: {
        getAll: vi
          .fn<() => Promise<unknown[]>>()
          .mockResolvedValueOnce([target])
          .mockResolvedValueOnce([target]),
      },
    });
    const result = await operations.rebuildCopper({ pourIds: ['target-id'] });
    expect(result).toMatchObject({
      success: true,
      rebuiltCount: 1,
      results: [{ status: 'rebuilt', verified: true }],
    });
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

  it.each([
    { caseName: 'with no new poured read-back', includeStaleTarget: false },
    { caseName: 'even with a stale target poured read-back', includeStaleTarget: true },
  ])(
    'rejects a rebuild result associated with another pour $caseName',
    async ({ includeStaleTarget }) => {
      const wrongNativeResult = fakePoured('poured-original', 'pour-original');
      const existingPoured = fakePouredWithFills('poured-original', 'pour-original');
      const targetPoured = fakePoured('poured-target-old', 'pour-target');
      const target = fakePour('pour-target', { rebuildResult: wrongNativeResult });
      const getAllPoured = vi
        .fn<() => Promise<unknown[]>>()
        .mockResolvedValueOnce([existingPoured])
        .mockResolvedValueOnce(
          includeStaleTarget ? [existingPoured, targetPoured] : [existingPoured],
        );
      const { operations } = createOperations({
        pourClass: {
          get: vi.fn(async () => target.primitive),
          getAll: vi.fn(async () => [target.primitive]),
        },
        pouredClass: { getAll: getAllPoured },
      });

      const result = await operations.rebuildCopper({ pourIds: ['pour-target'] });

      expect(result).toMatchObject({
        success: false,
        rebuiltCount: 0,
        results: [
          {
            pourId: 'pour-target',
            pouredId: includeStaleTarget ? 'poured-target-old' : null,
            status: 'readback-mismatch',
            verified: false,
          },
        ],
      });
      expect(result.results[0]?.error).toContain('pour-original');
      expect(result.results[0]?.error).toContain('pour-target');
      expect(target.rebuildCopperRegion).toHaveBeenCalledOnce();
    },
  );

  it('reconciles a wrong beta return only when independent new copper and unchanged existing fills prove the target', async () => {
    const existing = fakePouredWithFills('e336', 'e336', 12);
    const newlyFilled = fakePouredWithFills('target-id', 'target-id', 42);
    const pour = fakePour('target-id', { rebuildResult: existing });
    const getAllPoured = vi
      .fn<() => Promise<unknown[]>>()
      .mockResolvedValueOnce([existing])
      .mockResolvedValueOnce([existing, newlyFilled]);
    const { operations } = createOperations({
      identityDocuments: ['pcb-one', 'pcb-one'],
      pourClass: {
        get: vi.fn(async () => pour.primitive),
        getAll: vi.fn(async () => [pour.primitive]),
      },
      pouredClass: { getAll: getAllPoured },
    });

    const result = await operations.rebuildCopper({ pourIds: ['target-id'] });
    expect(result).toMatchObject({
      success: true,
      rebuiltCount: 1,
      results: [
        {
          pourId: 'target-id',
          pouredId: 'target-id',
          status: 'rebuilt',
          verified: true,
          warning: expect.stringContaining('independent'),
        },
      ],
    });
    expect(pour.rebuildCopperRegion).toHaveBeenCalledOnce();
    expect(getAllPoured).toHaveBeenCalledTimes(2);
  });

  it('accepts a native complex polygon with two paths and copper-edge line segments', async () => {
    const existing = fakePouredWithFills('e336', 'e336', 12);
    const derived = {
      ...fakePoured('target-id', 'target-id'),
      getState_PourFills: () => [
        {
          id: 'fill-region',
          lineWidth: 0,
          fill: true,
          path: {
            getSource: () => [
              [242.4, -221.6, 'L', 242.4, -180.4, 291.9, -180.4],
              [243.1, -211.6, 'L', 244.1, -211.6, 246.1, -201.6],
            ],
          },
        },
        {
          id: 'outline-line',
          lineWidth: 1,
          fill: false,
          path: { getSource: () => [270.6, -192.9, 'L', 270.6, -197.1] },
        },
      ],
    };
    const pour = fakePour('target-id', { rebuildResult: existing });
    const { operations } = createOperations({
      identityDocuments: ['pcb-one', 'pcb-one'],
      pourClass: {
        get: vi.fn(async () => pour.primitive),
        getAll: vi.fn(async () => [pour.primitive]),
      },
      pouredClass: {
        getAll: vi
          .fn<() => Promise<unknown[]>>()
          .mockResolvedValueOnce([existing])
          .mockResolvedValueOnce([existing, derived]),
      },
    });
    const result = await operations.rebuildCopper({ pourIds: ['target-id'] });
    expect(result).toMatchObject({
      success: true,
      rebuiltCount: 1,
      results: [{ pourId: 'target-id', status: 'rebuilt', verified: true }],
    });
  });

  it('rejects a malformed nested copper path rather than treating an ID as physical geometry', async () => {
    const existing = fakePouredWithFills('e336', 'e336', 12);
    const malformed = {
      ...fakePoured('target-id', 'target-id'),
      getState_PourFills: () => [
        {
          id: 'malformed',
          lineWidth: 0,
          fill: true,
          path: { getSource: () => [[1, 2, 'L']] },
        },
      ],
    };
    const pour = fakePour('target-id', { rebuildResult: existing });
    const { operations } = createOperations({
      identityDocuments: ['pcb-one', 'pcb-one'],
      pourClass: {
        get: vi.fn(async () => pour.primitive),
        getAll: vi.fn(async () => [pour.primitive]),
      },
      pouredClass: {
        getAll: vi
          .fn<() => Promise<unknown[]>>()
          .mockResolvedValueOnce([existing])
          .mockResolvedValueOnce([existing, malformed]),
      },
    });
    expect(await operations.rebuildCopper({ pourIds: ['target-id'] })).toMatchObject({
      success: false,
      results: [{ status: 'readback-mismatch', verified: false }],
    });
  });

  it.each([
    {
      scenario: 'previously present target Poured (stale fill)',
      before: [
        fakePouredWithFills('e336', 'e336', 12),
        fakePouredWithFills('target-id', 'target-id', 42),
      ],
      after: [
        fakePouredWithFills('e336', 'e336', 12),
        fakePouredWithFills('target-id', 'target-id', 42),
      ],
      docs: ['pcb-one', 'pcb-one'],
    },
    {
      scenario: 'unrelated copper changed shape',
      before: [fakePouredWithFills('e336', 'e336', 12)],
      after: [
        fakePouredWithFills('e336', 'e336', 20),
        fakePouredWithFills('target-id', 'target-id', 42),
      ],
      docs: ['pcb-one', 'pcb-one'],
    },
    {
      scenario: 'an extra unrelated fill was created',
      before: [fakePouredWithFills('e336', 'e336', 12)],
      after: [
        fakePouredWithFills('e336', 'e336', 12),
        fakePouredWithFills('target-id', 'target-id', 42),
        fakePouredWithFills('other', 'other', 30),
      ],
      docs: ['pcb-one', 'pcb-one'],
    },
    {
      scenario: 'target fill is empty or unverifiable',
      before: [fakePouredWithFills('e336', 'e336', 12)],
      after: [fakePouredWithFills('e336', 'e336', 12), fakePoured('target-id', 'target-id')],
      docs: ['pcb-one', 'pcb-one'],
    },
    {
      scenario: 'focused PCB changed during the rebuild',
      before: [fakePouredWithFills('e336', 'e336', 12)],
      after: [
        fakePouredWithFills('e336', 'e336', 12),
        fakePouredWithFills('target-id', 'target-id', 42),
      ],
      docs: ['pcb-one', 'pcb-one', 'pcb-one', 'pcb-two'],
    },
  ])('fails closed when $scenario', async ({ before, after, docs }) => {
    const existing = before.find((item) => item.getState_PourPrimitiveId() === 'e336');
    const pour = fakePour('target-id', { rebuildResult: existing });
    const { operations } = createOperations({
      identityDocuments: docs,
      pourClass: {
        get: vi.fn(async () => pour.primitive),
        getAll: vi.fn(async () => [pour.primitive]),
      },
      pouredClass: {
        getAll: vi
          .fn<() => Promise<unknown[]>>()
          .mockResolvedValueOnce(before)
          .mockResolvedValueOnce(after),
      },
    });
    const result = await operations.rebuildCopper({ pourIds: ['target-id'] });
    expect(result.success).toBe(false);
    expect(result.rebuiltCount).toBe(0);
    expect(result.results[0]).toMatchObject({
      status: 'readback-mismatch',
      verified: false,
    });
  });

  it('detects unrelated copper mutated in place despite the same native object reference', async () => {
    let originalX = 12;
    const existing = {
      ...fakePoured('e336', 'e336'),
      getState_PourFills: () => [
        {
          id: 'e1',
          lineWidth: 0.2,
          fill: true,
          path: { getSource: () => ['R', originalX, -100, 25, 20, 0, 0] },
        },
      ],
    };
    const target = fakePouredWithFills('target-id', 'target-id', 42);
    const pour = fakePour('target-id', { rebuildResult: existing });
    pour.rebuildCopperRegion.mockImplementation(async () => {
      originalX = 90;
      return existing;
    });
    const getAllPoured = vi
      .fn<() => Promise<unknown[]>>()
      .mockResolvedValueOnce([existing])
      .mockResolvedValueOnce([existing, target]);
    const { operations } = createOperations({
      identityDocuments: ['pcb-one', 'pcb-one'],
      pourClass: {
        get: vi.fn(async () => pour.primitive),
        getAll: vi.fn(async () => [pour.primitive]),
      },
      pouredClass: { getAll: getAllPoured },
    });
    const result = await operations.rebuildCopper({ pourIds: ['target-id'] });
    expect(result).toMatchObject({
      success: false,
      rebuiltCount: 0,
      results: [{ status: 'readback-mismatch', verified: false }],
    });
  });

  it('rejects wrong native identity if project and document APIs are unavailable', async () => {
    const existing = fakePouredWithFills('e336', 'e336', 12);
    const target = fakePouredWithFills('target-id', 'target-id', 42);
    const pour = fakePour('target-id', { rebuildResult: existing });
    const { operations } = createOperations({
      identityDocuments: null,
      pourClass: {
        get: vi.fn(async () => pour.primitive),
        getAll: vi.fn(async () => [pour.primitive]),
      },
      pouredClass: {
        getAll: vi
          .fn<() => Promise<unknown[]>>()
          .mockResolvedValueOnce([existing])
          .mockResolvedValueOnce([existing, target]),
      },
    });
    await expect(operations.rebuildCopper({ pourIds: ['target-id'] })).rejects.toThrow(
      'Active PCB project/document identity unavailable',
    );
    expect(pour.rebuildCopperRegion).not.toHaveBeenCalled();
  });

  it('rejects a project/document change during preflight without native writes', async () => {
    const item = fakePour('target-id', { rebuildResult: fakePoured('target-id', 'target-id') });
    const { operations } = createOperations({
      identityDocuments: ['pcb-one', 'pcb-two'],
      pourClass: {
        get: vi.fn(async () => item.primitive),
        getAll: vi.fn(async () => [item.primitive]),
      },
      pouredClass: { getAll: vi.fn(async () => []) },
    });
    await expect(operations.rebuildCopper({ pourIds: ['target-id'] })).rejects.toThrow(
      'Active PCB changed during copper rebuild preflight',
    );
    expect(item.rebuildCopperRegion).not.toHaveBeenCalled();
  });

  it('fails closed after a document switch even for an exact native return and read-back', async () => {
    const target = fakePoured('target-id', 'target-id');
    const item = fakePour('target-id', { rebuildResult: target });
    const { operations } = createOperations({
      identityDocuments: ['pcb-one', 'pcb-one', 'pcb-one', 'pcb-two'],
      pourClass: {
        get: vi.fn(async () => item.primitive),
        getAll: vi.fn(async () => [item.primitive]),
      },
      pouredClass: {
        getAll: vi
          .fn<() => Promise<unknown[]>>()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([target]),
      },
    });
    const result = await operations.rebuildCopper({ pourIds: ['target-id'] });
    expect(result).toMatchObject({
      success: false,
      rebuiltCount: 0,
      results: [{ status: 'readback-mismatch', verified: false, pouredId: null }],
    });
    expect(result.results[0]?.error).toContain('identity changed');
    expect(item.rebuildCopperRegion).toHaveBeenCalledOnce();
  });

  it('preserves the actual native error after the focused PCB changes', async () => {
    const pour = fakePour('target-id', { rebuildError: new Error('native operation failed') });
    const { operations } = createOperations({
      identityDocuments: ['pcb-one', 'pcb-one', 'pcb-one', 'pcb-two'],
      pourClass: {
        get: vi.fn(async () => pour.primitive),
        getAll: vi.fn(async () => [pour.primitive]),
      },
      pouredClass: { getAll: vi.fn(async () => []) },
    });
    const result = await operations.rebuildCopper({ pourIds: ['target-id'] });
    expect(result).toMatchObject({
      success: false,
      attemptedCount: 1,
      results: [{ status: 'error', verified: false, error: 'native operation failed' }],
    });
    expect(pour.rebuildCopperRegion).toHaveBeenCalledOnce();
  });

  it('stops a multi-target rebuild before writing to a switched PCB', async () => {
    const first = fakePour('pour-1', { rebuildResult: fakePoured('pour-1', 'pour-1') });
    const second = fakePour('pour-2', { rebuildResult: fakePoured('pour-2', 'pour-2') });
    const { operations } = createOperations({
      // Initial, pre-write, first native target = pcb-one; next target is pcb-two.
      identityDocuments: ['pcb-one', 'pcb-one', 'pcb-one', 'pcb-two'],
      pourClass: {
        get: vi.fn(async () => undefined),
        getAll: vi.fn(async () => [first.primitive, second.primitive]),
      },
      pouredClass: {
        getAll: vi
          .fn<() => Promise<unknown[]>>()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([fakePoured('pour-1', 'pour-1')]),
      },
    });
    const result = await operations.rebuildCopper({ net: 'GND' });
    expect(result).toMatchObject({
      success: false,
      matchedCount: 2,
      attemptedCount: 1,
      rebuiltCount: 0,
      transactionCovered: false,
    });
    expect(first.rebuildCopperRegion).toHaveBeenCalledOnce();
    expect(second.rebuildCopperRegion).not.toHaveBeenCalled();
    expect(result.results).toMatchObject([
      { pourId: 'pour-1', status: 'readback-mismatch', verified: false },
      { pourId: 'pour-2', status: 'error', verified: false },
    ]);
    expect(result.results[1]?.error).toContain('was not invoked');
    expect(result.results.every((item) => !item.verified)).toBe(true);
  });

  it('does not count an ambiguous native timeout as success even when derived copper appeared', async () => {
    const item = fakePour('target-id', { rebuildError: new Error('native rebuild timed out') });
    const { operations, deletePrimitives } = createOperations({
      pourClass: {
        get: vi.fn(async () => item.primitive),
        getAll: vi.fn(async () => [item.primitive]),
      },
      pouredClass: {
        getAll: vi
          .fn<() => Promise<unknown[]>>()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([fakePouredWithFills('target-id', 'target-id', 42)]),
      },
    });
    const result = await operations.rebuildCopper({ pourIds: ['target-id'] });
    expect(result).toMatchObject({
      success: false,
      attemptedCount: 1,
      rebuiltCount: 0,
      transactionCovered: false,
      results: [{ status: 'error', verified: false, error: 'native rebuild timed out' }],
    });
    expect(item.rebuildCopperRegion).toHaveBeenCalledOnce();
    expect(deletePrimitives).not.toHaveBeenCalled();
  });

  it('blocks a second native write after a failed or timed-out rebuild', async () => {
    const item = fakePour('target-id', { rebuildError: new Error('native rebuild timed out') });
    const { operations } = createOperations({
      pourClass: {
        get: vi.fn(async () => item.primitive),
        getAll: vi.fn(async () => [item.primitive]),
      },
      pouredClass: { getAll: vi.fn(async () => []) },
    });

    expect((await operations.rebuildCopper({ pourIds: ['target-id'] })).success).toBe(false);
    await expect(operations.rebuildCopper({ pourIds: ['target-id'] })).rejects.toThrow(
      'previous native PCB copper rebuild ended without complete verification',
    );
    expect(item.rebuildCopperRegion).toHaveBeenCalledOnce();
  });

  it('blocks a second write after ambiguous derived copper read-back', async () => {
    const item = fakePour('target-id', { rebuildResult: fakePoured('target-id', 'target-id') });
    const { operations } = createOperations({
      pourClass: {
        get: vi.fn(async () => item.primitive),
        getAll: vi.fn(async () => [item.primitive]),
      },
      pouredClass: { getAll: vi.fn(async () => []) },
    });

    const first = await operations.rebuildCopper({ pourIds: ['target-id'] });
    expect(first).toMatchObject({
      success: false,
      results: [{ verified: false }],
    });
    await expect(operations.rebuildCopper({ pourIds: ['target-id'] })).rejects.toThrow(
      'Inspect and reconcile the PCB independently',
    );
    expect(item.rebuildCopperRegion).toHaveBeenCalledOnce();
  });

  it('allows another explicit write after fully verified no-copper without side effects', async () => {
    const item = fakePour('target-id', { rebuildResult: undefined });
    const { operations } = createOperations({
      pourClass: {
        get: vi.fn(async () => item.primitive),
        getAll: vi.fn(async () => [item.primitive]),
      },
      pouredClass: { getAll: vi.fn(async () => []) },
    });

    expect((await operations.rebuildCopper({ pourIds: ['target-id'] })).results[0]).toMatchObject({
      status: 'no-copper',
      verified: true,
    });
    expect((await operations.rebuildCopper({ pourIds: ['target-id'] })).results[0]).toMatchObject({
      status: 'no-copper',
      verified: true,
    });
    expect(item.rebuildCopperRegion).toHaveBeenCalledTimes(2);
  });

  it('rejects concurrent rebuilds while an unresolved native call is in flight', async () => {
    let resolveNative!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      resolveNative = resolve;
    });
    const native = fakePouredWithFills('target-id', 'target-id');
    const item = fakePour('target-id', { rebuildResult: native });
    item.rebuildCopperRegion.mockImplementation(() => pending);
    const { operations, deletePrimitives } = createOperations({
      pourClass: {
        get: vi.fn(async () => item.primitive),
        getAll: vi.fn(async () => [item.primitive]),
      },
      pouredClass: {
        getAll: vi
          .fn<() => Promise<unknown[]>>()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([native])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([native]),
      },
    });
    const first = operations.rebuildCopper({ pourIds: ['target-id'] });
    // Reaching the first native call is necessary to prove the lock covers awaits.
    await vi.waitFor(() => expect(item.rebuildCopperRegion).toHaveBeenCalledOnce());
    await expect(operations.rebuildCopper({ pourIds: ['target-id'] })).rejects.toThrow(
      'already in progress',
    );
    expect(item.rebuildCopperRegion).toHaveBeenCalledOnce();
    resolveNative(native);
    expect((await first).success).toBe(true);
    expect(deletePrimitives).not.toHaveBeenCalled();
    // Lock is released after completion. A subsequent explicit invocation can run.
    expect((await operations.rebuildCopper({ pourIds: ['target-id'] })).success).toBe(true);
    expect(item.rebuildCopperRegion).toHaveBeenCalledTimes(2);
  });

  it('releases the lock if native preflight rejects without writes', async () => {
    const item = fakePour('target-id', {
      rebuildResult: fakePouredWithFills('target-id', 'target-id'),
    });
    const { operations } = createOperations({
      pourClass: {
        get: vi.fn(async () => item.primitive),
        getAll: vi.fn(async () => [item.primitive]),
      },
      pouredClass: {
        getAll: vi
          .fn<() => Promise<unknown[]>>()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([fakePouredWithFills('target-id', 'target-id')]),
      },
    });
    await expect(operations.rebuildCopper({ pourIds: ['missing'] })).rejects.toThrow('missing');
    expect((await operations.rebuildCopper({ pourIds: ['target-id'] })).success).toBe(true);
    expect(item.rebuildCopperRegion).toHaveBeenCalledOnce();
  });

  it('stops after a native rebuild error and reports already-attempted work only', async () => {
    const poured1 = fakePouredWithFills('poured-1', 'pour-1');
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
