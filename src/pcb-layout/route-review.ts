/**
 * Bounded native PCB track/via evidence review.
 *
 * Native coordinates and widths are EasyEDA PCB mils (1 mil = 0.0254 mm).
 * Primitive collections are not an atomic copper/plane connectivity snapshot.
 * @module
 */
const MIL_TO_MM = 0.0254;
const MAX_FINDINGS = 60;

export interface NativeTrack {
  primitiveId?: string;
  net?: string;
  layer?: number;
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
  width?: number;
}

export interface NativeVia {
  primitiveId?: string;
  net?: string;
  x?: number;
  y?: number;
  holeDiameter?: number;
  diameter?: number;
}

export type GeometryStatus = 'WARNING' | 'ADVISORY' | 'UNKNOWN';
export type GeometryRule =
  | 'TRACE_WIDTH_BELOW_CONTEXT_MINIMUM'
  | 'TRACE_CLEARANCE_BELOW_CONTEXT_MINIMUM'
  | 'OBSERVED_TRACK_COPPER_OVERLAP'
  | 'TRACK_GEOMETRY_UNAVAILABLE'
  | 'RIGHT_ANGLE_STYLE_REVIEW'
  | 'VIA_ANNULAR_GEOMETRY'
  | 'VIA_GEOMETRY_UNAVAILABLE'
  | 'VIA_LAYER_TRANSITION_CANDIDATE'
  | 'VIA_CURRENT_CAPACITY_UNKNOWN'
  | 'REFERENCE_PLANE_UNVERIFIED'
  | 'COPPER_CLEARANCE_UNVERIFIED'
  | 'NATIVE_COLLECTION_INCOMPLETE';

export interface RouteGeometryFinding {
  id: string;
  rule_id: GeometryRule;
  status: GeometryStatus;
  message: string;
  net?: string;
  other_net?: string;
  layer?: number;
  native_layers?: number[];
  primitive_ids: string[];
  observed_edge_gap_mm?: number;
  position_mil?: { x: number; y: number };
  width_mm?: number;
  threshold_mm?: number;
  deflection_degrees?: number;
}

export interface RouteGeometryResult {
  overall_status: 'WARNING' | 'UNKNOWN';
  coordinate_unit: 'mil';
  width_unit: 'mm';
  method: 'NATIVE_TRACK_SEGMENT_GEOMETRY';
  reference: 'EasyEDA Pro PCB_PrimitiveLine and PCB_PrimitiveVia read-only primitive getters';
  review_intent: 'general' | 'high-speed';
  input_evidence: {
    tracks: 'observed' | 'unavailable';
    vias: 'observed' | 'unavailable';
    collection_complete: boolean;
  };
  coverage: {
    requested_track_count: number;
    returned_track_count: number;
    requested_via_count: number;
    returned_via_count: number;
    findings_truncated: boolean;
  };
  findings: RouteGeometryFinding[];
  limitations: string[];
  engineering_sign_off: false;
}

export interface RouteGeometryInput {
  tracks: NativeTrack[];
  vias: NativeVia[];
  trackCount: number;
  viaCount: number;
  tracksAvailable: boolean;
  viasAvailable: boolean;
  intent: 'general' | 'high-speed';
  minWidthMm?: number;
  minClearanceMm?: number;
}

type Endpoint = {
  id: string;
  net: string;
  layer: number;
  x: number;
  y: number;
  otherX: number;
  otherY: number;
};

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function exactPrimitiveId(id: string | undefined): id is string {
  return typeof id === 'string' && id.length > 0 && id.trim() === id;
}

function exactNativeNet(net: string | undefined): net is string {
  return typeof net === 'string' && net.length > 0 && net.trim() === net;
}

function duplicatePrimitiveIds(items: Array<{ primitiveId?: string }>): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    const id = item.primitiveId;
    if (!exactPrimitiveId(id)) continue;
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return duplicates;
}

