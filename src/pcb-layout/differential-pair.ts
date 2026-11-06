import { lookupProtocolRouting, type ProtocolKey } from '../design-rules/protocol-routing.js';
import { nativeCopperLayerCode, type NativeTrack, type NativeVia } from './route-review.js';

const MIL_TO_MM = 0.0254;
// Unit conversions and subtraction of large path lengths can differ by a
// few floating-point ulps. This picometer tolerance is numerical only,
// not an electrical or fabrication design margin.
const NUMERIC_TOLERANCE_MM = 1e-9;

/** Explicitly declared nets and thresholds; never inferred from protocol defaults. */
export interface DifferentialPairDeclaration {
  positiveNet: string;
  negativeNet: string;
  protocol: ProtocolKey | 'custom';
  maxSkewMm?: number;
  minEdgeGapMm?: number;
  maxEdgeGapMm?: number;
  targetImpedanceOhms?: number;
  /** Explicit data-sheet / design-revision provenance; not verified by the tool. */
  constraintSource?: string;
}

type NetCoverage = 'MISSING' | 'UNAVAILABLE' | 'OBSERVED_SINGLE_CHAIN' | 'AMBIGUOUS';
type Assessment = 'WARNING' | 'UNKNOWN' | 'WITHIN_DECLARED_LIMIT_REFERENCE';

export interface PairNetLength {
  net: string;
  coverage: NetCoverage;
  segment_count: number;
  primitive_ids: string[];
  observed_length_mm?: number;
  single_layer?: number;
}

export interface PairMeasurement {
  status: Assessment;
  observed_mm?: number;
  declared_limit_mm?: number;
  note: string;
}

export interface DifferentialPairReview {
  status: 'WARNING' | 'UNKNOWN';
  nets: { positive: string; negative: string };
  protocol: string;
  protocol_guidance: {
    source: string;
    caveat: string;
    differential_impedance_reference_ohms?: number;
  } | null;
  target_impedance_ohms?: number;
  /** Null means the caller did not provide a traceable source for numerical limits. */
  constraint_source: string | null;
  impedance_status: 'UNKNOWN';
  evidence: 'native_segments_not_field_solver_or_full_route';
  length_units: 'mm';
  coordinate_units: 'mil';
  paths: { positive: PairNetLength; negative: PairNetLength };
  skew: PairMeasurement;
  spacing: PairMeasurement & { observed_max_mm?: number; sample_count: number };
  findings: Array<{
    id: string;
    status: 'WARNING' | 'UNKNOWN';
    message: string;
    net?: string;
    primitive_ids: string[];
  }>;
  limitations: string[];
  engineering_sign_off: false;
}

type Sample = { id: string; lengthMil: number; start: string; end: string; layer: number };
type Geometry = NativeTrack & {
  primitiveId: string;
  net: string;
  layer: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  width: number;
};

function exactNativeIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function uniqueNativePrimitiveIds(items: Array<{ primitiveId?: string }>): boolean {
  const ids = items.map((item) => item.primitiveId);
  return ids.every(exactNativeIdentity) && new Set(ids).size === ids.length;
}

function nativeCopperCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}

function isGeometry(track: NativeTrack): track is Geometry {
  return (
    exactNativeIdentity(track.primitiveId) &&
    exactNativeIdentity(track.net) &&
    nativeCopperLayerCode(track.layer) &&
    nativeCopperCoordinate(track.startX) &&
    nativeCopperCoordinate(track.startY) &&
    nativeCopperCoordinate(track.endX) &&
    nativeCopperCoordinate(track.endY) &&
    typeof track.width === 'number' &&
    Number.isFinite(track.width) &&
    track.width > 0 &&
    track.width <= 1_000_000 &&
    (track.startX !== track.endX || track.startY !== track.endY)
  );
}

function geometrySample(track: Geometry): Sample {
  return {
    id: track.primitiveId,
    lengthMil: Math.hypot(track.endX - track.startX, track.endY - track.startY),
    start: JSON.stringify([track.layer, track.startX, track.startY]),
    end: JSON.stringify([track.layer, track.endX, track.endY]),
    layer: track.layer,
  };
}

