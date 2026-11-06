import { nativeCopperLayerCode } from './route-review.js';

/**
 * Bounded, read-only center-overlap screening for a native EasyEDA Poured copper
 * source. It deliberately cannot prove pad-to-copper connection or a return path.
 *
 * Polygon source coordinates may use a different scale and Y axis than native
 * pad coordinates. Callers must supply an independently sourced transform.
 * An unsupported contour invalidates the entire filled-region screening; it
 * must never be silently skipped and converted into a positive result.
 */
export interface CopperCenterTransform {
  /** Native pad coordinate to polygon source coordinate multiplier. */
  scale: number;
  invertY: boolean;
  /** Documented/checked provenance for the coordinate mapping. */
  source: string;
}

export interface NativeCopperCenterInput {
  pourNet: string;
  pourLayer: number;
  pouredRegions: unknown;
  pads: unknown;
  transform?: CopperCenterTransform;
}

export type CopperPadCenterOutcome = {
  primitiveId: string;
  status: 'CENTER_OVERLAP_CANDIDATE' | 'UNKNOWN';
  reason: string;
};

export interface CopperCenterReview {
  method: 'READ_ONLY_FILLED_COPPER_PAD_CENTER_SCREEN';
  overall_status: 'UNKNOWN';
  engineering_sign_off: false;
  filledRegionCount: number;
  contourCount: number;
  diagnostics: string[];
  candidates: CopperPadCenterOutcome[];
  pads: CopperPadCenterOutcome[];
}

interface Point {
  x: number;
  y: number;
}

const MAX_REGIONS = 256;
const MAX_PADS = 256;
const MAX_CONTOURS = 256;
const MAX_SOURCE_TOKENS = 30_000;
const MAX_APPROX_POINTS = 40_000;
const ARC_STEP_DEGREES = 5;

function point(x: unknown, y: unknown): Point | undefined {
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)
    ? { x, y }
    : undefined;
}

function appendLines(tokens: readonly unknown[], offset: number, output: Point[]): number {
  let cursor = offset;
  const first = cursor;
  while (cursor < tokens.length && typeof tokens[cursor] !== 'string') {
    const next = point(tokens[cursor], tokens[cursor + 1]);
    if (!next) return -1;
    output.push(next);
    if (output.length > MAX_APPROX_POINTS) return -1;
    cursor += 2;
  }
  return cursor > first ? cursor : -1;
}

function appendArc(tokens: readonly unknown[], offset: number, output: Point[]): number {
  const sweep = tokens[offset];
  const end = point(tokens[offset + 1], tokens[offset + 2]);
  const start = output.at(-1);
  if (
    typeof sweep !== 'number' ||
    !Number.isFinite(sweep) ||
    Math.abs(sweep) < 0.001 ||
    Math.abs(sweep) >= 359.999 ||
    !start ||
    !end
  )
    return -1;
  const phi = (sweep * Math.PI) / 180;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const chord = Math.hypot(dx, dy);
  if (chord <= 1e-9) return -1;
  const halfCotangent = 1 / (2 * Math.tan(phi / 2));
  const cx = (start.x + end.x) / 2 - dy * halfCotangent;
  const cy = (start.y + end.y) / 2 + dx * halfCotangent;
  const radius = Math.hypot(start.x - cx, start.y - cy);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(radius)) return -1;
  const steps = Math.ceil(Math.abs(sweep) / ARC_STEP_DEGREES);
  if (output.length + steps > MAX_APPROX_POINTS) return -1;
  const a0 = Math.atan2(start.y - cy, start.x - cx);
  for (let step = 1; step <= steps; step++) {
    const a = a0 + (phi * step) / steps;
    output.push(
      step === steps ? end : { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) },
    );
  }
  return offset + 3;
}

function parseContour(source: unknown): Point[] | undefined {
  if (!Array.isArray(source) || source.length < 5 || source.length > MAX_SOURCE_TOKENS) return;
  const first = point(source[0], source[1]);
  if (!first) return;
  const points: Point[] = [first];
  let cursor = 2;
  while (cursor < source.length) {
    const command = source[cursor++];
    if (command === 'L') cursor = appendLines(source, cursor, points);
    else if (command === 'ARC') cursor = appendArc(source, cursor, points);
    else return; // CARC, Bezier, rectangle and circle need separately verified handling.
    if (cursor < 0) return;
  }
  return points.length >= 3 ? points : undefined;
}

