import {
  boundsBottom,
  boundsInside,
  boundsOverlap,
  boundsRight,
  snapToGrid,
  translateBounds,
  type SchematicBounds,
  type SchematicPoint,
  type SchematicSheetGeometry,
} from '../schematic-engine/geometry.js';
import type { PrimitiveRotation } from '../schematic-model/primitive-bounds.js';

export type PlacementRegionKind =
  'title-block' | 'page-border' | 'caller-reserved' | 'support-reservation' | 'existing-object';

export interface PlacementConstraintRegion {
  id: string;
  kind: PlacementRegionKind;
  bounds: SchematicBounds;
  primitiveId?: string;
  ownerId?: string;
}

export interface PlacementCandidate {
  origin: SchematicPoint;
  rotation: PrimitiveRotation;
  combinedBounds: SchematicBounds;
}

export type PlacementConflictCode =
  | 'PAGE_BORDER_KEEP_OUT'
  | 'TITLE_BLOCK_KEEP_OUT'
  | 'CALLER_RESERVED_REGION'
  | 'SUPPORT_RESERVATION'
  | 'EXISTING_OBJECT_OCCUPIED'
  | 'MINIMUM_CLEARANCE';

export interface PlacementConflict {
  code: PlacementConflictCode;
  regionId: string;
  regionKind: PlacementRegionKind;
  candidateBounds: SchematicBounds;
  conflictingBounds: SchematicBounds;
  clearance: number;
  requiredClearance: number;
  message: string;
}

export interface PlacementAlternative extends PlacementCandidate {
  reason: string;
}

export interface PlacementCheckInput {
  sheet: SchematicSheetGeometry;
  candidate: PlacementCandidate;
  hardKeepouts?: readonly PlacementConstraintRegion[];
  reservedRegions?: readonly PlacementConstraintRegion[];
  occupiedRegions?: readonly PlacementConstraintRegion[];
  minimumClearance?: number;
  maxAlternatives?: number;
  searchPreference?: SafeRegionPreference;
}

export interface PlacementCheckResult {
  accepted: boolean;
  proposed: PlacementCandidate;
  combinedBounds: SchematicBounds;
  clearances: Array<{ regionId: string; regionKind: PlacementRegionKind; clearance: number }>;
  conflicts: PlacementConflict[];
  suggestedAlternatives: PlacementAlternative[];
  failure?: {
    code: 'NO_FEASIBLE_POSITION';
    unsatisfiedConstraints: PlacementConflictCode[];
    searchedCandidates: number;
  };
}

export type SafeRegionPreference =
  | 'upper-left'
  | 'upper-center'
  | 'upper-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'lower-left'
  | 'lower-center'
  | 'lower-right';

export interface SafeRegionInput {
  sheet: SchematicSheetGeometry;
  size: { width: number; height: number };
  preference?: SafeRegionPreference;
  hardKeepouts?: readonly PlacementConstraintRegion[];
  reservedRegions?: readonly PlacementConstraintRegion[];
  occupiedRegions?: readonly PlacementConstraintRegion[];
  minimumClearance?: number;
  rotation?: PrimitiveRotation;
}

export interface SafeRegionResult {
  feasible: boolean;
  preference: SafeRegionPreference;
  candidate?: PlacementCandidate;
  check: PlacementCheckResult;
  rationale: string[];
}

function rectangleClearance(a: SchematicBounds, b: SchematicBounds): number {
  const dx = Math.max(b.x - boundsRight(a), a.x - boundsRight(b), 0);
  const dy = Math.max(b.y - boundsBottom(a), a.y - boundsBottom(b), 0);
  if (dx === 0 && dy === 0 && boundsOverlap(a, b)) {
    const overlapX = Math.min(boundsRight(a), boundsRight(b)) - Math.max(a.x, b.x);
    const overlapY = Math.min(boundsBottom(a), boundsBottom(b)) - Math.max(a.y, b.y);
    return -Math.min(overlapX, overlapY);
  }
  return Math.hypot(dx, dy);
}

function conflictCode(kind: PlacementRegionKind, clearance: number): PlacementConflictCode {
  if (clearance >= 0) return 'MINIMUM_CLEARANCE';
  if (kind === 'title-block') return 'TITLE_BLOCK_KEEP_OUT';
  if (kind === 'page-border') return 'PAGE_BORDER_KEEP_OUT';
  if (kind === 'caller-reserved') return 'CALLER_RESERVED_REGION';
  if (kind === 'support-reservation') return 'SUPPORT_RESERVATION';
  return 'EXISTING_OBJECT_OCCUPIED';
}

