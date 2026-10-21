import type { ApiRuntime } from './api-runtime.js';
import type { BoardInspectionOperations } from './board-inspection.js';
import { logRecoverableError } from './utils.js';
import { evaluateZoneOutlineEvidence, type ZoneRectangle } from './zone-outline-evidence.js';

export type PrimitiveStateReader = (value: unknown, key: string) => unknown;

export interface PcbReadOperationDependencies {
  requireActivePcbContext: BoardInspectionOperations['requireActivePcbContext'];
  readFirstPath: ApiRuntime['readFirstPath'];
  readState: PrimitiveStateReader;
}

export interface PcbReadOperations {
  zonePreflight(netName: string, layer: number, rectangle?: ZoneRectangle): Promise<unknown>;
  readProjectScoped(projectId: string, read: () => Promise<unknown>): Promise<unknown>;
  listComponents(limit?: number, offset?: number): Promise<unknown>;
  listFills(limit?: number, offset?: number): Promise<unknown>;
  listRegions(limit?: number, offset?: number): Promise<unknown>;
  listTracks(limit?: number, offset?: number): Promise<unknown>;
  listVias(limit?: number, offset?: number): Promise<unknown>;
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

async function focusedPcbIsVerified(pcb: any, selection: any): Promise<boolean> {
  const current = await optionalNativeRead(() => pcb?.getCurrentPcbInfo?.());
  if (current) return true;
  const selected = (await optionalNativeRead(() => selection?.getCurrentDocumentInfo?.())) as
    { documentType?: unknown; uuid?: unknown } | undefined;
  return (
    selected?.documentType === 3 && typeof selected.uuid === 'string' && selected.uuid.length > 0
  );
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
  boardGeometry: { intersectionVerified: boolean } | null,
): void {
  if (rectangle && !boardGeometry?.intersectionVerified) {
    blockers.push('candidate-board-intersection-unverified');
  }
}

export function createPcbReadOperations({
  requireActivePcbContext,
  readFirstPath,
  readState,
}: PcbReadOperationDependencies): PcbReadOperations {
  function identityMatches(
    projectId: string,
    document: { documentType?: unknown; uuid?: unknown; parentProjectUuid?: unknown } | undefined,
    project: { uuid?: unknown } | undefined,
  ): boolean {
    return (
      document?.documentType === 3 &&
      typeof document.uuid === 'string' &&
      document.uuid.length > 0 &&
      typeof project?.uuid === 'string' &&
      project.uuid.length > 0 &&
      document.parentProjectUuid === project.uuid &&
      projectId === project.uuid
    );
  }

  async function verifiedPcbIdentity(projectId: string) {
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
    if (!identityMatches(projectId, document, project)) {
      throw new Error(
        'PCB project identity mismatch: requested project UUID must match the focused PCB',
      );
    }
    return { projectUuid: project.uuid as string, documentUuid: document.uuid as string };
  }

  async function readProjectScoped(
    projectId: string,
    read: () => Promise<unknown>,
  ): Promise<unknown> {
    const before = await verifiedPcbIdentity(projectId);
    const result = await read();
    const after = await verifiedPcbIdentity(projectId);
    if (before.projectUuid !== after.projectUuid || before.documentUuid !== after.documentUuid) {
      throw new Error('PCB document changed during list read; discard results and retry');
    }
    return result;
  }

  async function zonePreflight(
    netName: string,
    layer: number,
    rectangle?: ZoneRectangle,
  ): Promise<unknown> {
    const environment = readFirstPath<any>(['SYS_Environment', 'sys_Environment']);
    const pcb = readFirstPath<any>(['DMT_Pcb', 'dmt_Pcb']);
    const selection = readFirstPath<any>(['DMT_SelectControl', 'dmt_SelectControl']);
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
    const activePcb = await focusedPcbIsVerified(pcb, selection);
    const nativeCapabilities =
      typeof pours?.create === 'function' &&
      typeof poured?.get === 'function' &&
      typeof document?.save === 'function';

    const names = activePcb ? await optionalNativeRead(() => nets?.getAllNetName?.()) : undefined;
    const netVerified = Array.isArray(names) && names.includes(netName);
    const count = activePcb
      ? await optionalNativeRead(() => layers?.getTheNumberOfCopperLayers?.())
      : undefined;
    const layerVerified =
      (layer === 1 || layer === 2) &&
      typeof count === 'number' &&
      Number.isInteger(count) &&
      count >= 2;
    // Informational only. Even a proven rectangle overlap says nothing about clearance.
    const boardGeometry = await readZoneGeometry(rectangle, activePcb, readFirstPath, readState);
    const checks: Array<[boolean, string]> = [
      [runtimeVerified, 'runtime-version-unverified'],
      [activePcb, 'active-pcb-unverified'],
      [nativeCapabilities, 'native-zone-capabilities-unavailable'],
      [netVerified, 'net-not-in-active-pcb'],
      [layerVerified, 'copper-layer-unverified'],
    ];
    const blockers = checks.filter(([passed]) => !passed).map(([, reason]) => reason);
    // A bounding box is not proof of full board containment or safe copper topology.
    blockers.push(
      'board-outline-and-copper-topology-unverified',
      'apply-and-rollback-not-implemented',
    );
    appendGeometryBlocker(blockers, rectangle, boardGeometry);
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

  async function listComponents(limit?: number, offset = 0): Promise<unknown> {
    await requireActivePcbContext();
    const pcbCompClass = readFirstPath<any>(['PCB_PrimitiveComponent', 'pcb_PrimitiveComponent']);
    if (!pcbCompClass || typeof pcbCompClass.getAll !== 'function') {
      return { total: 0, items: [] };
    }

    const all = (await pcbCompClass.getAll()) || [];
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
    const pcbClass = readFirstPath<any>([`PCB_Primitive${kind}`, `pcb_Primitive${kind}`]);
    if (!pcbClass || typeof pcbClass.getAll !== 'function') {
      throw new Error(`PCB_Primitive${kind}.getAll is unavailable in this EasyEDA Pro runtime`);
    }
    const all = (await pcbClass.getAll()) || [];
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

  const listFills = (limit?: number, offset = 0) => listPolygonPrimitives('Fill', limit, offset);
  const listRegions = (limit?: number, offset = 0) =>
    listPolygonPrimitives('Region', limit, offset);

  async function listTracks(limit?: number, offset = 0): Promise<unknown> {
    await requireActivePcbContext();
    // Tracks are PCB_PrimitiveLine segments. PCB_PrimitivePolyline.create()
    // never resolved in the live runtime used to validate pcb.addTrack.
    const pcbLineClass = readFirstPath<any>(['PCB_PrimitiveLine', 'pcb_PrimitiveLine']);
    if (!pcbLineClass || typeof pcbLineClass.getAll !== 'function') {
      return { total: 0, items: [] };
    }

    const all = (await pcbLineClass.getAll()) || [];
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
    const pcbViaClass = readFirstPath<any>(['PCB_PrimitiveVia', 'pcb_PrimitiveVia']);
    if (!pcbViaClass || typeof pcbViaClass.getAll !== 'function') {
      return { total: 0, items: [] };
    }

    const all = (await pcbViaClass.getAll()) || [];
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

  return {
    zonePreflight,
    readProjectScoped,
    listComponents,
    listFills,
    listRegions,
    listTracks,
    listVias,
    deletePrimitives,
  };
}
