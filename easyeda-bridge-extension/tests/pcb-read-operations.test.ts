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

  it('maps Fill native state and extracts the documented polygon source with pagination', async () => {
    const source = ['CIRCLE', 90, -95, 61.0236];
    const fills = [
      { getState_PrimitiveId: () => 'skip-me' },
      {
        getState_PrimitiveId: () => 'fill-1',
        getState_Layer: () => 12,
        getState_Net: () => '',
        getState_FillMode: () => 0,
        getState_LineWidth: () => 1,
        getState_PrimitiveLock: () => true,
        getState_ComplexPolygon: () => ({ getSource: () => source }),
      },
    ];
    const { operations } = makeOperations({ PCB_PrimitiveFill: { getAll: async () => fills } });

    await expect(operations.listFills(1, 1)).resolves.toEqual({
      total: 2,
      items: [
        {
          primitiveId: 'fill-1',
          layer: 12,
          net: '',
          fillMode: 0,
          lineWidth: 1,
          locked: true,
          polygonSource: source,
        },
      ],
    });
  });

  it('prefers the native polygon primitive state bag over disagreeing getters', async () => {
    const regionSource = ['R', 5000, 3000, 200, 100, 0, 0];
    const fillSource = ['R', 6000, 3000, 200, 100, 0, 0];
    const { operations } = makeOperations({
      PCB_PrimitiveRegion: {
        getAll: async () => [
          {
            state: {
              PrimitiveId: 'region-raw',
              Layer: 1,
              RuleType: [2],
              RegionName: 'raw region',
              LineWidth: 5,
              PrimitiveLock: false,
              ComplexPolygon: { polygon: regionSource },
            },
            getState_PrimitiveId: () => 'region-getter',
            getState_Layer: () => 12,
            getState_RuleType: () => [7],
            getState_RegionName: () => undefined,
            getState_LineWidth: () => 0.2,
            getState_PrimitiveLock: () => true,
            getState_ComplexPolygon: () => null,
          },
        ],
      },
      PCB_PrimitiveFill: {
        getAll: async () => [
          {
            state: {
              PrimitiveId: 'fill-raw',
              Layer: 13,
              Net: '',
              FillMode: 0,
              LineWidth: 5,
              PrimitiveLock: false,
              ComplexPolygon: { polygon: fillSource },
            },
            getState_PrimitiveId: () => 'fill-getter',
            getState_Layer: () => 12,
            getState_Net: () => 'WRONG',
            getState_FillMode: () => 2,
            getState_LineWidth: () => 0.2,
            getState_PrimitiveLock: () => true,
            getState_ComplexPolygon: () => null,
          },
        ],
      },
    });

    await expect(operations.listRegions()).resolves.toEqual({
      total: 1,
      items: [
        {
          primitiveId: 'region-raw',
          layer: 1,
          ruleTypes: [2],
          regionName: 'raw region',
          lineWidth: 5,
          locked: false,
          polygonSource: regionSource,
        },
      ],
    });
    await expect(operations.listFills()).resolves.toEqual({
      total: 1,
      items: [
        {
          primitiveId: 'fill-raw',
          layer: 13,
          net: '',
          fillMode: 0,
          lineWidth: 5,
          locked: false,
          polygonSource: fillSource,
        },
      ],
    });
  });

  it('reads lower-camel polygon primitive fields from the native state bag', async () => {
    const source = ['R', 7000, 3000, 100, 80, 0, 0];
    const { operations } = makeOperations({
      PCB_PrimitiveRegion: {
        getAll: async () => [
          {
            state: {
              primitiveId: 'region-lower-camel',
              layer: 1,
              ruleType: [2, 7],
              regionName: 'lower-camel',
              lineWidth: 0.2,
              primitiveLock: false,
              complexPolygon: { polygon: source },
            },
          },
        ],
      },
    });

    await expect(operations.listRegions()).resolves.toEqual({
      total: 1,
      items: [
        {
          primitiveId: 'region-lower-camel',
          layer: 1,
          ruleTypes: [2, 7],
          regionName: 'lower-camel',
          lineWidth: 0.2,
          locked: false,
          polygonSource: source,
        },
      ],
    });
  });

  it('maps Region state and accepts the runtime polygon property fallback', async () => {
    const source = ['R', 10, 20, 30, 40, 0, 0];
    const { operations } = makeOperations({
      pcb_PrimitiveRegion: {
        getAll: async () => [
          {
            getState_PrimitiveId: () => 'region-1',
            getState_Layer: () => 12,
            getState_RuleType: () => [5, 7],
            getState_RegionName: () => 'route keepout',
            getState_LineWidth: () => 0.2,
            getState_PrimitiveLock: () => false,
            getState_ComplexPolygon: () => ({ polygon: source }),
          },
        ],
      },
    });

    await expect(operations.listRegions()).resolves.toEqual({
      total: 1,
      items: [
        {
          primitiveId: 'region-1',
          layer: 12,
          ruleTypes: [5, 7],
          regionName: 'route keepout',
          lineWidth: 0.2,
          locked: false,
          polygonSource: source,
        },
      ],
    });
  });

  it('passes through a direct polygon source array and contains missing geometry', async () => {
    const source = ['R', 1, 2, 3, 4, 0, 0];
    const { operations } = makeOperations({
      PCB_PrimitiveFill: {
        getAll: async () => [
          { getState_PrimitiveId: () => 'direct', getState_ComplexPolygon: () => source },
          { getState_PrimitiveId: () => 'missing', getState_ComplexPolygon: () => null },
          { getState_PrimitiveId: () => 'scalar', getState_ComplexPolygon: () => 'opaque' },
        ],
      },
    });

    const result = (await operations.listFills()) as { items: Array<Record<string, unknown>> };
    expect(result.items.map((item) => item.polygonSource)).toEqual([source, undefined, undefined]);
  });

  it('falls back to legacy state readers when polygon primitive state is absent or non-object', async () => {
    const source = ['R', 7200, 3000, 100, 80, 0, 0];
    const { operations, readState } = makeOperations({
      PCB_PrimitiveRegion: {
        getAll: async () => [
          null,
          {
            state: {},
            getState_PrimitiveId: () => 'region-legacy-fallback',
            getState_Layer: () => 1,
            getState_RuleType: () => [2],
            getState_RegionName: () => 'legacy fallback',
            getState_LineWidth: () => 0.2,
            getState_PrimitiveLock: () => false,
            getState_ComplexPolygon: () => ({ polygon: source }),
          },
        ],
      },
    });

    await expect(operations.listRegions()).resolves.toEqual({
      total: 2,
      items: [
        {
          primitiveId: undefined,
          layer: undefined,
          ruleTypes: undefined,
          regionName: undefined,
          lineWidth: undefined,
          locked: undefined,
          polygonSource: undefined,
        },
        {
          primitiveId: 'region-legacy-fallback',
          layer: 1,
          ruleTypes: [2],
          regionName: 'legacy fallback',
          lineWidth: 0.2,
          locked: false,
          polygonSource: source,
        },
      ],
    });
    expect(readState).toHaveBeenCalled();
  });

  it('contains polygon source read failures and non-array getter results', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { operations } = makeOperations({
      PCB_PrimitiveRegion: {
        getAll: async () => [
          {
            getState_PrimitiveId: () => 'throws',
            getState_ComplexPolygon: () => ({
              getSource: () => Promise.reject(new Error('source unavailable')),
            }),
          },
          {
            getState_PrimitiveId: () => 'not-array',
            getState_ComplexPolygon: () => ({ getSource: () => ({ opaque: true }) }),
          },
        ],
      },
    });

    const result = (await operations.listRegions()) as { items: Array<Record<string, unknown>> };
    expect(result.items.map((item) => item.polygonSource)).toEqual([undefined, undefined]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('returns an empty list for legacy PCB readers when a native read class is unavailable', async () => {
    const { operations, requireActivePcbContext } = makeOperations();

    await expect(operations.listComponents()).resolves.toEqual({ total: 0, items: [] });
    await expect(operations.listTracks()).resolves.toEqual({ total: 0, items: [] });
    await expect(operations.listVias()).resolves.toEqual({ total: 0, items: [] });
    expect(requireActivePcbContext).toHaveBeenCalledTimes(3);
  });

  it('fails cleanly when Fill/Region native APIs are unavailable', async () => {
    const { operations, requireActivePcbContext } = makeOperations();

    await expect(operations.listFills()).rejects.toThrow(
      'PCB_PrimitiveFill.getAll is unavailable in this EasyEDA Pro runtime',
    );
    await expect(operations.listRegions()).rejects.toThrow(
      'PCB_PrimitiveRegion.getAll is unavailable in this EasyEDA Pro runtime',
    );
    expect(requireActivePcbContext).toHaveBeenCalledTimes(2);
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

describe('native zone preflight', () => {
  const base = {
    sys_Environment: { getEditorCurrentVersion: async () => '3.2.206.715d940d' },
    dmt_Pcb: { getCurrentPcbInfo: async () => ({ uuid: 'pcb-1' }) },
    pcb_Net: { getAllNetName: async () => ['GND', 'VCC'] },
    pcb_Layer: { getTheNumberOfCopperLayers: async () => 2 },
    pcb_PrimitivePour: { create: vi.fn() },
    pcb_PrimitivePoured: { get: vi.fn() },
    pcb_Document: { save: vi.fn() },
  };
  it('validates exact net and active board but never authorizes writes', async () => {
    const { operations } = makeOperations(base);
    const result = await operations.zonePreflight('GND', 2);
    expect(result).toMatchObject({
      runtimeVerified: true,
      activePcb: true,
      nativeCapabilities: true,
      netVerified: true,
      layerVerified: true,
      readyToApply: false,
    });
    expect((result as { blockers: string[] }).blockers).toContain(
      'board-outline-and-copper-topology-unverified',
    );
    expect(base.pcb_PrimitivePour.create).not.toHaveBeenCalled();
    expect(base.pcb_Document.save).not.toHaveBeenCalled();
  });
  it('accepts documented focused PCB selection when getCurrentPcbInfo is unavailable', async () => {
    const { operations } = makeOperations({
      ...base,
      dmt_Pcb: { getCurrentPcbInfo: async () => undefined },
      dmt_SelectControl: {
        getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'pcb-1' }),
      },
    });
    expect(await operations.zonePreflight('GND', 2)).toMatchObject({
      activePcb: true,
      netVerified: true,
      readyToApply: false,
    });
  });
  it('rejects focused schematic selection as non-PCB', async () => {
    const { operations } = makeOperations({
      ...base,
      dmt_Pcb: { getCurrentPcbInfo: async () => undefined },
      dmt_SelectControl: {
        getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'schematic-1' }),
      },
    });
    expect(await operations.zonePreflight('GND', 2)).toMatchObject({
      activePcb: false,
      netVerified: false,
      readyToApply: false,
    });
  });

  it('rejects a missing net even though native create accepts unknown net names', async () => {
    const { operations } = makeOperations(base);
    expect(await operations.zonePreflight('MISSING_NET', 2)).toMatchObject({
      netVerified: false,
      readyToApply: false,
      blockers: expect.arrayContaining(['net-not-in-active-pcb']),
    });
  });
  it.each([
    ['missing PCB', { dmt_Pcb: undefined }, 'active-pcb-unverified'],
    [
      'missing focus',
      { dmt_Pcb: { getCurrentPcbInfo: async () => null } },
      'active-pcb-unverified',
    ],
    [
      'wrong version',
      { sys_Environment: { getEditorCurrentVersion: async () => '3.2.149' } },
      'runtime-version-unverified',
    ],
    ['net API missing', { pcb_Net: undefined }, 'net-not-in-active-pcb'],
    [
      'net API fails',
      {
        pcb_Net: {
          getAllNetName: async () => {
            throw Error('offline');
          },
        },
      },
      'net-not-in-active-pcb',
    ],
    ['layer not readable', { pcb_Layer: undefined }, 'copper-layer-unverified'],
    [
      'too few layers',
      { pcb_Layer: { getTheNumberOfCopperLayers: async () => 1 } },
      'copper-layer-unverified',
    ],
    ['no save support', { pcb_Document: undefined }, 'native-zone-capabilities-unavailable'],
  ])('is fail-closed for %s', async (_reason, override, blocker) => {
    const { operations } = makeOperations({ ...base, ...override });
    const result = await operations.zonePreflight('GND', 2);
    expect(result).toMatchObject({
      readyToApply: false,
      blockers: expect.arrayContaining([blocker]),
    });
    expect(base.pcb_PrimitivePour.create).not.toHaveBeenCalled();
  });
});