function allRegions(input: PlacementCheckInput): PlacementConstraintRegion[] {
  const titleBlock: PlacementConstraintRegion[] = input.sheet.titleBlockBounds
    ? [
        {
          id: 'sheet-title-block',
          kind: 'title-block',
          bounds: input.sheet.titleBlockBounds,
        },
      ]
    : [];
  return [
    ...titleBlock,
    ...(input.hardKeepouts ?? []),
    ...(input.reservedRegions ?? []),
    ...(input.occupiedRegions ?? []),
  ].sort((a, b) => a.id.localeCompare(b.id));
}

function checkCandidate(
  input: PlacementCheckInput,
  candidate: PlacementCandidate,
): Omit<PlacementCheckResult, 'suggestedAlternatives' | 'failure'> {
  const minimumClearance = Math.max(0, input.minimumClearance ?? input.sheet.grid);
  const conflicts: PlacementConflict[] = [];
  const clearances: PlacementCheckResult['clearances'] = [];
  const drawable = input.sheet.drawableBounds;
  if (!boundsInside(candidate.combinedBounds, drawable)) {
    conflicts.push({
      code: 'PAGE_BORDER_KEEP_OUT',
      regionId: 'sheet-drawable-bounds',
      regionKind: 'page-border',
      candidateBounds: candidate.combinedBounds,
      conflictingBounds: drawable,
      clearance: -1,
      requiredClearance: minimumClearance,
      message: 'Rendered combined bounds extend outside the drawable sheet bounds.',
    });
  } else {
    const boundaryClearance = Math.min(
      candidate.combinedBounds.x - drawable.x,
      candidate.combinedBounds.y - drawable.y,
      boundsRight(drawable) - boundsRight(candidate.combinedBounds),
      boundsBottom(drawable) - boundsBottom(candidate.combinedBounds),
    );
    clearances.push({
      regionId: 'sheet-drawable-bounds',
      regionKind: 'page-border',
      clearance: boundaryClearance,
    });
    if (boundaryClearance < minimumClearance) {
      conflicts.push({
        code: 'MINIMUM_CLEARANCE',
        regionId: 'sheet-drawable-bounds',
        regionKind: 'page-border',
        candidateBounds: candidate.combinedBounds,
        conflictingBounds: drawable,
        clearance: boundaryClearance,
        requiredClearance: minimumClearance,
        message: 'Rendered combined bounds do not satisfy page-border clearance.',
      });
    }
  }

  for (const region of allRegions(input)) {
    const clearance = rectangleClearance(candidate.combinedBounds, region.bounds);
    clearances.push({ regionId: region.id, regionKind: region.kind, clearance });
    if (clearance >= minimumClearance) continue;
    const code = conflictCode(region.kind, clearance);
    conflicts.push({
      code,
      regionId: region.id,
      regionKind: region.kind,
      candidateBounds: candidate.combinedBounds,
      conflictingBounds: region.bounds,
      clearance,
      requiredClearance: minimumClearance,
      message:
        clearance < 0
          ? `Rendered combined bounds intersect ${region.kind} region "${region.id}".`
          : `Rendered combined bounds are ${clearance} units from ${region.kind} region "${region.id}"; ${minimumClearance} is required.`,
    });
  }
  return {
    accepted: conflicts.length === 0,
    proposed: candidate,
    combinedBounds: candidate.combinedBounds,
    clearances,
    conflicts,
  };
}

function preferredCoordinateValues(
  start: number,
  end: number,
  grid: number,
  preference: 'start' | 'center' | 'end',
): number[] {
  const values: number[] = [];
  for (let value = snapToGrid(start, grid); value <= end; value += grid) values.push(value);
  if (preference === 'end') return values.reverse();
  if (preference === 'center') {
    const center = (start + end) / 2;
    return values.sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
  }
  return values;
}

function preferenceParts(preference: SafeRegionPreference): {
  horizontal: 'start' | 'center' | 'end';
  vertical: 'upper' | 'center' | 'lower';
} {
  const horizontal = preference.endsWith('left')
    ? 'start'
    : preference.endsWith('right')
      ? 'end'
      : 'center';
  const vertical = preference.startsWith('upper')
    ? 'upper'
    : preference.startsWith('lower')
      ? 'lower'
      : 'center';
  return { horizontal, vertical };
}

