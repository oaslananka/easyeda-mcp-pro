/**
 * Bounded component-origin relationship review using existing native PCB
 * component getters. No pad-to-net, copper loop, or electrical PASS claims.
 */
const MIL_TO_MM = 0.0254;

export type PlacementKind =
  'decoupling' | 'switching-loop' | 'crystal' | 'esd-entry' | 'feedback' | 'sensitive-adjacency';

export interface NativePlacement {
  primitiveId?: string;
  designator?: string;
  x?: number;
  y?: number;
  layer?: number;
  rotation?: number;
  footprintName?: string;
}

export interface PlacementRelation {
  first: string;
  second: string;
  kind: PlacementKind;
  /** Explicit caller-provided numerical limit, not a default rule. */
  maxCenterDistanceMm?: number;
  requireSameLayer?: boolean;
  firstRotationDeg?: number;
  rotationToleranceDeg?: number;
  constraintSource?: string;
}

export interface PlacementFinding {
  id: string;
  relation: PlacementKind;
  components: string[];
  primitive_ids: string[];
  status: 'WARNING' | 'UNKNOWN';
  evidence: 'caller_declared_unverified' | 'native_component_origins';
  measured_center_distance_mm?: number;
  declared_max_center_distance_mm?: number;
  native_layers?: number[];
  first_rotation_deg?: number;
  declared_first_rotation_deg?: number;
  constraint_source?: string;
  reasons: string[];
  electrical_loop_status: 'UNKNOWN';
}

export interface PlacementReview {
  status: 'WARNING' | 'UNKNOWN';
  method: 'NATIVE_COMPONENT_ORIGIN_RELATIONSHIPS';
  coordinate_unit: 'mil';
  distance_unit: 'mm';
  input_evidence: {
    components: 'observed' | 'unavailable';
    native_total: number;
    returned_count: number;
    collection_complete: boolean;
  };
  findings: PlacementFinding[];
  limitations: string[];
  engineering_sign_off: false;
}

type NativePlaced = NativePlacement & {
  primitiveId: string;
  designator: string;
  x: number;
  y: number;
  layer: number;
};

function validComponent(component: NativePlacement | undefined): component is NativePlaced {
  if (!component) return false;
  return (
    typeof component.primitiveId === 'string' &&
    component.primitiveId.length > 0 &&
    typeof component.designator === 'string' &&
    component.designator.length > 0 &&
    Number.isFinite(component.x) &&
    Number.isFinite(component.y) &&
    Math.abs(component.x as number) <= 1_000_000 &&
    Math.abs(component.y as number) <= 1_000_000 &&
    Number.isInteger(component.layer)
  );
}

function angularDifference(a: number, b: number): number {
  const delta = (((a - b) % 360) + 360) % 360;
  return Math.min(delta, 360 - delta);
}

function applyDistanceConstraint(
  relation: PlacementRelation,
  distanceMm: number,
  finding: PlacementFinding,
  reasons: string[],
): void {
  const limit = relation.maxCenterDistanceMm;
  if (limit === undefined) return;
  if (!Number.isFinite(limit) || limit < 0) {
    finding.reasons.push('Caller-declared maximum component-origin distance is invalid.');
    return;
  }
  finding.declared_max_center_distance_mm = limit;
  if (distanceMm > limit + 1e-9) {
    reasons.push('Observed component-origin distance exceeds the caller-declared limit.');
  }
}

function applyRotationConstraint(
  relation: PlacementRelation,
  first: NativePlaced,
  finding: PlacementFinding,
  reasons: string[],
): void {
  const target = relation.firstRotationDeg;
  const tolerance = relation.rotationToleranceDeg;
  if (target === undefined) {
    if (tolerance !== undefined) {
      finding.reasons.push('Rotation tolerance is declared without a rotation target.');
    }
    return;
  }
  if (!Number.isFinite(target)) {
    finding.reasons.push('Caller-declared rotation target is invalid.');
    return;
  }
  finding.declared_first_rotation_deg = target;
  if (
    tolerance !== undefined &&
    (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 180)
  ) {
    finding.reasons.push('Caller-declared rotation tolerance is invalid.');
    return;
  }
  if (!Number.isFinite(first.rotation)) {
    finding.reasons.push('First component native rotation is missing.');
    return;
  }
  // Numerical angular tolerance prevents floating-point-only threshold warnings.
  if (angularDifference(first.rotation as number, target) > (tolerance ?? 0) + 1e-9) {
    reasons.push('Observed rotation exceeds the explicitly declared angular tolerance.');
  }
}

