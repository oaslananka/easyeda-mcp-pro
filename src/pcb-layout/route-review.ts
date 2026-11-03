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
  | 'TRACK_GEOMETRY_UNAVAILABLE'
  | 'RIGHT_ANGLE_STYLE_REVIEW'
  | 'VIA_ANNULAR_GEOMETRY'
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
  layer?: number;
  primitive_ids: string[];
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
      !Number.isInteger(layer) ||
      !net ||
      !primitiveId ||
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

function reviewTracks(input: RouteGeometryInput): RouteGeometryFinding[] {
  const findings: RouteGeometryFinding[] = [];
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
  input.tracks.forEach((track, index) => {
    const id = track.primitiveId || String(index);
    if (
      !positive(track.width) ||
      !finite(track.startX) ||
      !finite(track.startY) ||
      !finite(track.endX) ||
      !finite(track.endY) ||
      !Number.isInteger(track.layer) ||
      !track.net ||
      !track.primitiveId ||
      (track.startX === track.endX && track.startY === track.endY)
    ) {
      findings.push({
        ...finding(
          'track:' + id + ':missing-geometry',
          'TRACK_GEOMETRY_UNAVAILABLE',
          'UNKNOWN',
          'Native segment width, endpoints, layer, net or primitive identity is missing.',
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
  if (input.intent === 'high-speed') findings.push(...detectRightAngleJoints(input.tracks));
  return findings;
}

function reviewVias(input: RouteGeometryInput): RouteGeometryFinding[] {
  const findings: RouteGeometryFinding[] = [];
  for (const [index, via] of input.vias.entries()) {
    const id = via.primitiveId || String(index);
    if (positive(via.holeDiameter) && positive(via.diameter) && via.holeDiameter >= via.diameter) {
      findings.push({
        ...finding(
          'via:' + id + ':geometry',
          'VIA_ANNULAR_GEOMETRY',
          'WARNING',
          'Reported via drill diameter is not smaller than the reported copper diameter.',
          [id],
        ),
        net: via.net,
        position_mil: finite(via.x) && finite(via.y) ? { x: via.x, y: via.y } : undefined,
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
    input.viaCount === input.vias.length;
  const findings = [
    ...reviewTracks(input),
    ...reviewVias(input),
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
        'At least one native primitive collection is missing, incomplete or exceeds the bounded read window.',
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
      'Read-only native primitive snapshot, not atomic across tracks and vias.',
      'Coordinates are native PCB mils; widths converted using 0.0254 mm per mil.',
      'Right-angle turns are style guidance only; no unconditional 90-degree failure.',
      'Native pours, zones, copper fill continuity, return-current paths and DRC clearances are unverified.',
      'A caller-supplied width limit is not a verified fabricator specification.',
    ],
    engineering_sign_off: false,
  };
}
