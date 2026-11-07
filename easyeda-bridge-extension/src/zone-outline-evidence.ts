// Conservative geometry evidence for the read-only zone preflight.
// A verified board outline is NOT copper topology, keepout, DRC or fabrication approval.
import {
  primitiveIsOnBoardOutlineResolved,
  readBoardPolygonSource,
  readPrimitiveStateResolved,
} from './board-inspection.js';
import { nativeClosedPolyline, polygonRectangleRelation } from './zone-polygon-intersection.js';
export interface ZoneRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ZoneIntersectionStatus =
  'intersection-confirmed' | 'outside-board' | 'observed' | 'unsupported-outline' | 'unavailable';

export interface ZoneOutlineEvidence {
  status: ZoneIntersectionStatus;
  intersectionVerified: boolean;
  outline: { x: number; y: number; width: number; height: number } | null;
  outlineKind?: 'rectangle' | 'closed-polyline';
  intersection?: 'inside' | 'partial' | 'outside';
}

type NativeReader = <T>(paths: readonly string[]) => T | undefined;
type StateReader = (object: unknown, field: string) => unknown;

function unavailable(): ZoneOutlineEvidence {
  return { status: 'unavailable', intersectionVerified: false, outline: null };
}

function unsupported(): ZoneOutlineEvidence {
  return { status: 'unsupported-outline', intersectionVerified: false, outline: null };
}

function isFiniteRectangle(r: ZoneRectangle): boolean {
  return [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
}

function nativeRectangle(source: unknown): ZoneRectangle | undefined {
  if (
    !Array.isArray(source) ||
    source.length !== 7 ||
    source[0] !== 'R' ||
    source[5] !== 0 ||
    source[6] !== 0
  )
    return undefined;
  const rect = { x: source[1], y: source[2], width: source[3], height: source[4] };
  if (!isFiniteRectangle(rect)) return undefined;
  return rect;
}

function overlaps(a: ZoneRectangle, b: ZoneRectangle): boolean {
  // Native R rectangles extend right and DOWN (negative Y).
  return (
    Math.max(a.x, b.x) < Math.min(a.x + a.width, b.x + b.width) &&
    Math.max(a.y - a.height, b.y - b.height) < Math.min(a.y, b.y)
  );
}

async function documentIdentity(readFirstPath: NativeReader): Promise<string | undefined> {
  const project = readFirstPath<Record<string, unknown>>(['DMT_Project', 'dmt_Project']);
  const selection = readFirstPath<Record<string, unknown>>([
    'DMT_SelectControl',
    'dmt_SelectControl',
  ]);
  if (
    typeof project?.getCurrentProjectInfo !== 'function' ||
    typeof selection?.getCurrentDocumentInfo !== 'function'
  )
    return undefined;
  const p = (await project.getCurrentProjectInfo()) as { uuid?: unknown } | undefined;
  const d = (await selection.getCurrentDocumentInfo()) as
    | {
        uuid?: unknown;
        parentProjectUuid?: unknown;
        documentType?: unknown;
      }
    | undefined;
  if (
    typeof p?.uuid !== 'string' ||
    !p.uuid ||
    typeof d?.uuid !== 'string' ||
    !d.uuid ||
    d.documentType !== 3 ||
    d.parentProjectUuid !== p.uuid
  )
    return undefined;
  return JSON.stringify([p.uuid, d.uuid]);
}

async function outlineCollection(readFirstPath: NativeReader, name: string): Promise<unknown[]> {
  const api = readFirstPath<Record<string, unknown>>([name, name.replace(/^PCB_/, 'pcb_')]);
  if (typeof api?.getAll !== 'function') throw Error('Outline API missing');
  const values = await api.getAll();
  if (!Array.isArray(values)) throw Error('Outline read failed');
  return values;
}

async function readSingleOutlineSource(
  readFirstPath: NativeReader,
  readState: StateReader,
): Promise<unknown[] | undefined> {
  const polyline = await outlineCollection(readFirstPath, 'PCB_PrimitivePolyline');
  const line = await outlineCollection(readFirstPath, 'PCB_PrimitiveLine');
  const arc = await outlineCollection(readFirstPath, 'PCB_PrimitiveArc');
  const regions = await outlineCollection(readFirstPath, 'PCB_PrimitiveRegion');
  // Additional boundary primitives/regions have unverified contour and cutout semantics.
  if (regions.length > 0) return undefined;
  for (const primitive of [...line, ...arc]) {
    if (await primitiveIsOnBoardOutlineResolved(primitive)) return undefined;
  }
  const outlines: unknown[] = [];
  for (const primitive of polyline) {
    if (await primitiveIsOnBoardOutlineResolved(primitive)) outlines.push(primitive);
  }
  if (outlines.length !== 1) return undefined;
  const polygon =
    (await readState(outlines[0], 'Polygon')) ??
    (await readPrimitiveStateResolved(outlines[0], 'Polygon'));
  if (!polygon || typeof polygon !== 'object') return undefined;
  return readBoardPolygonSource(polygon as Record<string, unknown>);
}

function classifyOutline(rectangle: ZoneRectangle, source: unknown): ZoneOutlineEvidence {
  const bounds = nativeRectangle(source);
  if (bounds) {
    const intersects = overlaps(rectangle, bounds);
    return {
      status: intersects ? 'intersection-confirmed' : 'outside-board',
      intersectionVerified: intersects,
      outline: bounds,
    };
  }
  const vertices = nativeClosedPolyline(source);
  if (!vertices) return unsupported();
  const intersection = polygonRectangleRelation(vertices, rectangle);
  return {
    status: 'observed',
    intersectionVerified: intersection !== 'outside',
    outline: null, // A polygon cannot be represented truthfully by its bounding rectangle.
    outlineKind: 'closed-polyline',
    intersection,
  };
}

export async function evaluateZoneOutlineEvidence(
  rectangle: ZoneRectangle,
  readFirstPath: NativeReader,
  readState: StateReader,
): Promise<ZoneOutlineEvidence> {
  if (!isFiniteRectangle(rectangle)) return unavailable();
  try {
    const identityBefore = await documentIdentity(readFirstPath);
    if (!identityBefore) return unavailable();
    const source = await readSingleOutlineSource(readFirstPath, readState);
    const identityAfter = await documentIdentity(readFirstPath);
    if (identityBefore !== identityAfter) return unavailable();
    return classifyOutline(rectangle, source);
  } catch {
    return unavailable();
  }
}
