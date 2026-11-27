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
  /** Native positive-width stroke regions omitted from filled-polygon center screening. */
  strokedRegionCount: number;
  /** Source-frame stroke endpoint / declared inner-boundary proximity; never electrical contact proof. */
  strokeFillBoundaryCandidateCount: number;
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

/** Stroked pour regions (e.g. thermals) are native copper geometry, not
 * filled polygons. Count them separately without inferring contact or a net path.
 */
function countUnscreenedStrokedRegions(regions: unknown): number {
  if (!Array.isArray(regions) || regions.length > MAX_REGIONS) return 0;
  return regions.filter((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const region = value as Record<string, unknown>;
    return (
      region.fill === false &&
      typeof region.lineWidth === 'number' &&
      Number.isFinite(region.lineWidth) &&
      region.lineWidth > 0
    );
  }).length;
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

function onSegment(pointToCheck: Point, start: Point, end: Point): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  // At large/native-unsupported coordinates, treat uncertain boundaries
  // conservatively rather than asserting that the center is inside copper.
  if (!Number.isFinite(length)) return true;
  const tolerance =
    1e-9 * Math.max(1, Math.abs(start.x), Math.abs(start.y), Math.abs(end.x), Math.abs(end.y));
  if (length === 0)
    return Math.hypot(pointToCheck.x - start.x, pointToCheck.y - start.y) <= tolerance;
  const projection =
    ((pointToCheck.x - start.x) * dx + (pointToCheck.y - start.y) * dy) / (length * length);
  if (projection < 0 || projection > 1 || !Number.isFinite(projection)) return false;
  return (
    Math.hypot(
      pointToCheck.x - (start.x + projection * dx),
      pointToCheck.y - (start.y + projection * dy),
    ) <= tolerance
  );
}

function onContourBoundary(target: Point, contour: readonly Point[]): boolean {
  return contour.some((vertex, index) => {
    const previous = contour[(index + contour.length - 1) % contour.length];
    return previous ? onSegment(target, previous, vertex) : true;
  });
}

function insideFilledContours(center: Point, contours: readonly Point[][]): boolean {
  // Candidate screen, NOT an implementation of native EasyEDA's nonzero fill
  // rule. The documented first ring is an outer boundary; subsequent rings
  // are declared inner contours. If the point is in any inner contour,
  // withhold candidates because nested/overlapping holes may have nonzero
  // winding and could be filled according to the native engine.
  const outer = contours[0];
  return (
    !!outer &&
    insideRing(center, outer) &&
    !contours.slice(1).some((inner) => insideRing(center, inner))
  );
}

/** Return approximate centerline-to-contour distance in the native poured source frame. */
function segmentDistance(target: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const squaredLength = dx * dx + dy * dy;
  if (!Number.isFinite(squaredLength) || squaredLength <= 0) return Number.POSITIVE_INFINITY;
  const projection = ((target.x - a.x) * dx + (target.y - a.y) * dy) / squaredLength;
  if (!Number.isFinite(projection)) return Number.POSITIVE_INFINITY;
  const t = Math.max(0, Math.min(1, projection));
  return Math.hypot(target.x - a.x - t * dx, target.y - a.y - t * dy);
}

function endpointNearDeclaredHole(
  endpoint: Point,
  contours: readonly Point[][],
  halfWidth: number,
) {
  const outer = contours.at(0);
  if (outer === undefined || !insideRing(endpoint, outer)) return false;
  return contours.slice(1).some(
    (hole) =>
      insideRing(endpoint, hole) &&
      hole.some((vertex, index) => {
        const next = hole.at((index + 1) % hole.length);
        return next !== undefined && segmentDistance(endpoint, vertex, next) < halfWidth;
      }),
  );
}

function simpleNativeLine(path: unknown): readonly [Point, Point] | undefined {
  if (!path || typeof path !== 'object') return;
  const complex = (path as Record<string, unknown>).complexPolygon;
  const ring = Array.isArray(complex) && complex.length === 1 ? complex[0] : undefined;
  if (!Array.isArray(ring) || ring.length !== 5 || ring[2] !== 'L') return;
  const start = point(ring[0], ring[1]);
  const end = point(ring[3], ring[4]);
  if (!start || !end || Math.hypot(start.x - end.x, start.y - end.y) === 0) return;
  return [start, end];
}

