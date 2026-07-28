import type { ApiRuntime } from './api-runtime.js';
import type { BoardInspectionOperations } from './board-inspection.js';
import type { CanvasOperations } from './canvas-operations.js';
import type { DesignRuleCheckOperations } from './design-rule-check-operations.js';
import type { ExportOperations } from './export-operations.js';
import type { PcbMutationOperations } from './pcb-mutation-operations.js';
import type { PcbReadOperations } from './pcb-read-operations.js';
import type { PcbWriteOperations } from './pcb-write-operations.js';
import type { ProjectOperations } from './project-operations.js';

export interface DispatcherDomainRouterDependencies {
  projectOperations: ProjectOperations;
  boardInspection: BoardInspectionOperations;
  exportOperations: ExportOperations;
  designRuleCheckOperations: DesignRuleCheckOperations;
  canvasOperations: CanvasOperations;
  pcbWriteOperations: PcbWriteOperations;
  pcbMutationOperations: PcbMutationOperations;
  pcbReadOperations: PcbReadOperations;
  callFirst: ApiRuntime['callFirst'];
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

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function offsetNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

export function createDispatcherDomainRouter(
  dependencies: DispatcherDomainRouterDependencies,
): DispatcherDomainRouter {
  const handlers = new Map<string, DomainMethodHandler>(
    Object.entries({
      'board.exportGerbers': (params) => dependencies.exportOperations.exportGerbers(params),
      'board.getDimensions': () => dependencies.boardInspection.getDimensions(),
      'board.getFeatures': () => dependencies.boardInspection.getFeatures(),
      'board.getStackup': () => dependencies.boardInspection.getStackup(),
      'board.listLayers': () => dependencies.boardInspection.listLayers(),
      'canvas.capture': (params) => dependencies.canvasOperations.capture(params),
      'canvas.captureRegion': (params) => dependencies.canvasOperations.captureRegion(params),
      'canvas.locate': (params) => dependencies.canvasOperations.locate(params),
      'design.drc': () => dependencies.designRuleCheckOperations.runDrc(),
      'design.erc': () => dependencies.designRuleCheckOperations.runErc(),
      'design.ruleCheck': () => dependencies.designRuleCheckOperations.runRuleCheck(),
      'export.netlist': (params) => dependencies.exportOperations.exportNetlist(params),
      'export.pdf': (params) => dependencies.exportOperations.exportPdf(params),
      'export.pickPlace': (params) => dependencies.exportOperations.exportPickPlace(params),
      'library.getDeviceByLcscId': (params) => {
        const lcscId = String(params.lcscId ?? '');
        const libraryUuid = typeof params.libraryUuid === 'string' ? params.libraryUuid : undefined;
        return dependencies.callFirst(['LIB_Device.getByLcscIds'], [lcscId], libraryUuid, false);
      },
      'pcb.addSilkscreenLine': (params) =>
        dependencies.pcbWriteOperations.addSilkscreenLine(params),
      'pcb.addText': (params) => dependencies.pcbWriteOperations.addText(params),
      'pcb.addTrack': (params) => dependencies.pcbWriteOperations.addTrack(params),
      'pcb.addVia': (params) => dependencies.pcbWriteOperations.addVia(params),
      'pcb.addZone': (params) => dependencies.pcbMutationOperations.addZone(params),
      'pcb.deleteComponent': (params) =>
        dependencies.pcbMutationOperations.deleteComponents(params),
      'pcb.exportRouteContext': (params) =>
        dependencies.exportOperations.exportRouteContext(params),
      'pcb.listComponents': (params) =>
        dependencies.pcbReadOperations.listComponents(
          optionalNumber(params.limit),
          offsetNumber(params.offset),
        ),
      'pcb.listTracks': (params) =>
        dependencies.pcbReadOperations.listTracks(
          optionalNumber(params.limit),
          offsetNumber(params.offset),
        ),
      'pcb.listVias': (params) =>
        dependencies.pcbReadOperations.listVias(
          optionalNumber(params.limit),
          offsetNumber(params.offset),
        ),
      'pcb.modifyComponent': (params) => dependencies.pcbMutationOperations.modifyComponent(params),
      'project.export': (params) => dependencies.projectOperations.export(params),
      'project.open': (params) => dependencies.projectOperations.open(params),
      'project.save': (params) => dependencies.projectOperations.save(params),
    } satisfies Record<string, DomainMethodHandler>),
  );
  const methodList = Object.freeze([...handlers.keys()].sort());

  return {
    methodList,
    async tryDispatch(method, params = {}) {
      const handler = handlers.get(method);
      if (!handler) return { handled: false };
      return { handled: true, value: await handler(params) };
    },
  };
}