describe('PCB list project identity enforcement', () => {
  const projectUuid = 'verified-project-uuid';
  const documentUuid = 'verified-pcb-document-uuid';
  const realDocument = { documentType: 3, uuid: documentUuid, parentProjectUuid: projectUuid };
  const project = { uuid: projectUuid };

  function runtime(
    document = vi.fn(async (): Promise<unknown> => realDocument),
    currentProject = vi.fn(async (): Promise<unknown> => project),
  ) {
    return {
      DMT_SelectControl: { getCurrentDocumentInfo: document },
      DMT_Project: { getCurrentProjectInfo: currentProject },
    };
  }

  it('returns list data only when the native project UUID and focused PCB match', async () => {
    const { operations } = makeOperations(runtime());
    const read = vi.fn(async () => ({ total: 4, items: [{ primitiveId: 'e107' }] }));
    await expect(operations.readProjectScoped(projectUuid, read)).resolves.toEqual({
      total: 4,
      items: [{ primitiveId: 'e107' }],
    });
    expect(read).toHaveBeenCalledOnce();
  });

  it('rejects a fabricated requested project before reading any primitives', async () => {
    const { operations } = makeOperations(runtime());
    const read = vi.fn(async () => ({ total: 4, items: [{ primitiveId: 'e107' }] }));
    await expect(operations.readProjectScoped('Z480_NONEXISTENT_PROJECT', read)).rejects.toThrow(
      'PCB project identity mismatch',
    );
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    [
      'no focused PCB',
      { documentType: 1, uuid: documentUuid, parentProjectUuid: projectUuid },
      project,
    ],
    ['focused document missing UUID', { documentType: 3, parentProjectUuid: projectUuid }, project],
    [
      'document belongs to another project',
      { documentType: 3, uuid: documentUuid, parentProjectUuid: 'other-project' },
      project,
    ],
    ['no current project', realDocument, undefined],
  ])('fails closed for %s', async (_case, document, currentProject) => {
    const { operations } = makeOperations(
      runtime(
        vi.fn(async () => document),
        vi.fn(async () => currentProject),
      ),
    );
    const read = vi.fn(async () => ({ total: 4, items: [{ primitiveId: 'e107' }] }));
    await expect(operations.readProjectScoped(projectUuid, read)).rejects.toThrow(
      'PCB project identity mismatch',
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a missing native getter before the read', async () => {
    const { operations } = makeOperations({ DMT_SelectControl: {} });
    const read = vi.fn(async () => 'should-never-be-exposed');
    await expect(operations.readProjectScoped(projectUuid, read)).rejects.toThrow(
      'PCB project identity unavailable',
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('fails closed when a native identity getter throws', async () => {
    const { operations } = makeOperations(
      runtime(
        vi.fn(async () => {
          throw Error('disconnected');
        }),
      ),
    );
    const read = vi.fn(async () => 'should-never-be-exposed');
    await expect(operations.readProjectScoped(projectUuid, read)).rejects.toThrow('disconnected');
    expect(read).not.toHaveBeenCalled();
  });

  it('discards the entire read when focus changes to another PCB document', async () => {
    const document = vi
      .fn()
      .mockResolvedValueOnce(realDocument)
      .mockResolvedValueOnce({ ...realDocument, uuid: 'other-pcb-doc' });
    const { operations } = makeOperations(runtime(document));
    const read = vi.fn(async () => ({ total: 4, items: [{ primitiveId: 'e107' }] }));
    await expect(operations.readProjectScoped(projectUuid, read)).rejects.toThrow(
      'PCB document changed during list read',
    );
    expect(read).toHaveBeenCalledOnce();
  });

  it('discards the read if current project switches during the request', async () => {
    const projectGetter = vi
      .fn()
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce({ uuid: 'different-project' });
    const { operations } = makeOperations(
      runtime(
        vi.fn(async () => realDocument),
        projectGetter,
      ),
    );
    const read = vi.fn(async () => ({ total: 4, items: [{ primitiveId: 'e107' }] }));
    await expect(operations.readProjectScoped(projectUuid, read)).rejects.toThrow(
      'PCB project identity mismatch',
    );
    expect(read).toHaveBeenCalledOnce();
  });
});