type XY = { x: number; y: number };

/** Native mil coordinates: an endpoint touching another segment's interior
 * or a proper crossing creates a second copper path, not a simple chain.
 */
function cross(a: XY, b: XY, c: XY): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegmentInterior(point: XY, start: XY, end: XY): boolean {
  if (cross(start, end, point) !== 0) return false;
  const projection =
    (point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y);
  const lengthSquared = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
  return projection > 0 && projection < lengthSquared;
}

function intersectsOutsideSharedEndpoints(a: Geometry, b: Geometry): boolean {
  const a0 = { x: a.startX, y: a.startY },
    a1 = { x: a.endX, y: a.endY };
  const b0 = { x: b.startX, y: b.startY },
    b1 = { x: b.endX, y: b.endY };
  if (
    onSegmentInterior(a0, b0, b1) ||
    onSegmentInterior(a1, b0, b1) ||
    onSegmentInterior(b0, a0, a1) ||
    onSegmentInterior(b1, a0, a1)
  )
    return true;
  const sideA = cross(a0, a1, b0),
    sideB = cross(a0, a1, b1);
  const sideC = cross(b0, b1, a0),
    sideD = cross(b0, b1, a1);
  return sideA * sideB < 0 && sideC * sideD < 0;
}

function hasInteriorCopperJunction(tracks: Geometry[]): boolean {
  for (let i = 0; i < tracks.length; i++) {
    const first = tracks[i];
    if (!first) continue;
    for (let j = i + 1; j < tracks.length; j++) {
      const second = tracks[j];
      if (second && intersectsOutsideSharedEndpoints(first, second)) return true;
    }
  }
  return false;
}

function isSingleUnbranchedChain(segments: Sample[]): boolean {
  const adjacency = new Map<string, number[]>();
  segments.forEach((segment, index) => {
    for (const key of [segment.start, segment.end]) {
      adjacency.set(key, [...(adjacency.get(key) || []), index]);
    }
  });
  const ends = [...adjacency.values()].filter((edges) => edges.length === 1).length;
  if (ends !== 2 || [...adjacency.values()].some((edges) => edges.length > 2)) {
    return false;
  }
  const visited = new Set<number>();
  const pending = [0];
  while (pending.length) {
    const index = pending.pop();
    if (index === undefined || visited.has(index)) continue;
    visited.add(index);
    const segment = segments[index];
    if (!segment) continue;
    for (const key of [segment.start, segment.end]) {
      for (const neighbor of adjacency.get(key) || []) {
        if (!visited.has(neighbor)) pending.push(neighbor);
      }
    }
  }
  return visited.size === segments.length;
}

function netLength(
  name: string,
  tracks: NativeTrack[],
  vias: NativeVia[],
  complete: boolean,
): PairNetLength {
  const matching = tracks.filter((track) => track.net === name);
  const primitiveIds = matching
    .map((track) => track.primitiveId || '')
    .filter(Boolean)
    .sort();
  const base = { net: name, segment_count: matching.length, primitive_ids: primitiveIds };
  if (!complete) return { ...base, coverage: 'UNAVAILABLE' };
  if (!matching.length) return { ...base, coverage: 'MISSING' };
  if (
    matching.some((track) => !isGeometry(track)) ||
    vias.some((via) => via.net === name) ||
    new Set(primitiveIds).size !== matching.length
  ) {
    return { ...base, coverage: 'AMBIGUOUS' };
  }
  const segments = (matching as Geometry[]).map(geometrySample);
  const layers = new Set(segments.map((sample) => sample.layer));
  if (layers.size !== 1) return { ...base, coverage: 'AMBIGUOUS' };
  // Endpoint connectivity alone misses overlapping copper or paths that
  // double back through a segment interior, overcounting length and skew.
  if (hasInteriorCopperJunction(matching as Geometry[])) return { ...base, coverage: 'AMBIGUOUS' };
  if (!isSingleUnbranchedChain(segments)) return { ...base, coverage: 'AMBIGUOUS' };
  const mil = segments.reduce((sum, segment) => sum + segment.lengthMil, 0);
  return {
    ...base,
    coverage: 'OBSERVED_SINGLE_CHAIN',
    observed_length_mm: mil * MIL_TO_MM,
    single_layer: segments[0]?.layer,
  };
}

