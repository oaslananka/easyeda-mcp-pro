import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createDispatcherDomainRouter } from '../src/dispatcher-domain-router.js';

function createDependencies() {
  return {
    projectOperations: {
      open: vi.fn(async (params: Record<string, unknown>) => ({ method: 'project.open', params })),
      save: vi.fn(async (_params: Record<string, unknown>) => undefined),
      export: vi.fn(async (params: Record<string, unknown>) => ({
        method: 'project.export',
        params,
      })),
    },
    boardInspection: {
      requireActivePcbContext: vi.fn(async () => undefined),
      listLayers: vi.fn(async () => 'layers'),
      getStackup: vi.fn(async () => 'stackup'),
      getDimensions: vi.fn(async () => 'dimensions'),
      getFeatures: vi.fn(async () => 'features'),
    },
    exportOperations: {
      exportGerbers: vi.fn(async (params: Record<string, unknown>) => ({
        method: 'gerbers',
        params,
      })),
      exportRouteContext: vi.fn(async (params: Record<string, unknown>) => ({
        method: 'route',
        params,
      })),
      exportPickPlace: vi.fn(async (params: Record<string, unknown>) => ({
        method: 'pick-place',
        params,
      })),
      exportPdf: vi.fn(async (params: Record<string, unknown>) => ({ method: 'pdf', params })),
      exportNetlist: vi.fn(async (params: Record<string, unknown>) => ({
        method: 'netlist',
        params,
      })),
    },
    designRuleCheckOperations: {
      runDrc: vi.fn(async () => 'drc'),
      runErc: vi.fn(async () => 'erc'),
      runRuleCheck: vi.fn(async () => 'rule-check'),
      runSchematicCheck: vi.fn(async () => 'schematic-check'),
    },
    canvasOperations: {
      capture: vi.fn(async (params: Record<string, unknown>) => ({ method: 'capture', params })),
      captureRegion: vi.fn(async (params: Record<string, unknown>) => ({
        method: 'capture-region',
        params,
      })),
      locate: vi.fn(async (params: Record<string, unknown>) => ({ method: 'locate', params })),
    },
    pcbWriteOperations: {
      addTrack: vi.fn(async (params: Record<string, unknown>) => ({ method: 'track', params })),
      addText: vi.fn(async (params: Record<string, unknown>) => ({ method: 'text', params })),
      addSilkscreenLine: vi.fn(async (params: Record<string, unknown>) => ({
        method: 'silk',
        params,
      })),
      addVia: vi.fn(async (params: Record<string, unknown>) => ({ method: 'via', params })),
    },
    pcbMutationOperations: {
      addZone: vi.fn(async (params: Record<string, unknown>) => ({ method: 'zone', params })),
      deleteComponents: vi.fn(async (params: Record<string, unknown>) => ({ deleted: params })),
      modifyComponent: vi.fn(async (params: Record<string, unknown>) => ({
        method: 'modify',
        params,
      })),
    },
    pcbReadOperations: {
      listFills: vi.fn(async (limit?: number, offset?: number) => ({
        method: 'fills',
        limit,
        offset,
      })),
      listRegions: vi.fn(async (limit?: number, offset?: number) => ({
        method: 'regions',
        limit,
        offset,
      })),
      listComponents: vi.fn(async (limit?: number, offset?: number) => ({
        method: 'components',
        limit,
        offset,
      })),
      listTracks: vi.fn(async (limit?: number, offset?: number) => ({
        method: 'tracks',
        limit,
        offset,
      })),
      listVias: vi.fn(async (limit?: number, offset?: number) => ({
        method: 'vias',
        limit,
        offset,
      })),
      deletePrimitives: vi.fn(async () => ({ deleted: [], notFound: [] })),
    },
    schematicTransactionOperations: {
      deletePrimitives: vi.fn(async (primitiveIds: unknown) => ({
        method: 'schematic.deletePrimitive',
        primitiveIds,
      })),
      recreatePrimitiveSnapshot: vi.fn(async (snapshot: unknown) => ({
        method: 'schematic.recreatePrimitiveSnapshot',
        snapshot,
      })),
      restorePrimitiveSnapshot: vi.fn(async (snapshot: unknown) => ({
        method: 'schematic.restorePrimitiveSnapshot',
        snapshot,
      })),
      modifyPrimitive: vi.fn(async (primitiveId: string, property: Record<string, unknown>) => ({
        method: 'schematic.modifyPrimitive',
        primitiveId,
        property,
      })),
      getPrimitiveSnapshot: vi.fn(),
      listPrimitiveIds: vi.fn(),
    },
    readOnlyOperations: {
      listNets: vi.fn(async () => ({ method: 'schematic.listNets' })),
      getNetDetail: vi.fn(async (params: Record<string, unknown>) => ({
        method: 'schematic.getNetDetail',
        params,
      })),
      getPrimitiveSnapshot: vi.fn(async (params: Record<string, unknown>) => ({
        method: 'schematic.getPrimitiveSnapshot',
        params,
      })),
      listPrimitiveIds: vi.fn(async (params: Record<string, unknown>) => ({
        method: 'schematic.listPrimitiveIds',
        params,
      })),
      listComponents: vi.fn(async (params: Record<string, unknown>) => ({
        method: 'schematic.listComponents',
        params,
      })),
      getSheetInfo: vi.fn(async () => ({ method: 'schematic.getSheetInfo' })),
      primitiveBounds: vi.fn(async (params: Record<string, unknown>) => ({
        method: 'schematic.primitiveBounds',
        params,
      })),
      searchDevice: vi.fn(async (params: Record<string, unknown>) => ({
        method: 'schematic.searchDevice',
        params,
      })),
      listRectangles: vi.fn(async () => ({ method: 'schematic.listRectangles' })),
      getPinNoConnect: vi.fn(async (params: Record<string, unknown>) => ({
        method: 'schematic.getPinNoConnect',
        params,
      })),
      validateNetlist: vi.fn(async () => ({ method: 'schematic.validateNetlist' })),
      getDeviceByLcscId: vi.fn(async (params: Record<string, unknown>) => ({
        method: 'library.getDeviceByLcscId',
        params,
      })),
      generateBom: vi.fn(async (params: Record<string, unknown>) => ({
        method: 'bom.generate',
        params,
      })),
      validateBom: vi.fn(async () => ({ method: 'bom.validate' })),
      inventorySearch: vi.fn(async () => []),
      inventoryGetPrice: vi.fn(async () => null),
    },
    systemApiOperations: {
      apiCall: vi.fn(async (params: Record<string, unknown>) => ({ method: 'api.call', params })),
      apiExecute: vi.fn(async (params: Record<string, unknown>) => ({
        method: 'api.execute',
        params,
      })),
      apiInventory: vi.fn(async (params: Record<string, unknown>) => ({
        method: 'system.apiInventory',
        params,
      })),
      getStatus: vi.fn(async () => 'status'),
      inspectComponents: vi.fn(async (params: Record<string, unknown>) => ({
        method: 'system.inspectComponents',
        params,
      })),
      inspectWires: vi.fn(async (params: Record<string, unknown>) => ({
        method: 'system.inspectWires',
        params,
      })),
    },
  };
}

