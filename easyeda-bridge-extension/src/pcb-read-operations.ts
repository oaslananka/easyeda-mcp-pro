import type { ApiRuntime } from './api-runtime.js';
import { createComponentPadConnectionReader } from './pcb-pad-connection-operations.js';
import type { BoardInspectionOperations } from './board-inspection.js';
import { logRecoverableError } from './utils.js';
import {
  documentIdentity,
  evaluateZoneOutlineEvidence,
  type ZoneRectangle,
} from './zone-outline-evidence.js';

export type PrimitiveStateReader = (value: unknown, key: string) => unknown;

export interface PcbReadOperationDependencies {
  requireActivePcbContext: BoardInspectionOperations['requireActivePcbContext'];
  readFirstPath: ApiRuntime['readFirstPath'];
  readState: PrimitiveStateReader;
}

export interface PcbReadOperations {
  zonePreflight(netName: string, layer: number, rectangle?: ZoneRectangle): Promise<unknown>;
  readProjectScoped(
    projectId: string,
    read: () => Promise<unknown>,
    documentType?: number,
  ): Promise<unknown>;
  listComponents(limit?: number, offset?: number): Promise<unknown>;
  listFills(limit?: number, offset?: number): Promise<unknown>;
  listPours(limit?: number, offset?: number): Promise<unknown>;
  listRegions(limit?: number, offset?: number): Promise<unknown>;
  listTracks(limit?: number, offset?: number): Promise<unknown>;
  listVias(limit?: number, offset?: number): Promise<unknown>;
  listComponentPadConnections(componentPrimitiveId: string, padNumber: string): Promise<unknown>;
  deletePrimitives(primitiveIds: string[]): Promise<{ deleted: string[]; notFound: string[] }>;
}

/**
 * Classes deletePrimitives checks, in lookup order. Confirmed live
 * (2026-07-07): PCB_PrimitiveComponent.delete() returns `true` for ANY id,
 * including ids belonging to other primitive types or ids that do not exist.
 * Membership must therefore be checked through each concrete class before
 * invoking its delete method.
 */
const PCB_DELETABLE_CLASSES = [
  'PCB_PrimitiveComponent',
  'PCB_PrimitiveVia',
  'PCB_PrimitiveLine',
  'PCB_PrimitivePad',
  'PCB_PrimitivePolyline',
  'PCB_PrimitivePour',
  'PCB_PrimitiveArc',
  'PCB_PrimitiveAttribute',
  'PCB_PrimitiveDimension',
  'PCB_PrimitiveFill',
  'PCB_PrimitiveImage',
  'PCB_PrimitiveObject',
  'PCB_PrimitivePoured',
  'PCB_PrimitiveRegion',
  'PCB_PrimitiveString',
] as const;

function paginationEnd(limit: number | undefined, start: number): number | undefined {
  return typeof limit === 'number' ? start + Math.max(1, limit) : undefined;
}

function readPolygonPrimitiveState(
  readState: PrimitiveStateReader,
  value: unknown,
  key: string,
): unknown {
  if (value && typeof value === 'object') {
    const state = (value as { state?: unknown }).state;
    if (state && typeof state === 'object') {
      const record = state as Record<string, unknown>;
      const lowerCamelKey = key.length > 0 ? key.charAt(0).toLowerCase() + key.slice(1) : key;
      if (key in record) return record[key];
      if (lowerCamelKey in record) return record[lowerCamelKey];
    }
  }
  return readState(value, key);
}

async function polygonSource(
  readState: PrimitiveStateReader,
  value: unknown,
): Promise<unknown[] | undefined> {
  const polygon = readPolygonPrimitiveState(readState, value, 'ComplexPolygon');
  if (Array.isArray(polygon)) return polygon;
  if (!polygon || typeof polygon !== 'object') return undefined;
  try {
    const getSource = (polygon as { getSource?: unknown }).getSource;
    const source =
      typeof getSource === 'function'
        ? await (getSource as () => unknown).call(polygon)
        : (polygon as { polygon?: unknown }).polygon;
    return Array.isArray(source) ? source : undefined;
  } catch (error) {
    logRecoverableError('failed to read PCB Fill/Region polygon source', error);
    return undefined;
  }
}

