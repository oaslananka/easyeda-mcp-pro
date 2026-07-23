import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBoardInspectionOperations } from '../src/board-inspection.js';

function bridgeError(code: string, message: string, suggestion: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, suggestion, data });
}

function makeOperations(
  runtime: Record<string, unknown> = {},
  globalRoot: Record<string, unknown> | null = {},
) {
  const readFirstPath = vi.fn(<T>(paths: readonly string[]): T | undefined => {
    for (const path of paths) {
      if (path in runtime) return runtime[path] as T;
    }
    return undefined;
  });
  const getGlobal = vi.fn(() => globalRoot);
  return {
    readFirstPath,
    getGlobal,
    operations: createBoardInspectionOperations({
      readFirstPath,
      getGlobal,
      createBridgeError: bridgeError,
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('board inspection operations', () => {
  it('preserves compatibility when DMT_Pcb is unavailable', async () => {
    const { operations } = makeOperations();

    await expect(operations.requireActivePcbContext()).resolves.toBeUndefined();
  });

  it('translates a failing PCB context read into the stable bridge error', async () => {
    const { operations } = makeOperations({
      DMT_Pcb: {
        getCurrentPcbInfo: async () => {
          throw new Error('message bus unavailable');
        },
      },
    });

    await expect(operations.requireActivePcbContext()).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
      message: 'PCB data is unavailable in the current editor context.',
      suggestion: 'Open and focus a PCB document, then retry.',
      data: { cause: 'message bus unavailable' },
    });
  });

  it('rejects a missing focused PCB before reading board data', async () => {
    const getAllLayers = vi.fn(async () => []);
    const { operations } = makeOperations({
      DMT_Pcb: { getCurrentPcbInfo: async () => null },
      PCB_Layer: { getAllLayers },
    });

    await expect(operations.listLayers()).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
      message: 'No active PCB document is focused.',
    });
    expect(getAllLayers).not.toHaveBeenCalled();
  });

  it('filters inactive catalogue layers and normalizes public layer fields', async () => {
    const { operations } = makeOperations({
      DMT_Pcb: { getCurrentPcbInfo: async () => ({ uuid: 'pcb-1' }) },
      PCB_Layer: {
        getTheNumberOfCopperLayers: async () => 4,
        getAllLayers: async () => [
          { name: 'Top Layer', type: 'SIGNAL', color: '#f00', visible: false, order: 7 },
          { name: 'Bottom Layer', type: 'SIGNAL' },
          { name: 'Inner1', type: 'SIGNAL' },
          { name: 'Inner2', type: 'SIGNAL' },
          { name: 'Inner3', type: 'SIGNAL' },
          { name: 'Custom1', type: 'CUSTOM' },
          { name: 'Dielectric1', type: 'OTHER' },
          { name: 'Mechanical Layer', type: 'OTHER', order: Number.NaN },
          { name: 'RF Keepout', type: 'CUSTOM', order: 0 },
        ],
      },
    });

    await expect(operations.listLayers()).resolves.toEqual([
      { name: 'Top Layer', type: 'SIGNAL', color: '#f00', visible: false, order: 7 },
      { name: 'Bottom Layer', type: 'SIGNAL', color: '', visible: true, order: 1 },
      { name: 'Inner1', type: 'SIGNAL', color: '', visible: true, order: 2 },
      { name: 'Inner2', type: 'SIGNAL', color: '', visible: true, order: 3 },
      { name: 'Mechanical Layer', type: 'OTHER', color: '', visible: true, order: 4 },
      { name: 'RF Keepout', type: 'CUSTOM', color: '', visible: true, order: 5 },
    ]);
  });

  it('degrades invalid copper-layer counts and non-array layer results safely', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const getTheNumberOfCopperLayers = vi
      .fn()
      .mockRejectedValueOnce(new Error('count failed'))
      .mockResolvedValueOnce(1);
    const getAllLayers = vi
      .fn()
      .mockResolvedValueOnce([{ name: 'Inner1' }])
      .mockResolvedValueOnce({});
    const { operations } = makeOperations({
      DMT_Pcb: { getCurrentPcbInfo: async () => ({ uuid: 'pcb-1' }) },
      PCB_Layer: { getTheNumberOfCopperLayers, getAllLayers },
    });

    await expect(operations.listLayers()).resolves.toEqual([]);
    await expect(operations.listLayers()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      '[easyeda-mcp-pro]',
      'failed to read copper layer count',
      expect.any(Error),
    );
  });

  it('rejects listLayers when the layer API is unavailable', async () => {
    const { operations } = makeOperations({
      DMT_Pcb: { getCurrentPcbInfo: async () => ({ uuid: 'pcb-1' }) },
    });

    await expect(operations.listLayers()).rejects.toThrow(
      'pcb_Layer class or getAllLayers method not found',
    );
  });

  it('maps a physical stackup without inventing missing values', async () => {
    const { operations } = makeOperations({
      DMT_Pcb: { getCurrentPcbInfo: async () => ({ uuid: 'pcb-1' }) },
      PCB_Layer: {
        getTheNumberOfCopperLayers: async () => 4,
        getCurrentPhysicalStackingConfiguration: async () => ({
          thicknessMm: 1.6,
          layers: [
            {
              name: 'Top',
              type: 'copper',
              thicknessMm: 0.035,
              material: 'Cu',
              dielectricConstant: 1,
              copperWeightOz: 1,
            },
            {
              name: 'Core',
              type: 'dielectric',
              thickness: 1.5,
              material: 'FR4',
              dielectric: 4.2,
              copperWeight: 0,
            },
          ],
        }),
      },
    });

    await expect(operations.getStackup()).resolves.toEqual({
      totalLayers: 4,
      boardThicknessMm: 1.6,
      layers: [
        {
          name: 'Top',
          type: 'copper',
          thicknessMm: 0.035,
          material: 'Cu',
          dielectricConstant: 1,
          copperWeightOz: 1,
        },
        {
          name: 'Core',
          type: 'dielectric',
          thicknessMm: 1.5,
          material: 'FR4',
          dielectricConstant: 4.2,
          copperWeightOz: 0,
        },
      ],
      available: true,
      source: 'physical_stackup',
    });
  });

  it('supports the alternate stackup shape and degrades a failed physical read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const getCurrentPhysicalStackingConfiguration = vi
      .fn()
      .mockResolvedValueOnce({ thickness: 1.2, stackup: [{ name: 'Core' }] })
      .mockRejectedValueOnce(new Error('stackup failed'));
    const { operations } = makeOperations({
      DMT_Pcb: { getCurrentPcbInfo: async () => ({ uuid: 'pcb-1' }) },
      PCB_Layer: {
        getTheNumberOfCopperLayers: async () => 2,
        getCurrentPhysicalStackingConfiguration,
      },
    });

    await expect(operations.getStackup()).resolves.toMatchObject({
      boardThicknessMm: 1.2,
      layers: [{ name: 'Core' }],
      available: true,
      source: 'physical_stackup',
    });
    await expect(operations.getStackup()).resolves.toEqual({
      totalLayers: 2,
      boardThicknessMm: undefined,
      layers: [],
      available: false,
      source: 'copper_layer_count_only',
    });
    expect(warn).toHaveBeenCalledWith(
      '[easyeda-mcp-pro]',
      'failed to read physical stackup',
      expect.any(Error),
    );
  });

  it('rejects getStackup when the layer class is unavailable', async () => {
    const { operations } = makeOperations({
      DMT_Pcb: { getCurrentPcbInfo: async () => ({ uuid: 'pcb-1' }) },
    });

    await expect(operations.getStackup()).rejects.toThrow('pcb_Layer class not found');
  });

  it('calculates dimensions from outline lines, arcs, and mounting-hole pads', async () => {
    const { operations } = makeOperations(
      { DMT_Pcb: { getCurrentPcbInfo: async () => ({ uuid: 'pcb-1' }) } },
      {
        pcb_PrimitiveLine: {
          getAll: async () => [
            {
              getState_Layer: () => 11,
              getState_Points: () => [
                { x: 1, y: 2 },
                { x: 11, y: 7 },
              ],
            },
            { getState_Layer: () => 1, getState_Points: () => [{ x: 100, y: 100 }] },
          ],
        },
        pcb_PrimitiveArc: {
          getAll: async () => [
            {
              getState_Layer: () => 11,
              getState_StartX: () => -1,
              getState_StartY: () => -2,
              getState_EndX: () => 9,
              getState_EndY: () => 8,
            },
            { getState_Layer: () => 2 },
          ],
        },
        pcb_PrimitivePad: {
          getAll: async () => [
            { getState_HoleType: () => 'MountingHole', getState_HoleSize: () => 1 },
            { getState_HoleType: () => '', getState_HoleSize: () => 2.5 },
            { getState_HoleType: () => '', getState_HoleSize: () => 1 },
          ],
        },
      },
    );

    await expect(operations.getDimensions()).resolves.toEqual({
      widthMm: 12,
      heightMm: 10,
      shape: 'custom',
      mountingHoleCount: 2,
      areaMm2: 120,
      hasOutline: true,
    });
  });

  it('returns an empty dimension summary when primitive reads fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failingClass = { getAll: async () => Promise.reject(new Error('read failed')) };
    const { operations } = makeOperations(
      { DMT_Pcb: { getCurrentPcbInfo: async () => ({ uuid: 'pcb-1' }) } },
      {
        pcb_PrimitiveLine: failingClass,
        pcb_PrimitiveArc: failingClass,
        pcb_PrimitivePad: failingClass,
      },
    );

    await expect(operations.getDimensions()).resolves.toEqual({
      widthMm: 0,
      heightMm: 0,
      shape: undefined,
      mountingHoleCount: 0,
      areaMm2: 0,
      hasOutline: false,
    });
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('counts all supported board feature classes', async () => {
    const { operations } = makeOperations(
      { DMT_Pcb: { getCurrentPcbInfo: async () => ({ uuid: 'pcb-1' }) } },
      {
        pcb_PrimitiveVia: { getAll: async () => [1, 2] },
        pcb_PrimitiveLine: { getAll: async () => [1, 2, 3] },
        pcb_PrimitivePad: { getAll: async () => [1, 2, 3, 4] },
        pcb_PrimitivePour: { getAll: async () => [1] },
        pcb_PrimitiveComponent: { getAll: async () => [1, 2, 3, 4, 5] },
      },
    );

    await expect(operations.getFeatures()).resolves.toEqual({
      vias: 2,
      tracks: 3,
      zones: 1,
      pads: 4,
      components: 5,
    });
  });

  it('preserves a non-Error PCB context failure as bridge error cause text', async () => {
    const { operations } = makeOperations({
      DMT_Pcb: {
        getCurrentPcbInfo: async () => Promise.reject('message bus unavailable'),
      },
    });

    await expect(operations.requireActivePcbContext()).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
      data: { cause: 'message bus unavailable' },
    });
  });

  it('normalizes absent layer metadata and stackup APIs without inventing values', async () => {
    const getAllLayers = vi.fn(async () => [undefined]);
    const { operations } = makeOperations({
      DMT_Pcb: { getCurrentPcbInfo: async () => ({ uuid: 'pcb-1' }) },
      PCB_Layer: { getAllLayers },
    });

    await expect(operations.listLayers()).resolves.toEqual([
      { name: '', type: '', color: '', visible: true, order: 0 },
    ]);
    await expect(operations.getStackup()).resolves.toEqual({
      totalLayers: 0,
      boardThicknessMm: undefined,
      layers: [],
      available: false,
      source: 'copper_layer_count_only',
    });
  });

  it('normalizes an undefined physical stackup layer without inventing fields', async () => {
    const { operations } = makeOperations({
      DMT_Pcb: { getCurrentPcbInfo: async () => ({ uuid: 'pcb-1' }) },
      PCB_Layer: {
        getTheNumberOfCopperLayers: async () => 2,
        getCurrentPhysicalStackingConfiguration: async () => ({ layers: [undefined] }),
      },
    });

    await expect(operations.getStackup()).resolves.toEqual({
      totalLayers: 2,
      boardThicknessMm: undefined,
      layers: [
        {
          name: '',
          type: '',
          thicknessMm: undefined,
          material: '',
          dielectricConstant: undefined,
          copperWeightOz: undefined,
        },
      ],
      available: true,
      source: 'physical_stackup',
    });
  });

  it('contains absent, null, and partial primitive dimension data', async () => {
    const root: Record<string, unknown> = {};
    const { operations } = makeOperations(
      { DMT_Pcb: { getCurrentPcbInfo: async () => ({ uuid: 'pcb-1' }) } },
      root,
    );
    const emptyDimensions = {
      widthMm: 0,
      heightMm: 0,
      shape: undefined,
      mountingHoleCount: 0,
      areaMm2: 0,
      hasOutline: false,
    };

    await expect(operations.getDimensions()).resolves.toEqual(emptyDimensions);

    root.pcb_PrimitiveLine = { getAll: async () => null };
    root.pcb_PrimitiveArc = { getAll: async () => null };
    root.pcb_PrimitivePad = { getAll: async () => null };
    await expect(operations.getDimensions()).resolves.toEqual(emptyDimensions);

    root.pcb_PrimitiveLine = {
      getAll: async () => [
        {},
        { getState_Layer: () => 11 },
        { getState_Layer: () => 11, getState_Points: () => null },
      ],
    };
    root.pcb_PrimitiveArc = {
      getAll: async () => [{}, { getState_Layer: () => 11 }],
    };
    root.pcb_PrimitivePad = { getAll: async () => [{}] };
    await expect(operations.getDimensions()).resolves.toEqual(emptyDimensions);
  });

  it('contains absent feature classes and null feature collections', async () => {
    const root: Record<string, unknown> = {};
    const { operations } = makeOperations(
      { DMT_Pcb: { getCurrentPcbInfo: async () => ({ uuid: 'pcb-1' }) } },
      root,
    );
    const emptyFeatures = { vias: 0, tracks: 0, zones: 0, pads: 0, components: 0 };

    await expect(operations.getFeatures()).resolves.toEqual(emptyFeatures);

    const nullCollection = { getAll: async () => null };
    root.pcb_PrimitiveVia = nullCollection;
    root.pcb_PrimitiveLine = nullCollection;
    root.pcb_PrimitivePad = nullCollection;
    root.pcb_PrimitivePour = nullCollection;
    root.pcb_PrimitiveComponent = nullCollection;
    await expect(operations.getFeatures()).resolves.toEqual(emptyFeatures);
  });

  it('contains every individual feature-count failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = { getAll: async () => Promise.reject(new Error('count failed')) };
    const { operations } = makeOperations(
      { DMT_Pcb: { getCurrentPcbInfo: async () => ({ uuid: 'pcb-1' }) } },
      {
        pcb_PrimitiveVia: failing,
        pcb_PrimitiveLine: failing,
        pcb_PrimitivePad: failing,
        pcb_PrimitivePour: failing,
        pcb_PrimitiveComponent: failing,
      },
    );

    await expect(operations.getFeatures()).resolves.toEqual({
      vias: 0,
      tracks: 0,
      zones: 0,
      pads: 0,
      components: 0,
    });
    expect(warn).toHaveBeenCalledTimes(5);
  });
});
