import { describe, expect, it, vi } from 'vitest';
import { createDispatcher } from '../src/dispatcher.js';
import type { DispatcherToolkit } from '../src/toolkit.js';

function makeToolkit(edaGlobal: Record<string, unknown>): DispatcherToolkit {
  return {
    getEda: () => edaGlobal,
    getEDA: () => undefined,
    getApi: () => undefined,
    getGlobal: () => edaGlobal,
    log: () => {},
    showToast: () => {},
    getBridgeMaxPayloadSize: () => 1_048_576,
    getBridgeVersion: () => '1.0.0',
  };
}

/** Minimal wire primitive exposing the getState_* getters the dispatcher reads. */
function fakeWire(id: string, net: string, line: number[]): Record<string, unknown> {
  return {
    getState_PrimitiveType: () => 'Wire',
    getState_PrimitiveId: () => id,
    getState_Line: () => line,
    getState_Net: () => net,
    getState_Color: () => '#000000',
    getState_LineWidth: () => 1,
    getState_LineType: () => 0,
  };
}

describe('createDispatcher', () => {
  it('returns a dispatcher with a sorted, non-empty method list and a build id', () => {
    const dispatcher = createDispatcher(makeToolkit({}));
    expect(dispatcher.methodList.length).toBeGreaterThan(40);
    expect(dispatcher.methodList).toEqual([...dispatcher.methodList].sort());
    expect(dispatcher.buildId).toBeTruthy();
    expect(dispatcher.methodList).toContain('schematic.addWire');
    expect(dispatcher.methodList).toContain('system.inspectWires');
  });

  it('rejects unknown methods with METHOD_NOT_ALLOWED', async () => {
    const dispatcher = createDispatcher(makeToolkit({}));
    await expect(dispatcher.dispatch('nope.nothing')).rejects.toMatchObject({
      code: 'METHOD_NOT_ALLOWED',
    });
  });

  it('resolves EasyEDA classes through the toolkit, not bare globals', async () => {
    const getAll = vi.fn(async () => [fakeWire('w1', 'NET_A', [0, 0, 10, 0])]);
    const dispatcher = createDispatcher(makeToolkit({ SCH_PrimitiveWire: { getAll } }));
    const result = (await dispatcher.dispatch('system.inspectWires', {})) as {
      total: number;
      samples: Array<Record<string, unknown>>;
    };
    expect(getAll).toHaveBeenCalled();
    expect(result.total).toBe(1);
    expect(result.samples[0].net).toBe('NET_A');
  });

  it('refuses addWire when a point collides with a wire on a different net', async () => {
    const create = vi.fn();
    const dispatcher = createDispatcher(
      makeToolkit({
        SCH_PrimitiveWire: {
          getAll: async () => [fakeWire('w1', 'NET_B', [10, 20, 30, 20])],
          create,
        },
      }),
    );
    await expect(
      dispatcher.dispatch('schematic.addWire', {
        netName: 'NET_A',
        points: [
          { x: 10, y: 20 },
          { x: 10, y: 40 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'NET_COLLISION' });
    expect(create).not.toHaveBeenCalled();
  });

  it('allows addWire on the same net and flattens points for create()', async () => {
    const create = vi.fn(async () => ({ primitiveId: 'w2' }));
    const dispatcher = createDispatcher(
      makeToolkit({
        SCH_PrimitiveWire: {
          getAll: async () => [fakeWire('w1', 'NET_A', [10, 20, 30, 20])],
          create,
        },
      }),
    );
    await dispatcher.dispatch('schematic.addWire', {
      netName: 'NET_A',
      points: [
        { x: 10, y: 20 },
        { x: 10, y: 40 },
      ],
    });
    expect(create).toHaveBeenCalledWith([10, 20, 10, 40], 'NET_A', undefined, undefined, undefined);
  });

  it('rejects api.call paths outside the allowed class prefixes', async () => {
    const dispatcher = createDispatcher(makeToolkit({}));
    await expect(
      dispatcher.dispatch('api.call', { path: 'SYS_Shell.exec', args: [] }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('api.call resolves an allowed class method and normalizes the result', async () => {
    const dispatcher = createDispatcher(
      makeToolkit({
        SCH_PrimitiveWire: { getAll: async () => [] },
      }),
    );
    const result = (await dispatcher.dispatch('api.call', {
      path: 'SCH_PrimitiveWire.getAll',
      args: [],
    })) as { resolvedPath: string };
    expect(result.resolvedPath).toBe('eda.SCH_PrimitiveWire.getAll');
  });

  it('system.getStatus reports capabilities equal to methodList and the build id', async () => {
    const dispatcher = createDispatcher(makeToolkit({}));
    const status = (await dispatcher.dispatch('system.getStatus', {})) as {
      capabilities: string[];
      bridgeVersion: string;
      dispatcherBuildId: string;
    };
    expect(status.capabilities).toEqual(dispatcher.methodList);
    expect(status.bridgeVersion).toBe('1.0.0');
    expect(status.dispatcherBuildId).toBe(dispatcher.buildId);
  });

  // Live-verified (2026-07-07, twice): SCH_Drc.check()'s verbose mode only
  // ever returns per-severity aggregates, e.g. exactly [{type:"warn",count:1}]
  // for a schematic with one floating-pin part — no location/net/component
  // field at any depth. design.erc supplements that native count with
  // floating pins located via this bridge's own netlist inference.
  it('design.erc supplements the native aggregate with inferred floating pins', async () => {
    const pinConnected = {
      getState_PinNumber: () => '1',
      getState_OtherProperty: () => ({ net: 'NET_A' }),
    };
    const pinFloating = {
      getState_PinNumber: () => '2',
      getState_OtherProperty: () => ({}),
    };
    const comp = {
      getState_Designator: () => 'R1',
      getState_PrimitiveId: () => 'r1',
      getAllPins: async () => [pinConnected, pinFloating],
    };
    const dispatcher = createDispatcher(
      makeToolkit({
        SCH_PrimitiveComponent: { getAll: async () => [comp] },
        SCH_Drc: { check: async () => [{ type: 'warn', count: 1 }] },
      }),
    );
    const result = await dispatcher.dispatch('design.erc', {});
    expect(result).toMatchObject({
      warningCount: 1,
      errorCount: 0,
      passed: true,
      inferredFloatingPins: [{ primitiveId: 'r1', designator: 'R1', pinNumber: '2' }],
      detailSource: 'inferred_partial',
    });
  });

  it('design.erc reports native_aggregate_only when no floating pins are found', async () => {
    const pinConnected = {
      getState_PinNumber: () => '1',
      getState_OtherProperty: () => ({ net: 'NET_A' }),
    };
    const comp = {
      getState_Designator: () => 'R1',
      getState_PrimitiveId: () => 'r1',
      getAllPins: async () => [pinConnected],
    };
    const dispatcher = createDispatcher(
      makeToolkit({
        SCH_PrimitiveComponent: { getAll: async () => [comp] },
        SCH_Drc: { check: async () => [] },
      }),
    );
    const result = await dispatcher.dispatch('design.erc', {});
    expect(result).toMatchObject({
      inferredFloatingPins: [],
      detailSource: 'native_aggregate_only',
    });
  });

  // Live-verified against EasyEDA Pro (2026-07-07): PCB_PrimitiveVia.create's
  // real signature is (net, x, y, holeDiameter, diameter, viaType,
  // designRuleBlindViaName, locked, solderMaskExpansion) — net comes FIRST,
  // and hole/outer diameter are swapped relative to the previous (x, y,
  // outerDiameter, holeSize, net) call, which silently wrote garbage values
  // while still resolving successfully.
  it('pcb.addVia calls PCB_PrimitiveVia.create with the live-verified argument order', async () => {
    const create = vi.fn(async () => ({ primitiveId: 'via1' }));
    const dispatcher = createDispatcher(makeToolkit({ PCB_PrimitiveVia: { create } }));
    await dispatcher.dispatch('pcb.addVia', {
      x: 150,
      y: 150,
      outerDiameter: 600,
      holeSize: 300,
      netName: 'GND',
    });
    expect(create).toHaveBeenCalledWith('GND', 150, 150, 300, 600, 0, '', false, undefined);
  });

  // Live-verified against EasyEDA Pro (2026-07-07): PCB_PrimitivePolyline.create
  // never succeeded against any points/layer/width/net permutation tried live.
  // PCB_PrimitiveLine.create's real signature IS resolved: (net, layer,
  // startX, startY, endX, endY, lineWidth, locked). A multi-point track is
  // drawn as one line segment per consecutive point pair, all sharing netName.
  it('pcb.addTrack draws one PCB_PrimitiveLine segment per consecutive point pair', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ primitiveId: 'line1' })
      .mockResolvedValueOnce({ primitiveId: 'line2' });
    const dispatcher = createDispatcher(makeToolkit({ PCB_PrimitiveLine: { create } }));
    const result = (await dispatcher.dispatch('pcb.addTrack', {
      points: [
        { x: 150, y: 150 },
        { x: 200, y: 150 },
        { x: 200, y: 200 },
      ],
      layer: 1,
      width: 200,
      netName: 'GND',
    })) as { primitiveId: string; primitiveIds: string[] };

    expect(create).toHaveBeenNthCalledWith(1, 'GND', 1, 150, 150, 200, 150, 200, false);
    expect(create).toHaveBeenNthCalledWith(2, 'GND', 1, 200, 150, 200, 200, 200, false);
    expect(result).toEqual({ primitiveId: 'line1', primitiveIds: ['line1', 'line2'] });
  });

  it('pcb.addTrack rejects fewer than 2 points', async () => {
    const dispatcher = createDispatcher(makeToolkit({}));
    await expect(
      dispatcher.dispatch('pcb.addTrack', { points: [{ x: 0, y: 0 }], layer: 1, width: 200 }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  // PCB readback: field names below are the getState_* getters observed live
  // on real primitives created via the fixed pcb.addVia/pcb.addTrack and a
  // manually-placed footprint (2026-07-07), not guessed.
  it('pcb.listVias maps getState_* fields from PCB_PrimitiveVia.getAll', async () => {
    const via = {
      getState_PrimitiveId: () => 'via1',
      getState_Net: () => 'GND',
      getState_X: () => 150,
      getState_Y: () => 150,
      getState_HoleDiameter: () => 300,
      getState_Diameter: () => 600,
      getState_PrimitiveLock: () => false,
    };
    const dispatcher = createDispatcher(
      makeToolkit({ PCB_PrimitiveVia: { getAll: async () => [via] } }),
    );
    const result = (await dispatcher.dispatch('pcb.listVias', {})) as {
      total: number;
      items: Array<Record<string, unknown>>;
    };
    expect(result).toEqual({
      total: 1,
      items: [
        {
          primitiveId: 'via1',
          net: 'GND',
          x: 150,
          y: 150,
          holeDiameter: 300,
          diameter: 600,
          locked: false,
        },
      ],
    });
  });

  it('pcb.listTracks maps getState_* fields from PCB_PrimitiveLine.getAll', async () => {
    const line = {
      getState_PrimitiveId: () => 'line1',
      getState_Net: () => 'GND',
      getState_Layer: () => 1,
      getState_StartX: () => 150,
      getState_StartY: () => 150,
      getState_EndX: () => 200,
      getState_EndY: () => 150,
      getState_LineWidth: () => 200,
      getState_PrimitiveLock: () => false,
    };
    const dispatcher = createDispatcher(
      makeToolkit({ PCB_PrimitiveLine: { getAll: async () => [line] } }),
    );
    const result = (await dispatcher.dispatch('pcb.listTracks', {})) as {
      total: number;
      items: Array<Record<string, unknown>>;
    };
    expect(result).toEqual({
      total: 1,
      items: [
        {
          primitiveId: 'line1',
          net: 'GND',
          layer: 1,
          startX: 150,
          startY: 150,
          endX: 200,
          endY: 150,
          width: 200,
          locked: false,
        },
      ],
    });
  });

  it('pcb.listComponents maps getState_* fields including nested Footprint/Component', async () => {
    const comp = {
      getState_PrimitiveId: () => 'comp1',
      getState_Designator: () => 'R1',
      getState_Footprint: () => ({
        uuid: 'fp-uuid',
        libraryUuid: 'proj-uuid',
        name: 'R0603',
      }),
      getState_Component: () => ({ uuid: 'dev-uuid', libraryUuid: 'proj-uuid', name: 'Res_0603' }),
      getState_X: () => 11000,
      getState_Y: () => 6000,
      getState_Rotation: () => 0,
      getState_Layer: () => 1,
      getState_PrimitiveLock: () => false,
    };
    const dispatcher = createDispatcher(
      makeToolkit({ PCB_PrimitiveComponent: { getAll: async () => [comp] } }),
    );
    const result = (await dispatcher.dispatch('pcb.listComponents', {})) as {
      total: number;
      items: Array<Record<string, unknown>>;
    };
    expect(result).toEqual({
      total: 1,
      items: [
        {
          primitiveId: 'comp1',
          designator: 'R1',
          footprintName: 'R0603',
          footprintUuid: 'fp-uuid',
          footprintLibraryUuid: 'proj-uuid',
          deviceName: 'Res_0603',
          x: 11000,
          y: 6000,
          rotation: 0,
          layer: 1,
          locked: false,
        },
      ],
    });
  });

  it('pcb.listVias/listTracks/listComponents return an empty list when the class is unavailable (no PCB tab focused)', async () => {
    const dispatcher = createDispatcher(makeToolkit({}));
    await expect(dispatcher.dispatch('pcb.listVias', {})).resolves.toEqual({
      total: 0,
      items: [],
    });
    await expect(dispatcher.dispatch('pcb.listTracks', {})).resolves.toEqual({
      total: 0,
      items: [],
    });
    await expect(dispatcher.dispatch('pcb.listComponents', {})).resolves.toEqual({
      total: 0,
      items: [],
    });
  });

  // Live-verified (2026-07-07): PCB_PrimitiveComponent.delete() returns true
  // for ANY id, including a via's id or a completely nonexistent one, without
  // deleting it — it does not validate ownership. pcb.deleteComponent must
  // check each class's real getAllPrimitiveId() membership before deleting.
  it('pcb.deleteComponent routes each id to the PCB class that actually owns it', async () => {
    const componentDelete = vi.fn(async () => true);
    const viaDelete = vi.fn(async () => true);
    const dispatcher = createDispatcher(
      makeToolkit({
        PCB_PrimitiveComponent: {
          getAllPrimitiveId: async () => ['comp1'],
          delete: componentDelete,
        },
        PCB_PrimitiveVia: {
          getAllPrimitiveId: async () => ['via1'],
          delete: viaDelete,
        },
      }),
    );
    const result = await dispatcher.dispatch('pcb.deleteComponent', {
      primitiveIds: ['comp1', 'via1'],
    });
    expect(componentDelete).toHaveBeenCalledWith(['comp1']);
    expect(viaDelete).toHaveBeenCalledWith(['via1']);
    expect(result).toEqual({
      success: true,
      deletedCount: 2,
      deleted: ['comp1', 'via1'],
      notFound: [],
    });
  });

  it('pcb.deleteComponent reports ids not owned by any deletable class as notFound, without throwing', async () => {
    const componentDelete = vi.fn(async () => true);
    const dispatcher = createDispatcher(
      makeToolkit({
        PCB_PrimitiveComponent: {
          getAllPrimitiveId: async () => ['comp1'],
          delete: componentDelete,
        },
      }),
    );
    const result = await dispatcher.dispatch('pcb.deleteComponent', {
      primitiveIds: ['comp1', 'nonexistent'],
    });
    expect(componentDelete).toHaveBeenCalledWith(['comp1']);
    expect(result).toEqual({
      success: false,
      deletedCount: 1,
      deleted: ['comp1'],
      notFound: ['nonexistent'],
    });
  });
});
