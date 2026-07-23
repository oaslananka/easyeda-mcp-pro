import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPcbReadOperations } from '../src/pcb-read-operations.js';

function makeOperations(runtime: Record<string, unknown> = {}) {
  const requireActivePcbContext = vi.fn(async () => undefined);
  const readFirstPath = vi.fn(<T>(paths: readonly string[]): T | undefined => {
    for (const path of paths) {
      if (path in runtime) return runtime[path] as T;
    }
    return undefined;
  });
  const readState = vi.fn((value: unknown, key: string): unknown => {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    const getter = record[`getState_${key}`];
    if (typeof getter === 'function') return (getter as () => unknown).call(value);
    return record[key];
  });
  return {
    requireActivePcbContext,
    readFirstPath,
    readState,
    operations: createPcbReadOperations({
      requireActivePcbContext,
      readFirstPath,
      readState,
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PCB read operations', () => {
  it('maps components through the live native state fields and paginates safely', async () => {
    const components = [
      {
        getState_PrimitiveId: () => 'c0',
        getState_Designator: () => 'R0',
      },
      {
        getState_PrimitiveId: () => 'c1',
        getState_Designator: () => 'R1',
        getState_Footprint: () => ({ name: 'R0603', uuid: 'fp-1', libraryUuid: 'lib-1' }),
        getState_Component: () => ({ name: 'Resistor' }),
        getState_X: () => 10,
        getState_Y: () => 20,
        getState_Rotation: () => 90,
        getState_Layer: () => 1,
        getState_PrimitiveLock: () => true,
      },
      {
        getState_PrimitiveId: () => 'c2',
        getState_Designator: () => 'R2',
      },
    ];
    const { operations, requireActivePcbContext } = makeOperations({
      PCB_PrimitiveComponent: { getAll: async () => components },
    });

    await expect(operations.listComponents(0, 1)).resolves.toEqual({
      total: 3,
      items: [
        {
          primitiveId: 'c1',
          designator: 'R1',
          footprintName: 'R0603',
          footprintUuid: 'fp-1',
          footprintLibraryUuid: 'lib-1',
          deviceName: 'Resistor',
          x: 10,
          y: 20,
          rotation: 90,
          layer: 1,
          locked: true,
        },
      ],
    });
    expect(requireActivePcbContext).toHaveBeenCalledOnce();
  });

  it('normalizes a null component collection as an empty result', async () => {
    const { operations } = makeOperations({
      PCB_PrimitiveComponent: { getAll: async () => null },
    });

    await expect(operations.listComponents()).resolves.toEqual({ total: 0, items: [] });
  });

  it('uses the lower-case component alias and normalizes missing nested metadata', async () => {
    const { operations } = makeOperations({
      pcb_PrimitiveComponent: {
        getAll: async () => [
          {
            getState_PrimitiveId: () => undefined,
            getState_Designator: () => undefined,
            getState_Footprint: () => undefined,
            getState_Component: () => undefined,
            getState_PrimitiveLock: () => undefined,
          },
        ],
      },
    });

    await expect(operations.listComponents(undefined, -10)).resolves.toEqual({
      total: 1,
      items: [
        {
          primitiveId: '',
          designator: '',
          footprintName: '',
          footprintUuid: '',
          footprintLibraryUuid: '',
          deviceName: '',
          x: undefined,
          y: undefined,
          rotation: undefined,
          layer: undefined,
          locked: false,
        },
      ],
    });
  });

  it('maps tracks from PCB_PrimitiveLine and preserves null collections as empty', async () => {
    const line = {
      getState_PrimitiveId: () => 'line1',
      getState_Net: () => 'GND',
      getState_Layer: () => 1,
      getState_StartX: () => 10,
      getState_StartY: () => 20,
      getState_EndX: () => 30,
      getState_EndY: () => 40,
      getState_LineWidth: () => 5,
      getState_PrimitiveLock: () => false,
    };
    const getAll = vi
      .fn()
      .mockResolvedValueOnce([line])
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([{}]);
    const { operations } = makeOperations({ PCB_PrimitiveLine: { getAll } });

    await expect(operations.listTracks()).resolves.toEqual({
      total: 1,
      items: [
        {
          primitiveId: 'line1',
          net: 'GND',
          layer: 1,
          startX: 10,
          startY: 20,
          endX: 30,
          endY: 40,
          width: 5,
          locked: false,
        },
      ],
    });
    await expect(operations.listTracks()).resolves.toEqual({ total: 0, items: [] });
    await expect(operations.listTracks()).resolves.toEqual({
      total: 1,
      items: [
        {
          primitiveId: '',
          net: '',
          layer: undefined,
          startX: undefined,
          startY: undefined,
          endX: undefined,
          endY: undefined,
          width: undefined,
          locked: false,
        },
      ],
    });
  });

  it('maps vias and applies offset/limit after reading the total', async () => {
    const via = (id: string) => ({
      getState_PrimitiveId: () => id,
      getState_Net: () => 'VCC',
      getState_X: () => 1,
      getState_Y: () => 2,
      getState_HoleDiameter: () => 3,
      getState_Diameter: () => 4,
      getState_PrimitiveLock: () => undefined,
    });
    const getAll = vi
      .fn()
      .mockResolvedValueOnce([via('v0'), via('v1'), via('v2')])
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([{}]);
    const { operations } = makeOperations({
      pcb_PrimitiveVia: { getAll },
    });

    await expect(operations.listVias(1, 1)).resolves.toEqual({
      total: 3,
      items: [
        {
          primitiveId: 'v1',
          net: 'VCC',
          x: 1,
          y: 2,
          holeDiameter: 3,
          diameter: 4,
          locked: false,
        },
      ],
    });
    await expect(operations.listVias()).resolves.toEqual({ total: 0, items: [] });
    await expect(operations.listVias()).resolves.toEqual({
      total: 1,
      items: [
        {
          primitiveId: '',
          net: '',
          x: undefined,
          y: undefined,
          holeDiameter: undefined,
          diameter: undefined,
          locked: false,
        },
      ],
    });
  });

  it('returns an empty list when a native read class is unavailable', async () => {
    const { operations, requireActivePcbContext } = makeOperations();

    await expect(operations.listComponents()).resolves.toEqual({ total: 0, items: [] });
    await expect(operations.listTracks()).resolves.toEqual({ total: 0, items: [] });
    await expect(operations.listVias()).resolves.toEqual({ total: 0, items: [] });
    expect(requireActivePcbContext).toHaveBeenCalledTimes(3);
  });
});

describe('PCB primitive deletion routing', () => {
  it('routes each id only to the class that reports ownership and deduplicates input', async () => {
    const componentDelete = vi.fn(async () => true);
    const viaDelete = vi.fn(async () => true);
    const { operations } = makeOperations({
      PCB_PrimitiveComponent: {
        getAllPrimitiveId: async () => ['component-1'],
        delete: componentDelete,
      },
      PCB_PrimitiveVia: {
        getAllPrimitiveId: async () => ['via-1'],
        delete: viaDelete,
      },
    });

    await expect(
      operations.deletePrimitives(['component-1', 'via-1', 'component-1']),
    ).resolves.toEqual({
      deleted: ['component-1', 'via-1'],
      notFound: [],
    });
    expect(componentDelete).toHaveBeenCalledWith(['component-1']);
    expect(viaDelete).toHaveBeenCalledWith(['via-1']);
  });

  it('treats null or non-matching ownership results as not found', async () => {
    const componentDelete = vi.fn(async () => true);
    const viaDelete = vi.fn(async () => true);
    const { operations } = makeOperations({
      PCB_PrimitiveComponent: {
        getAllPrimitiveId: async () => null,
        delete: componentDelete,
      },
      PCB_PrimitiveVia: {
        getAllPrimitiveId: async () => ['other-via'],
        delete: viaDelete,
      },
    });

    await expect(operations.deletePrimitives(['missing'])).resolves.toEqual({
      deleted: [],
      notFound: ['missing'],
    });
    expect(componentDelete).not.toHaveBeenCalled();
    expect(viaDelete).not.toHaveBeenCalled();
  });

  it('continues after ownership reads fail and reports the id as not found', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const deletePrimitive = vi.fn(async () => true);
    const { operations } = makeOperations({
      PCB_PrimitiveComponent: {
        getAllPrimitiveId: async () => Promise.reject(new Error('membership failed')),
        delete: deletePrimitive,
      },
    });

    await expect(operations.deletePrimitives(['component-1'])).resolves.toEqual({
      deleted: [],
      notFound: ['component-1'],
    });
    expect(deletePrimitive).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[easyeda-mcp-pro]',
      'pcb.deleteComponent: PCB_PrimitiveComponent.getAllPrimitiveId failed',
      expect.any(Error),
    );
  });

  it('keeps matched ids pending when the owning class delete call fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { operations } = makeOperations({
      PCB_PrimitiveVia: {
        getAllPrimitiveId: async () => ['via-1'],
        delete: async () => Promise.reject(new Error('delete failed')),
      },
    });

    await expect(operations.deletePrimitives(['via-1'])).resolves.toEqual({
      deleted: [],
      notFound: ['via-1'],
    });
    expect(warn).toHaveBeenCalledWith(
      '[easyeda-mcp-pro]',
      'pcb.deleteComponent: PCB_PrimitiveVia.delete failed',
      expect.any(Error),
    );
  });

  it('skips incomplete classes and stops checking once every id is deleted', async () => {
    const laterMembership = vi.fn(async () => ['component-1']);
    const { operations } = makeOperations({
      PCB_PrimitiveComponent: {
        getAllPrimitiveId: async () => ['component-1'],
        delete: async () => true,
      },
      PCB_PrimitiveVia: { getAllPrimitiveId: async () => ['component-1'] },
      PCB_PrimitiveLine: {
        getAllPrimitiveId: laterMembership,
        delete: async () => true,
      },
    });

    await expect(operations.deletePrimitives(['component-1'])).resolves.toEqual({
      deleted: ['component-1'],
      notFound: [],
    });
    expect(laterMembership).not.toHaveBeenCalled();
  });
});
