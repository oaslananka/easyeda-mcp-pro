import type { BoardInspectionOperations } from './board-inspection.js';
import type { CanvasOperations } from './canvas-operations.js';
import type { DesignRuleCheckOperations } from './design-rule-check-operations.js';
import type { ExportOperations } from './export-operations.js';
import type { PcbMutationOperations } from './pcb-mutation-operations.js';
import type { PcbReadOperations } from './pcb-read-operations.js';
import type { PcbWriteOperations } from './pcb-write-operations.js';
import type { ProjectOperations } from './project-operations.js';
import type { SystemApiOperations } from './system-api-operations.js';

export interface DispatcherDomainRouterDependencies {
  projectOperations: ProjectOperations;
  systemApiOperations: SystemApiOperations;
  boardInspection: BoardInspectionOperations;
  exportOperations: ExportOperations;
  designRuleCheckOperations: DesignRuleCheckOperations;
  canvasOperations: CanvasOperations;
  pcbWriteOperations: PcbWriteOperations;
  pcbMutationOperations: PcbMutationOperations;
  pcbReadOperations: PcbReadOperations;
}

export type DispatcherDomainRouteResult = { handled: false } | { handled: true; value: unknown };

export interface DispatcherDomainRouter {
  methodList: readonly string[];
  tryDispatch(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<DispatcherDomainRouteResult>;
}

type DomainMethodHandler = (params: Record<string, unknown>) => Promise<unknown>;

interface DomainRoute {
  method: string;
  handle: DomainMethodHandler;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function offsetNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

export function createDispatcherDomainRouter(
  dependencies: DispatcherDomainRouterDependencies,
): DispatcherDomainRouter {
  const routes = [
    { method: 'api.call', handle: (params) => dependencies.systemApiOperations.apiCall(params) },
    {
      method: 'api.execute',
      handle: (params) => dependencies.systemApiOperations.apiExecute(params),
    },
    {
      method: 'board.exportGerbers',
      handle: (params) => dependencies.exportOperations.exportGerbers(params),
    },
    { method: 'board.getDimensions', handle: () => dependencies.boardInspection.getDimensions() },
    { method: 'board.getFeatures', handle: () => dependencies.boardInspection.getFeatures() },
    { method: 'board.getStackup', handle: () => dependencies.boardInspection.getStackup() },
    { method: 'board.listLayers', handle: () => dependencies.boardInspection.listLayers() },
    { method: 'canvas.capture', handle: (params) => dependencies.canvasOperations.capture(params) },
    {
      method: 'canvas.captureRegion',
      handle: (params) => dependencies.canvasOperations.captureRegion(params),
    },
    { method: 'canvas.locate', handle: (params) => dependencies.canvasOperations.locate(params) },
    { method: 'design.drc', handle: () => dependencies.designRuleCheckOperations.runDrc() },
    { method: 'design.erc', handle: () => dependencies.designRuleCheckOperations.runErc() },
    {
      method: 'design.ruleCheck',
      handle: () => dependencies.designRuleCheckOperations.runRuleCheck(),
    },
    {
      method: 'export.netlist',
      handle: (params) => dependencies.exportOperations.exportNetlist(params),
    },
    { method: 'export.pdf', handle: (params) => dependencies.exportOperations.exportPdf(params) },
    {
      method: 'export.pickPlace',
      handle: (params) => dependencies.exportOperations.exportPickPlace(params),
    },
    {
      method: 'pcb.addSilkscreenLine',
      handle: (params) => dependencies.pcbWriteOperations.addSilkscreenLine(params),
    },
    { method: 'pcb.addText', handle: (params) => dependencies.pcbWriteOperations.addText(params) },
    {
      method: 'pcb.addTrack',
      handle: (params) => dependencies.pcbWriteOperations.addTrack(params),
    },
    { method: 'pcb.addVia', handle: (params) => dependencies.pcbWriteOperations.addVia(params) },
    {
      method: 'pcb.addZone',
      handle: (params) => dependencies.pcbMutationOperations.addZone(params),
    },
    {
      method: 'pcb.deleteComponent',
      handle: (params) => dependencies.pcbMutationOperations.deleteComponents(params),
    },
    {
      method: 'pcb.exportRouteContext',
      handle: (params) => dependencies.exportOperations.exportRouteContext(params),
    },
    {
      method: 'pcb.listComponents',
      handle: (params) =>
        dependencies.pcbReadOperations.listComponents(
          optionalNumber(params.limit),
          offsetNumber(params.offset),
        ),
    },
    {
      method: 'pcb.listTracks',
      handle: (params) =>
        dependencies.pcbReadOperations.listTracks(
          optionalNumber(params.limit),
          offsetNumber(params.offset),
        ),
    },
    {
      method: 'pcb.listVias',
      handle: (params) =>
        dependencies.pcbReadOperations.listVias(
          optionalNumber(params.limit),
          offsetNumber(params.offset),
        ),
    },
    {
      method: 'pcb.modifyComponent',
      handle: (params) => dependencies.pcbMutationOperations.modifyComponent(params),
    },
    {
      method: 'project.export',
      handle: (params) => dependencies.projectOperations.export(params),
    },
    { method: 'project.open', handle: (params) => dependencies.projectOperations.open(params) },
    { method: 'project.save', handle: (params) => dependencies.projectOperations.save(params) },
    {
      method: 'system.apiInventory',
      handle: (params) => dependencies.systemApiOperations.apiInventory(params),
    },
    { method: 'system.getStatus', handle: () => dependencies.systemApiOperations.getStatus() },
    {
      method: 'system.inspectComponents',
      handle: (params) => dependencies.systemApiOperations.inspectComponents(params),
    },
    {
      method: 'system.inspectWires',
      handle: (params) => dependencies.systemApiOperations.inspectWires(params),
    },
  ] satisfies DomainRoute[];
  const methodList = Object.freeze(
    routes.map((route) => route.method).sort((left, right) => left.localeCompare(right)),
  );

  return {
    methodList,
    async tryDispatch(method, params = {}) {
      const route = routes.find((candidate) => candidate.method === method);
      if (!route) return { handled: false };
      return { handled: true, value: await route.handle(params) };
    },
  };
}
