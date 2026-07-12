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

function fakeSchematicPin(pinNumber: string, x: number, y: number): Record<string, unknown> {
  return {
    getState_PinNumber: () => pinNumber,
    getState_X: () => x,
    getState_Y: () => y,
    getState_OtherProperty: () => ({}),
  };
}

function fakeSchematicPart(
  designator: string,
  pins: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    getState_Designator: () => designator,
    getState_ComponentType: () => 'part',
    getAllPins: async () => pins,
  };
}

describe('createDispatcher', () => {
  it('returns a dispatcher with a sorted, non-empty method list and a build id', () => {
    const dispatcher = createDispatcher(makeToolkit({}));
    expect(dispatcher.methodList.length).toBeGreaterThan(40);
    expect(dispatcher.methodList).toEqual([...dispatcher.methodList].sort());
    expect(dispatcher.buildId).toBeTruthy();
    expect(dispatcher.methodList).toContain('schematic.addWire');
    expect(dispatcher.methodList).toContain('schematic.getPrimitiveSnapshot');
    expect(dispatcher.methodList).toContain('schematic.restorePrimitiveSnapshot');
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
    expect(create).toHaveBeenCalledWith(
      [10, 20, 10, 40],
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it('suppresses duplicate net names when addWire lands on a same-net flag', async () => {
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
    expect(create).toHaveBeenCalledWith(
      [500, 500, 500, 550],
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it('keeps the net name for a disconnected new named wire seed', async () => {
    const create = vi.fn(async () => ({ primitiveId: 'w4' }));
    const dispatcher = createDispatcher(
      makeToolkit({
        SCH_PrimitiveWire: { getAll: async () => [], create },
        SCH_PrimitiveComponent: { getAll: async () => [] },
      }),
    );
    await dispatcher.dispatch('schematic.addWire', {
      netName: 'NET_NEW',
      points: [
        { x: 700, y: 700 },
        { x: 700, y: 760 },
      ],
    });
    expect(create).toHaveBeenCalledWith(
      [700, 700, 700, 760],
      'NET_NEW',
      undefined,
      undefined,
      undefined,
    );
  });

  it('schematic.listNets reports pins joined only by an unnamed wire', async () => {
    const u1 = fakeSchematicPart('U1', [fakeSchematicPin('XL1', 100, 200)]);
    const x1 = fakeSchematicPart('X1', [fakeSchematicPin('1', 300, 200)]);
    const dispatcher = createDispatcher(
      makeToolkit({
        SCH_PrimitiveComponent: { getAll: async () => [u1, x1] },
        SCH_PrimitiveWire: { getAll: async () => [fakeWire('w1', '', [100, 200, 300, 200])] },
      }),
    );

    await expect(dispatcher.dispatch('schematic.listNets', {})).resolves.toEqual([
      {
        netName: 'N$1',
        nodes: [
          {
            component: 'U1',
            pin: 'XL1',
            x: 100,
            y: 200,
            source: 'coordinate-fallback',
          },
          {
            component: 'X1',
            pin: '1',
            x: 300,
            y: 200,
            source: 'coordinate-fallback',
          },
        ],
      },
    ]);
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

  it('schematic.listNets uses a connected net port name instead of an anonymous name', async () => {
    const u1 = fakeSchematicPart('U1', [fakeSchematicPin('XL1', 100, 200)]);
    const x1 = fakeSchematicPart('X1', [fakeSchematicPin('1', 300, 200)]);
    const port = {
      getState_ComponentType: () => 'netport',
      getState_Net: () => 'XL1',
      getState_X: () => 100,
      getState_Y: () => 200,
    };
    const dispatcher = createDispatcher(
      makeToolkit({
        SCH_PrimitiveComponent: { getAll: async () => [u1, x1, port] },
        SCH_PrimitiveWire: { getAll: async () => [fakeWire('w1', '', [100, 200, 300, 200])] },
      }),
    );

    const result = (await dispatcher.dispatch('schematic.listNets', {})) as Array<{
      netName: string;
      nodes: Array<{ component: string; pin: string }>;
    }>;
    expect(result).toEqual([
      {
        netName: 'XL1',
        nodes: [
          expect.objectContaining({ component: 'U1', pin: 'XL1' }),
          expect.objectContaining({ component: 'X1', pin: '1' }),
        ],
      },
    ]);
  });

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

  it('design.drc translates an inactive PCB canvas failure into CONTEXT_UNAVAILABLE', async () => {
    const check = vi.fn(async () => {
      throw new Error('localized message-bus error');
    });
    const dispatcher = createDispatcher(makeToolkit({ PCB_Drc: { check } }));

    await expect(dispatcher.dispatch('design.drc', {})).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
      message: 'PCB DRC is unavailable in the current editor context.',
      suggestion: 'Open and focus a PCB document, then retry design.drc.',
      data: { cause: 'localized message-bus error' },
    });
    expect(check).toHaveBeenCalledWith(true, true, true);
  });

  it('design.ruleCheck falls back from inactive PCB DRC to the schematic checker', async () => {
    const pcbCheck = vi.fn(async () => {
      throw new Error('no PCB canvas');
    });
    const schematicCheck = vi.fn(async () => [{ type: 'warn', count: 2 }]);
    const dispatcher = createDispatcher(
      makeToolkit({
        PCB_Drc: { check: pcbCheck },
        SCH_Drc: { check: schematicCheck },
      }),
    );

    await expect(dispatcher.dispatch('design.ruleCheck', {})).resolves.toMatchObject({
      totalViolations: 2,
      warningCount: 2,
      errorCount: 0,
      passed: true,
    });
    expect(pcbCheck).toHaveBeenCalledWith(true, true, true);
    expect(schematicCheck).toHaveBeenCalledWith(true, true, true);
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
      undefined,
    );
  });

  it('rejects schematic text alignMode values outside the documented 1..9 enum', async () => {
    const create = vi.fn();
    const dispatcher = createDispatcher(makeToolkit({ SCH_PrimitiveText: { create } }));

    await expect(
      dispatcher.dispatch('schematic.addText', {
        x: 10,
        y: 20,
        content: 'INVALID ALIGN',
        alignMode: 0,
      }),
    ).rejects.toThrow('alignMode must be an integer from 1 through 9');
    expect(create).not.toHaveBeenCalled();
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

  it('schematic.listComponents excludes sheet/netflag primitives and resolves library display metadata', async () => {
    const makeSchematicComponent = (state: Record<string, unknown>) => {
      const component: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(state)) {
        component[`getState_${key}`] = () => value;
      }
      return component;
    };
    const frame = makeSchematicComponent({
      PrimitiveId: 'frame1',
      ComponentType: 'sheet',
      Component: { uuid: 'frame-dev', libraryUuid: 'lib', name: 'Drawing-Symbol_A4' },
    });
    const netflag = makeSchematicComponent({
      PrimitiveId: 'flag1',
      ComponentType: 'netflag',
      Component: { uuid: 'gnd-dev', libraryUuid: 'lib', name: 'Ground-GND' },
    });
    const resistor = makeSchematicComponent({
      PrimitiveId: 'r1',
      ComponentType: 'part',
      Component: { uuid: 'res-dev', libraryUuid: 'lib', name: 'RES_1K' },
      Symbol: { name: 'RES' },
      Footprint: { uuid: 'fp-r', libraryUuid: 'lib', name: 'R0805' },
      Designator: 'R1',
      Name: '={Value}',
      Manufacturer: 'Example',
      ManufacturerId: 'RES-1K',
      SupplierId: 'C1',
      OtherProperty: { Value: '1kΩ', Datasheet: 'https://example.invalid/r1' },
      X: 100,
      Y: 200,
      Rotation: 0,
    });
    const timer = makeSchematicComponent({
      PrimitiveId: 'u1',
      ComponentType: 'part',
      Component: { uuid: 'timer-dev', libraryUuid: 'lib', name: 'NE555P' },
      Symbol: { name: 'NE555P' },
      Footprint: null,
      Designator: 'U1',
      Name: '={Manufacturer Part}',
      Manufacturer: 'TI',
      ManufacturerId: 'NE555P',
      SupplierId: 'C2',
      OtherProperty: { 'Supplier Footprint': 'DIP-8' },
      X: 300,
      Y: 400,
      Rotation: 0,
    });
    const dispatcher = createDispatcher(
      makeToolkit({
        SCH_PrimitiveComponent: { getAll: async () => [frame, netflag, resistor, timer] },
      }),
    );

    const result = (await dispatcher.dispatch('schematic.listComponents', {})) as {
      total: number;
      items: Array<Record<string, unknown>>;
    };

    expect(result.total).toBe(2);
    expect(result.items).toEqual([
      expect.objectContaining({
        primitiveId: 'r1',
        reference: 'R1',
        value: '1kΩ',
        footprint: 'R0805',
        deviceName: 'RES_1K',
      }),
      expect.objectContaining({
        primitiveId: 'u1',
        reference: 'U1',
        value: 'NE555P',
        footprint: 'DIP-8',
        deviceName: 'NE555P',
      }),
    ]);
  });

  it('schematic.listComponents paginates after filtering non-BOM primitives', async () => {
    const makePart = (id: string, ref: string) => ({
      getState_PrimitiveId: () => id,
      getState_ComponentType: () => 'part',
      getState_Component: () => ({ uuid: `${id}-dev`, libraryUuid: 'lib', name: id }),
      getState_Designator: () => ref,
      getState_Name: () => id,
      getState_OtherProperty: () => ({}),
    });
    const frame = {
      getState_PrimitiveId: () => 'frame',
      getState_ComponentType: () => 'sheet',
      getState_Component: () => ({ name: 'Drawing-Symbol_A4' }),
    };
    const dispatcher = createDispatcher(
      makeToolkit({
        SCH_PrimitiveComponent: {
          getAll: async () => [frame, makePart('a', 'R1'), makePart('b', 'R2')],
        },
      }),
    );

    await expect(
      dispatcher.dispatch('schematic.listComponents', { limit: 1, offset: 1 }),
    ).resolves.toMatchObject({
      total: 2,
      items: [expect.objectContaining({ primitiveId: 'b', reference: 'R2' })],
    });
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

  describe('schematic primitive transaction snapshots', () => {
    it('captures a complete component property snapshot', async () => {
      const component = fakeComponent({
        ComponentType: 'part',
        X: 120,
        Y: 240,
        Designator: 'R7',
        Name: '10k',
        OtherProperty: { Footprint: 'R0603' },
      });
      const dispatcher = createDispatcher(
        makeToolkit({ SCH_PrimitiveComponent: { get: async () => component } }),
      );

      const snapshot = (await dispatcher.dispatch('schematic.getPrimitiveSnapshot', {
        primitiveId: 'r7-id',
      })) as Record<string, any>;

      expect(snapshot).toMatchObject({
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'r7-id',
        primitiveKind: 'component',
        componentType: 'part',
        property: {
          x: 120,
          y: 240,
          designator: 'R7',
          name: '10k',
          otherProperty: { Footprint: 'R0603' },
        },
      });
    });

    it('captures a wire snapshot after component lookup misses', async () => {
      const wire = fakeWire('w1', 'NET_A', [0, 0, 20, 0]);
      const dispatcher = createDispatcher(
        makeToolkit({
          SCH_PrimitiveComponent: { get: async () => undefined },
          SCH_PrimitiveWire: { get: async () => wire },
        }),
      );

      const snapshot = await dispatcher.dispatch('schematic.getPrimitiveSnapshot', {
        primitiveId: 'w1',
      });

      expect(snapshot).toEqual({
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'w1',
        primitiveKind: 'wire',
        property: {
          line: [0, 0, 20, 0],
          net: 'NET_A',
          color: '#000000',
          lineWidth: 1,
          lineType: 0,
        },
      });
    });

    it('restores an exact snapshot through the normal safe modify path', async () => {
      const modify = vi.fn(async () => true);
      const component = fakeComponent({
        ComponentType: 'part',
        X: 100,
        Y: 200,
        Designator: 'R1',
        Name: '1k',
      });
      const dispatcher = createDispatcher(
        makeToolkit({
          SCH_PrimitiveComponent: {
            get: async () => component,
            modify,
            getAllPinsByPrimitiveId: async () => [],
          },
        }),
      );
      const snapshot = await dispatcher.dispatch('schematic.getPrimitiveSnapshot', {
        primitiveId: 'r1-id',
      });

      const result = (await dispatcher.dispatch('schematic.restorePrimitiveSnapshot', {
        snapshot,
      })) as Record<string, any>;

      expect(modify).toHaveBeenCalledWith(
        'r1-id',
        expect.objectContaining({ x: 100, y: 200, designator: 'R1', name: '1k' }),
      );
      expect(result).toMatchObject({
        restored: true,
        snapshot: {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'r1-id',
          primitiveKind: 'component',
        },
      });
    });

    it('rejects invented or malformed restore payloads', async () => {
      const dispatcher = createDispatcher(makeToolkit({}));
      await expect(
        dispatcher.dispatch('schematic.restorePrimitiveSnapshot', {
          snapshot: { schemaVersion: 'wrong', primitiveId: 'p1', property: {} },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    });
  });

  describe('schematic batch primitive support', () => {
    it('captures rectangle state in a transaction-safe snapshot', async () => {
      const rectangle = {
        getState_PrimitiveId: () => 'rect1',
        getState_TopLeftX: () => 100,
        getState_TopLeftY: () => -200,
        getState_Width: () => 300,
        getState_Height: () => 150,
        getState_CornerRadius: () => 5,
        getState_Rotation: () => 0,
        getState_Color: () => '#000000',
        getState_FillColor: () => 'none',
        getState_LineWidth: () => 1,
        getState_LineType: () => 0,
        getState_FillStyle: () => 'none',
      };
      const dispatcher = createDispatcher(
        makeToolkit({ SCH_PrimitiveRectangle: { get: async () => rectangle } }),
      );

      const snapshot = await dispatcher.dispatch('schematic.getPrimitiveSnapshot', {
        primitiveId: 'rect1',
      });

      expect(snapshot).toEqual({
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'rect1',
        primitiveKind: 'rectangle',
        property: {
          x: 100,
          y: -200,
          width: 300,
          height: 150,
          cornerRadius: 5,
          rotation: 0,
          color: '#000000',
          fillColor: 'none',
          lineWidth: 1,
          lineType: 0,
          fillStyle: 'none',
        },
      });
    });

    it('captures state exposed as direct lower-camel properties after a native modify', async () => {
      const text = {
        primitiveId: 'text1',
        x: 100,
        y: 200,
        content: 'TITLE',
        rotation: 0,
        textColor: '#000000',
        fontName: 'Arial',
        fontSize: 12,
        bold: false,
        italic: false,
        underLine: false,
        alignMode: 3,
      };
      const dispatcher = createDispatcher(
        makeToolkit({ SCH_PrimitiveText: { get: async () => text } }),
      );

      const snapshot = await dispatcher.dispatch('schematic.getPrimitiveSnapshot', {
        primitiveId: 'text1',
      });

      expect(snapshot).toMatchObject({
        primitiveKind: 'text',
        property: {
          x: 100,
          y: 200,
          content: 'TITLE',
          color: '#000000',
          underline: false,
          alignMode: 3,
        },
      });
    });

    it('falls back when a retained getState getter returns undefined after modify', async () => {
      const text = {
        getState_PrimitiveId: () => 'text-fallback',
        getState_X: () => 100,
        getState_Y: () => 200,
        getState_Content: () => 'TITLE',
        getState_Rotation: () => 0,
        getState_TextColor: () => '#000000',
        getState_FontName: () => 'Arial',
        getState_FontSize: () => 12,
        getState_Bold: () => false,
        getState_Italic: () => false,
        getState_UnderLine: () => false,
        getState_AlignMode: () => undefined,
        alignMode: 3,
      };
      const dispatcher = createDispatcher(
        makeToolkit({ SCH_PrimitiveText: { get: async () => text } }),
      );

      const snapshot = await dispatcher.dispatch('schematic.getPrimitiveSnapshot', {
        primitiveId: 'text-fallback',
      });

      expect(snapshot).toMatchObject({
        primitiveKind: 'text',
        property: { alignMode: 3 },
      });
    });

    it('keeps the public get() alignment while using getAll() only for missing fields', async () => {
      const publicText = {
        getState_PrimitiveId: () => 'text-persistent',
        getState_X: () => 100,
        getState_Y: () => 200,
        getState_Content: () => undefined,
        getState_Rotation: () => 0,
        getState_TextColor: () => '#000000',
        getState_FontName: () => 'Arial',
        getState_FontSize: () => 12,
        getState_Bold: () => false,
        getState_Italic: () => false,
        getState_UnderLine: () => false,
        getState_AlignMode: () => 3,
      };
      const persistent = {
        ...publicText,
        getState_Content: () => 'TITLE FROM DOCUMENT STATE',
        getState_AlignMode: () => 11,
      };
      const get = vi.fn(async () => publicText);
      const getAll = vi.fn(async () => [persistent]);
      const dispatcher = createDispatcher(makeToolkit({ SCH_PrimitiveText: { get, getAll } }));

      const snapshot = await dispatcher.dispatch('schematic.getPrimitiveSnapshot', {
        primitiveId: 'text-persistent',
      });

      expect(get).toHaveBeenCalledWith('text-persistent');
      expect(getAll).toHaveBeenCalledOnce();
      expect(snapshot).toMatchObject({
        primitiveKind: 'text',
        property: {
          content: 'TITLE FROM DOCUMENT STATE',
          alignMode: 3,
        },
      });
    });

    it('ignores an unrelated text wrapper returned for a rectangle ID', async () => {
      const unrelatedText = {
        getState_PrimitiveId: () => 'different-text',
        getState_AlignMode: () => 3,
      };
      const rectangle = {
        getState_PrimitiveId: () => 'rect-target',
        getState_TopLeftX: () => 100,
        getState_TopLeftY: () => -200,
        getState_Width: () => 300,
        getState_Height: () => 150,
        getState_CornerRadius: () => 0,
        getState_Rotation: () => 0,
        getState_Color: () => '#000000',
        getState_FillColor: () => 'none',
        getState_LineWidth: () => 1,
        getState_LineType: () => 0,
        getState_FillStyle: () => 'none',
      };
      const dispatcher = createDispatcher(
        makeToolkit({
          SCH_PrimitiveText: {
            get: async () => unrelatedText,
            getAll: async () => [],
          },
          SCH_PrimitiveRectangle: {
            get: async (id: string) => (id === 'rect-target' ? rectangle : undefined),
          },
        }),
      );

      const snapshot = await dispatcher.dispatch('schematic.getPrimitiveSnapshot', {
        primitiveId: 'rect-target',
      });

      expect(snapshot).toMatchObject({
        primitiveId: 'rect-target',
        primitiveKind: 'rectangle',
        property: { x: 100, y: -200, width: 300, height: 150 },
      });
    });

    it('continues past a same-ID text wrapper without public alignment and finds the rectangle', async () => {
      const misleadingText = {
        getState_PrimitiveId: () => 'rect-same-id',
        getState_AlignMode: () => undefined,
      };
      const rectangle = {
        getState_PrimitiveId: () => 'rect-same-id',
        getState_TopLeftX: () => 100,
        getState_TopLeftY: () => -200,
        getState_Width: () => 300,
        getState_Height: () => 150,
        getState_CornerRadius: () => 0,
        getState_Rotation: () => 0,
        getState_Color: () => '#000000',
        getState_FillColor: () => 'none',
        getState_LineWidth: () => 1,
        getState_LineType: () => 0,
        getState_FillStyle: () => 'none',
      };
      const dispatcher = createDispatcher(
        makeToolkit({
          SCH_PrimitiveText: {
            get: async () => misleadingText,
            getAll: async () => [],
          },
          SCH_PrimitiveRectangle: {
            get: async (id: string) => (id === 'rect-same-id' ? rectangle : undefined),
          },
        }),
      );

      const snapshot = await dispatcher.dispatch('schematic.getPrimitiveSnapshot', {
        primitiveId: 'rect-same-id',
      });

      expect(snapshot).toMatchObject({
        primitiveId: 'rect-same-id',
        primitiveKind: 'rectangle',
        property: { x: 100, y: -200, width: 300, height: 150 },
      });
    });

    it('uses expectedPrimitiveKind to bypass a misleading text wrapper with the same ID', async () => {
      const misleadingText = {
        getState_PrimitiveId: () => 'rect-target',
        getState_Content: () => 'NOT A REAL TEXT',
        getState_AlignMode: () => undefined,
      };
      const rectangle = {
        getState_PrimitiveId: () => 'rect-target',
        getState_TopLeftX: () => 100,
        getState_TopLeftY: () => -200,
        getState_Width: () => 300,
        getState_Height: () => 150,
        getState_CornerRadius: () => 0,
        getState_Rotation: () => 0,
        getState_Color: () => '#000000',
        getState_FillColor: () => 'none',
        getState_LineWidth: () => 1,
        getState_LineType: () => 0,
        getState_FillStyle: () => 'none',
      };
      const textGet = vi.fn(async () => misleadingText);
      const dispatcher = createDispatcher(
        makeToolkit({
          SCH_PrimitiveText: { get: textGet, getAll: async () => [] },
          SCH_PrimitiveRectangle: { get: async () => rectangle },
        }),
      );

      const snapshot = await dispatcher.dispatch('schematic.getPrimitiveSnapshot', {
        primitiveId: 'rect-target',
        expectedPrimitiveKind: 'rectangle',
      });

      expect(textGet).not.toHaveBeenCalled();
      expect(snapshot).toMatchObject({
        primitiveId: 'rect-target',
        primitiveKind: 'rectangle',
        property: { x: 100, y: -200, width: 300, height: 150 },
      });
    });

    it('lists addressable primitive IDs by kind', async () => {
      const dispatcher = createDispatcher(
        makeToolkit({
          SCH_PrimitiveText: {
            getAll: async () => [
              { getState_PrimitiveId: () => 'text2' },
              { getState_PrimitiveId: () => 'text1' },
            ],
          },
        }),
      );

      await expect(
        dispatcher.dispatch('schematic.listPrimitiveIds', { primitiveKind: 'text' }),
      ).resolves.toEqual({ primitiveKind: 'text', primitiveIds: ['text1', 'text2'] });
    });

    it('routes deletion to the primitive class that owns the ID', async () => {
      const componentDelete = vi.fn();
      const textDelete = vi.fn(async () => true);
      const dispatcher = createDispatcher(
        makeToolkit({
          SCH_PrimitiveComponent: { get: async () => undefined, delete: componentDelete },
          SCH_PrimitiveText: {
            get: async (id: string) =>
              id === 'text1' ? { getState_PrimitiveId: () => id } : undefined,
            delete: textDelete,
          },
        }),
      );

      const result = await dispatcher.dispatch('schematic.deletePrimitive', {
        primitiveIds: ['text1', 'missing'],
      });

      expect(componentDelete).not.toHaveBeenCalled();
      expect(textDelete).toHaveBeenCalledWith(['text1']);
      expect(result).toEqual({
        success: false,
        deleted: ['text1'],
        notFound: ['missing'],
      });
    });

    it('recreates a wire snapshot and returns the new addressable snapshot', async () => {
      const wires: Array<Record<string, unknown>> = [];
      const create = vi.fn(async (line: number[], net: string) => {
        const wire = fakeWire('wire-new', net, line);
        wires.push(wire);
        return wire;
      });
      const dispatcher = createDispatcher(
        makeToolkit({
          SCH_PrimitiveWire: {
            create,
            getAll: async () => wires,
            get: async (id: string) => wires.find((wire) => wire.getState_PrimitiveId?.() === id),
          },
        }),
      );

      const result = await dispatcher.dispatch('schematic.recreatePrimitiveSnapshot', {
        snapshot: {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'wire-old',
          primitiveKind: 'wire',
          property: {
            line: [0, 0, 10, 0],
            net: 'NET_A',
            color: '#000000',
            lineWidth: 1,
            lineType: 0,
          },
        },
      });

      expect(create).toHaveBeenCalledWith([0, 0, 10, 0], 'NET_A', '#000000', 1, 0);
      expect(result).toMatchObject({
        primitiveId: 'wire-new',
        snapshot: {
          primitiveId: 'wire-new',
          primitiveKind: 'wire',
          property: { line: [0, 0, 10, 0], net: 'NET_A' },
        },
      });
    });

    it('recreates annotation Y coordinates using the live text sign convention', async () => {
      const texts: Array<Record<string, unknown>> = [];
      const create = vi.fn(async (x: number, createY: number, content: string) => {
        const text = {
          getState_PrimitiveId: () => 'text-new',
          getState_X: () => x,
          getState_Y: () => -createY,
          getState_Content: () => content,
          getState_Rotation: () => 0,
          getState_TextColor: () => '#000000',
          getState_FontName: () => 'Arial',
          getState_FontSize: () => 20,
          getState_Bold: () => false,
          getState_Italic: () => false,
          getState_UnderLine: () => false,
          getState_AlignMode: () => 3,
        };
        texts.push(text);
        return text;
      });
      const dispatcher = createDispatcher(
        makeToolkit({
          SCH_PrimitiveText: {
            create,
            getAll: async () => texts,
            get: async (id: string) => texts.find((text) => text.getState_PrimitiveId?.() === id),
          },
        }),
      );

      const result = await dispatcher.dispatch('schematic.recreatePrimitiveSnapshot', {
        snapshot: {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'text-old',
          primitiveKind: 'text',
          property: { x: 100, y: -600, content: 'TITLE', alignMode: 3 },
        },
      });

      expect(create).toHaveBeenCalledWith(
        100,
        600,
        'TITLE',
        0,
        '#000000',
        'Arial',
        20,
        false,
        false,
        false,
        3,
      );
      expect(result).toMatchObject({
        snapshot: { primitiveId: 'text-new', property: { x: 100, y: -600, content: 'TITLE' } },
      });
    });

    it('rejects component recreation without a complete library device descriptor', async () => {
      const dispatcher = createDispatcher(makeToolkit({}));
      await expect(
        dispatcher.dispatch('schematic.recreatePrimitiveSnapshot', {
          snapshot: {
            schemaVersion: 'schematic-primitive-snapshot/v1',
            primitiveId: 'u1',
            primitiveKind: 'component',
            property: { designator: 'U1' },
          },
        }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_RUNTIME' });
    });
  });

  describe('schematic.modifyPrimitive wire-following', () => {
    it("translates a wire endpoint that was touching the moved component's old pin coordinate", async () => {
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

      expect(modify).toHaveBeenCalledWith('comp1', expect.objectContaining({ x: 300, y: 300 }));
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
          SCH_PrimitiveWire: {
            getAll: async () => [fakeWire('w1', 'NET_A', [100, 100, 150, 100])],
            modify: wireModify,
          },
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
    it('preserves the public alignment instead of replaying getAll internal state', async () => {
      const publicText = {
        getState_PrimitiveId: () => 'text1',
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
        getState_AlignMode: () => 3,
      };
      const lossyText = {
        ...publicText,
        getState_AlignMode: () => undefined,
      };
      const persistentText = {
        ...publicText,
        getState_AlignMode: () => 11,
      };
      const textGet = vi.fn().mockResolvedValueOnce(publicText).mockResolvedValue(lossyText);
      const textGetAll = vi.fn(async () => [persistentText]);
      const textModify = vi.fn(async () => publicText);
      const dispatcher = createDispatcher(
        makeToolkit({
          SCH_PrimitiveText: { get: textGet, getAll: textGetAll, modify: textModify },
        }),
      );

      const before = await dispatcher.dispatch('schematic.getPrimitiveSnapshot', {
        primitiveId: 'text1',
      });
      await dispatcher.dispatch('schematic.modifyPrimitive', {
        primitiveId: 'text1',
        property: { content: 'NEW TITLE', color: '#FF0000', underline: true },
      });
      const after = await dispatcher.dispatch('schematic.getPrimitiveSnapshot', {
        primitiveId: 'text1',
      });

      expect(before).toMatchObject({ property: { alignMode: 3 } });
      expect(after).toMatchObject({ property: { alignMode: 3 } });
      expect(textGet).toHaveBeenCalled();
      expect(textGetAll).toHaveBeenCalled();
      expect(textModify).toHaveBeenCalledWith(
        'text1',
        expect.objectContaining({
          x: 200,
          y: 600,
          content: 'NEW TITLE',
          textColor: '#FF0000',
          underLine: true,
          alignMode: 3,
          fontName: 'Arial',
          fontSize: 20,
        }),
      );
      const nativeProperty = textModify.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(nativeProperty).not.toHaveProperty('color');
      expect(nativeProperty).not.toHaveProperty('underline');
    });

    it('rejects internal or out-of-range alignment values on modify', async () => {
      const textModify = vi.fn();
      const text = {
        getState_PrimitiveId: () => 'text-invalid-align',
        getState_AlignMode: () => 3,
      };
      const dispatcher = createDispatcher(
        makeToolkit({ SCH_PrimitiveText: { get: async () => text, modify: textModify } }),
      );

      await expect(
        dispatcher.dispatch('schematic.modifyPrimitive', {
          primitiveId: 'text-invalid-align',
          property: { alignMode: 11 },
        }),
      ).rejects.toThrow('alignMode must be an integer from 1 through 9');
      expect(textModify).not.toHaveBeenCalled();
    });
  });

  describe('schematic.modifyPrimitive on circle/polygon primitives', () => {
    it('snapshots and merges a circle primitive instead of falling through to the wrong handler', async () => {
      const circleModify = vi.fn(async () => true);
      const circleGet = vi.fn(async () => ({
        getState_CenterX: () => 300,
        getState_CenterY: () => 700,
        getState_Radius: () => 50,
        getState_Color: () => '#000000',
        getState_FillColor: () => 'none',
        getState_LineWidth: () => 1,
        getState_LineType: () => 0,
        getState_FillStyle: () => 'none',
      }));
      const dispatcher = createDispatcher(
        makeToolkit({ SCH_PrimitiveCircle: { get: circleGet, modify: circleModify } }),
      );

      await dispatcher.dispatch('schematic.modifyPrimitive', {
        primitiveId: 'circle1',
        property: { radius: 75 },
      });

      expect(circleModify).toHaveBeenCalledWith(
        'circle1',
        expect.objectContaining({ centerX: 300, centerY: 700, radius: 75, color: '#000000' }),
      );
    });

    it('snapshots and merges a polygon primitive instead of falling through to the wrong handler', async () => {
      const polygonModify = vi.fn(async () => true);
      const polygonGet = vi.fn(async () => ({
        getState_Line: () => [0, 0, 10, 0, 5, 10],
        getState_Color: () => '#FF0000',
        getState_FillColor: () => 'none',
        getState_LineWidth: () => 1,
        getState_LineType: () => 0,
      }));
      const dispatcher = createDispatcher(
        makeToolkit({ SCH_PrimitivePolygon: { get: polygonGet, modify: polygonModify } }),
      );

      await dispatcher.dispatch('schematic.modifyPrimitive', {
        primitiveId: 'poly1',
        property: { color: '#00FF00' },
      });

      expect(polygonModify).toHaveBeenCalledWith(
        'poly1',
        expect.objectContaining({ line: [0, 0, 10, 0, 5, 10], color: '#00FF00' }),
      );
    });
  });

  describe('schematic.listRectangles', () => {
    it('lists rectangles with their coordinates via the live-confirmed TopLeftX/TopLeftY keys, negating the live-verified Y sign flip', async () => {
      const getAll = vi.fn(async () => [
        {
          getState_PrimitiveId: () => 'rect1',
          getState_TopLeftX: () => 100,
          // Live-verified (2026-07-09): SCH_PrimitiveRectangle reports TopLeftY
          // sign-flipped relative to what create() was given — raw -200 here
          // means the box was actually created at y:200.
          getState_TopLeftY: () => -200,
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

    it('falls back to X/Y if TopLeftX/TopLeftY are not exposed, still negating Y', async () => {
      const getAll = vi.fn(async () => [
        {
          getState_PrimitiveId: () => 'rect1',
          getState_X: () => 100,
          getState_Y: () => -200,
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
      const dispatcher = createDispatcher(makeToolkit({ SCH_PrimitiveComponent: { create } }));

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
      const dispatcher = createDispatcher(makeToolkit({ SCH_PrimitiveComponent: { create } }));

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
