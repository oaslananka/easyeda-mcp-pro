import type { ApiRuntime } from './api-runtime.js';
import type { BoardInspectionOperations } from './board-inspection.js';
import { logRecoverableError } from './utils.js';

export type PrimitiveStateReader = (value: unknown, key: string) => unknown;

export interface PcbReadOperationDependencies {
  requireActivePcbContext: BoardInspectionOperations['requireActivePcbContext'];
  readFirstPath: ApiRuntime['readFirstPath'];
  readState: PrimitiveStateReader;
}

export interface PcbReadOperations {
  listComponents(limit?: number, offset?: number): Promise<unknown>;
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

export function createPcbReadOperations({
  requireActivePcbContext,
  readFirstPath,
  readState,
}: PcbReadOperationDependencies): PcbReadOperations {
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
    listComponents,
    listTracks,
    listVias,
    deletePrimitives,
  };
}
