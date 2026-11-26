import { validNativeRouteInventory } from './placement-pad-route-chain.js';
import { minimumCenterDistanceMil, type NativeTrack } from './route-review.js';

export interface SensitiveLineSpacingDeclaration {
  sensitiveNet: string;
  otherNet: string;
  context: 'sensitive-adjacency' | 'feedback';
  constraintSource: string;
  minEdgeGapMm?: number;
}
type Closest = {
  primitive_ids: [string, string];
  native_layer: number;
  observed_edge_gap_mm: number;
};
export interface SensitiveLineSpacingReview {
  sensitive_net: string;
  other_net: string;
  context: SensitiveLineSpacingDeclaration['context'];
  constraint_source: string;
  declared_min_edge_gap_mm?: number;
  evidence: 'observed_same_layer_lines' | 'unavailable';
  status: 'WARNING' | 'UNKNOWN';
  line_counts: { sensitive: number; other: number };
  compared_pair_count: number;
  closest?: Closest;
  electrical_isolation_status: 'UNKNOWN';
  engineering_sign_off: false;
  reason: string;
}
type Line = Required<NativeTrack>;
const MIL_TO_MM = 0.0254;
const TOLERANCE_MM = 1e-9;

function exact(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

function validDeclaration(d: SensitiveLineSpacingDeclaration): boolean {
  return (
    exact(d.sensitiveNet) &&
    exact(d.otherNet) &&
    d.sensitiveNet !== d.otherNet &&
    exact(d.constraintSource) &&
    (d.minEdgeGapMm === undefined || (Number.isFinite(d.minEdgeGapMm) && d.minEdgeGapMm > 0))
  );
}

function closer(a: Closest, b: Closest): boolean {
  if (a.observed_edge_gap_mm !== b.observed_edge_gap_mm)
    return a.observed_edge_gap_mm < b.observed_edge_gap_mm;
  return JSON.stringify(a.primitive_ids) < JSON.stringify(b.primitive_ids);
}

function closestSameLayer(a: Line[], b: Line[]) {
  let closest: Closest | undefined;
  let count = 0;
  for (const first of a) {
    for (const second of b) {
      if (first.layer !== second.layer) continue;
      count++;
      const candidate: Closest = {
        primitive_ids: [first.primitiveId, second.primitiveId],
        native_layer: first.layer,
        observed_edge_gap_mm:
          (minimumCenterDistanceMil(first, second) - (first.width + second.width) / 2) * MIL_TO_MM,
      };
      if (!closest || closer(candidate, closest)) closest = candidate;
    }
  }
  return { closest, count };
}

/** A bounded 2D line observation, not a field solver, route connectivity or isolation verdict. */
export function reviewSensitiveLineSpacing(
  d: SensitiveLineSpacingDeclaration,
  tracks: NativeTrack[],
  complete: boolean,
): SensitiveLineSpacingReview {
  const base: SensitiveLineSpacingReview = {
    sensitive_net: d.sensitiveNet,
    other_net: d.otherNet,
    context: d.context,
    constraint_source: d.constraintSource,
    ...(d.minEdgeGapMm === undefined ? {} : { declared_min_edge_gap_mm: d.minEdgeGapMm }),
    evidence: 'unavailable',
    status: 'UNKNOWN',
    line_counts: { sensitive: 0, other: 0 },
    compared_pair_count: 0,
    electrical_isolation_status: 'UNKNOWN',
    engineering_sign_off: false,
    reason:
      'Exact distinct caller-declared nets and a complete, valid, focus-matched native line inventory are required.',
  };
  if (!validDeclaration(d) || !validNativeRouteInventory(tracks, complete)) return base;
  const a = tracks.filter((t) => t.net === d.sensitiveNet),
    b = tracks.filter((t) => t.net === d.otherNet);
  const counts = { sensitive: a.length, other: b.length };
  const { closest, count } = closestSameLayer(a, b);
  if (!closest)
    return {
      ...base,
      line_counts: counts,
      reason:
        'No observed same-layer line pair for both exact nets; absence does not prove isolation.',
    };
  const gap = closest.observed_edge_gap_mm;
  const warning = gap <= 0 || (d.minEdgeGapMm !== undefined && gap + TOLERANCE_MM < d.minEdgeGapMm);
  return {
    ...base,
    evidence: 'observed_same_layer_lines',
    status: warning ? 'WARNING' : 'UNKNOWN',
    line_counts: counts,
    compared_pair_count: count,
    closest,
    reason:
      'Closest observed same-layer line-edge geometry only; caller roles and limit are unverified. Pads, arcs, vias, fills, layer separation, parallel coupling, return paths, EMI and electrical isolation remain unverified.',
  };
}