function compareComponentOrigins(
  relation: PlacementRelation,
  first: NativePlaced,
  second: NativePlaced,
  base: PlacementFinding,
): PlacementFinding {
  const distanceMm = Math.hypot(first.x - second.x, first.y - second.y) * MIL_TO_MM;
  base.primitive_ids = [first.primitiveId, second.primitiveId];
  base.evidence = 'native_component_origins';
  base.measured_center_distance_mm = distanceMm;
  base.native_layers = [first.layer, second.layer];
  if (Number.isFinite(first.rotation)) base.first_rotation_deg = first.rotation;
  const reasons: string[] = [];
  applyDistanceConstraint(relation, distanceMm, base, reasons);
  if (relation.requireSameLayer && first.layer !== second.layer) {
    reasons.push('Native component layers differ; caller required the same native layer.');
  }
  applyRotationConstraint(relation, first, base, reasons);
  if (reasons.length) base.status = 'WARNING';
  base.reasons.push(...reasons);
  base.reasons.push(
    'Origins, rotations and layers are not pad coordinates, electrical net topology or current-loop evidence.',
  );
  return base;
}

function inspectRelation(
  relation: PlacementRelation,
  components: NativePlacement[],
  complete: boolean,
  index: number,
): PlacementFinding {
  const base: PlacementFinding = {
    id: 'placement:' + index + ':' + relation.first + ':' + relation.second,
    relation: relation.kind,
    components: [relation.first, relation.second],
    primitive_ids: [],
    status: 'UNKNOWN',
    evidence: 'caller_declared_unverified',
    electrical_loop_status: 'UNKNOWN',
    reasons: [],
    ...(relation.constraintSource ? { constraint_source: relation.constraintSource } : {}),
  };
  if (!complete) {
    base.reasons.push(
      'Native component enumeration is missing or truncated; no absence claim is valid.',
    );
    return base;
  }
  const a = components.filter((component) => component.designator === relation.first);
  const b = components.filter((component) => component.designator === relation.second);
  const first = a[0],
    second = b[0];
  if (a.length !== 1 || b.length !== 1 || !validComponent(first) || !validComponent(second)) {
    base.reasons.push(
      'A declared designator is missing, duplicated, or lacks native origin/layer evidence.',
    );
    return base;
  }
  return compareComponentOrigins(relation, first, second, base);
}

export function reviewPlacementRelations(
  relations: PlacementRelation[],
  components: NativePlacement[],
  nativeTotal: number,
  available: boolean,
): PlacementReview {
  const complete = available && components.length > 0 && nativeTotal === components.length;
  const findings = relations.map((relation, index) =>
    inspectRelation(relation, components, complete, index),
  );
  return {
    status: findings.some((item) => item.status === 'WARNING') ? 'WARNING' : 'UNKNOWN',
    method: 'NATIVE_COMPONENT_ORIGIN_RELATIONSHIPS',
    coordinate_unit: 'mil',
    distance_unit: 'mm',
    input_evidence: {
      components: available && components.length > 0 ? 'observed' : 'unavailable',
      native_total: nativeTotal,
      returned_count: components.length,
      collection_complete: complete,
    },
    findings,
    limitations: [
      'Native component origins are not PCB pad locations or actual routed current-path distances.',
      'No pad/net topology or copper loop/plane continuity was verified; decoupling, buck and ESD loop adequacy remain UNKNOWN.',
      'Rotation and native layer are reported without inferring top/bottom orientation from an undocumented layer number.',
      'Numeric distance/angle limits and their source are caller-supplied and not verified device datasheet constraints.',
      'Read-only bounded non-atomic PCB component snapshot; missing native component getters can return an empty list.',
    ],
    engineering_sign_off: false,
  };
}
