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

/** Minimal component primitive exposing the getState_* getters modifyPrimitive snapshots. */
function fakeComponent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const state: Record<string, unknown> = {
    X: 100,
    Y: 100,
    Rotation: 0,
    Mirror: false,
    AddIntoBom: true,
    AddIntoPcb: true,
    Designator: 'C1',
    Name: 'CAP',
    UniqueId: 'uid1',
    Manufacturer: '',
    ManufacturerId: '',
    Supplier: '',
    SupplierId: '',
    OtherProperty: {},
    ...overrides,
  };
  const obj: Record<string, unknown> = {};
  for (const key of Object.keys(state)) {
    obj[`getState_${key}`] = () => state[key];
  }
  return obj;
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

  // Live-verified (2026-07-07): a generic net label (SCH_PrimitiveAttribute.
  // createNetLabel) is cosmetic and never appears here, but a power/ground
  // flag (SCH_PrimitiveComponent.createNetFlag) is a real componentType
  // 'netflag' instance with its own net/x/y — a wire landing on its
  // coordinate shorts nets exactly like landing on a foreign wire does, and
  // the wire-only check above never sees it (no wire object at that point).
  function fakeNetFlag(net: string, x: number, y: number): Record<string, unknown> {
    return {
      getState_ComponentType: () => 'netflag',
      getState_Net: () => net,
      getState_X: () => x,
      getState_Y: () => y,
    };
  }

  it('refuses addWire when a point collides with a foreign net flag', async () => {
    const create = vi.fn();
    const dispatcher = createDispatcher(
      makeToolkit({
        SCH_PrimitiveWire: { getAll: async () => [] },
        SCH_PrimitiveComponent: { getAll: async () => [fakeNetFlag('NET_GND', 400, 400)] },
      }),
    );
    await expect(
      dispatcher.dispatch('schematic.addWire', {
        netName: 'NET_E',
        points: [
          { x: 400, y: 400 },
          { x: 400, y: 450 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'NET_COLLISION' });
    expect(create).not.toHaveBeenCalled();
  });

  it('allows addWire landing on a net flag that shares the same net', async () => {
    const create = vi.fn(async () => ({ primitiveId: 'w3' }));
    const dispatcher = createDispatcher(
      makeToolkit({
        SCH_PrimitiveWire: { getAll: async () => [], create },
        SCH_PrimitiveComponent: { getAll: async () => [fakeNetFlag('NET_VCC', 500, 500)] },
      }),
    );
    await dispatcher.dispatch('schematic.addWire', {
      netName: 'NET_VCC',
      points: [
        { x: 500, y: 500 },
        { x: 500, y: 550 },
      ],
    });
    expect(create).toHaveBeenCalled();
  });

  // DATA-LOSS INCIDENT (2026-07-07, live-reproduced on a real project): the
  // first implementation round-tripped the FULL getCurrentSchematicPageInfo()
  // snapshot back through modifySchematicPageTitleBlock. That silently wiped
  // Symbol/Border/Title Block/showTitleBlock and left EasyEDA Pro's own Log
  // panel reporting "Found abnormal data, The Symbol/Device property ... is
  // incorrect" for the title block's internal element. Root cause: several
  // snapshot fields (Symbol, Device, Name, Description, Border, Width,
  // Height, Region*, Blade Width, Color, Title Block Position, Title Block,
  // all "@"-prefixed fields, ID) are read-only through this RPC — writing
  // them individually either no-ops silently (Symbol) or throws a native
  // TypeError (Border) — and including them in a full round-trip corrupts
  // the record server-side. Fix: never read/merge the snapshot at all, send
  // ONLY the caller's explicit patch, and reject any field outside a
  // confirmed-safe allowlist before it ever reaches the native call.
  it('schematic.setTitleBlock sends only the caller-supplied fields, never a snapshot round-trip', async () => {
    const modifySchematicPageTitleBlock = vi.fn(async () => true);
    const getCurrentSchematicPageInfo = vi.fn(async () => ({
      showTitleBlock: true,
      titleBlockData: {
        Company: { showTitle: false, showValue: false, value: 'EasyEDA.com' },
        Version: { showTitle: false, showValue: false, value: 'V1.0' },
        Symbol: { showTitle: false, showValue: false, value: 'Drawing-Symbol_A4' },
        Border: { showTitle: null, showValue: null, value: '1' },
        ID: {},
      },
    }));
    const dispatcher = createDispatcher(
      makeToolkit({
        DMT_Schematic: { getCurrentSchematicPageInfo, modifySchematicPageTitleBlock },
      }),
    );
    const result = await dispatcher.dispatch('schematic.setTitleBlock', {
      fields: { Company: { value: 'ACME', showValue: true } },
    });
    expect(modifySchematicPageTitleBlock).toHaveBeenCalledWith(true, {
      Company: { value: 'ACME', showValue: true },
    });
    expect(result).toEqual({ success: true });
  });

  it('schematic.setTitleBlock rejects fields outside the confirmed-safe allowlist', async () => {
    const modifySchematicPageTitleBlock = vi.fn(async () => true);
    const dispatcher = createDispatcher(
      makeToolkit({
        DMT_Schematic: {
          getCurrentSchematicPageInfo: async () => ({ showTitleBlock: true, titleBlockData: {} }),
          modifySchematicPageTitleBlock,
        },
      }),
    );
    await expect(
      dispatcher.dispatch('schematic.setTitleBlock', {
        fields: { Border: { value: '1' } },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(modifySchematicPageTitleBlock).not.toHaveBeenCalled();
  });

  it('schematic.setTitleBlock refuses when the schematic tab is not focused', async () => {
    const dispatcher = createDispatcher(
      makeToolkit({ DMT_Schematic: { getCurrentSchematicPageInfo: async () => null } }),
    );
    await expect(
      dispatcher.dispatch('schematic.setTitleBlock', { fields: {} }),
    ).rejects.toMatchObject({ code: 'SCHEMATIC_NOT_FOCUSED' });
  });

  // Live-verified (2026-07-07): PCB_PrimitiveComponent.create() never
  // resolves, but component placement isn't actually blocked — the real
  // mechanism is schematic (addIntoPcb) -> SCH_Document.importChanges()
  // (called with the schematic document focused) -> pcb.listComponents.
  it('schematic.syncToPcb calls SCH_Document.importChanges when the schematic is focused', async () => {
    const importChanges = vi.fn(async () => true);
    const dispatcher = createDispatcher(
      makeToolkit({
        DMT_Schematic: { getCurrentSchematicInfo: async () => ({ uuid: 'sch-1' }) },
        SCH_Document: { importChanges },
      }),
    );
    const result = await dispatcher.dispatch('schematic.syncToPcb', {});
    expect(importChanges).toHaveBeenCalled();
    expect(result).toEqual({ synced: true });
  });

  it('schematic.syncToPcb refuses when the schematic tab is not focused', async () => {
    const importChanges = vi.fn(async () => true);
    const dispatcher = createDispatcher(
      makeToolkit({
        DMT_Schematic: { getCurrentSchematicInfo: async () => null },
        SCH_Document: { importChanges },
      }),
    );
    await expect(dispatcher.dispatch('schematic.syncToPcb', {})).rejects.toMatchObject({
      code: 'SCHEMATIC_NOT_FOCUSED',
    });
    expect(importChanges).not.toHaveBeenCalled();
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

  // Live-verified (2026-07-07): SCH_PrimitiveCircle's field order was
  // recovered by reading the minified source of .modify() via .toString():
  // create(CenterX, CenterY, Radius, Color, FillColor, LineWidth, LineType,
  // FillStyle).
  it('schematic.addCircle calls SCH_PrimitiveCircle.create with the recovered argument order', async () => {
    const create = vi.fn(async () => ({ primitiveId: 'circle1' }));
    const dispatcher = createDispatcher(makeToolkit({ SCH_PrimitiveCircle: { create } }));
    await dispatcher.dispatch('schematic.addCircle', {
      centerX: 500,
      centerY: 900,
      radius: 30,
      color: '#800080',
    });
    expect(create).toHaveBeenCalledWith(500, 900, 30, '#800080', 'none', 1, 0, 'none');
  });

  // Live-verified (2026-07-07): SCH_PrimitivePolygon's field order was
  // recovered by reading the minified source of .modify() via .toString():
  // create(Line, Color, FillColor, LineWidth, LineType) — `line` is a flat
  // [x1,y1,x2,y2,...] array of vertices, same shape as SCH_PrimitiveWire.
  it('schematic.addPolygon calls SCH_PrimitivePolygon.create with a flattened points array', async () => {
    const create = vi.fn(async () => ({ primitiveId: 'poly1' }));
    const dispatcher = createDispatcher(makeToolkit({ SCH_PrimitivePolygon: { create } }));
    await dispatcher.dispatch('schematic.addPolygon', {
      points: [
        { x: 400, y: 800 },
        { x: 450, y: 850 },
        { x: 400, y: 900 },
      ],
      color: '#008000',
    });
    expect(create).toHaveBeenCalledWith([400, 800, 450, 850, 400, 900], '#008000', 'none', 1, 0);
  });

  // Live-verified (2026-07-07): SCH_PrimitiveText.create(X, Y, Content,
  // Rotation, TextColor, FontName, FontSize, Bold, Italic, UnderLine,
  // AlignMode) — recovered by reading getState_*/setState_* off a created
  // instance. Untyped numeric placeholders create nothing despite {ok:true}.
  it('schematic.addText calls SCH_PrimitiveText.create with the live-verified argument order', async () => {
    const create = vi.fn(async () => ({ primitiveId: 'text1' }));
    const dispatcher = createDispatcher(makeToolkit({ SCH_PrimitiveText: { create } }));
    await dispatcher.dispatch('schematic.addText', {
      x: 200,
      y: 600,
      content: 'SECTION A',
      color: '#0000FF',
      fontName: 'Arial',
      fontSize: 20,
    });
    expect(create).toHaveBeenCalledWith(
      200,
      600,
      'SECTION A',
      0,
      '#0000FF',
      'Arial',
      20,
      false,
      false,
      false,
      0,
    );
  });

  // Live-verified (2026-07-07): SCH_PrimitiveRectangle's field order was
  // recovered by reading the minified source of .modify() via .toString() —
  // its setState_* call sequence gives create(TopLeftX, TopLeftY, Width,
  // Height, CornerRadius, Rotation, Color, FillColor, LineWidth, LineType,
  // FillStyle).
  it('schematic.addRectangle calls SCH_PrimitiveRectangle.create with the recovered argument order', async () => {
    const create = vi.fn(async () => ({ primitiveId: 'rect1' }));
    const dispatcher = createDispatcher(makeToolkit({ SCH_PrimitiveRectangle: { create } }));
    await dispatcher.dispatch('schematic.addRectangle', {
      x: 300,
      y: 700,
      width: 200,
      height: 100,
      color: '#FF0000',
      lineWidth: 2,
    });
    expect(create).toHaveBeenCalledWith(300, 700, 200, 100, 0, 0, '#FF0000', 'none', 2, 0, 'none');
  });

  // Live-verified (2026-07-07): PCB_PrimitiveString's field order was
  // recovered by reading the minified source of .modify() via .toString() —
  // its destructured input gives create(Layer, X, Y, Text, FontFamily,
  // FontSize, LineWidth, AlignMode, Rotation, Reverse, Expansion, Mirror,
  // PrimitiveLock).
  it('pcb.addText calls PCB_PrimitiveString.create with the recovered argument order', async () => {
    const create = vi.fn(async () => ({ primitiveId: 'str1' }));
    const dispatcher = createDispatcher(makeToolkit({ PCB_PrimitiveString: { create } }));
    await dispatcher.dispatch('pcb.addText', {
      layer: 3,
      x: 100,
      y: 5000,
      text: 'TEST',
    });
    expect(create).toHaveBeenCalledWith(
      3,
      100,
      5000,
      'TEST',
      'NotoSansMonoCJKsc-Regular',
      1,
      0.15,
      0,
      0,
      false,
      0,
      false,
      false,
    );
  });

  // pcb.addSilkscreenLine reuses PCB_PrimitiveLine.create (same primitive
  // pcb.addTrack draws copper with) but always with an empty net name, so it
  // never appears in the netlist/ratsnest — live-verified on the Top
  // Silkscreen layer (2026-07-07).
  it('pcb.addSilkscreenLine calls PCB_PrimitiveLine.create with an empty net name', async () => {
    const create = vi.fn(async () => ({ primitiveId: 'line3' }));
    const dispatcher = createDispatcher(makeToolkit({ PCB_PrimitiveLine: { create } }));
    await dispatcher.dispatch('pcb.addSilkscreenLine', {
      layer: 3,
      startX: 90,
      startY: 4990,
      endX: 110,
      endY: 4990,
    });
    expect(create).toHaveBeenCalledWith('', 3, 90, 4990, 110, 4990, 0.2, false);
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

  describe('schematic.modifyPrimitive wire-following', () => {
    it('translates a wire endpoint that was touching the moved component\'s old pin coordinate', async () => {
      const modify = vi.fn(async () => true);
      const get = vi.fn(async () => fakeComponent({ X: 100, Y: 100 }));
      const getAllPinsByPrimitiveId = vi.fn(async () => [
        { pinNumber: '1', pinName: 'P1', x: 100, y: 100, rotation: 0 },
      ]);
      const wire = fakeWire('w1', 'NET_A', [100, 100, 150, 100]);
      const wireModify = vi.fn(async () => true);
      const dispatcher = createDispatcher(
        makeToolkit({
          SCH_PrimitiveComponent: { get, modify, getAllPinsByPrimitiveId },
          SCH_PrimitiveWire: { getAll: async () => [wire], modify: wireModify },
        }),
      );

      const result = (await dispatcher.dispatch('schematic.modifyPrimitive', {
        primitiveId: 'comp1',
        property: { x: 300, y: 300 },
      })) as { followedWireIds: string[]; wireFollowFailures: string[] };

      expect(modify).toHaveBeenCalledWith(
        'comp1',
        expect.objectContaining({ x: 300, y: 300 }),
      );
      // Only the endpoint that was at the pin's old coordinate (100,100) moves;
      // the wire's other endpoint (150,100), which wasn't touching this pin, stays put.
      expect(wireModify).toHaveBeenCalledWith(
        'w1',
        expect.objectContaining({ line: [300, 300, 150, 100], net: 'NET_A' }),
      );
      expect(result.followedWireIds).toEqual(['w1']);
      expect(result.wireFollowFailures).toEqual([]);
    });

    it('does not touch wires when the modify does not change x/y', async () => {
      const modify = vi.fn(async () => true);
      const get = vi.fn(async () => fakeComponent({ X: 100, Y: 100, Designator: 'C1' }));
      const getAllPinsByPrimitiveId = vi.fn(async () => [
        { pinNumber: '1', pinName: 'P1', x: 100, y: 100, rotation: 0 },
      ]);
      const wireModify = vi.fn(async () => true);
      const dispatcher = createDispatcher(
        makeToolkit({
          SCH_PrimitiveComponent: { get, modify, getAllPinsByPrimitiveId },
          SCH_PrimitiveWire: { getAll: async () => [fakeWire('w1', 'NET_A', [100, 100, 150, 100])], modify: wireModify },
        }),
      );

      await dispatcher.dispatch('schematic.modifyPrimitive', {
        primitiveId: 'comp1',
        property: { designator: 'C2' },
      });

      expect(getAllPinsByPrimitiveId).not.toHaveBeenCalled();
      expect(wireModify).not.toHaveBeenCalled();
    });
  });

  describe('schematic.modifyPrimitive on text primitives', () => {
    it('snapshots and merges a text primitive instead of falling through to the component/wire fallback', async () => {
      const textModify = vi.fn(async () => true);
      const textGet = vi.fn(async () => ({
        getState_X: () => 200,
        getState_Y: () => 600,
        getState_Content: () => 'OLD TITLE',
        getState_Rotation: () => 0,
        getState_TextColor: () => '#0000FF',
        getState_FontName: () => 'Arial',
        getState_FontSize: () => 20,
        getState_Bold: () => false,
        getState_Italic: () => false,
        getState_UnderLine: () => false,
        getState_AlignMode: () => 0,
      }));
      // No SCH_PrimitiveComponent/SCH_PrimitiveWire registered — proves the text
      // branch handles this, not the generic component/wire fallback.
      const dispatcher = createDispatcher(
        makeToolkit({ SCH_PrimitiveText: { get: textGet, modify: textModify } }),
      );

      await dispatcher.dispatch('schematic.modifyPrimitive', {
        primitiveId: 'text1',
        property: { content: 'NEW TITLE' },
      });

      expect(textModify).toHaveBeenCalledWith(
        'text1',
        expect.objectContaining({
          x: 200,
          y: 600,
          content: 'NEW TITLE',
          fontName: 'Arial',
          fontSize: 20,
        }),
      );
    });
  });

  describe('schematic.listRectangles', () => {
    it('lists rectangles with their coordinates via the live-confirmed TopLeftX/TopLeftY keys', async () => {
      const getAll = vi.fn(async () => [
        {
          getState_PrimitiveId: () => 'rect1',
          getState_TopLeftX: () => 100,
          getState_TopLeftY: () => 200,
          getState_Width: () => 300,
          getState_Height: () => 150,
          getState_Rotation: () => 0,
        },
      ]);
      const dispatcher = createDispatcher(makeToolkit({ SCH_PrimitiveRectangle: { getAll } }));

      const result = await dispatcher.dispatch('schematic.listRectangles', {});

      expect(result).toEqual({
        total: 1,
        items: [{ primitiveId: 'rect1', x: 100, y: 200, width: 300, height: 150, rotation: 0 }],
      });
    });

    it('falls back to X/Y if TopLeftX/TopLeftY are not exposed', async () => {
      const getAll = vi.fn(async () => [
        {
          getState_PrimitiveId: () => 'rect1',
          getState_X: () => 100,
          getState_Y: () => 200,
          getState_Width: () => 300,
          getState_Height: () => 150,
          getState_Rotation: () => 0,
        },
      ]);
      const dispatcher = createDispatcher(makeToolkit({ SCH_PrimitiveRectangle: { getAll } }));

      const result = await dispatcher.dispatch('schematic.listRectangles', {});

      expect(result).toEqual({
        total: 1,
        items: [{ primitiveId: 'rect1', x: 100, y: 200, width: 300, height: 150, rotation: 0 }],
      });
    });

    it('degrades to an empty list when SCH_PrimitiveRectangle is not available', async () => {
      const dispatcher = createDispatcher(makeToolkit({}));

      const result = await dispatcher.dispatch('schematic.listRectangles', {});

      expect(result).toEqual({ total: 0, items: [] });
    });
  });

  describe('schematic.placeComponent subPartName', () => {
    it('rejects a subPartName request with NOT_IMPLEMENTED instead of silently dropping it', async () => {
      const create = vi.fn(async () => ({ primitiveId: 'comp1' }));
      const dispatcher = createDispatcher(
        makeToolkit({ SCH_PrimitiveComponent: { create } }),
      );

      await expect(
        dispatcher.dispatch('schematic.placeComponent', {
          deviceItem: { uuid: 'dev-1', libraryUuid: 'lib-1' },
          x: 0,
          y: 0,
          subPartName: 'STM32F401CCU6.2',
        }),
      ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
      expect(create).not.toHaveBeenCalled();
    });

    it('places normally when subPartName is omitted', async () => {
      const create = vi.fn(async () => ({ primitiveId: 'comp1' }));
      const dispatcher = createDispatcher(
        makeToolkit({ SCH_PrimitiveComponent: { create } }),
      );

      const result = await dispatcher.dispatch('schematic.placeComponent', {
        deviceItem: { uuid: 'dev-1', libraryUuid: 'lib-1' },
        x: 10,
        y: 20,
      });

      expect(create).toHaveBeenCalledWith({ uuid: 'dev-1', libraryUuid: 'lib-1' }, 10, 20);
      expect(result).toMatchObject({ primitiveId: 'comp1' });
    });
  });
});
