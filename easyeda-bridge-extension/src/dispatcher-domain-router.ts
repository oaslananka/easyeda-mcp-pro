import type { BoardInspectionOperations } from './board-inspection.js';
import type { CanvasOperations } from './canvas-operations.js';
import type { DesignRuleCheckOperations } from './design-rule-check-operations.js';
import type { ExportOperations } from './export-operations.js';
import type { PcbMutationOperations } from './pcb-mutation-operations.js';
import type { PcbReadOperations } from './pcb-read-operations.js';
import type { PcbWriteOperations } from './pcb-write-operations.js';
import type { ProjectOperations } from './project-operations.js';
import type { createDeviceMetadataOperations } from './device-metadata-operations.js';
import type { ReadOnlyOperations } from './read-only-operations.js';
import type { SchematicTransactionOperations } from './schematic-transaction-operations.js';
import { assertSchematicReadOperationScope } from './schematic-read-scope.js';
import type { SystemApiOperations } from './system-api-operations.js';

export interface DispatcherDomainRouterDependencies {
  deviceMetadataOperations: ReturnType<typeof createDeviceMetadataOperations>;
  projectOperations: ProjectOperations;
  readOnlyOperations: ReadOnlyOperations;
  schematicTransactionOperations: SchematicTransactionOperations;
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

function assertRouterSchematicScope(method: string, params: Record<string, unknown>): void {
  assertSchematicReadOperationScope(params, method);
}

export function createDispatcherDomainRouter(
  dependencies: DispatcherDomainRouterDependencies,
): DispatcherDomainRouter {
  const pcbListRoutes: DomainRoute[] = Object.entries({
    'pcb.listComponents': dependencies.pcbReadOperations.listComponents,
    'pcb.listFills': dependencies.pcbReadOperations.listFills,
    'pcb.listRegions': dependencies.pcbReadOperations.listRegions,
    'pcb.listTracks': dependencies.pcbReadOperations.listTracks,
    'pcb.listVias': dependencies.pcbReadOperations.listVias,
  }).map(([method, read]) => ({
    method,
    handle: (params) => read(optionalNumber(params.limit), offsetNumber(params.offset)),
  }));

  const routeHandlers: Record<string, DomainMethodHandler> = {
    'library.updateDeviceMetadata': (params) =>
      dependencies.deviceMetadataOperations.updateDeviceMetadata(params),
    'api.call': (params) => dependencies.systemApiOperations.apiCall(params),
    'api.execute': (params) => dependencies.systemApiOperations.apiExecute(params),
    'board.exportGerbers': (params) => dependencies.exportOperations.exportGerbers(params),
    'board.getDimensions': () => dependencies.boardInspection.getDimensions(),
    'board.getDesignRules': () => dependencies.boardInspection.getDesignRules(),
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
    'export.odb': (params) => dependencies.exportOperations.exportOdb(params),
    'export.pdf': (params) => dependencies.exportOperations.exportPdf(params),
    'export.pickPlace': (params) => dependencies.exportOperations.exportPickPlace(params),
    'pcb.addSilkscreenLine': (params) => dependencies.pcbWriteOperations.addSilkscreenLine(params),
    'pcb.addText': (params) => dependencies.pcbWriteOperations.addText(params),
    'pcb.addTrack': (params) => dependencies.pcbWriteOperations.addTrack(params),
    'pcb.addVia': (params) => dependencies.pcbWriteOperations.addVia(params),
    'pcb.addZone': (params) => dependencies.pcbMutationOperations.addZone(params),
    'pcb.deleteComponent': (params) => dependencies.pcbMutationOperations.deleteComponents(params),
    'pcb.exportRouteContext': (params) => dependencies.exportOperations.exportRouteContext(params),
    'pcb.zonePreflight': (params) =>
      params.rectangle === undefined
        ? dependencies.pcbReadOperations.zonePreflight(
            params.netName as string,
            params.layer as number,
          )
        : dependencies.pcbReadOperations.zonePreflight(
            params.netName as string,
            params.layer as number,
            params.rectangle as { x: number; y: number; width: number; height: number },
          ),
    ...Object.fromEntries(pcbListRoutes.map(({ method, handle }) => [method, handle])),
    'pcb.modifyComponent': (params) => dependencies.pcbMutationOperations.modifyComponent(params),
    'pcb.rebuildCopper': (params) => dependencies.pcbMutationOperations.rebuildCopper(params),
    'project.export': (params) => dependencies.projectOperations.export(params),
    'project.open': (params) => dependencies.projectOperations.open(params),
    'project.save': (params) => dependencies.projectOperations.save(params),
    'bom.generate': (params) => dependencies.readOnlyOperations.generateBom(params),
    'bom.validate': () => dependencies.readOnlyOperations.validateBom(),
    'inventory.getPrice': () => dependencies.readOnlyOperations.inventoryGetPrice(),
    'inventory.search': () => dependencies.readOnlyOperations.inventorySearch(),
    'library.getDeviceByLcscId': (params) =>
      dependencies.readOnlyOperations.getDeviceByLcscId(params),
    'schematic.deletePrimitive': (params) =>
      dependencies.schematicTransactionOperations.deletePrimitives(params.primitiveIds),
    'schematic.getNetDetail': (params) => dependencies.readOnlyOperations.getNetDetail(params),
    'schematic.getPinNoConnect': (params) =>
      dependencies.readOnlyOperations.getPinNoConnect(params),
    'schematic.getPrimitiveSnapshot': (params) =>
      dependencies.readOnlyOperations.getPrimitiveSnapshot(params),
    'schematic.getSheetInfo': (params) => dependencies.readOnlyOperations.getSheetInfo(params),
    'schematic.listComponents': (params) => dependencies.readOnlyOperations.listComponents(params),
    'schematic.listNets': (params) => dependencies.readOnlyOperations.listNets(params),
    'schematic.listPrimitiveIds': (params) =>
      dependencies.readOnlyOperations.listPrimitiveIds(params),
    'schematic.listRectangles': () => dependencies.readOnlyOperations.listRectangles(),
    'schematic.modifyPrimitive': (params) =>
      dependencies.schematicTransactionOperations.modifyPrimitive(
        params.primitiveId as string,
        (params.property as Record<string, unknown>) || {},
      ),
    'schematic.primitiveBounds': (params) =>
      dependencies.readOnlyOperations.primitiveBounds(params),
    'schematic.recreatePrimitiveSnapshot': (params) =>
      dependencies.schematicTransactionOperations.recreatePrimitiveSnapshot(params.snapshot),
    'schematic.restorePrimitiveSnapshot': (params) =>
      dependencies.schematicTransactionOperations.restorePrimitiveSnapshot(params.snapshot),
    'schematic.searchDevice': (params) => dependencies.readOnlyOperations.searchDevice(params),
    'schematic.validateNetlist': (params) =>
      dependencies.readOnlyOperations.validateNetlist(params),
    'system.apiInventory': (params) => dependencies.systemApiOperations.apiInventory(params),
    'system.getStatus': () => dependencies.systemApiOperations.getStatus(),
    'system.inspectComponents': (params) =>
      dependencies.systemApiOperations.inspectComponents(params),
    'system.inspectWires': (params) => dependencies.systemApiOperations.inspectWires(params),
  };
  const methodList = Object.freeze(
    Object.keys(routeHandlers).sort((left, right) => left.localeCompare(right)),
  );

  return {
    methodList,
    async tryDispatch(method, params = {}) {
      const route = Object.prototype.hasOwnProperty.call(routeHandlers, method)
        ? routeHandlers[method]
        : undefined;
      if (!route) return { handled: false };
      assertRouterSchematicScope(method, params);
      const scoped =
        method.startsWith('pcb.list') ||
        (params.projectId !== undefined && /^board\.(get|list)/.test(method));
      return {
        handled: true,
        value: await (scoped
          ? dependencies.pcbReadOperations.readProjectScoped(params.projectId as string, () =>
              route(params),
            )
          : route(params)),
      };
    },
  };
}