function readFilledRegionContours(region: Record<string, unknown>): Point[][] | undefined {
  const path = region.path;
  const source =
    path && typeof path === 'object' ? (path as Record<string, unknown>).complexPolygon : undefined;
  if (!Array.isArray(source) || source.length === 0 || source.length > MAX_CONTOURS) return;
  const result: Point[][] = [];
  let tokens = 0;
  let points = 0;
  for (const ring of source) {
    if (!Array.isArray(ring)) return;
    tokens += ring.length;
    if (tokens > MAX_SOURCE_TOKENS) return;
    const parsed = parseContour(ring);
    if (!parsed) return;
    points += parsed.length;
    if (points > MAX_APPROX_POINTS) return;
    result.push(parsed);
  }
  return result;
}

function nativeFilledContours(
  regions: unknown,
): { contours: Point[][]; count: number } | undefined {
  if (!Array.isArray(regions) || regions.length > MAX_REGIONS) return;
  let filledCount = 0;
  let contours: Point[][] = [];
  for (const region of regions) {
    if (!region || typeof region !== 'object' || typeof region.fill !== 'boolean') return;
    if (!region.fill) continue;
    filledCount++;
    // Different filled regions must be evaluated as a union, never flattened
    // into a single even-odd contour graph (which could invent cutouts).
    if (filledCount > 1) return;
    const parsed = readFilledRegionContours(region);
    if (!parsed) return;
    contours = parsed;
  }
  return { contours, count: filledCount };
}

function insideRing(target: Point, vertices: readonly Point[]): boolean {
  let contained = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = vertices[i];
    const b = vertices[j];
    if (!a || !b) continue;
    const intersects =
      a.y > target.y !== b.y > target.y &&
      target.x < ((b.x - a.x) * (target.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) contained = !contained;
  }
  return contained;
}

function insideFilledContours(center: Point, contours: readonly Point[][]): boolean {
  // The native complex polygon uses an even-odd fill rule for inner cutouts.
  return contours.reduce((inside, contour) => inside !== insideRing(center, contour), false);
}

function validTransform(
  transform: CopperCenterTransform | undefined,
): transform is CopperCenterTransform {
  return (
    !!transform &&
    Number.isFinite(transform.scale) &&
    transform.scale > 0 &&
    transform.scale <= 1_000_000 &&
    typeof transform.invertY === 'boolean' &&
    typeof transform.source === 'string' &&
    transform.source.trim().length >= 3 &&
    transform.source.length <= 200
  );
}

