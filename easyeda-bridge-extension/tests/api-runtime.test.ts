import { describe, expect, it, vi } from 'vitest';
import {
  clampApiResultDepth,
  createApiRuntime,
  type BridgeErrorFactory,
} from '../src/api-runtime.js';
import type { DispatcherToolkit } from '../src/toolkit.js';

function bridgeError(code: string, message: string, suggestion: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, suggestion, data });
}

function mutableRoots() {
  let eda: unknown;
  let EDA: unknown;
  let api: unknown;
  const toolkit: Pick<DispatcherToolkit, 'getEda' | 'getEDA' | 'getApi'> = {
    getEda: () => eda,
    getEDA: () => EDA,
    getApi: () => api,
  };
  return {
    toolkit,
    setEda: (value: unknown) => {
      eda = value;
    },
    setEDA: (value: unknown) => {
      EDA = value;
    },
    setApi: (value: unknown) => {
      api = value;
    },
  };
}

describe('EasyEDA API runtime', () => {
  it('re-reads roots, preserves precedence, class variants, and method receivers', async () => {
    const roots = mutableRoots();
    const globalRoot = {
      SCH_Service: {
        source: 'global',
        identify() {
          return this.source;
        },
      },
    };
    const runtime = createApiRuntime(roots.toolkit, bridgeError, globalRoot);

    await expect(runtime.callFirst(['sch_Service.identify'])).resolves.toBe('global');

    roots.setApi({ SCH_Service: { identify: () => 'api' } });
    roots.setEDA({ SCH_Service: { identify: () => 'EDA' } });
    roots.setEda({ SCH_Service: { identify: () => 'eda' } });

    await expect(runtime.callFirst(['SCH_Service.identify'])).resolves.toBe('eda');
  });

  it('reads the first defined class value and keeps null as a resolved value', () => {
    const roots = mutableRoots();
    roots.setEda({ SCH_Missing: undefined, SCH_Nullable: null });
    roots.setEDA({ SCH_Missing: { source: 'EDA' }, SCH_Nullable: { source: 'EDA' } });
    const runtime = createApiRuntime(roots.toolkit, bridgeError, {});

    expect(runtime.readFirstPath<{ source: string }>(['SCH_Missing'])).toEqual({ source: 'EDA' });
    expect(runtime.readFirstPath(['SCH_Nullable'])).toBeNull();
    expect(runtime.readFirstPath(['SCH_Absent'])).toBeUndefined();
  });

  it('ignores unavailable and non-record runtime roots in inventory', () => {
    const roots = mutableRoots();
    roots.setEda('not-an-object');
    roots.setEDA(0);
    roots.setApi(false);
    const runtime = createApiRuntime(roots.toolkit, bridgeError, null);

    expect(runtime.inspectApiInventory()).toEqual({ classes: [], total: 0 });
  });

  it('builds a normalized, filtered, deduplicated API inventory', () => {
    const roots = mutableRoots();
    roots.setEda({
      sch_PrimitiveWire: {
        create() {},
        getAll() {},
      },
      SYS_Shell: { exec() {} },
    });
    roots.setEDA({
      SCH_PrimitiveWire: {
        get() {},
        getAll() {},
      },
      PCB_PrimitiveVia: { getAll() {} },
    });
    const runtime = createApiRuntime(roots.toolkit, bridgeError, {});

    expect(runtime.inspectApiInventory(' primitivewire ')).toEqual({
      classes: [
        {
          className: 'SCH_PrimitiveWire',
          runtimePaths: ['eda.sch_PrimitiveWire', 'EDA.SCH_PrimitiveWire'],
          methods: ['create', 'get', 'getAll'],
        },
      ],
      total: 1,
    });
    expect(runtime.inspectApiInventory()).toMatchObject({ total: 2 });
  });

  it('cuts results at the default depth and returns deeper levels on request', async () => {
    const roots = mutableRoots();
    const nested = { a: { b: { c: { d: { e: { f: { g: 'leaf' } } } } } } };
    roots.setEda({ SCH_Service: { read: () => nested } });
    const runtime = createApiRuntime(roots.toolkit, bridgeError, {});

    const cut = JSON.stringify(await runtime.callAllowedApi('SCH_Service.read', []));
    expect(cut).toContain('[MaxDepth]');
    expect(cut).not.toContain('leaf');

    const full = JSON.stringify(await runtime.callAllowedApi('SCH_Service.read', [], 12));
    expect(full).toContain('leaf');
    expect(full).not.toContain('[MaxDepth]');
  });

  it('keeps the requested depth within 1..16', () => {
    expect(clampApiResultDepth(undefined)).toBe(5);
    expect(clampApiResultDepth(2.5)).toBe(5);
    expect(clampApiResultDepth(0)).toBe(1);
    expect(clampApiResultDepth(99)).toBe(16);
    expect(clampApiResultDepth(10)).toBe(10);
  });

  it('authorizes API calls, binds the receiver, and normalizes the result', async () => {
    const roots = mutableRoots();
    roots.setEda({
      SCH_Service: {
        value: 7,
        read(extra: number) {
          return { total: this.value + extra, getState_Name: () => 'service' };
        },
      },
    });
    const runtime = createApiRuntime(roots.toolkit, bridgeError, {});

    await expect(runtime.callAllowedApi('sch_Service.read', [5])).resolves.toEqual({
      path: 'sch_Service.read',
      resolvedPath: 'eda.SCH_Service.read',
      result: expect.objectContaining({
        total: 12,
        state: { Name: 'service' },
      }),
    });
  });

  it('reduces repetitive native list payloads but preserves data and optional method inspection', async () => {
    const roots = mutableRoots();
    const makePrimitive = (index: number) => {
      const item: Record<string, unknown> = {
        index,
        getState_Designator: () => `U${index}`,
        getState_PrimitiveId: () => `id-${index}`,
      };
      for (let i = 0; i < 45; i += 1) item[`method${i}`] = () => undefined;
      return item;
    };
    roots.setEda({
      PCB_PrimitiveComponent: {
        getAll: () => Array.from({ length: 94 }, (_, index) => makePrimitive(index)),
      },
    });
    const runtime = createApiRuntime(roots.toolkit, bridgeError, {});
    const compact = (await runtime.callAllowedApi('PCB_PrimitiveComponent.getAll', [])) as {
      result: Array<Record<string, unknown>>;
    };
    const verbose = (await runtime.callAllowedApi(
      'PCB_PrimitiveComponent.getAll',
      [],
      5,
      true,
    )) as { result: Array<Record<string, unknown>> };
    expect(compact.result).toHaveLength(94);
    expect(compact.result[47]).toMatchObject({
      index: 47,
      state: { Designator: 'U47', PrimitiveId: 'id-47' },
    });
    expect(compact.result[47]).not.toHaveProperty('__methods');
    expect(verbose.result[47].__methods).toContain('method44');
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(verbose).length * 0.6);
  });

  it('checks the read-only native allowlist and scalar arguments inside the extension', async () => {
    const roots = mutableRoots();
    const getCurrentPcbInfo = vi.fn(() => ({ name: 'PCB' }));
    const getAll = vi.fn(() => [1, 2]);
    const create = vi.fn(() => 'unexpected-write');
    roots.setEda({
      DMT_Pcb: { getCurrentPcbInfo },
      DMT_SelectControl: {
        getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'pcb-a' }),
      },
      PCB_PrimitiveVia: { getAll, create, getAllAndDelete: create },
    });
    const runtime = createApiRuntime(roots.toolkit, bridgeError, {});
    await expect(runtime.callReadOnlyApi('DMT_Pcb.getCurrentPcbInfo', [])).resolves.toMatchObject({
      result: { name: 'PCB' },
    });
    await expect(runtime.callReadOnlyApi('pcb_PrimitiveVia.getAll', [])).resolves.toMatchObject({
      result: [1, 2],
    });
    for (const path of [
      'PCB_PrimitiveVia.create',
      'PCB_PrimitiveVia.getAllAndDelete',
      'DMT_Pcb.open',
    ]) {
      await expect(runtime.callReadOnlyApi(path, [])).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    }
    await expect(
      runtime.callReadOnlyApi('PCB_PrimitiveVia.getAll', [{ payload: 1 }]),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      runtime.callReadOnlyApi('PCB_PrimitiveVia.getAll', [Infinity]),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(create).not.toHaveBeenCalled();
    expect(getCurrentPcbInfo).toHaveBeenCalledOnce();
    expect(getAll).toHaveBeenCalledOnce();
  });

  it('reads audited pad, via, schematic, and DMT getters without executing mutations', async () => {
    const roots = mutableRoots();
    const padRead = vi.fn(async () => [{ getState_PrimitiveId: () => 'pad-a' }]);
    const viaIds = vi.fn(async () => ['via-a']);
    const schIds = vi.fn(async () => ['wire-a']);
    const boardInfo = vi.fn(async () => [{ name: 'test-board' }]);
    const pagesInfo = vi.fn(async () => [{ name: 'test-sheet' }]);
    let focus = 3;
    roots.setEda({
      DMT_SelectControl: {
        getCurrentDocumentInfo: async () => ({ documentType: focus, uuid: 'fixture-doc' }),
      },
      DMT_Board: { getAllBoardsInfo: boardInfo },
      DMT_Schematic: {
        getCurrentSchematicPageInfo: async () => ({ name: 'test-sheet' }),
        getAllSchematicPagesInfo: pagesInfo,
      },
      PCB_PrimitivePad: {
        getAll: padRead,
        get: padRead,
        getAllPrimitiveId: vi.fn(async () => ['pad-a']),
      },
      PCB_PrimitiveVia: { getAllPrimitiveId: viaIds },
      SCH_PrimitiveWire: { getAllPrimitiveId: schIds },
    });
    const runtime = createApiRuntime(roots.toolkit, bridgeError, {});
    await expect(runtime.callReadOnlyApi('pcb_PrimitivePad.getAll', [])).resolves.toMatchObject({
      result: [{ state: { PrimitiveId: 'pad-a' } }],
    });
    await expect(
      runtime.callReadOnlyApi('PCB_PrimitivePad.get', ['pad-a']),
    ).resolves.toHaveProperty('result');
    await expect(
      runtime.callReadOnlyApi('PCB_PrimitiveVia.getAllPrimitiveId', []),
    ).resolves.toMatchObject({ result: ['via-a'] });
    await expect(runtime.callReadOnlyApi('DMT_Board.getAllBoardsInfo', [])).resolves.toMatchObject({
      result: [{ name: 'test-board' }],
    });
    focus = 1;
    await expect(
      runtime.callReadOnlyApi('SCH_PrimitiveWire.getAllPrimitiveId', []),
    ).resolves.toMatchObject({ result: ['wire-a'] });
    await expect(
      runtime.callReadOnlyApi('DMT_Schematic.getAllSchematicPagesInfo', []),
    ).resolves.toMatchObject({ result: [{ name: 'test-sheet' }] });
    expect(padRead).toHaveBeenCalledTimes(2);
    expect(boardInfo).toHaveBeenCalledOnce();
    expect(pagesInfo).toHaveBeenCalledOnce();
  });

  it('returns typed document-context errors before any native getter runs', async () => {
    const roots = mutableRoots();
    const pcbGet = vi.fn(async () => ['should-not-run']);
    const schGet = vi.fn(async () => ['should-not-run']);
    const selector = vi.fn(async () => ({ documentType: 1, uuid: 'sheet-a' }));
    roots.setEda({
      DMT_SelectControl: { getCurrentDocumentInfo: selector },
      DMT_Schematic: {
        getCurrentSchematicPageInfo: vi.fn(async () => ({ name: 'Sheet A', uuid: 'sheet-a' })),
      },
      PCB_PrimitivePad: { getAll: pcbGet },
      SCH_PrimitiveWire: { getAll: schGet },
    });
    const runtime = createApiRuntime(roots.toolkit, bridgeError, {});
    await expect(runtime.callReadOnlyApi('PCB_PrimitivePad.getAll', [])).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
      message: expect.stringContaining('Sheet A'),
      data: { focusedName: 'Sheet A', focusedDocumentType: 1, focusedDocumentUuid: 'sheet-a' },
    });
    expect(pcbGet).not.toHaveBeenCalled();
    selector.mockResolvedValue({ documentType: 3, uuid: 'pcb-a' });
    roots.setEda({
      DMT_SelectControl: { getCurrentDocumentInfo: selector },
      DMT_Pcb: { getCurrentPcbInfo: async () => ({ name: 'PCB A', uuid: 'pcb-a' }) },
      PCB_PrimitivePad: { getAll: pcbGet },
      SCH_PrimitiveWire: { getAll: schGet },
    });
    await expect(runtime.callReadOnlyApi('SCH_PrimitiveWire.getAll', [])).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
      message: expect.stringContaining('PCB A'),
    });
    expect(schGet).not.toHaveBeenCalled();
    selector.mockResolvedValue({ documentType: 3, uuid: '' });
    await expect(runtime.callReadOnlyApi('PCB_PrimitivePad.getAll', [])).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
    });
    expect(pcbGet).not.toHaveBeenCalled();
    selector.mockResolvedValue({ documentType: 3, uuid: 'pcb-a' });
    await expect(runtime.callReadOnlyApi('PCB_PrimitivePad.getAll', [])).resolves.toHaveProperty(
      'result',
    );
  });

  it('fails closed on unavailable focused identity but permits project metadata reads', async () => {
    const roots = mutableRoots();
    const pcbGet = vi.fn();
    roots.setEda({
      PCB_PrimitivePad: { getAll: pcbGet },
      DMT_Board: { getAllBoardsInfo: async () => [] },
    });
    const runtime = createApiRuntime(roots.toolkit, bridgeError, {});
    await expect(runtime.callReadOnlyApi('PCB_PrimitivePad.getAll', [])).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
    });
    expect(pcbGet).not.toHaveBeenCalled();
    await expect(runtime.callReadOnlyApi('DMT_Board.getAllBoardsInfo', [])).resolves.toMatchObject({
      result: [],
    });
  });

  it('does not trust stale names or malformed focused-document metadata', async () => {
    const roots = mutableRoots();
    const readPads = vi.fn(async () => []);
    const selector = vi.fn();
    const sheet = vi.fn();
    roots.setEda({
      DMT_SelectControl: { getCurrentDocumentInfo: selector },
      DMT_Schematic: { getCurrentSchematicPageInfo: sheet },
      PCB_PrimitivePad: { getAll: readPads },
    });
    const runtime = createApiRuntime(roots.toolkit, bridgeError, {});

    selector.mockResolvedValueOnce(null);
    await expect(runtime.callReadOnlyApi('PCB_PrimitivePad.getAll', [])).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
      data: { focusedName: 'unknown', focusedDocumentType: null, focusedDocumentUuid: null },
    });

    selector.mockResolvedValueOnce({ documentType: 7, name: '3D Model' });
    await expect(runtime.callReadOnlyApi('PCB_PrimitivePad.getAll', [])).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
      message: expect.stringContaining('3D Model'),
      data: { focusedName: '3D Model', focusedDocumentType: 7, focusedDocumentUuid: null },
    });

    // A getter failure cannot convert a stale or off-domain document into a PCB.
    selector.mockResolvedValueOnce({ documentType: 1, uuid: 'sheet-new', name: 'Fallback' });
    sheet.mockRejectedValueOnce(new Error('page metadata unavailable'));
    await expect(runtime.callReadOnlyApi('PCB_PrimitivePad.getAll', [])).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
      message: expect.stringContaining('Fallback'),
    });

    selector.mockResolvedValueOnce({ documentType: 1, uuid: 'sheet-new', name: 'Actual' });
    sheet.mockResolvedValueOnce({ uuid: 'sheet-old', name: 'Wrong stale sheet' });
    await expect(runtime.callReadOnlyApi('PCB_PrimitivePad.getAll', [])).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
      data: { focusedName: 'Actual', focusedDocumentUuid: 'sheet-new' },
    });

    selector.mockResolvedValueOnce({ documentType: 1, uuid: 'sheet-new' });
    sheet.mockResolvedValueOnce(null);
    await expect(runtime.callReadOnlyApi('PCB_PrimitivePad.getAll', [])).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
      data: { focusedName: 'unknown', focusedDocumentUuid: 'sheet-new' },
    });
    expect(readPads).not.toHaveBeenCalled();
  });

  it('rejects a throwing focused-document getter rather than executing a native read', async () => {
    const roots = mutableRoots();
    const readWires = vi.fn(async () => []);
    roots.setEda({
      DMT_SelectControl: {
        getCurrentDocumentInfo: async () => {
          throw new Error('invalid focus');
        },
      },
      SCH_PrimitiveWire: { getAll: readWires },
    });
    const runtime = createApiRuntime(roots.toolkit, bridgeError, {});
    await expect(runtime.callReadOnlyApi('SCH_PrimitiveWire.getAll', [])).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
      message: 'Focused EasyEDA document cannot be read.',
    });
    expect(readWires).not.toHaveBeenCalled();
  });

  it('materializes tagged polygon arguments inside the bridge before native calls', async () => {
    const roots = mutableRoots();
    const polygon = { kind: 'live-polygon' };
    const complexPolygon = { kind: 'live-complex-polygon' };
    const modify = vi.fn(() => ({ ok: true }));
    const createPolygon = vi.fn(() => polygon);
    const createComplexPolygon = vi.fn(() => complexPolygon);
    roots.setEda({
      PCB_MathPolygon: {
        createPolygon,
        createComplexPolygon,
      },
      PCB_PrimitivePolyline: {
        modify,
      },
    });
    const runtime = createApiRuntime(roots.toolkit, bridgeError, {});

    await runtime.callAllowedApi('PCB_PrimitivePolyline.modify', [
      'outline-1',
      {
        polygon: { $polygon: [0, 0, 'L', 10, 0, 10, 10] },
        holes: [{ $complexPolygon: [[0, 0, 'L', 1, 0, 1, 1]] }],
      },
    ]);

    expect(createPolygon).toHaveBeenCalledWith([0, 0, 'L', 10, 0, 10, 10]);
    expect(createComplexPolygon).toHaveBeenCalledWith([[0, 0, 'L', 1, 0, 1, 1]]);
    expect(modify).toHaveBeenCalledWith('outline-1', {
      polygon,
      holes: [complexPolygon],
    });
  });

  it('rejects serialized EasyEDA descriptors instead of forwarding them', async () => {
    const roots = mutableRoots();
    const modify = vi.fn(() => ({ ok: true }));
    roots.setEda({
      PCB_PrimitivePolyline: {
        modify,
      },
    });
    const runtime = createApiRuntime(roots.toolkit, bridgeError, {});

    await expect(
      runtime.callAllowedApi('PCB_PrimitivePolyline.modify', [
        'outline-1',
        {
          polygon: {
            __class: 'Et',
            __methods: ['getSource'],
            polygon: [0, 0, 'L', 10, 0, 10, 10],
          },
        },
      ]),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message:
        'Serialized EasyEDA API descriptors cannot be used as call arguments (args[1].polygon)',
    });
    expect(modify).not.toHaveBeenCalled();
  });

  it('rejects conflicting tagged polygon arguments before invoking native methods', async () => {
    const roots = mutableRoots();
    const modify = vi.fn(() => ({ ok: true }));
    roots.setEda({
      PCB_PrimitivePolyline: {
        modify,
      },
    });
    const runtime = createApiRuntime(roots.toolkit, bridgeError, {});

    await expect(
      runtime.callAllowedApi('PCB_PrimitivePolyline.modify', [
        'outline-1',
        {
          polygon: {
            $polygon: [0, 0, 'L', 10, 0, 10, 10],
            $complexPolygon: [[0, 0, 'L', 1, 0, 1, 1]],
          },
        },
      ]),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'Polygon argument has conflicting tags (args[1].polygon)',
    });
    expect(modify).not.toHaveBeenCalled();
  });

  it('rejects tagged polygon arguments with extra fields before invoking native methods', async () => {
    const roots = mutableRoots();
    const modify = vi.fn(() => ({ ok: true }));
    roots.setEda({
      PCB_PrimitivePolyline: {
        modify,
      },
    });
    const runtime = createApiRuntime(roots.toolkit, bridgeError, {});

    await expect(
      runtime.callAllowedApi('PCB_PrimitivePolyline.modify', [
        'outline-1',
        {
          polygon: {
            $polygon: [0, 0, 'L', 10, 0, 10, 10],
            label: 'unexpected',
          },
        },
      ]),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'Tagged polygon arguments cannot contain extra fields (args[1].polygon)',
    });
    expect(modify).not.toHaveBeenCalled();
  });

  it('rejects malformed tagged polygon arguments before invoking native methods', async () => {
    const roots = mutableRoots();
    const modify = vi.fn(() => ({ ok: true }));
    roots.setEda({
      PCB_PrimitivePolyline: {
        modify,
      },
    });
    const runtime = createApiRuntime(roots.toolkit, bridgeError, {});

    await expect(
      runtime.callAllowedApi('PCB_PrimitivePolyline.modify', [
        'outline-1',
        { polygon: { $polygon: 'not-an-array' } },
      ]),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: '$polygon must contain an array (args[1].polygon)',
    });
    expect(modify).not.toHaveBeenCalled();
  });

  it('returns bounded bridge errors for denied and missing methods', async () => {
    const roots = mutableRoots();
    const errorFactory = vi.fn<BridgeErrorFactory>(bridgeError);
    const runtime = createApiRuntime(roots.toolkit, errorFactory, {});

    await expect(runtime.callAllowedApi('SYS_Shell.exec', [])).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'API path is not allowed: SYS_Shell.exec',
    });
    await expect(runtime.callAllowedApi('SCH_Service.missing', [])).rejects.toMatchObject({
      code: 'METHOD_NOT_FOUND',
      message: 'No EasyEDA API implementation found for SCH_Service.missing',
    });
    await expect(
      runtime.callFirst(['SCH_Service.first', 'SCH_Service.second']),
    ).rejects.toMatchObject({
      code: 'METHOD_NOT_FOUND',
      message: 'No EasyEDA API implementation found for SCH_Service.first or SCH_Service.second',
    });
    expect(errorFactory).toHaveBeenCalledTimes(3);
  });
});