function uniquelyIdentified(items: Array<{ primitiveId?: string }>): boolean {
  return (
    items.every((item) => exactPrimitiveId(item.primitiveId)) &&
    duplicatePrimitiveIds(items).size === 0
  );
}

function finding(
  id: string,
  rule: GeometryRule,
  status: GeometryStatus,
  message: string,
  primitive_ids: string[] = [],
): RouteGeometryFinding {
  return { id, rule_id: rule, status, message, primitive_ids };
}

function endpointKey(endpoint: Endpoint): string {
  return JSON.stringify([endpoint.net, endpoint.layer, endpoint.x, endpoint.y]);
}

function detectRightAngleJoints(tracks: NativeTrack[]): RouteGeometryFinding[] {
  const nodes = new Map<string, Endpoint[]>();
  tracks.forEach((track, index) => {
    const { startX, startY, endX, endY, layer, net, primitiveId } = track;
    if (
      !finite(startX) ||
      !finite(startY) ||
      !finite(endX) ||
      !finite(endY) ||
      !nativeCopperLayerCode(layer) ||
      !net ||
      !exactPrimitiveId(primitiveId) ||
      (startX === endX && startY === endY)
    )
      return;
    for (const point of [
      { x: startX, y: startY, otherX: endX, otherY: endY },
      { x: endX, y: endY, otherX: startX, otherY: startY },
    ]) {
      const endpoint = { ...point, id: primitiveId || String(index), net, layer: layer as number };
      const key = endpointKey(endpoint);
      nodes.set(key, [...(nodes.get(key) ?? []), endpoint]);
    }
  });
  const result: RouteGeometryFinding[] = [];
  for (const endpoints of nodes.values()) {
    // Do not mistake a branched/T junction for a two-segment turn.
    if (endpoints.length !== 2) continue;
    const [a, b] = endpoints;
    if (!a || !b || a.id === b.id) continue;
    const ax = a.otherX - a.x,
      ay = a.otherY - a.y;
    const bx = b.otherX - b.x,
      by = b.otherY - b.y;
    const magnitude = Math.hypot(ax, ay) * Math.hypot(bx, by);
    if (magnitude === 0) continue;
    const angle =
      (Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / magnitude))) * 180) / Math.PI;
    const deflection = 180 - angle;
    if (Math.abs(deflection - 90) > 1e-5) continue;
    const ids = [a.id, b.id].sort();
    result.push({
      ...finding(
        'corner:' + JSON.stringify([a.net, a.layer, a.x, a.y, ...ids]),
        'RIGHT_ANGLE_STYLE_REVIEW',
        'ADVISORY',
        'A right-angle turn was observed. This is a contextual routing-style review, not an electrical failure.',
        ids,
      ),
      net: a.net,
      layer: a.layer,
      position_mil: { x: a.x, y: a.y },
      deflection_degrees: 90,
    });
  }
  return result;
}

/** Copper-only finite line primitives, never schematic wires or a polygon/plane substitute. */
type CopperSegment = Required<
  Pick<
    NativeTrack,
    'primitiveId' | 'net' | 'layer' | 'startX' | 'startY' | 'endX' | 'endY' | 'width'
  >
>;

/** Documented EasyEDA Pro copper IDs: TOP 1, BOTTOM 2, INNER_1..INNER_30 15..44.
 * MULTI (12), silk, mechanical, mask, and custom layers are not copper evidence.
 * These IDs do not establish that a particular inner layer exists in the board stack.
 */
export function nativeCopperLayerCode(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    (value === 1 || value === 2 || (value >= 15 && value <= 44))
  );
}

function validNativeCoordinate(value: unknown): value is number {
  return finite(value) && Math.abs(value) <= 1_000_000;
}

function validNativeViaDiameter(value: unknown): value is number {
  return positive(value) && value <= 1_000_000;
}