function nativeStrokeLine(
  region: unknown,
): { endpoints: readonly [Point, Point]; width: number } | undefined {
  if (!region || typeof region !== 'object' || Array.isArray(region)) return;
  const data = region as Record<string, unknown>;
  const width = data.lineWidth;
  if (data.fill !== false || typeof width !== 'number' || !Number.isFinite(width) || width <= 0)
    return;
  const endpoints = simpleNativeLine(data.path);
  return endpoints ? { endpoints, width } : undefined;
}

/**
 * Conservative geometry candidates in the common poured-source coordinate frame.
 * Does not establish native fill winding, real copper contact or GND return reachability.
 */
function countStrokeFillBoundaryCandidates(regions: unknown, contours: readonly Point[][]): number {
  if (!Array.isArray(regions) || regions.length > MAX_REGIONS || contours.length < 2) return 0;
  let candidates = 0;
  for (const region of regions) {
    const stroke = nativeStrokeLine(region);
    if (!stroke) continue;
    const [start, end] = stroke.endpoints;
    if (
      endpointNearDeclaredHole(start, contours, stroke.width / 2) ||
      endpointNearDeclaredHole(end, contours, stroke.width / 2)
    )
      candidates++;
  }
  return candidates;
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
  if (contours.some((contour) => onContourBoundary(center, contour)))
    return unknown('CENTER_ON_NATIVE_COPPER_BOUNDARY');
  if (!insideFilledContours(center, contours)) {
    // The source declares subsequent contours as inner rings, but EasyEDA's
    // nonzero winding rule can re-fill overlapping/nested rings. This result
    // means only that the point is inside a declared source contour; it does
    // not prove a hole in the native filled copper or electrical disconnection.
    const outer = contours[0];
    return unknown(
      outer && insideRing(center, outer)
        ? 'CENTER_IN_DECLARED_INNER_CONTOUR'
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
    strokedRegionCount: 0,
    strokeFillBoundaryCandidateCount: 0,
    contourCount: 0,
    diagnostics: [],
    candidates: [],
    pads: [],
  };
  output.strokedRegionCount = countUnscreenedStrokedRegions(input.pouredRegions);
  if (output.strokedRegionCount > 0) {
    output.diagnostics.push('NATIVE_STROKE_GEOMETRY_NOT_SCREENED');
  }
  const polygon = nativeFilledContours(input.pouredRegions);
  if (!polygon) output.diagnostics.push('UNSUPPORTED_POLYGON_SOURCE');
  else {
    output.filledRegionCount = polygon.count;
    output.contourCount = polygon.contours.length;
    if (polygon.count === 0) output.diagnostics.push('NO_NATIVE_FILLED_REGIONS');
    if (polygon.contours.length > 1)
      output.diagnostics.push('NONZERO_FILL_RULE_NOT_INDEPENDENTLY_VALIDATED');
  }
  if (!validTransform(input.transform)) output.diagnostics.push('UNVERIFIED_COORDINATE_TRANSFORM');
  if (
    !input.pourNet ||
    input.pourNet !== input.pourNet.trim() ||
    !nativeCopperLayerCode(input.pourLayer)
  )
    output.diagnostics.push('UNVERIFIED_POUR_IDENTITY');
  if (polygon?.count === 1 && !output.diagnostics.includes('UNVERIFIED_POUR_IDENTITY')) {
    output.strokeFillBoundaryCandidateCount = countStrokeFillBoundaryCandidates(
      input.pouredRegions,
      polygon.contours,
    );
    if (output.strokeFillBoundaryCandidateCount > 0)
      output.diagnostics.push('NATIVE_STROKE_FILL_BOUNDARY_CANDIDATE_ONLY');
  }
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

/** Independent, caller-declared round drill geometry. Never infer native hole units
 * from the pad coordinate unit or a single fixture. */
export interface CopperAnnulusDrillDeclaration {
  primitiveId: string;
  diameterMm: number;
  nativeHoleMmPerUnit: number;
  source: string;
}

export interface NativeCopperAnnulusInput extends NativeCopperCenterInput {
  drills: unknown;
}

export interface CopperAnnulusOutcome {
  primitiveId: string;
  status: 'GEOMETRIC_OVERLAP_CANDIDATE' | 'UNKNOWN';
  reason: string;
  electrical_continuity_status: 'UNKNOWN';
  fill_id?: string;
  drill_source?: string;
  drill_diameter_mm?: number;
  native_hole_mm_per_unit?: number;
  witness?: { x_mm: number; y_mm: number; minimum_margin_mm: number };
}

const ANNULUS_MIL_TO_MM = 0.0254;
const MAX_ANNULUS_PADS = 8;
const MAX_ANNULUS_VERTICES = 4096;
// Numerical interior margin only, not a PCB design-rule threshold.
const INTERIOR_MARGIN_MM = 0.001;
const DRILL_COMPARISON_EPSILON_MM = 1e-6;

function annulusRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function annulusId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value
  );
}

function annulusPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1_000_000;
}

function roundDiameter(shape: unknown, kind: string): number | undefined {
  return Array.isArray(shape) &&
    shape.length === 3 &&
    shape[0] === kind &&
    annulusPositive(shape[1]) &&
    shape[1] === shape[2]
    ? shape[1]
    : undefined;
}

function closedLineContour(ring: unknown, maxVertices = MAX_ANNULUS_VERTICES): Point[] | undefined {
  if (
    !Array.isArray(ring) ||
    ring.length > maxVertices * 2 + 1 ||
    ring[2] !== 'L' ||
    ring.length % 2 !== 1 ||
    !ring.slice(3).every((v) => typeof v === 'number' && Number.isFinite(v))
  )
    return;
  const vertices = parseContour(ring);
  if (!vertices || vertices.length < 4) return;
  const first = vertices[0],
    last = vertices.at(-1);
  return first && last && first.x === last.x && first.y === last.y ? vertices : undefined;
}

function singleAnnulusFill(regions: unknown): { id: string; vertices: Point[] } | undefined {
  if (!Array.isArray(regions) || regions.length !== 1) return;
  const region = annulusRecord(regions[0]);
  if (!annulusId(region.id) || region.fill !== true || region.lineWidth !== 0) return;
  const rings = annulusRecord(region.path).complexPolygon;
  if (!Array.isArray(rings) || rings.length !== 1) return;
  const vertices = closedLineContour(rings[0]);
  return vertices ? { id: region.id, vertices } : undefined;
}

function annulusDrillIndex(
  drills: unknown,
): Map<string, CopperAnnulusDrillDeclaration> | undefined {
  if (!Array.isArray(drills) || drills.length > MAX_ANNULUS_PADS) return;
  const index = new Map<string, CopperAnnulusDrillDeclaration>();
  for (const raw of drills) {
    const d = annulusRecord(raw);
    if (
      !annulusId(d.primitiveId) ||
      index.has(d.primitiveId) ||
      !annulusPositive(d.diameterMm) ||
      !annulusPositive(d.nativeHoleMmPerUnit) ||
      typeof d.source !== 'string' ||
      d.source.trim().length < 3 ||
      d.source.length > 200
    )
      return;
    index.set(d.primitiveId, {
      primitiveId: d.primitiveId,
      diameterMm: d.diameterMm,
      nativeHoleMmPerUnit: d.nativeHoleMmPerUnit,
      source: d.source,
    });
  }
  return index;
}

function boundedAnnulusPoint(p: Point): boolean {
  return (
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    Math.abs(p.x) <= 1_000_000 * ANNULUS_MIL_TO_MM &&
    Math.abs(p.y) <= 1_000_000 * ANNULUS_MIL_TO_MM
  );
}

function inNativePadMm(vertices: Point[], transform: CopperCenterTransform): Point[] | undefined {
  const scale = ANNULUS_MIL_TO_MM / transform.scale;
  const mapped = vertices.map((p) => ({
    x: p.x * scale,
    y: p.y * scale * (transform.invertY ? -1 : 1),
  }));
  return mapped.every(boundedAnnulusPoint) ? mapped : undefined;
}

/** Require agreement of even-odd and nonzero interpretations at the witness.
 * Fractured source contours may repeat bridge edges. Do not claim to reproduce
 * the native fill engine or infer topology from the contour. */