/**
 * Edge-to-edge separation for one observed pair of parallel, overlapping
 * line segments on the same layer. No extrapolation beyond their overlap.
 */
function parallelEdgeGapMil(a: Geometry, b: Geometry): number | undefined {
  if (a.layer !== b.layer) return undefined;
  const dx = a.endX - a.startX,
    dy = a.endY - a.startY;
  const ex = b.endX - b.startX,
    ey = b.endY - b.startY;
  const lenA = Math.hypot(dx, dy),
    lenB = Math.hypot(ex, ey);
  if (lenA <= 0 || lenB <= 0) return undefined;
  const ux = dx / lenA,
    uy = dy / lenA;
  // Require truly parallel finite segments, rather than approximating a
  // varying distance between nonparallel centre lines.
  if (Math.abs(ux * ey - uy * ex) / lenB > 1e-7) return undefined;
  const projectionA = (b.startX - a.startX) * ux + (b.startY - a.startY) * uy;
  const projectionB = (b.endX - a.startX) * ux + (b.endY - a.startY) * uy;
  if (
    Math.min(lenA, Math.max(projectionA, projectionB)) <=
    Math.max(0, Math.min(projectionA, projectionB))
  ) {
    return undefined;
  }
  const centreDistance = Math.abs((b.startX - a.startX) * uy - (b.startY - a.startY) * ux);
  return centreDistance - (a.width + b.width) / 2;
}

function parallelGapSamples(positive: Geometry[], negative: Geometry[]): number[] {
  const gaps: number[] = [];
  for (const a of positive as Geometry[]) {
    for (const b of negative as Geometry[]) {
      const gapMil = parallelEdgeGapMil(a, b);
      if (gapMil !== undefined) gaps.push(gapMil * MIL_TO_MM);
    }
  }
  return gaps;
}

function ambiguousNativeIdentity(path: PairNetLength): PairNetLength {
  return {
    net: path.net,
    segment_count: path.segment_count,
    primitive_ids: path.primitive_ids,
    coverage: 'AMBIGUOUS',
  };
}

function invalidSpacingLimits(lower: number | undefined, upper: number | undefined): boolean {
  return (
    (lower !== undefined && (!Number.isFinite(lower) || lower < 0)) ||
    (upper !== undefined && (!Number.isFinite(upper) || upper < 0)) ||
    (lower !== undefined && upper !== undefined && lower > upper)
  );
}

function sampledSpacingAssessment(
  gaps: number[],
  lower: number | undefined,
  upper: number | undefined,
): DifferentialPairReview['spacing'] {
  const minimum = Math.min(...gaps);
  const maximum = Math.max(...gaps);
  // A distinct-net same-layer copper contact is unsafe even if only a
  // maximum spacing limit was declared (or no limits were supplied).
  const copperContact = minimum <= 0;
  const outside =
    (lower !== undefined && minimum < lower - NUMERIC_TOLERANCE_MM) ||
    (upper !== undefined && maximum > upper + NUMERIC_TOLERANCE_MM);
  return {
    status:
      copperContact || outside
        ? 'WARNING'
        : lower !== undefined || upper !== undefined
          ? 'WITHIN_DECLARED_LIMIT_REFERENCE'
          : 'UNKNOWN',
    observed_mm: minimum,
    observed_max_mm: maximum,
    sample_count: gaps.length,
    note: copperContact
      ? 'Observed same-layer different-net parallel copper widths touch or overlap; inspect native DRC. Full route clearance remains unverified.'
      : outside
        ? 'Observed parallel segment gap lies outside the caller-declared spacing range.'
        : 'Only sampled overlapping parallel segments were compared; other coupling and reference-plane regions remain unverified.',
  };
}