function supportedPadShape(shape: unknown): boolean {
  return (
    Array.isArray(shape) &&
    ['ELLIPSE', 'OVAL', 'RECT'].includes(shape[0]) &&
    [shape[1], shape[2]].every(
      (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
    )
  );
}

function padEvidenceLimitation(
  data: Record<string, unknown>,
  net: string,
  copperLayer: number,
): string | undefined {
  if (data.net !== net) return 'NET_DOES_NOT_MATCH_POUR';
  if (typeof data.layer !== 'number' || ![copperLayer, 12].includes(data.layer))
    return 'UNVERIFIED_PAD_COPPER_LAYER';
  if (!supportedPadShape(data.pad)) return 'UNVERIFIED_PAD_SHAPE';
  if (data.metallization !== true || data.heatWelding != null)
    return 'UNVERIFIED_PLATING_OR_THERMAL_CONTACT';
}

function padCenterInPolygonCoordinates(
  data: Record<string, unknown>,
  transform: CopperCenterTransform,
): Point | undefined {
  const coordinates = point(data.x, data.y);
  if (!coordinates) return;
  return point(
    coordinates.x * transform.scale,
    coordinates.y * transform.scale * (transform.invertY ? -1 : 1),
  );
}

function resultForPad(
  pad: unknown,
  pourNet: string,
  pourLayer: number,
  contours: Point[][],
  transform: CopperCenterTransform | undefined,
): CopperPadCenterOutcome {
  const data = pad && typeof pad === 'object' ? (pad as Record<string, unknown>) : {};
  const primitiveId = typeof data.primitiveId === 'string' ? data.primitiveId : '';
  const unknown = (reason: string): CopperPadCenterOutcome => ({
    primitiveId,
    status: 'UNKNOWN',
    reason,
  });
  if (!primitiveId || primitiveId !== primitiveId.trim()) return unknown('INVALID_PAD_ID');
  const limitation = padEvidenceLimitation(data, pourNet, pourLayer);
  if (limitation) return unknown(limitation);
  if (!validTransform(transform)) return unknown('UNVERIFIED_COORDINATE_TRANSFORM');
  const center = padCenterInPolygonCoordinates(data, transform);
  if (!center) return unknown('INVALID_PAD_CENTER');
  if (!insideFilledContours(center, contours)) {
    // EasyEDA's complex polygon defines the first contour as the outer
    // boundary and subsequent contours as holes. Being in a hole cannot
    // establish either copper absence at the pad edge or electrical disconnection.
    const outer = contours[0];
    return unknown(
      outer && insideRing(center, outer)
        ? 'CENTER_IN_NATIVE_COPPER_CUTOUT'
        : 'CENTER_NOT_INSIDE_FILLED_POLYGON',
    );
  }
  return {
    primitiveId,
    status: 'CENTER_OVERLAP_CANDIDATE',
    reason: 'NOT_ELECTRICAL_CONTACT_PROOF',
  };
}

function classifyPads(
  pads: readonly unknown[],
  input: NativeCopperCenterInput,
  polygon: { contours: Point[][]; count: number } | undefined,
  pourIdentityValid: boolean,
): CopperPadCenterOutcome[] {
  const output: CopperPadCenterOutcome[] = [];
  for (const pad of pads) {
    const record = pad && typeof pad === 'object' ? (pad as Record<string, unknown>) : {};
    const usable = polygon && polygon.count > 0 && pourIdentityValid;
    output.push(
      usable
        ? resultForPad(pad, input.pourNet, input.pourLayer, polygon.contours, input.transform)
        : {
            primitiveId: typeof record.primitiveId === 'string' ? record.primitiveId : '',
            status: 'UNKNOWN',
            reason: !polygon
              ? 'UNSUPPORTED_POLYGON_SOURCE'
              : polygon.count === 0
                ? 'NO_NATIVE_FILLED_REGIONS'
                : 'UNVERIFIED_POUR_IDENTITY',
          },
    );
  }
  const counts = new Map<string, number>();
  for (const item of output) counts.set(item.primitiveId, (counts.get(item.primitiveId) ?? 0) + 1);
  return output.map((item) =>
    (counts.get(item.primitiveId) ?? 0) > 1
      ? { primitiveId: item.primitiveId, status: 'UNKNOWN', reason: 'DUPLICATE_PAD_ID' }
      : item,
  );
}

export function reviewCopperPadCenterCandidates(
  input: NativeCopperCenterInput,
): CopperCenterReview {
  const output: CopperCenterReview = {
    method: 'READ_ONLY_FILLED_COPPER_PAD_CENTER_SCREEN',
    overall_status: 'UNKNOWN',
    engineering_sign_off: false,
    filledRegionCount: 0,
    contourCount: 0,
    diagnostics: [],
    candidates: [],
    pads: [],
  };
  const polygon = nativeFilledContours(input.pouredRegions);
  if (!polygon) output.diagnostics.push('UNSUPPORTED_POLYGON_SOURCE');
  else {
    output.filledRegionCount = polygon.count;
    output.contourCount = polygon.contours.length;
    if (polygon.count === 0) output.diagnostics.push('NO_NATIVE_FILLED_REGIONS');
  }
  if (!validTransform(input.transform)) output.diagnostics.push('UNVERIFIED_COORDINATE_TRANSFORM');
  if (
    !input.pourNet ||
    input.pourNet !== input.pourNet.trim() ||
    !nativeCopperLayerCode(input.pourLayer)
  )
    output.diagnostics.push('UNVERIFIED_POUR_IDENTITY');
  if (!Array.isArray(input.pads) || input.pads.length > MAX_PADS) {
    output.diagnostics.push('INVALID_OR_OVERSIZED_PAD_COLLECTION');
    return output;
  }
  output.pads = classifyPads(
    input.pads,
    input,
    polygon,
    !output.diagnostics.includes('UNVERIFIED_POUR_IDENTITY'),
  );
  output.candidates = output.pads.filter((item) => item.status === 'CENTER_OVERLAP_CANDIDATE');
  return output;
}