async function optionalNativeRead(read: () => Promise<unknown>): Promise<unknown> {
  try {
    return await read();
  } catch {
    // Missing/throwing native getters must never authorize mutation.
    return undefined;
  }
}

async function readZoneGeometry(
  rectangle: ZoneRectangle | undefined,
  activePcb: boolean,
  readFirstPath: ApiRuntime['readFirstPath'],
  readState: PrimitiveStateReader,
) {
  if (!rectangle || !activePcb) return null;
  return evaluateZoneOutlineEvidence(rectangle, readFirstPath, readState);
}

function appendGeometryBlocker(
  blockers: string[],
  rectangle: ZoneRectangle | undefined,
  boardGeometry: { intersectionVerified: boolean; containmentVerified: boolean } | null,
): void {
  if (!rectangle) return;
  if (!boardGeometry?.intersectionVerified)
    blockers.push('candidate-board-intersection-unverified');
  if (!boardGeometry?.containmentVerified) blockers.push('candidate-board-containment-unverified');
}

interface ZonePreflightFlags {
  runtimeVerified: boolean;
  activePcb: boolean;
  nativeCapabilities: boolean;
  netVerified: boolean;
  layerVerified: boolean;
  focusChanged: boolean;
}

function zonePreflightBlockers(
  flags: ZonePreflightFlags,
  rectangle: ZoneRectangle | undefined,
  boardGeometry: { intersectionVerified: boolean; containmentVerified: boolean } | null,
): string[] {
  const checks: Array<[boolean, string]> = [
    [flags.runtimeVerified, 'runtime-version-unverified'],
    [flags.activePcb, 'active-pcb-unverified'],
    [flags.nativeCapabilities, 'native-zone-capabilities-unavailable'],
    [flags.netVerified, 'net-not-in-active-pcb'],
    [flags.layerVerified, 'copper-layer-unverified'],
  ];
  const blockers = checks.filter(([passed]) => !passed).map(([, reason]) => reason);
  if (flags.focusChanged) blockers.push('focused-pcb-changed-during-preflight');
  blockers.push(
    'board-outline-and-copper-topology-unverified',
    'apply-and-rollback-not-implemented',
  );
  appendGeometryBlocker(blockers, rectangle, boardGeometry);
  return blockers;
}

function hasNativeZoneCapabilities(pours: any, poured: any, document: any): boolean {
  return (
    typeof pours?.create === 'function' &&
    typeof poured?.get === 'function' &&
    typeof document?.save === 'function'
  );
}

function hasVerifiedZoneCopperLayer(layer: number, count: unknown): boolean {
  return (
    (layer === 1 || layer === 2) &&
    typeof count === 'number' &&
    Number.isInteger(count) &&
    count >= 2
  );
}

/** Classify scoped read failures without returning account/project/document identifiers. */
function scopedIdentityFailure(
  document: { documentType?: unknown; uuid?: unknown; parentProjectUuid?: unknown } | null,
  project: { uuid?: unknown } | null,
  requested: string,
  documentType: number,
): string | undefined {
  if (document?.documentType !== documentType) return 'wrong-focused-document-type';
  if (typeof document.uuid !== 'string' || !document.uuid)
    return 'focused-document-uuid-unavailable';
  if (project?.uuid !== requested) return 'current-project-uuid-mismatch';
  if (document.parentProjectUuid !== requested) return 'document-parent-project-mismatch';
  return undefined;
}