type AttributableVia = Required<
  Pick<NativeVia, 'primitiveId' | 'net' | 'x' | 'y' | 'holeDiameter' | 'diameter'>
>;

function hasAttributableViaGeometry(via: NativeVia): via is AttributableVia {
  return (
    exactPrimitiveId(via.primitiveId) &&
    exactNativeNet(via.net) &&
    validNativeCoordinate(via.x) &&
    validNativeCoordinate(via.y) &&
    validNativeViaDiameter(via.holeDiameter) &&
    validNativeViaDiameter(via.diameter)
  );
}

function observedCopperSegment(track: NativeTrack): CopperSegment | undefined {
  if (
    !exactPrimitiveId(track.primitiveId) ||
    !exactNativeNet(track.net) ||
    !nativeCopperLayerCode(track.layer)
  )
    return undefined;
  if (!positive(track.width) || track.width > 1_000_000) return undefined;
  const coords = [track.startX, track.startY, track.endX, track.endY];
  if (!coords.every(validNativeCoordinate)) return undefined;
  if (track.startX === track.endX && track.startY === track.endY) return undefined;
  return track as CopperSegment;
}

type Point = { x: number; y: number };
function orient(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function between(a: Point, b: Point, p: Point): boolean {
  return (
    p.x >= Math.min(a.x, b.x) &&
    p.x <= Math.max(a.x, b.x) &&
    p.y >= Math.min(a.y, b.y) &&
    p.y <= Math.max(a.y, b.y)
  );
}
function oppositeSides(a: number, b: number): boolean {
  return (a > 0 && b < 0) || (a < 0 && b > 0);
}
function lineSegmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = orient(a, b, c),
    abD = orient(a, b, d);
  const cdA = orient(c, d, a),
    cdB = orient(c, d, b);
  if (oppositeSides(abC, abD) && oppositeSides(cdA, cdB)) return true;
  return (
    (abC === 0 && between(a, b, c)) ||
    (abD === 0 && between(a, b, d)) ||
    (cdA === 0 && between(c, d, a)) ||
    (cdB === 0 && between(c, d, b))
  );
}
function pointToSegmentDistance(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t = Math.max(
    0,
    Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}
/** Source-backed shortest native 2D segment centerline distance, in mil.
 * A geometric observation only: no pad, via, pour or physical net connectivity proof.
 */
export function minimumCenterDistanceMil(a: CopperSegment, b: CopperSegment): number {
  const a0 = { x: a.startX, y: a.startY },
    a1 = { x: a.endX, y: a.endY };
  const b0 = { x: b.startX, y: b.startY },
    b1 = { x: b.endX, y: b.endY };
  if (lineSegmentsIntersect(a0, a1, b0, b1)) return 0;
  return Math.min(
    pointToSegmentDistance(a0, b0, b1),
    pointToSegmentDistance(a1, b0, b1),
    pointToSegmentDistance(b0, a0, a1),
    pointToSegmentDistance(b1, a0, a1),
  );
}

/** Only a demonstrated two-segment geometric overlap is a WARNING.
 * All other net clearances (including pads/fills/keepouts) stay UNKNOWN.
 */
function reviewObservedTrackOverlaps(
  tracks: NativeTrack[],
  minClearanceMm?: number,
): RouteGeometryFinding[] {
  const segments = tracks.map(observedCopperSegment).filter((s): s is CopperSegment => !!s);
  const findings: RouteGeometryFinding[] = [];
  for (let i = 0; i < segments.length; i++) {
    const a = segments[i];
    if (!a) continue;
    for (let j = i + 1; j < segments.length; j++) {
      // The public report retains at most 60 findings. Avoid allocating an
      // unbounded O(n²) list of overlapping copper findings on dense boards.
      if (findings.length > MAX_FINDINGS) return findings;
      const b = segments[j];
      if (!b) continue;
      if (a.net === b.net || a.layer !== b.layer || a.primitiveId === b.primitiveId) continue;
      const gapMil = minimumCenterDistanceMil(a, b) - (a.width + b.width) / 2;
      const ids = [a.primitiveId, b.primitiveId].sort();
      if (gapMil > 0) {
        const gapMm = gapMil * MIL_TO_MM;
        // A declared limit is advisory source context, not an active native
        // DRC/fabricator specification. Tolerance only handles numeric noise.
        if (minClearanceMm === undefined || gapMm + 1e-9 >= minClearanceMm) continue;
        findings.push({
          ...finding(
            'copper-clearance:' + JSON.stringify([a.layer, ...ids]),
            'TRACE_CLEARANCE_BELOW_CONTEXT_MINIMUM',
            'WARNING',
            'Observed different-net line edge gap is below a caller-declared minimum; active DRC, pads, keepouts, pours and fabrication rules are unverified.',
            ids,
          ),
          net: a.net,
          other_net: b.net,
          layer: a.layer,
          observed_edge_gap_mm: gapMm,
          threshold_mm: minClearanceMm,
        });
        continue;
      }
      findings.push({
        ...finding(
          'copper-overlap:' + JSON.stringify([a.layer, ...ids]),
          'OBSERVED_TRACK_COPPER_OVERLAP',
          'WARNING',
          'Two different-net native copper line widths overlap/touch in observed same-layer geometry; inspect native DRC. This does not certify all other clearances.',
          ids,
        ),
        net: a.net,
        other_net: b.net,
        layer: a.layer,
        observed_edge_gap_mm: gapMil * MIL_TO_MM,
      });
    }
  }
  return findings;
}

function reviewTracks(input: RouteGeometryInput): RouteGeometryFinding[] {
  const findings: RouteGeometryFinding[] = [];
  const duplicateIds = duplicatePrimitiveIds(input.tracks);
  const reportedDuplicates = new Set<string>();
  if (!input.tracksAvailable || input.tracks.length === 0) {
    findings.push(
      finding(
        'coverage:tracks',
        'TRACK_GEOMETRY_UNAVAILABLE',
        'UNKNOWN',
        'No complete native track observation is available; an empty list is not design approval.',
      ),
    );
  }
  // Stale payload rows cannot be used as measured geometry after the
  // source collection was explicitly marked unavailable.
  if (!input.tracksAvailable) return findings;
  input.tracks.forEach((track, index) => {
    const id = track.primitiveId || String(index);
    if (duplicateIds.has(id)) {
      if (!reportedDuplicates.has(id)) {
        findings.push(
          finding(
            'track:' + id + ':ambiguous-identity',
            'TRACK_GEOMETRY_UNAVAILABLE',
            'UNKNOWN',
            'Duplicate native track primitive identity cannot support attributable geometry findings.',
            [id],
          ),
        );
        reportedDuplicates.add(id);
      }
      return;
    }
    if (!observedCopperSegment(track)) {
      findings.push({
        ...finding(
          'track:' + id + ':missing-geometry',
          'TRACK_GEOMETRY_UNAVAILABLE',
          'UNKNOWN',
          'Native copper segment width, endpoints, copper-layer code, net or primitive identity is unsupported or missing.',
          [id],
        ),
        net: track.net,
      });
      return;
    }
    const widthMm = (track.width as number) * MIL_TO_MM;
    if (input.minWidthMm !== undefined && widthMm < input.minWidthMm) {
      findings.push({
        ...finding(
          'track:' + id + ':width',
          'TRACE_WIDTH_BELOW_CONTEXT_MINIMUM',
          'WARNING',
          'Observed width is below the caller-supplied minimum; verify the actual DRC/fabricator requirement.',
          [id],
        ),
        net: track.net,
        layer: track.layer,
        width_mm: widthMm,
        threshold_mm: input.minWidthMm,
      });
    }
  });
  const uniquelyIdentifiedTracks = input.tracks.filter(
    (track) => !duplicateIds.has(track.primitiveId ?? ''),
  );
  findings.push(...reviewObservedTrackOverlaps(uniquelyIdentifiedTracks, input.minClearanceMm));
  if (input.intent === 'high-speed')
    findings.push(
      ...detectRightAngleJoints(
        uniquelyIdentifiedTracks.filter((track) => observedCopperSegment(track) !== undefined),
      ),
    );
  return findings;
}

/** Distinct native layer codes at the same exact via center are only
 * evidence of a possible transition, not via barrel or plane connectivity.
 */
function reviewViaLayerTransitionCandidates(input: RouteGeometryInput): RouteGeometryFinding[] {
  if (!input.tracksAvailable || !input.viasAvailable) return [];
  const duplicateTracks = duplicatePrimitiveIds(input.tracks);
  const segments = input.tracks
    .filter((track) => !duplicateTracks.has(track.primitiveId ?? ''))
    .map(observedCopperSegment)
    .filter((s): s is CopperSegment => !!s);
  return input.vias.flatMap((via) => {
    if (!hasAttributableViaGeometry(via) || via.holeDiameter >= via.diameter) return [];
    if (input.vias.filter((item) => item.primitiveId === via.primitiveId).length !== 1) return [];
    const touching = segments.filter(
      (segment) =>
        segment.net === via.net &&
        ((segment.startX === via.x && segment.startY === via.y) ||
          (segment.endX === via.x && segment.endY === via.y)),
    );
    const layers = [...new Set(touching.map((segment) => segment.layer))].sort((a, b) => a - b);
    if (
      layers.length < 2 ||
      new Set(touching.map((segment) => segment.primitiveId)).size !== touching.length
    )
      return [];
    const ids = [via.primitiveId, ...touching.map((segment) => segment.primitiveId)].sort();
    return [
      {
        ...finding(
          'via-transition:' + via.primitiveId,
          'VIA_LAYER_TRANSITION_CANDIDATE',
          'UNKNOWN',
          'Same-net native track endpoints on distinct layer codes meet the observed via center; via span, actual copper connection and return path are unverified.',
          ids,
        ),
        net: via.net,
        position_mil: { x: via.x, y: via.y },
        native_layers: layers,
      },
    ];
  });
}

function reviewVias(input: RouteGeometryInput): RouteGeometryFinding[] {
  const findings: RouteGeometryFinding[] = [];
  // An unavailable or identity-ambiguous via row cannot provide a
  // trustworthy primitive-attributed drill-to-land warning.
  const duplicateIds = duplicatePrimitiveIds(input.vias);
  for (const via of input.viasAvailable ? input.vias : []) {
    const id = via.primitiveId;
    if (!exactPrimitiveId(id) || duplicateIds.has(id)) continue;
    if (!hasAttributableViaGeometry(via)) {
      findings.push({
        ...finding(
          'via:' + id + ':missing-geometry',
          'VIA_GEOMETRY_UNAVAILABLE',
          'UNKNOWN',
          'Native via net, center, drill or copper diameter is missing or untrustworthy.',
          [id],
        ),
        ...(exactNativeNet(via.net) ? { net: via.net } : {}),
      });
      continue;
    }
    if (via.holeDiameter >= via.diameter) {
      findings.push({
        ...finding(
          'via:' + id + ':geometry',
          'VIA_ANNULAR_GEOMETRY',
          'WARNING',
          'Reported via drill diameter is not smaller than the reported copper diameter.',
          [id],
        ),
        net: via.net,
        position_mil: { x: via.x, y: via.y },
      });
    }
  }
  findings.push(
    finding(
      'coverage:via-current',
      'VIA_CURRENT_CAPACITY_UNKNOWN',
      'UNKNOWN',
      'Via barrel thickness, layer transitions and parallel current paths are not verified.',
    ),
  );
  return findings;
}

export function reviewRouteGeometry(input: RouteGeometryInput): RouteGeometryResult {
  const complete =
    input.tracksAvailable &&
    input.viasAvailable &&
    input.trackCount === input.tracks.length &&
    input.viaCount === input.vias.length &&
    uniquelyIdentified(input.tracks) &&
    uniquelyIdentified(input.vias) &&
    input.tracks.every((track) => observedCopperSegment(track) !== undefined) &&
    input.vias.every(hasAttributableViaGeometry);
  const findings = [
    ...reviewTracks(input),
    ...reviewVias(input),
    ...reviewViaLayerTransitionCandidates(input),
    finding(
      'coverage:planes',
      'REFERENCE_PLANE_UNVERIFIED',
      'UNKNOWN',
      'Copper Fill/Region primitives do not verify poured-zone connectivity or return-current continuity.',
    ),
    finding(
      'coverage:clearance',
      'COPPER_CLEARANCE_UNVERIFIED',
      'UNKNOWN',
      'No native DRC or polygon clearance proof was executed; track geometry alone cannot certify spacing.',
    ),
  ];
  if (!complete)
    findings.push(
      finding(
        'coverage:pagination',
        'NATIVE_COLLECTION_INCOMPLETE',
        'UNKNOWN',
        'At least one native primitive collection is missing, incomplete, has ambiguous primitive identities or exceeds the bounded multi-page read budget.',
      ),
    );
  const rank = { WARNING: 0, ADVISORY: 1, UNKNOWN: 2 };
  findings.sort((a, b) => rank[a.status] - rank[b.status] || a.id.localeCompare(b.id));
  // A large number of narrow-track warnings must not hide the mandatory
  // uncertainty disclosures from the bounded output window.
  const mandatory = findings.filter((item) =>
    [
      'VIA_CURRENT_CAPACITY_UNKNOWN',
      'REFERENCE_PLANE_UNVERIFIED',
      'COPPER_CLEARANCE_UNVERIFIED',
      'NATIVE_COLLECTION_INCOMPLETE',
    ].includes(item.rule_id),
  );
  const optional = findings.filter((item) => !mandatory.includes(item));
  const visible =
    findings.length > MAX_FINDINGS
      ? [...optional.slice(0, MAX_FINDINGS - mandatory.length), ...mandatory]
      : findings;
  visible.sort((a, b) => rank[a.status] - rank[b.status] || a.id.localeCompare(b.id));
  return {
    overall_status: findings.some((f) => f.status === 'WARNING') ? 'WARNING' : 'UNKNOWN',
    coordinate_unit: 'mil',
    width_unit: 'mm',
    method: 'NATIVE_TRACK_SEGMENT_GEOMETRY',
    reference: 'EasyEDA Pro PCB_PrimitiveLine and PCB_PrimitiveVia read-only primitive getters',
    review_intent: input.intent,
    input_evidence: {
      tracks: input.tracksAvailable ? 'observed' : 'unavailable',
      vias: input.viasAvailable ? 'observed' : 'unavailable',
      collection_complete: complete,
    },
    coverage: {
      requested_track_count: input.trackCount,
      returned_track_count: input.tracks.length,
      requested_via_count: input.viaCount,
      returned_via_count: input.vias.length,
      findings_truncated: findings.length > MAX_FINDINGS,
    },
    findings: visible,
    limitations: [
      'Read-only native primitive pages, not an atomic snapshot across calls or tracks/vias.',
      'Coordinates are native PCB mils; widths converted using 0.0254 mm per mil.',
      'Right-angle turns are style guidance only; no unconditional 90-degree failure.',
      'Native via layer codes and coincident endpoints cannot verify via span, copper continuity, or a return-current path.',
      'Native pours, zones, copper fill continuity, return-current paths and DRC clearances are unverified.',
      'A caller-supplied width or edge-clearance minimum is not a verified native DRC or fabricator specification.',
    ],
    engineering_sign_off: false,
  };
}