function spacingReview(
  tracks: NativeTrack[],
  declaration: DifferentialPairDeclaration,
  complete: boolean,
): DifferentialPairReview['spacing'] {
  const unknown = (note: string): DifferentialPairReview['spacing'] => ({
    status: 'UNKNOWN',
    note,
    sample_count: 0,
  });
  if (!complete) return unknown('Native track/via collections are unavailable or incomplete.');
  const lower = declaration.minEdgeGapMm;
  const upper = declaration.maxEdgeGapMm;
  if (invalidSpacingLimits(lower, upper))
    return unknown('Caller-declared spacing limits are invalid or inverted.');
  const positive = tracks.filter((track) => track.net === declaration.positiveNet);
  const negative = tracks.filter((track) => track.net === declaration.negativeNet);
  if (
    !positive.length ||
    !negative.length ||
    [...positive, ...negative].some((t) => !isGeometry(t))
  ) {
    return unknown('Both nets need valid observed segments before measuring spacing.');
  }
  const gaps = parallelGapSamples(positive as Geometry[], negative as Geometry[]);
  if (!gaps.length)
    return unknown('No overlapping same-layer parallel segment samples are available.');
  return sampledSpacingAssessment(gaps, lower, upper);
}

function skewReview(
  positive: PairNetLength,
  negative: PairNetLength,
  limit: number | undefined,
): PairMeasurement {
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
    return { status: 'UNKNOWN', note: 'Caller-declared skew limit is invalid.' };
  }
  if (
    positive.coverage !== 'OBSERVED_SINGLE_CHAIN' ||
    negative.coverage !== 'OBSERVED_SINGLE_CHAIN' ||
    positive.observed_length_mm === undefined ||
    negative.observed_length_mm === undefined
  ) {
    return {
      status: 'UNKNOWN',
      declared_limit_mm: limit,
      note: 'Missing, branched, via-connected, fragmented or incomplete native paths prevent a trustworthy skew comparison.',
    };
  }
  const difference = Math.abs(positive.observed_length_mm - negative.observed_length_mm);
  if (limit === undefined) {
    return {
      status: 'UNKNOWN',
      observed_mm: difference,
      note: 'Observed path-length delta is reported without a declared device-specific skew threshold.',
    };
  }
  return {
    status:
      difference > limit + NUMERIC_TOLERANCE_MM ? 'WARNING' : 'WITHIN_DECLARED_LIMIT_REFERENCE',
    observed_mm: difference,
    declared_limit_mm: limit,
    note:
      difference > limit + NUMERIC_TOLERANCE_MM
        ? 'Observed single-chain segment-length delta exceeds the declared limit.'
        : 'Observed single-chain segment-length delta is within the declared limit; pads, propagation delay and end-to-end SI remain unverified.',
  };
}

function sourceBoundPairPaths(
  declaration: DifferentialPairDeclaration,
  tracks: NativeTrack[],
  vias: NativeVia[],
  complete: boolean,
): { positive: PairNetLength; negative: PairNetLength; trustedIds: boolean } {
  const trustedIds =
    uniqueNativePrimitiveIds(tracks) &&
    uniqueNativePrimitiveIds(vias) &&
    exactNativeIdentity(declaration.positiveNet) &&
    exactNativeIdentity(declaration.negativeNet) &&
    declaration.positiveNet !== declaration.negativeNet;
  const netListSupported = complete && tracks.length > 0;
  const observedPositive = netLength(declaration.positiveNet, tracks, vias, netListSupported);
  const observedNegative = netLength(declaration.negativeNet, tracks, vias, netListSupported);
  return {
    positive:
      complete && !trustedIds ? ambiguousNativeIdentity(observedPositive) : observedPositive,
    negative:
      complete && !trustedIds ? ambiguousNativeIdentity(observedNegative) : observedNegative,
    trustedIds,
  };
}

