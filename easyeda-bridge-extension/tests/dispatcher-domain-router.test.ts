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
    callFirst: vi.fn(async (paths: string[], ...args: unknown[]) => ({ paths, args })),
  };
}

const expectedMethods = [
  'board.exportGerbers',
  'board.getDimensions',
  'board.getFeatures',
  'board.getStackup',
  'board.listLayers',
  'canvas.capture',
  'canvas.captureRegion',
  'canvas.locate',
  'design.drc',
  'design.erc',
  'design.ruleCheck',
  'export.netlist',
  'export.pdf',
  'export.pickPlace',
  'library.getDeviceByLcscId',
  'pcb.addSilkscreenLine',
  'pcb.addText',
  'pcb.addTrack',
  'pcb.addVia',
  'pcb.addZone',
  'pcb.deleteComponent',
  'pcb.exportRouteContext',
  'pcb.listComponents',
  'pcb.listTracks',
  'pcb.listVias',
  'pcb.modifyComponent',
  'project.export',
  'project.open',
  'project.save',
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
  });

  it('preserves PCB pagination coercion and library lookup arguments', async () => {
    const dependencies = createDependencies();
    const router = createDispatcherDomainRouter(dependencies);

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
    await expect(
      router.tryDispatch('library.getDeviceByLcscId', {
        lcscId: 123,
        libraryUuid: 'library-1',
      }),
    ).resolves.toEqual({
      handled: true,
      value: {
        paths: ['LIB_Device.getByLcscIds'],
        args: [['123'], 'library-1', false],
      },
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