async function readCopperAssociation(
  pour: { getCopperRegion?: () => Promise<unknown> },
  primitiveId: string,
  readState: PrimitiveStateReader,
): Promise<Record<string, unknown>> {
  // Native getter is beta: missing/failed readback never means copper is verified.
  if (typeof pour.getCopperRegion !== 'function') return { copperLinkStatus: 'unavailable' };
  try {
    const derived = await pour.getCopperRegion();
    if (derived === undefined) return { copperLinkStatus: 'absent' };
    if (!derived || typeof derived !== 'object') return { copperLinkStatus: 'unavailable' };
    const derivedId = readState(derived, 'PrimitiveId');
    if (derivedId !== primitiveId || readState(derived, 'PourPrimitiveId') !== primitiveId) {
      return { copperLinkStatus: 'mismatch' };
    }
    const fills = readState(derived, 'PourFills');
    if (!Array.isArray(fills)) return { copperLinkStatus: 'unavailable' };
    return { copperLinkStatus: 'present', pouredId: derivedId, fillRecordCount: fills.length };
  } catch (error) {
    return {
      copperLinkStatus: 'unavailable',
      readbackError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createPcbReadOperations({
  requireActivePcbContext,
  readFirstPath,
  readState,
}: PcbReadOperationDependencies): PcbReadOperations {
  async function verifiedPcbIdentity(projectId: string, documentType: number) {
    const documentApi = readFirstPath<any>(['DMT_SelectControl', 'dmt_SelectControl']);
    const projectApi = readFirstPath<any>(['DMT_Project', 'dmt_Project']);
    if (
      typeof projectId !== 'string' ||
      projectId.length === 0 ||
      typeof documentApi?.getCurrentDocumentInfo !== 'function' ||
      typeof projectApi?.getCurrentProjectInfo !== 'function'
    ) {
      throw new Error(
        'PCB project identity unavailable: native project/document getters are required',
      );
    }
    const document = await documentApi.getCurrentDocumentInfo();
    const project = await projectApi.getCurrentProjectInfo();
    const reason = scopedIdentityFailure(document, project, projectId, documentType);
    if (reason) {
      const label = documentType === 3 ? 'PCB' : 'Schematic';
      throw new Error(`${label} project identity mismatch: ${reason}`);
    }
    return document.uuid as string;
  }

  async function readProjectScoped(
    projectId: string,
    read: () => Promise<unknown>,
    documentType = 3,
  ): Promise<unknown> {
    const before = await verifiedPcbIdentity(projectId, documentType);
    const result = await read();
    const after = await verifiedPcbIdentity(projectId, documentType);
    if (before !== after) {
      throw new Error(
        `${documentType === 3 ? 'PCB' : 'Schematic'} document changed during list read; discard results and retry`,
      );
    }
    return result;
  }

  async function zonePreflight(
    netName: string,
    layer: number,
    rectangle?: ZoneRectangle,
  ): Promise<unknown> {
    const environment = readFirstPath<any>(['SYS_Environment', 'sys_Environment']);
    const nets = readFirstPath<any>(['PCB_Net', 'pcb_Net']);
    const layers = readFirstPath<any>(['PCB_Layer', 'pcb_Layer']);
    const pours = readFirstPath<any>(['PCB_PrimitivePour', 'pcb_PrimitivePour']);
    const poured = readFirstPath<any>(['PCB_PrimitivePoured', 'pcb_PrimitivePoured']);
    const document = readFirstPath<any>(['PCB_Document', 'pcb_Document']);

    const reportedVersion = await optionalNativeRead(() =>
      environment?.getEditorCurrentVersion?.(),
    );
    const version = typeof reportedVersion === 'string' ? reportedVersion : null;
    const runtimeVerified = version !== null && /^3\.2\.(?:206|209)(?:\.|$)/.test(version);
    const identityBefore = await optionalNativeRead(() => documentIdentity(readFirstPath));
    const focusedAtStart = typeof identityBefore === 'string';
    const nativeCapabilities = hasNativeZoneCapabilities(pours, poured, document);

    const names = focusedAtStart
      ? await optionalNativeRead(() => nets?.getAllNetName?.())
      : undefined;
    const count = focusedAtStart
      ? await optionalNativeRead(() => layers?.getTheNumberOfCopperLayers?.())
      : undefined;
    // Informational only. Even strict outline containment says nothing about copper topology.
    const observedGeometry = await readZoneGeometry(
      rectangle,
      focusedAtStart,
      readFirstPath,
      readState,
    );
    // The active design can change while awaiting native net/layer/outline reads.
    // Never return stale membership and geometry evidence as a valid preflight.
    const identityAfter = await optionalNativeRead(() => documentIdentity(readFirstPath));
    const focusChanged = focusedAtStart && identityBefore !== identityAfter;
    const activePcb = focusedAtStart && identityBefore === identityAfter;
    const netVerified = activePcb && Array.isArray(names) && names.includes(netName);
    const layerVerified = activePcb && hasVerifiedZoneCopperLayer(layer, count);
    const boardGeometry = activePcb ? observedGeometry : null;
    const blockers = zonePreflightBlockers(
      { runtimeVerified, activePcb, nativeCapabilities, netVerified, layerVerified, focusChanged },
      rectangle,
      boardGeometry,
    );
    return {
      runtimeVersion: version,
      runtimeVerified,
      activePcb,
      nativeCapabilities,
      netVerified,
      layerVerified,
      boardGeometry,
      readyToApply: false,
      blockers,
    };
  }

  async function nativePcbPrimitives(
    kind: 'Component' | 'Line' | 'Via' | 'Fill' | 'Region' | 'Pour',
  ): Promise<any[]> {
    const name = `PCB_Primitive${kind}`;
    const nativeClass = readFirstPath<any>([name, `pcb_Primitive${kind}`]);
    if (typeof nativeClass?.getAll !== 'function') {
      throw new Error(`${name}.getAll is unavailable in this EasyEDA Pro runtime`);
    }
    const result: unknown = await nativeClass.getAll();
    if (!Array.isArray(result)) {
      throw new Error(`${name}.getAll returned a non-array collection`);
    }
    return result;
  }

  async function listComponents(limit?: number, offset = 0): Promise<unknown> {
    await requireActivePcbContext();
    const all = await nativePcbPrimitives('Component');
    const start = Math.max(0, offset);
    const items = all.slice(start, paginationEnd(limit, start)).map((component: any) => {
      const footprint = readState(component, 'Footprint') as Record<string, unknown> | undefined;
      const device = readState(component, 'Component') as Record<string, unknown> | undefined;
      return {
        primitiveId: readState(component, 'PrimitiveId') ?? '',
        designator: readState(component, 'Designator') ?? '',
        footprintName: footprint?.name ?? '',
        footprintUuid: footprint?.uuid ?? '',
        footprintLibraryUuid: footprint?.libraryUuid ?? '',
        deviceName: device?.name ?? '',
        x: readState(component, 'X'),
        y: readState(component, 'Y'),
        rotation: readState(component, 'Rotation'),
        layer: readState(component, 'Layer'),
        locked: readState(component, 'PrimitiveLock') ?? false,
      };
    });
    return { total: all.length, items };
  }

  async function listPolygonPrimitives(
    kind: 'Fill' | 'Region',
    limit?: number,
    offset = 0,
  ): Promise<unknown> {
    await requireActivePcbContext();
    const all = await nativePcbPrimitives(kind);
    const start = Math.max(0, offset);
    const fill = kind === 'Fill';
    const items = await Promise.all(
      all.slice(start, paginationEnd(limit, start)).map(async (value: any) => ({
        primitiveId: readPolygonPrimitiveState(readState, value, 'PrimitiveId'),
        layer: readPolygonPrimitiveState(readState, value, 'Layer'),
        ...(fill
          ? {
              net: readPolygonPrimitiveState(readState, value, 'Net'),
              fillMode: readPolygonPrimitiveState(readState, value, 'FillMode'),
            }
          : {
              ruleTypes: readPolygonPrimitiveState(readState, value, 'RuleType'),
              regionName: readPolygonPrimitiveState(readState, value, 'RegionName'),
            }),
        lineWidth: readPolygonPrimitiveState(readState, value, 'LineWidth'),
        locked: readPolygonPrimitiveState(readState, value, 'PrimitiveLock'),
        polygonSource: await polygonSource(readState, value),
      })),
    );
    return { total: all.length, items };
  }

  async function listPours(limit?: number, offset = 0): Promise<unknown> {
    await requireActivePcbContext();
    const all = await nativePcbPrimitives('Pour');
    const start = Math.max(0, offset);
    const items: Array<Record<string, unknown>> = [];

    for (const pour of all.slice(start, paginationEnd(limit, start))) {
      const primitiveId = readState(pour, 'PrimitiveId');
      if (typeof primitiveId !== 'string' || !primitiveId) {
        throw new Error('Native copper Pour has no verifiable primitive ID');
      }
      const item: Record<string, unknown> = {
        primitiveId,
        net: readState(pour, 'Net') ?? '',
        layer: readState(pour, 'Layer'),
        fillMethod: readState(pour, 'PourFillMethod') ?? '',
        pourName: readState(pour, 'PourName') ?? '',
        locked: readState(pour, 'PrimitiveLock') === true,
      };

      Object.assign(item, await readCopperAssociation(pour, primitiveId, readState));
      items.push(item);
    }
    return { total: all.length, items };
  }

  const listFills = (limit?: number, offset = 0) => listPolygonPrimitives('Fill', limit, offset);
  const listRegions = (limit?: number, offset = 0) =>
    listPolygonPrimitives('Region', limit, offset);

  async function listTracks(limit?: number, offset = 0): Promise<unknown> {
    await requireActivePcbContext();
    // Tracks are PCB_PrimitiveLine segments. PCB_PrimitivePolyline.create()
    // never resolved in the live runtime used to validate pcb.addTrack.
    const all = await nativePcbPrimitives('Line');
    const start = Math.max(0, offset);
    const items = all.slice(start, paginationEnd(limit, start)).map((line: any) => ({
      primitiveId: readState(line, 'PrimitiveId') ?? '',
      net: readState(line, 'Net') ?? '',
      layer: readState(line, 'Layer'),
      startX: readState(line, 'StartX'),
      startY: readState(line, 'StartY'),
      endX: readState(line, 'EndX'),
      endY: readState(line, 'EndY'),
      width: readState(line, 'LineWidth'),
      locked: readState(line, 'PrimitiveLock') ?? false,
    }));
    return { total: all.length, items };
  }

  async function listVias(limit?: number, offset = 0): Promise<unknown> {
    await requireActivePcbContext();
    const all = await nativePcbPrimitives('Via');
    const start = Math.max(0, offset);
    const items = all.slice(start, paginationEnd(limit, start)).map((via: any) => ({
      primitiveId: readState(via, 'PrimitiveId') ?? '',
      net: readState(via, 'Net') ?? '',
      x: readState(via, 'X'),
      y: readState(via, 'Y'),
      holeDiameter: readState(via, 'HoleDiameter'),
      diameter: readState(via, 'Diameter'),
      locked: readState(via, 'PrimitiveLock') ?? false,
    }));
    return { total: all.length, items };
  }

  async function deletePrimitives(
    primitiveIds: string[],
  ): Promise<{ deleted: string[]; notFound: string[] }> {
    const remaining = new Set(primitiveIds);
    const deleted: string[] = [];

    for (const className of PCB_DELETABLE_CLASSES) {
      if (remaining.size === 0) break;
      const primitiveClass = readFirstPath<any>([className]);
      if (
        !primitiveClass ||
        typeof primitiveClass.getAllPrimitiveId !== 'function' ||
        typeof primitiveClass.delete !== 'function'
      ) {
        continue;
      }

      let ownedIds: Set<string>;
      try {
        ownedIds = new Set((await primitiveClass.getAllPrimitiveId()) ?? []);
      } catch (error) {
        logRecoverableError(`pcb.deleteComponent: ${className}.getAllPrimitiveId failed`, error);
        continue;
      }

      const matches = [...remaining].filter((id) => ownedIds.has(id));
      if (matches.length === 0) continue;
      try {
        await primitiveClass.delete(matches);
        for (const id of matches) {
          remaining.delete(id);
          deleted.push(id);
        }
      } catch (error) {
        logRecoverableError(`pcb.deleteComponent: ${className}.delete failed`, error);
      }
    }

    return { deleted, notFound: [...remaining] };
  }

  const listComponentPadConnections = createComponentPadConnectionReader({
    requireActivePcbContext,
    readFirstPath,
    readState,
  });

  return {
    zonePreflight,
    readProjectScoped,
    listComponents,
    listFills,
    listPours,
    listRegions,
    listTracks,
    listVias,
    listComponentPadConnections,
    deletePrimitives,
  };
}