export function reviewDifferentialPair(
  declaration: DifferentialPairDeclaration,
  tracks: NativeTrack[],
  vias: NativeVia[],
  complete: boolean,
): DifferentialPairReview {
  // A native getter can report an empty list when its primitive class is unavailable.
  // Without any observed tracks, absence of a named pair is not proven.
  const { positive, negative, trustedIds } = sourceBoundPairPaths(
    declaration,
    tracks,
    vias,
    complete,
  );
  const skew = skewReview(positive, negative, declaration.maxSkewMm);
  const spacing = spacingReview(tracks, declaration, complete && trustedIds);
  const guidance =
    declaration.protocol === 'custom' ? null : lookupProtocolRouting(declaration.protocol);
  const findings: DifferentialPairReview['findings'] = [];
  for (const path of [positive, negative]) {
    if (path.coverage !== 'OBSERVED_SINGLE_CHAIN') {
      findings.push({
        id: 'pair:' + path.net + ':coverage',
        status: path.coverage === 'MISSING' ? 'WARNING' : 'UNKNOWN',
        message:
          'Declared net observation: ' + path.coverage + '; do not infer a routed end-to-end pair.',
        net: path.net,
        primitive_ids: path.primitive_ids,
      });
    }
  }
  if (skew.status === 'WARNING') {
    findings.push({
      id: 'pair:skew',
      status: 'WARNING',
      message: skew.note,
      primitive_ids: [...positive.primitive_ids, ...negative.primitive_ids],
    });
  }
  if (spacing.status === 'WARNING') {
    findings.push({
      id: 'pair:spacing',
      status: 'WARNING',
      message: spacing.note,
      primitive_ids: [...positive.primitive_ids, ...negative.primitive_ids],
    });
  }
  findings.push({
    id: 'pair:impedance',
    status: 'UNKNOWN',
    message:
      'No verified stackup, dielectric/copper model, field-solver output or manufacturer impedance measurement is available.',
    primitive_ids: [],
  });
  findings.push({
    id: 'pair:return-path',
    status: 'UNKNOWN',
    message:
      'Native tracks and vias do not prove reference-plane continuity, differential coupling, or actual link signal integrity.',
    primitive_ids: [],
  });
  findings.sort((a, b) => a.id.localeCompare(b.id));
  return {
    status: findings.some((item) => item.status === 'WARNING') ? 'WARNING' : 'UNKNOWN',
    nets: { positive: declaration.positiveNet, negative: declaration.negativeNet },
    protocol: declaration.protocol,
    protocol_guidance: guidance && {
      source: guidance.source,
      caveat: guidance.caveat,
      ...(guidance.differentialImpedanceOhms === undefined
        ? {}
        : { differential_impedance_reference_ohms: guidance.differentialImpedanceOhms }),
    },
    ...(declaration.targetImpedanceOhms === undefined
      ? {}
      : { target_impedance_ohms: declaration.targetImpedanceOhms }),
    constraint_source: declaration.constraintSource?.trim() || null,
    impedance_status: 'UNKNOWN',
    evidence: 'native_segments_not_field_solver_or_full_route',
    length_units: 'mm',
    coordinate_units: 'mil',
    paths: { positive, negative },
    skew,
    spacing,
    findings,
    limitations: [
      'Native segment sums and parallel-gap samples do not establish actual end-to-end link topology.',
      'Reference impedance and protocol guidance never substitute a source-bound stackup model or field solver.',
      'Only explicit device/datasheet-specific caller limits can produce a skew or spacing warning; their claimed source is reported separately and remains unverified.',
      'Via transitions, layer discontinuities, pads, coupled impedance and plane return paths require additional native evidence.',
      'PCB snapshot is not atomic; missing/duplicated native primitive IDs, malformed copper geometry and editor/runtime mismatch fail closed.',
    ],
    engineering_sign_off: false,
  };
}
