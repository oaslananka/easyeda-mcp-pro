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

const MAX_PCB_POLYGON_POINTS = 500;

interface PcbPoint {
  x: number;
  y: number;
}

interface PcbBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface PcbPolygonContour {
  points: PcbPoint[];
  pointCount: number;
  truncated: boolean;
  bounds: PcbBounds;
}

interface PcbPolygonSummary {
  contours: PcbPolygonContour[];
  contourCount: number;
  pointCount: number;
  truncated: boolean;
  bounds: PcbBounds;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function mergeBounds(current: PcbBounds | undefined, point: PcbPoint): PcbBounds {
  if (!current) {
    return { minX: point.x, minY: point.y, maxX: point.x, maxY: point.y };
  }
  return {
    minX: Math.min(current.minX, point.x),
    minY: Math.min(current.minY, point.y),
    maxX: Math.max(current.maxX, point.x),
    maxY: Math.max(current.maxY, point.y),
  };
}

const FALLBACK_CIRCLE_SEGMENTS = 32;

function circleSourcePoints(source: unknown[]): PcbPoint[] {
  const cx = finiteNumber(source[1]);
  const cy = finiteNumber(source[2]);
  const radius = finiteNumber(source[3]);
  if (cx === undefined || cy === undefined || radius === undefined || radius <= 0) return [];
  return Array.from({ length: FALLBACK_CIRCLE_SEGMENTS }, (_, index) => {
    const angle = (index / FALLBACK_CIRCLE_SEGMENTS) * Math.PI * 2;
    return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
  });
}

function rectangleSourcePoints(source: unknown[]): PcbPoint[] {
  const x = finiteNumber(source[1]);
  const y = finiteNumber(source[2]);
  const width = finiteNumber(source[3]);
  const height = finiteNumber(source[4]);
  const rotation = finiteNumber(source[5]);
  const round = finiteNumber(source[6]);
  const values = [x, y, width, height];
  if (values.some((value) => value === undefined)) return [];
  if (rotation !== 0 || round !== 0 || (width as number) < 0 || (height as number) < 0) return [];
  const left = x as number;
  const top = y as number;
  const right = left + (width as number);
  const bottom = top + (height as number);
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

function lineSourcePoints(source: unknown[]): PcbPoint[] {
  if (source.some((token) => typeof token === 'string' && token !== 'L')) return [];
  const coordinates = source.filter((token) => token !== 'L');
  if (coordinates.length < 6 || coordinates.length % 2 !== 0) return [];
  const points: PcbPoint[] = [];
  for (let index = 0; index < coordinates.length; index += 2) {
    const point = { x: finiteNumber(coordinates[index]), y: finiteNumber(coordinates[index + 1]) };
    if (point.x === undefined || point.y === undefined) return [];
    points.push({ x: point.x, y: point.y });
  }
  return points;
}

function documentedSourcePoints(source: unknown): PcbPoint[] {
  if (!Array.isArray(source) || source.length === 0) return [];
  if (source[0] === 'CIRCLE') return circleSourcePoints(source);
  if (source[0] === 'R') return rectangleSourcePoints(source);
  return lineSourcePoints(source);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function createPcbReadOperations({
  requireActivePcbContext,
  readFirstPath,
  readState,
}: PcbReadOperationDependencies): PcbReadOperations {
  function normalizePoint(value: unknown): PcbPoint | undefined {
    if (Array.isArray(value)) {
      const x = finiteNumber(value[0]);
      const y = finiteNumber(value[1]);
      return x === undefined || y === undefined ? undefined : { x, y };
    }
    if (!isRecord(value)) return undefined;
    const x = finiteNumber(readState(value, 'X') ?? value.x);
    const y = finiteNumber(readState(value, 'Y') ?? value.y);
    return x === undefined || y === undefined ? undefined : { x, y };
  }

  async function discretizeContour(value: unknown, pcbMathPolygonClass: any): Promise<PcbPoint[]> {
    if (isRecord(value) && typeof value.discretize === 'function') {
      try {
        const points = await value.discretize();
        const normalized = Array.isArray(points)
          ? (points.map(normalizePoint).filter(Boolean) as PcbPoint[])
          : [];
        if (normalized.length > 0) return normalized;
      } catch (error) {
        logRecoverableError('failed to discretize PCB Fill/Region polygon directly', error);
      }
    }

    let source = value;
    if (isRecord(value) && typeof value.getSource === 'function') {
      try {
        source = await value.getSource();
      } catch (error) {
        logRecoverableError('failed to read PCB Fill/Region polygon source', error);
      }
    }

    if (pcbMathPolygonClass && typeof pcbMathPolygonClass.discretize === 'function') {
      try {
        const points = await pcbMathPolygonClass.discretize(source);
        const normalized = Array.isArray(points)
          ? (points.map(normalizePoint).filter(Boolean) as PcbPoint[])
          : [];
        if (normalized.length > 0) return normalized;
      } catch (error) {
        logRecoverableError('failed to discretize PCB Fill/Region polygon source', error);
      }
    }
    return documentedSourcePoints(source);
  }

  async function polygonContours(complexPolygon: unknown): Promise<unknown[]> {
    if (Array.isArray(complexPolygon)) {
      if (complexPolygon.length === 0) return [];
      return Array.isArray(complexPolygon[0]) ? complexPolygon : [complexPolygon];
    }
    if (!isRecord(complexPolygon)) return [];
    // EasyEDA Pro 3.2.149 exposes the primitive state's ComplexPolygon wrapper
    // with discretize() directly, even though newer API declarations also
    // describe toPolygon(). Treat that live wrapper as one contour instead of
    // dropping geometry when toPolygon() is absent.
    if (typeof complexPolygon.discretize === 'function') return [complexPolygon];
    if (typeof complexPolygon.toPolygon === 'function') {
      try {
        const polygons = await complexPolygon.toPolygon();
        if (Array.isArray(polygons)) return polygons;
      } catch (error) {
        logRecoverableError('failed to split PCB Fill/Region complex polygon', error);
      }
    }
    if (typeof complexPolygon.getSource === 'function') {
      try {
        const source = await complexPolygon.getSource();
        if (!Array.isArray(source)) return [];
        return Array.isArray(source[0]) ? source : [source];
      } catch (error) {
        logRecoverableError('failed to read PCB Fill/Region polygon source', error);
      }
    }
    return [];
  }

  async function normalizeComplexPolygon(value: unknown): Promise<PcbPolygonSummary | undefined> {
    const complexPolygon = await value;
    const candidates = await polygonContours(complexPolygon);
    if (candidates.length === 0) return undefined;
    const pcbMathPolygonClass = readFirstPath<any>(['PCB_MathPolygon', 'pcb_MathPolygon']);
    const contours: PcbPolygonContour[] = [];
    let contourCount = 0;
    let pointCount = 0;
    let storedPointCount = 0;
    let bounds: PcbBounds | undefined;

    for (const candidate of candidates) {
      const points = await discretizeContour(candidate, pcbMathPolygonClass);
      if (points.length === 0) continue;
      contourCount += 1;
      pointCount += points.length;
      let contourBounds: PcbBounds | undefined;
      for (const point of points) {
        contourBounds = mergeBounds(contourBounds, point);
        bounds = mergeBounds(bounds, point);
      }
      const remaining = Math.max(0, MAX_PCB_POLYGON_POINTS - storedPointCount);
      const storedPoints = points.slice(0, remaining);
      storedPointCount += storedPoints.length;
      if (storedPoints.length > 0 && contourBounds) {
        contours.push({
          points: storedPoints,
          pointCount: points.length,
          truncated: storedPoints.length < points.length,
          bounds: contourBounds,
        });
      }
    }

    if (!bounds || pointCount === 0) return undefined;
    return {
      contours,
      contourCount,
      pointCount,
      truncated: storedPointCount < pointCount,
      bounds,
    };
  }

  function readNumber(value: unknown, key: string): number | undefined {
    return finiteNumber(readState(value, key));
  }

  function readString(value: unknown, key: string): string {
    const current = readState(value, key);
    return typeof current === 'string' ? current : '';
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

  async function listFills(limit?: number, offset = 0): Promise<unknown> {
    await requireActivePcbContext();
    const pcbFillClass = readFirstPath<any>(['PCB_PrimitiveFill', 'pcb_PrimitiveFill']);
    if (!pcbFillClass || typeof pcbFillClass.getAll !== 'function') {
      throw new Error('PCB_PrimitiveFill.getAll is unavailable in this EasyEDA Pro runtime');
    }

    const all = (await pcbFillClass.getAll()) || [];
    const start = Math.max(0, offset);
    const selected = all.slice(start, paginationEnd(limit, start));
    const items = await Promise.all(
      selected.map(async (fill: any) => {
        const net = readString(fill, 'Net');
        return {
          primitiveId: readString(fill, 'PrimitiveId'),
          layer: readNumber(fill, 'Layer'),
          net,
          netless: net.length === 0,
          fillMode: readNumber(fill, 'FillMode'),
          lineWidth: readNumber(fill, 'LineWidth'),
          locked: readState(fill, 'PrimitiveLock') === true,
          polygon: await normalizeComplexPolygon(readState(fill, 'ComplexPolygon')),
        };
      }),
    );
    return { total: all.length, items };
  }

  async function listRegions(limit?: number, offset = 0): Promise<unknown> {
    await requireActivePcbContext();
    const pcbRegionClass = readFirstPath<any>(['PCB_PrimitiveRegion', 'pcb_PrimitiveRegion']);
    if (!pcbRegionClass || typeof pcbRegionClass.getAll !== 'function') {
      throw new Error('PCB_PrimitiveRegion.getAll is unavailable in this EasyEDA Pro runtime');
    }

    const all = (await pcbRegionClass.getAll()) || [];
    const start = Math.max(0, offset);
    const selected = all.slice(start, paginationEnd(limit, start));
    const items = await Promise.all(
      selected.map(async (region: any) => {
        const rawRuleTypes = readState(region, 'RuleType');
        const ruleTypes = Array.isArray(rawRuleTypes)
          ? rawRuleTypes.filter((value): value is number => Number.isInteger(value))
          : [];
        return {
          primitiveId: readString(region, 'PrimitiveId'),
          layer: readNumber(region, 'Layer'),
          ruleTypes,
          regionName: readString(region, 'RegionName'),
          lineWidth: readNumber(region, 'LineWidth'),
          locked: readState(region, 'PrimitiveLock') === true,
          polygon: await normalizeComplexPolygon(readState(region, 'ComplexPolygon')),
        };
      }),
    );
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
    listFills,
    listRegions,
    listTracks,
    listVias,
    deletePrimitives,
  };
}