function singleWinding(target: Point, ring: Point[]): boolean {
  let winding = 0;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1],
      b = ring[i];
    if (!a || !b) return false;
    const cross = (b.x - a.x) * (target.y - a.y) - (target.x - a.x) * (b.y - a.y);
    if (a.y <= target.y && b.y > target.y && cross > 0) winding++;
    else if (a.y > target.y && b.y <= target.y && cross < 0) winding--;
  }
  return Math.abs(winding) === 1 && insideRing(target, ring);
}

function contourMargin(target: Point, ring: Point[]): number {
  let margin = Number.POSITIVE_INFINITY;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1],
      b = ring[i];
    if (!a || !b) return 0;
    const distance =
      a.x === b.x && a.y === b.y
        ? Math.hypot(target.x - a.x, target.y - a.y)
        : segmentDistance(target, a, b);
    margin = Math.min(margin, distance);
  }
  return margin;
}

function annulusWitness(
  center: Point,
  inner: number,
  outer: number,
  ring: Point[],
): CopperAnnulusOutcome['witness'] {
  let best: CopperAnnulusOutcome['witness'];
  for (const fraction of [0.25, 0.5, 0.75]) {
    const radius = inner + (outer - inner) * fraction;
    for (let degrees = 0; degrees < 360; degrees += 10) {
      const angle = (degrees * Math.PI) / 180;
      const target = {
        x: center.x + radius * Math.cos(angle),
        y: center.y + radius * Math.sin(angle),
      };
      if (!boundedAnnulusPoint(target) || !singleWinding(target, ring)) continue;
      const margin = Math.min(radius - inner, outer - radius, contourMargin(target, ring));
      if (
        Number.isFinite(margin) &&
        margin > INTERIOR_MARGIN_MM &&
        (!best || margin > best.minimum_margin_mm)
      ) {
        best = { x_mm: target.x, y_mm: target.y, minimum_margin_mm: margin };
      }
    }
  }
  return best;
}

function plainConcentricPad(pad: Record<string, unknown>, net: string): boolean {
  return (
    annulusId(pad.primitiveId) &&
    pad.net === net &&
    pad.layer === 12 &&
    pad.metallization === true &&
    pad.heatWelding === null &&
    pad.holeOffsetX === 0 &&
    pad.holeOffsetY === 0 &&
    (pad.specialPad === null || (Array.isArray(pad.specialPad) && pad.specialPad.length === 0))
  );
}

function roundHoleDiameter(shape: unknown): number | undefined {
  // Public API declares ROUND + diameter; observed native 4.1.105 also returns
  // a repeated equal third entry. Reject all other tuple shapes.
  return Array.isArray(shape) &&
    shape.length === 2 &&
    shape[0] === 'ROUND' &&
    annulusPositive(shape[1])
    ? shape[1]
    : roundDiameter(shape, 'ROUND');
}

function reviewAnnulusPad(
  pad: Record<string, unknown>,
  input: NativeCopperAnnulusInput,
  drill: CopperAnnulusDrillDeclaration | undefined,
  fillId: string,
  ring: Point[],
): CopperAnnulusOutcome {
  const primitiveId = typeof pad.primitiveId === 'string' ? pad.primitiveId : '';
  const unknown = (reason: string): CopperAnnulusOutcome => ({
    primitiveId,
    status: 'UNKNOWN',
    reason,
    electrical_continuity_status: 'UNKNOWN',
  });
  if (!plainConcentricPad(pad, input.pourNet)) return unknown('UNVERIFIED_ROUND_PAD_IDENTITY');
  const diameter = roundDiameter(pad.pad, 'ELLIPSE');
  const hole = roundHoleDiameter(pad.hole);
  const center = point(pad.x, pad.y);
  if (!diameter || !hole || !center || !drill) return unknown('UNVERIFIED_ROUND_PAD_OR_DRILL');
  const nativeCenter = { x: center.x * ANNULUS_MIL_TO_MM, y: center.y * ANNULUS_MIL_TO_MM };
  const outer = (diameter * ANNULUS_MIL_TO_MM) / 2;
  const observedHole = hole * drill.nativeHoleMmPerUnit;
  if (
    !boundedAnnulusPoint(nativeCenter) ||
    Math.abs(observedHole - drill.diameterMm) > DRILL_COMPARISON_EPSILON_MM ||
    drill.diameterMm / 2 >= outer
  )
    return unknown('ROUND_DRILL_SOURCE_MISMATCH');
  const witness = annulusWitness(nativeCenter, drill.diameterMm / 2, outer, ring);
  if (!witness) return unknown('NO_BOUNDED_INTERIOR_WITNESS');
  return {
    primitiveId,
    status: 'GEOMETRIC_OVERLAP_CANDIDATE',
    reason: 'BOUNDED_INTERIOR_GEOMETRY_ONLY',
    electrical_continuity_status: 'UNKNOWN',
    fill_id: fillId,
    drill_source: drill.source,
    drill_diameter_mm: drill.diameterMm,
    native_hole_mm_per_unit: drill.nativeHoleMmPerUnit,
    witness,
  };
}