const expectedMethods = [
  'api.call',
  'api.execute',
  'board.exportGerbers',
  'board.getDimensions',
  'board.getFeatures',
  'board.getStackup',
  'board.listLayers',
  'bom.generate',
  'bom.validate',
  'canvas.capture',
  'canvas.captureRegion',
  'canvas.locate',
  'design.drc',
  'design.erc',
  'design.ruleCheck',
  'export.netlist',
  'export.pdf',
  'export.pickPlace',
  'inventory.getPrice',
  'inventory.search',
  'library.getDeviceByLcscId',
  'pcb.addSilkscreenLine',
  'pcb.addText',
  'pcb.addTrack',
  'pcb.addVia',
  'pcb.addZone',
  'pcb.deleteComponent',
  'pcb.exportRouteContext',
  'pcb.listComponents',
  'pcb.listFills',
  'pcb.listRegions',
  'pcb.listTracks',
  'pcb.listVias',
  'pcb.modifyComponent',
  'project.export',
  'project.open',
  'project.save',
  'schematic.deletePrimitive',
  'schematic.getNetDetail',
  'schematic.getPinNoConnect',
  'schematic.getPrimitiveSnapshot',
  'schematic.getSheetInfo',
  'schematic.listComponents',
  'schematic.listNets',
  'schematic.listPrimitiveIds',
  'schematic.listRectangles',
  'schematic.modifyPrimitive',
  'schematic.primitiveBounds',
  'schematic.recreatePrimitiveSnapshot',
  'schematic.restorePrimitiveSnapshot',
  'schematic.searchDevice',
  'schematic.validateNetlist',
  'system.apiInventory',
  'system.getStatus',
  'system.inspectComponents',
  'system.inspectWires',
];