function candidateSearch(input: PlacementCheckInput): {
  candidates: PlacementAlternative[];
  searched: number;
} {
  const drawable = input.sheet.drawableBounds;
  const relative = {
    x: input.candidate.combinedBounds.x - input.candidate.origin.x,
    y: input.candidate.combinedBounds.y - input.candidate.origin.y,
  };
  const maxOriginX = boundsRight(drawable) - input.candidate.combinedBounds.width - relative.x;
  const maxOriginY = boundsBottom(drawable) - input.candidate.combinedBounds.height - relative.y;
  const minOriginX = drawable.x - relative.x;
  const minOriginY = drawable.y - relative.y;
  const grid = Math.max(1, input.sheet.grid);
  const parts = preferenceParts(input.searchPreference ?? 'upper-left');
  const verticalPreference =
    parts.vertical === 'center'
      ? 'center'
      : input.sheet.coordinateOrigin.yAxis === 'down'
        ? parts.vertical === 'upper'
          ? 'start'
          : 'end'
        : parts.vertical === 'upper'
          ? 'end'
          : 'start';
  const xValues = preferredCoordinateValues(minOriginX, maxOriginX, grid, parts.horizontal);
  const yValues = preferredCoordinateValues(minOriginY, maxOriginY, grid, verticalPreference);
  const alternatives: PlacementAlternative[] = [];
  let searched = 0;
  const maximum = Math.max(1, input.maxAlternatives ?? 3);
  for (const y of yValues) {
    for (const x of xValues) {
      const delta = { x: x - input.candidate.origin.x, y: y - input.candidate.origin.y };
      const candidate: PlacementAlternative = {
        origin: { x, y },
        rotation: input.candidate.rotation,
        combinedBounds: translateBounds(input.candidate.combinedBounds, delta),
        reason: 'Deterministic grid-aligned alternative satisfying all hard constraints.',
      };
      searched += 1;
      if (checkCandidate(input, candidate).accepted) alternatives.push(candidate);
      if (alternatives.length >= maximum) return { candidates: alternatives, searched };
    }
  }
  return { candidates: alternatives, searched };
}

export function checkPlacement(input: PlacementCheckInput): PlacementCheckResult {
  const checked = checkCandidate(input, input.candidate);
  if (checked.accepted) return { ...checked, suggestedAlternatives: [] };
  const search = candidateSearch(input);
  if (search.candidates.length > 0) {
    return { ...checked, suggestedAlternatives: search.candidates };
  }
  return {
    ...checked,
    suggestedAlternatives: [],
    failure: {
      code: 'NO_FEASIBLE_POSITION',
      unsatisfiedConstraints: [...new Set(checked.conflicts.map((conflict) => conflict.code))].sort(
        (a, b) => a.localeCompare(b),
      ),
      searchedCandidates: search.searched,
    },
  };
}

function preferredOrigin(input: SafeRegionInput, preference: SafeRegionPreference): SchematicPoint {
  const drawable = input.sheet.drawableBounds;
  const parts = preferenceParts(preference);
  const x =
    parts.horizontal === 'start'
      ? drawable.x
      : parts.horizontal === 'end'
        ? boundsRight(drawable) - input.size.width
        : drawable.x + (drawable.width - input.size.width) / 2;
  const visualUpperY =
    input.sheet.coordinateOrigin.yAxis === 'down'
      ? drawable.y
      : boundsBottom(drawable) - input.size.height;
  const visualLowerY =
    input.sheet.coordinateOrigin.yAxis === 'down'
      ? boundsBottom(drawable) - input.size.height
      : drawable.y;
  const y =
    parts.vertical === 'upper'
      ? visualUpperY
      : parts.vertical === 'lower'
        ? visualLowerY
        : drawable.y + (drawable.height - input.size.height) / 2;
  return { x: snapToGrid(x, input.sheet.grid), y: snapToGrid(y, input.sheet.grid) };
}

export function selectSafeRegion(input: SafeRegionInput): SafeRegionResult {
  const preference = input.preference ?? 'upper-left';
  const origin = preferredOrigin(input, preference);
  const candidate: PlacementCandidate = {
    origin,
    rotation: input.rotation ?? 0,
    combinedBounds: { ...origin, ...input.size },
  };
  const check = checkPlacement({
    sheet: input.sheet,
    candidate,
    hardKeepouts: input.hardKeepouts,
    reservedRegions: input.reservedRegions,
    occupiedRegions: input.occupiedRegions,
    minimumClearance: input.minimumClearance,
    searchPreference: preference,
    maxAlternatives: 1,
  });
  const selected = check.accepted ? candidate : check.suggestedAlternatives[0];
  return {
    feasible: selected !== undefined,
    preference,
    ...(selected ? { candidate: selected } : {}),
    check,
    rationale: [
      `Coordinate origin was supplied by ${input.sheet.coordinateOrigin.source} with Y-axis ${input.sheet.coordinateOrigin.yAxis}.`,
      check.accepted
        ? `The requested ${preference} region satisfies every hard constraint.`
        : selected
          ? `The requested ${preference} region conflicted; a deterministic safe alternative was selected.`
          : 'No safe region satisfies every hard constraint.',
    ],
  };
}