/** Bounded, non-exhaustive geometric screening. Neither a positive nor a
 * missing witness establishes actual contact, plating or a shared return path. */
export function reviewCopperAnnulusCandidates(input: NativeCopperAnnulusInput) {
  const base = {
    method: 'READ_ONLY_FILLED_COPPER_ROUND_ANNULUS_SCREEN' as const,
    coordinate_frame: 'native_pad_mm' as const,
    overall_status: 'UNKNOWN' as const,
    engineering_sign_off: false as const,
  };
  const pads =
    Array.isArray(input.pads) && input.pads.length <= MAX_ANNULUS_PADS
      ? input.pads.map(annulusRecord)
      : [];
  const unavailable = (reason: string) => ({
    ...base,
    pads: pads.map((p) => ({
      primitiveId: typeof p.primitiveId === 'string' ? p.primitiveId : '',
      status: 'UNKNOWN' as const,
      reason,
      electrical_continuity_status: 'UNKNOWN' as const,
    })) as CopperAnnulusOutcome[],
  });
  const fill = singleAnnulusFill(input.pouredRegions);
  const drills = annulusDrillIndex(input.drills);
  if (
    !annulusId(input.pourNet) ||
    ![1, 2].includes(input.pourLayer) ||
    !validTransform(input.transform) ||
    !fill ||
    !drills ||
    new Set(pads.map((p) => p.primitiveId)).size !== pads.length
  ) {
    return unavailable('UNVERIFIED_FILLED_REGION_OR_SOURCE');
  }
  const ring = inNativePadMm(fill.vertices, input.transform);
  if (!ring) return unavailable('UNSUPPORTED_CONTOUR_COORDINATES');
  return {
    ...base,
    transform: input.transform,
    pads: pads.map((p) =>
      reviewAnnulusPad(p, input, drills.get(String(p.primitiveId)), fill.id, ring),
    ),
  };
}

/** Selected individual contour only; no union or via-layer flashing inference.
 * Independent caller-sourced dimensions bound the native nominal annulus. */
export function reviewViaContourWitness(input: {
  contour: unknown;
  transform: CopperCenterTransform;
  x: number;
  y: number;
  diameter: number;
  holeDiameter: number;
  diameterMm: number;
  drillDiameterMm: number;
}): CopperAnnulusOutcome['witness'] {
  const nativeDiameter = input.diameter * ANNULUS_MIL_TO_MM;
  const nativeDrill = input.holeDiameter * ANNULUS_MIL_TO_MM;
  if (
    !validTransform(input.transform) ||
    !annulusPositive(input.diameterMm) ||
    !annulusPositive(input.drillDiameterMm) ||
    !annulusPositive(nativeDiameter) ||
    !annulusPositive(nativeDrill) ||
    Math.abs(nativeDiameter - input.diameterMm) > 0.002 ||
    Math.abs(nativeDrill - input.drillDiameterMm) > 0.002
  )
    return;
  const inner = Math.max(nativeDrill, input.drillDiameterMm) / 2;
  const outer = Math.min(nativeDiameter, input.diameterMm) / 2;
  if (outer <= inner) return;
  const center = { x: input.x * ANNULUS_MIL_TO_MM, y: input.y * ANNULUS_MIL_TO_MM };
  if (!boundedAnnulusPoint(center)) return;
  const vertices = closedLineContour(input.contour, 8192);
  const ring = vertices && inNativePadMm(vertices, input.transform);
  if (!ring) return;
  return annulusWitness(center, inner, outer, ring);
}
