// Conservative geometry evidence for the read-only zone preflight.
// Do not promote this rectangle-only survey to general copper topology approval.
export interface ZoneRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ZoneIntersectionStatus =
  'intersection-confirmed' | 'outside-board' | 'unsupported-outline' | 'unavailable';

export interface ZoneOutlineEvidence {
  status: ZoneIntersectionStatus;
  intersectionVerified: boolean;
  outline: { x: number; y: number; width: number; height: number } | null;
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

export async function evaluateZoneOutlineEvidence(
  rectangle: ZoneRectangle,
  readFirstPath: NativeReader,
  readState: StateReader,
): Promise<ZoneOutlineEvidence> {
  if (!isFiniteRectangle(rectangle)) return unavailable();
  try {
    const identityBefore = await documentIdentity(readFirstPath);
    if (!identityBefore) return unavailable();
    const polyline = await outlineCollection(readFirstPath, 'PCB_PrimitivePolyline');
    const line = await outlineCollection(readFirstPath, 'PCB_PrimitiveLine');
    const arc = await outlineCollection(readFirstPath, 'PCB_PrimitiveArc');
    const regions = await outlineCollection(readFirstPath, 'PCB_PrimitiveRegion');
    const identityAfter = await documentIdentity(readFirstPath);
    if (identityBefore !== identityAfter) return unavailable();
    // Anything other than ONE board-frame polyline is not a proven solid rectangle.
    if (
      line.some((o) => readState(o, 'Layer') === 11) ||
      arc.some((o) => readState(o, 'Layer') === 11) ||
      regions.length > 0
    )
      return unsupported();
    const outlines = polyline.filter((o) => readState(o, 'Layer') === 11);
    if (outlines.length !== 1) return unsupported();
    const polygon = readState(outlines[0], 'Polygon');
    if (
      !polygon ||
      typeof polygon !== 'object' ||
      typeof (polygon as { getSource?: unknown }).getSource !== 'function'
    )
      return unsupported();
    const bounds = nativeRectangle((polygon as { getSource: () => unknown }).getSource());
    if (!bounds) return unsupported();
    const intersects = overlaps(rectangle, bounds);
    return {
      status: intersects ? 'intersection-confirmed' : 'outside-board',
      intersectionVerified: intersects,
      outline: bounds,
    };
  } catch {
    return unavailable();
  }
}
