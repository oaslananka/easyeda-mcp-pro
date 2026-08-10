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

  it('maps Fill state, preserves netless fills, and normalizes complex polygon contours', async () => {
    const complexPolygon = {
      toPolygon: () => [
        {
          discretize: () => [
            { x: 0, y: 0 },
            { x: 20, y: 0 },
            { x: 20, y: 10 },
          ],
        },
        {
          discretize: () => [
            { x: 5, y: 2 },
            { x: 7, y: 2 },
            { x: 7, y: 4 },
          ],
        },
      ],
    };
    const fill = {
      getState_PrimitiveId: () => 'fill-1',
      getState_Layer: () => 1,
      getState_Net: () => '',
      getState_FillMode: () => 0,
      getState_LineWidth: () => 1,
      getState_PrimitiveLock: () => false,
      getState_ComplexPolygon: () => complexPolygon,
    };
    const { operations } = makeOperations({ PCB_PrimitiveFill: { getAll: async () => [fill] } });

    await expect(operations.listFills()).resolves.toEqual({
      total: 1,
      items: [
        {
          primitiveId: 'fill-1',
          layer: 1,
          net: '',
          netless: true,
          fillMode: 0,
          lineWidth: 1,
          locked: false,
          polygon: {
            contours: [
              {
                points: [
                  { x: 0, y: 0 },
                  { x: 20, y: 0 },
                  { x: 20, y: 10 },
                ],
                pointCount: 3,
                truncated: false,
                bounds: { minX: 0, minY: 0, maxX: 20, maxY: 10 },
              },
              {
                points: [
                  { x: 5, y: 2 },
                  { x: 7, y: 2 },
                  { x: 7, y: 4 },
                ],
                pointCount: 3,
                truncated: false,
                bounds: { minX: 5, minY: 2, maxX: 7, maxY: 4 },
              },
            ],
            contourCount: 2,
            pointCount: 6,
            truncated: false,
            bounds: { minX: 0, minY: 0, maxX: 20, maxY: 10 },
          },
        },
      ],
    });
  });

  it('normalizes the live EasyEDA 3.2.149 ComplexPolygon shape that exposes discretize directly', async () => {
    const complexPolygon = {
      discretize: () => [
        { x: 10, y: 20 },
        { x: 40, y: 20 },
        { x: 40, y: 60 },
        { x: 10, y: 60 },
      ],
      getSource: () => ['R', 10, 20, 30, 40, 0, 0],
    };
    const fill = {
      getState_PrimitiveId: () => 'fill-live-shape',
      getState_Net: () => '',
      getState_ComplexPolygon: () => complexPolygon,
    };
    const { operations } = makeOperations({ PCB_PrimitiveFill: { getAll: async () => [fill] } });

    const result = (await operations.listFills()) as { items: Array<Record<string, any>> };

    expect(result.items[0].polygon).toEqual({
      contours: [
        {
          points: [
            { x: 10, y: 20 },
            { x: 40, y: 20 },
            { x: 40, y: 60 },
            { x: 10, y: 60 },
          ],
          pointCount: 4,
          truncated: false,
          bounds: { minX: 10, minY: 20, maxX: 40, maxY: 60 },
        },
      ],
      contourCount: 1,
      pointCount: 4,
      truncated: false,
      bounds: { minX: 10, minY: 20, maxX: 40, maxY: 60 },
    });
  });

  it('falls back to PCB_MathPolygon when the live wrapper discretize method yields no points', async () => {
    const source = ['CIRCLE', 90, -95, 61.0236];
    const directDiscretize = vi.fn(() => []);
    const staticDiscretize = vi.fn((polygon: unknown) =>
      polygon === source
        ? [
            { x: 29, y: -95 },
            { x: 90, y: -34 },
            { x: 151, y: -95 },
            { x: 90, y: -156 },
          ]
        : [],
    );
    const complexPolygon = {
      discretize: directDiscretize,
      getSource: () => source,
    };
    const { operations } = makeOperations({
      PCB_MathPolygon: { discretize: staticDiscretize },
      PCB_PrimitiveFill: {
        getAll: async () => [
          {
            getState_PrimitiveId: () => 'fill-live-circle',
            getState_ComplexPolygon: () => complexPolygon,
          },
        ],
      },
    });

    const result = (await operations.listFills()) as { items: Array<Record<string, any>> };

    expect(directDiscretize).toHaveBeenCalledOnce();
    expect(staticDiscretize).toHaveBeenCalledWith(source);
    expect(result.items[0].polygon).toMatchObject({
      contourCount: 1,
      pointCount: 4,
      bounds: { minX: 29, minY: -156, maxX: 151, maxY: -34 },
    });
  });

  it('normalizes documented CIRCLE and axis-aligned R sources when EasyEDA discretizers are not implemented', async () => {
    const circleSource = ['CIRCLE', 90, -95, 61.0236];
    const rectangleSource = ['R', 10, 20, 30, 40, 0, 0];
    const notImplemented = vi.fn(() => {
      throw new Error('Not implemented');
    });
    const { operations } = makeOperations({
      PCB_MathPolygon: { discretize: notImplemented },
      PCB_PrimitiveFill: {
        getAll: async () => [
          {
            getState_PrimitiveId: () => 'fill-circle-fallback',
            getState_ComplexPolygon: () => ({
              discretize: notImplemented,
              getSource: () => circleSource,
            }),
          },
        ],
      },
      PCB_PrimitiveRegion: {
        getAll: async () => [
          {
            getState_PrimitiveId: () => 'region-rect-fallback',
            getState_ComplexPolygon: () => ({
              discretize: notImplemented,
              getSource: () => rectangleSource,
            }),
          },
        ],
      },
    });

    const fills = (await operations.listFills()) as { items: Array<Record<string, any>> };
    const regions = (await operations.listRegions()) as { items: Array<Record<string, any>> };

    expect(fills.items[0].polygon).toMatchObject({ contourCount: 1, pointCount: 32 });
    expect(fills.items[0].polygon.bounds.minX).toBeCloseTo(28.9764, 4);
    expect(fills.items[0].polygon.bounds.maxX).toBeCloseTo(151.0236, 4);
    expect(fills.items[0].polygon.bounds.minY).toBeCloseTo(-156.0236, 4);
    expect(fills.items[0].polygon.bounds.maxY).toBeCloseTo(-33.9764, 4);
    expect(regions.items[0].polygon).toMatchObject({
      contourCount: 1,
      pointCount: 4,
      bounds: { minX: 10, minY: 20, maxX: 40, maxY: 60 },
    });
  });

  it('maps Region rule metadata and bounds polygon output to 500 points without hiding truncation', async () => {
    const points = Array.from({ length: 501 }, (_, index) => ({ x: index, y: index * 2 }));
    const region = {
      getState_PrimitiveId: () => 'region-1',
      getState_Layer: () => 12,
      getState_RuleType: () => [5, 7],
      getState_RegionName: () => 'route keepout',
      getState_LineWidth: () => 2,
      getState_PrimitiveLock: () => true,
      getState_ComplexPolygon: () => ({
        toPolygon: () => [{ discretize: () => points }],
      }),
    };
    const { operations } = makeOperations({
      pcb_PrimitiveRegion: { getAll: async () => [region] },
    });

    const result = (await operations.listRegions()) as {
      total: number;
      items: Array<Record<string, any>>;
    };
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      primitiveId: 'region-1',
      layer: 12,
      ruleTypes: [5, 7],
      regionName: 'route keepout',
      lineWidth: 2,
      locked: true,
      polygon: {
        contourCount: 1,
        pointCount: 501,
        truncated: true,
        bounds: { minX: 0, minY: 0, maxX: 500, maxY: 1000 },
      },
    });
    expect(result.items[0].polygon.contours).toHaveLength(1);
    expect(result.items[0].polygon.contours[0].points).toHaveLength(500);
    expect(result.items[0].polygon.contours[0]).toMatchObject({
      pointCount: 501,
      truncated: true,
      bounds: { minX: 0, minY: 0, maxX: 500, maxY: 1000 },
    });
  });

  it('normalizes Fill/Region geometry through PCB_MathPolygon when only complex polygon source is exposed', async () => {
    const staticDiscretize = vi.fn((source: unknown) => {
      if (Array.isArray(source) && source[0] === 'R') {
        return [
          { x: 10, y: 20 },
          { x: 40, y: 20 },
          { x: 40, y: 60 },
          { x: 10, y: 60 },
        ];
      }
      return [];
    });
    const geometry = { getSource: () => ['R', 10, 20, 30, 40, 0, 0] };
    const { operations } = makeOperations({
      PCB_MathPolygon: { discretize: staticDiscretize },
      PCB_PrimitiveFill: {
        getAll: async () => [
          { getState_PrimitiveId: () => 'fill-source', getState_ComplexPolygon: () => geometry },
        ],
      },
      PCB_PrimitiveRegion: {
        getAll: async () => [
          { getState_PrimitiveId: () => 'region-source', getState_ComplexPolygon: () => geometry },
        ],
      },
    });

    const fills = (await operations.listFills()) as { items: Array<Record<string, any>> };
    const regions = (await operations.listRegions()) as { items: Array<Record<string, any>> };
    expect(staticDiscretize).toHaveBeenCalled();
    expect(fills.items[0].polygon.bounds).toEqual({ minX: 10, minY: 20, maxX: 40, maxY: 60 });
    expect(regions.items[0].polygon.bounds).toEqual({ minX: 10, minY: 20, maxX: 40, maxY: 60 });
  });

  it('normalizes direct polygon source arrays exposed by the live Fill/Region state API', async () => {
    const source = ['R', 10, 20, 30, 40, 0, 0];
    const staticDiscretize = vi.fn((polygon: unknown) => {
      if (polygon === source) {
        return [
          { x: 10, y: 20 },
          { x: 40, y: 20 },
          { x: 40, y: 60 },
          { x: 10, y: 60 },
        ];
      }
      return [];
    });
    const { operations } = makeOperations({
      PCB_MathPolygon: { discretize: staticDiscretize },
      PCB_PrimitiveFill: {
        getAll: async () => [
          { getState_PrimitiveId: () => 'fill-live-source', getState_ComplexPolygon: () => source },
        ],
      },
      PCB_PrimitiveRegion: {
        getAll: async () => [
          {
            getState_PrimitiveId: () => 'region-live-source',
            getState_ComplexPolygon: () => source,
          },
        ],
      },
    });

    const fills = (await operations.listFills()) as { items: Array<Record<string, any>> };
    const regions = (await operations.listRegions()) as { items: Array<Record<string, any>> };
    expect(staticDiscretize).toHaveBeenCalledWith(source);
    expect(fills.items[0].polygon).toMatchObject({
      contourCount: 1,
      pointCount: 4,
      bounds: { minX: 10, minY: 20, maxX: 40, maxY: 60 },
    });
    expect(regions.items[0].polygon).toMatchObject({
      contourCount: 1,
      pointCount: 4,
      bounds: { minX: 10, minY: 20, maxX: 40, maxY: 60 },
    });
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