describe('createDispatcherDomainRouter', () => {
  it('publishes a stable sorted list of every extracted domain method', () => {
    const router = createDispatcherDomainRouter(createDependencies());
    expect(router.methodList).toEqual(expectedMethods);
    expect(router.methodList).toEqual([...router.methodList].sort());
  });

  it('delegates exact methods without changing parameters or results', async () => {
    const dependencies = createDependencies();
    const router = createDispatcherDomainRouter(dependencies);
    const params = { value: 'preserved' };

    await expect(router.tryDispatch('project.open', params)).resolves.toEqual({
      handled: true,
      value: { method: 'project.open', params },
    });
    await expect(router.tryDispatch('project.save', params)).resolves.toEqual({
      handled: true,
      value: undefined,
    });
    await expect(router.tryDispatch('project.export', params)).resolves.toEqual({
      handled: true,
      value: { method: 'project.export', params },
    });

    await expect(router.tryDispatch('board.listLayers', params)).resolves.toEqual({
      handled: true,
      value: 'layers',
    });
    await expect(router.tryDispatch('board.getStackup', params)).resolves.toEqual({
      handled: true,
      value: 'stackup',
    });
    await expect(router.tryDispatch('board.getDimensions', params)).resolves.toEqual({
      handled: true,
      value: 'dimensions',
    });
    await expect(router.tryDispatch('board.getFeatures', params)).resolves.toEqual({
      handled: true,
      value: 'features',
    });

    await expect(router.tryDispatch('board.exportGerbers', params)).resolves.toMatchObject({
      handled: true,
      value: { method: 'gerbers', params },
    });
    await expect(router.tryDispatch('pcb.exportRouteContext', params)).resolves.toMatchObject({
      handled: true,
      value: { method: 'route', params },
    });
    await expect(router.tryDispatch('export.pickPlace', params)).resolves.toMatchObject({
      handled: true,
      value: { method: 'pick-place', params },
    });
    await expect(router.tryDispatch('export.pdf', params)).resolves.toMatchObject({
      handled: true,
      value: { method: 'pdf', params },
    });
    await expect(router.tryDispatch('export.netlist', params)).resolves.toMatchObject({
      handled: true,
      value: { method: 'netlist', params },
    });

    await expect(router.tryDispatch('design.ruleCheck', params)).resolves.toEqual({
      handled: true,
      value: 'rule-check',
    });
    await expect(router.tryDispatch('design.erc', params)).resolves.toEqual({
      handled: true,
      value: 'erc',
    });
    await expect(router.tryDispatch('design.drc', params)).resolves.toEqual({
      handled: true,
      value: 'drc',
    });

    await expect(router.tryDispatch('canvas.capture', params)).resolves.toMatchObject({
      handled: true,
      value: { method: 'capture', params },
    });
    await expect(router.tryDispatch('canvas.captureRegion', params)).resolves.toMatchObject({
      handled: true,
      value: { method: 'capture-region', params },
    });
    await expect(router.tryDispatch('canvas.locate', params)).resolves.toMatchObject({
      handled: true,
      value: { method: 'locate', params },
    });

    await expect(router.tryDispatch('pcb.addTrack', params)).resolves.toMatchObject({
      handled: true,
      value: { method: 'track', params },
    });
    await expect(router.tryDispatch('pcb.addText', params)).resolves.toMatchObject({
      handled: true,
      value: { method: 'text', params },
    });
    await expect(router.tryDispatch('pcb.addSilkscreenLine', params)).resolves.toMatchObject({
      handled: true,
      value: { method: 'silk', params },
    });
    await expect(router.tryDispatch('pcb.addVia', params)).resolves.toMatchObject({
      handled: true,
      value: { method: 'via', params },
    });
    await expect(router.tryDispatch('pcb.addZone', params)).resolves.toMatchObject({
      handled: true,
      value: { method: 'zone', params },
    });
    await expect(router.tryDispatch('pcb.deleteComponent', params)).resolves.toMatchObject({
      handled: true,
      value: { deleted: params },
    });
    await expect(router.tryDispatch('pcb.modifyComponent', params)).resolves.toMatchObject({
      handled: true,
      value: { method: 'modify', params },
    });

    await expect(router.tryDispatch('api.call', params)).resolves.toEqual({
      handled: true,
      value: { method: 'api.call', params },
    });
    await expect(router.tryDispatch('api.execute', params)).resolves.toEqual({
      handled: true,
      value: { method: 'api.execute', params },
    });
    await expect(router.tryDispatch('system.apiInventory', params)).resolves.toEqual({
      handled: true,
      value: { method: 'system.apiInventory', params },
    });
    await expect(router.tryDispatch('system.getStatus', params)).resolves.toEqual({
      handled: true,
      value: 'status',
    });
    await expect(router.tryDispatch('system.inspectComponents', params)).resolves.toEqual({
      handled: true,
      value: { method: 'system.inspectComponents', params },
    });
    await expect(router.tryDispatch('system.inspectWires', params)).resolves.toEqual({
      handled: true,
      value: { method: 'system.inspectWires', params },
    });

    await expect(
      router.tryDispatch('schematic.deletePrimitive', { primitiveIds: ['wire-1'] }),
    ).resolves.toEqual({
      handled: true,
      value: { method: 'schematic.deletePrimitive', primitiveIds: ['wire-1'] },
    });
    const snapshot = { schemaVersion: 'schematic-primitive-snapshot/v1' };
    await expect(
      router.tryDispatch('schematic.recreatePrimitiveSnapshot', { snapshot }),
    ).resolves.toEqual({
      handled: true,
      value: { method: 'schematic.recreatePrimitiveSnapshot', snapshot },
    });
    await expect(
      router.tryDispatch('schematic.restorePrimitiveSnapshot', { snapshot }),
    ).resolves.toEqual({
      handled: true,
      value: { method: 'schematic.restorePrimitiveSnapshot', snapshot },
    });
    await expect(
      router.tryDispatch('schematic.modifyPrimitive', { primitiveId: 'text-1' }),
    ).resolves.toEqual({
      handled: true,
      value: { method: 'schematic.modifyPrimitive', primitiveId: 'text-1', property: {} },
    });

    const readOnlyMethods = [
      'schematic.getNetDetail',
      'schematic.getPinNoConnect',
      'schematic.getPrimitiveSnapshot',
      'schematic.listComponents',
      'schematic.listPrimitiveIds',
      'schematic.primitiveBounds',
      'schematic.searchDevice',
      'library.getDeviceByLcscId',
      'bom.generate',
    ];
    for (const readOnlyMethod of readOnlyMethods) {
      await expect(router.tryDispatch(readOnlyMethod, params)).resolves.toEqual({
        handled: true,
        value: { method: readOnlyMethod, params },
      });
    }
    await expect(router.tryDispatch('schematic.listNets', params)).resolves.toEqual({
      handled: true,
      value: { method: 'schematic.listNets' },
    });
    await expect(router.tryDispatch('schematic.getSheetInfo', params)).resolves.toEqual({
      handled: true,
      value: { method: 'schematic.getSheetInfo' },
    });
    await expect(router.tryDispatch('schematic.listRectangles', params)).resolves.toEqual({
      handled: true,
      value: { method: 'schematic.listRectangles' },
    });
    await expect(router.tryDispatch('schematic.validateNetlist', params)).resolves.toEqual({
      handled: true,
      value: { method: 'schematic.validateNetlist' },
    });
    await expect(router.tryDispatch('bom.validate', params)).resolves.toEqual({
      handled: true,
      value: { method: 'bom.validate' },
    });
    await expect(router.tryDispatch('inventory.search', params)).resolves.toEqual({
      handled: true,
      value: [],
    });
    await expect(router.tryDispatch('inventory.getPrice', params)).resolves.toEqual({
      handled: true,
      value: null,
    });
  });

  it('preserves PCB pagination coercion', async () => {
    const dependencies = createDependencies();
    const router = createDispatcherDomainRouter(dependencies);

    await expect(router.tryDispatch('pcb.listFills', { limit: 5, offset: 1 })).resolves.toEqual({
      handled: true,
      value: { method: 'fills', limit: 5, offset: 1 },
    });
    await expect(router.tryDispatch('pcb.listRegions', { limit: 6, offset: 2 })).resolves.toEqual({
      handled: true,
      value: { method: 'regions', limit: 6, offset: 2 },
    });
    await expect(
      router.tryDispatch('pcb.listComponents', { limit: 4, offset: 2 }),
    ).resolves.toEqual({
      handled: true,
      value: { method: 'components', limit: 4, offset: 2 },
    });
    await expect(
      router.tryDispatch('pcb.listTracks', { limit: '4', offset: '2' }),
    ).resolves.toEqual({
      handled: true,
      value: { method: 'tracks', limit: undefined, offset: 0 },
    });
    await expect(router.tryDispatch('pcb.listVias', { offset: 3 })).resolves.toEqual({
      handled: true,
      value: { method: 'vias', limit: undefined, offset: 3 },
    });
  });

  it('rejects contradictory schematic selectors before route handlers', async () => {
    const dependencies = createDependencies();
    const router = createDispatcherDomainRouter(dependencies);

    await expect(
      router.tryDispatch('schematic.getSheetInfo', { scope: 'focused', pageUuid: 'page-2' }),
    ).rejects.toMatchObject({ code: 'PAGE_SCOPE_CONFLICT' });
    await expect(
      router.tryDispatch('schematic.getSheetInfo', { scope: 'page' }),
    ).rejects.toMatchObject({
      code: 'PAGE_UUID_REQUIRED',
    });
    expect(dependencies.readOnlyOperations.getSheetInfo).not.toHaveBeenCalled();
  });

  it('describes invalid object scope values without default object stringification', async () => {
    const dependencies = createDependencies();
    const router = createDispatcherDomainRouter(dependencies);

    await expect(
      router.tryDispatch('schematic.getSheetInfo', { scope: { unexpected: true } }),
    ).rejects.toMatchObject({
      code: 'PAGE_SCOPE_CONFLICT',
      data: expect.objectContaining({ requestedScope: 'object' }),
    });
    expect(dependencies.readOnlyOperations.getSheetInfo).not.toHaveBeenCalled();
  });

  it('fails closed on unsupported schematic scopes before invoking focused route handlers', async () => {
    const dependencies = createDependencies();
    const router = createDispatcherDomainRouter(dependencies);
    const pageRequest = { scope: 'page', pageUuid: 'page-2' };

    const cases = [
      ['schematic.listNets', dependencies.readOnlyOperations.listNets],
      ['schematic.getNetDetail', dependencies.readOnlyOperations.getNetDetail],
      ['schematic.validateNetlist', dependencies.readOnlyOperations.validateNetlist],
      ['system.inspectWires', dependencies.systemApiOperations.inspectWires],
      ['design.erc', dependencies.designRuleCheckOperations.runErc],
      ['schematic.listComponents', dependencies.readOnlyOperations.listComponents],
    ] as const;

    for (const [method, handler] of cases) {
      await expect(router.tryDispatch(method, pageRequest)).rejects.toMatchObject({
        code: 'PAGE_SCOPE_UNSUPPORTED',
        data: expect.objectContaining({
          requestedScope: 'page',
          pageUuid: 'page-2',
          operation: method,
        }),
      });
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it('forwards supported schematic selector intent to read-only routes', async () => {
    const dependencies = createDependencies();
    const router = createDispatcherDomainRouter(dependencies);

    await expect(
      router.tryDispatch('schematic.listComponents', { scope: 'focused', limit: 5 }),
    ).resolves.toMatchObject({ handled: true });
    expect(dependencies.readOnlyOperations.listComponents).toHaveBeenCalledWith({
      scope: 'focused',
      limit: 5,
    });

    await expect(
      router.tryDispatch('schematic.getSheetInfo', { pageUuid: 'page-2' }),
    ).resolves.toMatchObject({ handled: true });
    expect(dependencies.readOnlyOperations.getSheetInfo).toHaveBeenCalledWith({
      pageUuid: 'page-2',
    });
  });

  it('keeps extracted methods out of the central dispatcher switch', () => {
    const dispatcherSource = readFileSync(
      fileURLToPath(new URL('../src/dispatcher.ts', import.meta.url)),
      'utf8',
    );

    expect(dispatcherSource).toContain('domainRouter.tryDispatch(method, params)');
    for (const method of expectedMethods) {
      expect(dispatcherSource).not.toContain(`case '${method}':`);
    }
  });

  it('returns an explicit unhandled result for methods owned by the central dispatcher', async () => {
    const router = createDispatcherDomainRouter(createDependencies());
    await expect(router.tryDispatch('schematic.addWire', {})).resolves.toEqual({ handled: false });
    await expect(router.tryDispatch('not.real', {})).resolves.toEqual({ handled: false });
    await expect(router.tryDispatch('toString', {})).resolves.toEqual({ handled: false });
    await expect(router.tryDispatch('__proto__', {})).resolves.toEqual({ handled: false });
  });
});
