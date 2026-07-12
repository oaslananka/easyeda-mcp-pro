import {
  boundsBottom,
  combineBounds,
  snapToGrid,
  type SchematicBounds,
  type SchematicSheetGeometry,
} from '../schematic-engine/geometry.js';
import type { PrimitiveRotation } from '../schematic-model/primitive-bounds.js';
import { stableHash } from '../transactions/stable.js';
import {
  checkPlacement,
  type PlacementCandidate,
  type PlacementConflict,
  type PlacementConstraintRegion,
} from './placement.js';

export type FunctionalComponentRole =
  | 'main'
  | 'decoupling-capacitor'
  | 'bulk-capacitor'
  | 'feedback-network'
  | 'pull-up'
  | 'pull-down'
  | 'boot-strap'
  | 'connector-protection'
  | 'connector-filter'
  | 'regulator-inductor'
  | 'regulator-compensation'
  | 'led-current-limit'
  | 'transistor-gate-resistor'
  | 'transistor-base-resistor'
  | 'test-point'
  | 'support';

export interface FunctionalLayoutComponent {
  id: string;
  blockId: string;
  role: FunctionalComponentRole;
  parentId?: string;
  renderedSize: { width: number; height: number };
  preferredRotation?: PrimitiveRotation;
  allowedRotations?: readonly PrimitiveRotation[];
  minimumProximity?: number;
}

export interface FunctionalLayoutConstraints {
  minimumClearance: number;
  blockPadding: number;
  componentSpacing: number;
  preferredFlow: 'left-to-right' | 'top-to-bottom';
  maximumSupportDistance: number;
  maximumSupportDistanceByRole?: Partial<Record<FunctionalComponentRole, number>>;
  minimumReadableUtilization: number;
  maximumReadableUtilization: number;
}

export interface FunctionalLayoutPlanInput {
  sheet: SchematicSheetGeometry;
  a3FallbackSheet?: SchematicSheetGeometry;
  allowA3Fallback?: boolean;
  components: readonly FunctionalLayoutComponent[];
  hardKeepouts?: readonly PlacementConstraintRegion[];
  callerReservedRegions?: readonly PlacementConstraintRegion[];
  existingOccupiedRegions?: readonly PlacementConstraintRegion[];
  constraints?: Partial<FunctionalLayoutConstraints>;
}

export interface FunctionalBlockReservation {
  blockId: string;
  bounds: SchematicBounds;
  componentIds: string[];
  supportComponentIds: string[];
}

export interface SupportComponentReservation {
  id: string;
  blockId: string;
  parentId?: string;
  role: FunctionalComponentRole;
  componentIds: string[];
  bounds: SchematicBounds;
}

export interface FunctionalComponentPlacement extends PlacementCandidate {
  componentId: string;
  blockId: string;
  role: FunctionalComponentRole;
  parentId?: string;
  placementOrder: number;
}

export interface LayoutPlannerConflict {
  blockId?: string;
  componentId?: string;
  code: string;
  message: string;
  constraintIds: string[];
}

export interface PageSuitabilityAttempt {
  pageSize: SchematicSheetGeometry['pageSize'];
  feasible: boolean;
  utilization: number;
  unsatisfiedConstraints: string[];
  searchedBlockIds: string[];
}

export interface FunctionalLayoutScore {
  overall: number;
  utilization: number;
  proximity: number;
  clearance: number;
  rationale: string[];
}

export interface FunctionalLayoutPlan {
  feasible: boolean;
  deterministic: true;
  layoutHash: string;
  selectedSheet: SchematicSheetGeometry;
  blockReservations: FunctionalBlockReservation[];
  supportReservations: SupportComponentReservation[];
  placements: FunctionalComponentPlacement[];
  placementOrder: string[];
  occupancyMap: PlacementConstraintRegion[];
  conflicts: LayoutPlannerConflict[];
  pageSuitability: {
    attempts: PageSuitabilityAttempt[];
    selectedPageSize?: SchematicSheetGeometry['pageSize'];
    a3FallbackRationale?: string;
  };
  score: FunctionalLayoutScore;
}

interface BlockDraft {
  id: string;
  mains: FunctionalLayoutComponent[];
  supports: FunctionalLayoutComponent[];
  width: number;
  height: number;
}

interface SheetAttemptResult {
  sheet: SchematicSheetGeometry;
  blocks: FunctionalBlockReservation[];
  supportReservations: SupportComponentReservation[];
  placements: FunctionalComponentPlacement[];
  occupancy: PlacementConstraintRegion[];
  conflicts: LayoutPlannerConflict[];
  attempt: PageSuitabilityAttempt;
}

const DEFAULT_CONSTRAINTS: FunctionalLayoutConstraints = {
  minimumClearance: 10,
  blockPadding: 20,
  componentSpacing: 10,
  preferredFlow: 'left-to-right',
  maximumSupportDistance: 120,
  minimumReadableUtilization: 0.08,
  maximumReadableUtilization: 0.72,
};

function normalizedConstraints(
  input: Partial<FunctionalLayoutConstraints> | undefined,
): FunctionalLayoutConstraints {
  return {
    ...DEFAULT_CONSTRAINTS,
    ...input,
    maximumSupportDistanceByRole: { ...(input?.maximumSupportDistanceByRole ?? {}) },
  };
}

function componentRotation(component: FunctionalLayoutComponent): PrimitiveRotation {
  const allowed: PrimitiveRotation[] = [
    ...new Set<PrimitiveRotation>(component.allowedRotations ?? [0, 90, 180, 270]),
  ].sort((a, b) => a - b);
  if (component.preferredRotation !== undefined && allowed.includes(component.preferredRotation)) {
    return component.preferredRotation;
  }
  return allowed[0] ?? 0;
}

function renderedSize(
  component: FunctionalLayoutComponent,
  rotation: PrimitiveRotation,
): { width: number; height: number } {
  return rotation === 90 || rotation === 270
    ? { width: component.renderedSize.height, height: component.renderedSize.width }
    : component.renderedSize;
}

function buildBlockDrafts(
  components: readonly FunctionalLayoutComponent[],
  constraints: FunctionalLayoutConstraints,
): BlockDraft[] {
  const byBlock = new Map<string, FunctionalLayoutComponent[]>();
  for (const component of [...components].sort((a, b) => a.id.localeCompare(b.id))) {
    const group = byBlock.get(component.blockId) ?? [];
    group.push(component);
    byBlock.set(component.blockId, group);
  }
  return [...byBlock.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, members]) => {
      const mains = members.filter((member) => member.role === 'main');
      const supports = members.filter((member) => member.role !== 'main');
      const ordered = [...mains, ...supports];
      const sizes = ordered.map((component) =>
        renderedSize(component, componentRotation(component)),
      );
      if (constraints.preferredFlow === 'top-to-bottom') {
        return {
          id,
          mains,
          supports,
          width: Math.max(0, ...sizes.map((size) => size.width)) + constraints.blockPadding * 2,
          height:
            sizes.reduce((sum, size) => sum + size.height, 0) +
            Math.max(0, sizes.length - 1) * constraints.componentSpacing +
            constraints.blockPadding * 2,
        };
      }
      return {
        id,
        mains,
        supports,
        width:
          sizes.reduce((sum, size) => sum + size.width, 0) +
          Math.max(0, sizes.length - 1) * constraints.componentSpacing +
          constraints.blockPadding * 2,
        height: Math.max(0, ...sizes.map((size) => size.height)) + constraints.blockPadding * 2,
      };
    });
}

function conflictSummary(
  conflicts: readonly PlacementConflict[],
  blockId: string,
): LayoutPlannerConflict[] {
  if (conflicts.length === 0) {
    return [
      {
        blockId,
        code: 'NO_FEASIBLE_POSITION',
        message: `No feasible reservation could be found for block "${blockId}".`,
        constraintIds: [],
      },
    ];
  }
  const grouped = new Map<string, PlacementConflict[]>();
  for (const conflict of conflicts) {
    const group = grouped.get(conflict.code) ?? [];
    group.push(conflict);
    grouped.set(conflict.code, group);
  }
  return [...grouped.entries()].map(([code, group]) => ({
    blockId,
    code,
    message: group.map((item) => item.message).join(' '),
    constraintIds: [...new Set(group.map((item) => item.regionId))].sort((a, b) =>
      a.localeCompare(b),
    ),
  }));
}

function initialBlockCandidate(
  sheet: SchematicSheetGeometry,
  block: BlockDraft,
): PlacementCandidate {
  const clearance = sheet.grid;
  const origin = {
    x: snapToGrid(sheet.drawableBounds.x + clearance, sheet.grid),
    y:
      sheet.coordinateOrigin.yAxis === 'down'
        ? snapToGrid(sheet.drawableBounds.y + clearance, sheet.grid)
        : snapToGrid(boundsBottom(sheet.drawableBounds) - block.height - clearance, sheet.grid),
  };
  return {
    origin,
    rotation: 0,
    combinedBounds: { ...origin, width: block.width, height: block.height },
  };
}

function placeMembers(
  block: BlockDraft,
  reservation: FunctionalBlockReservation,
  constraints: FunctionalLayoutConstraints,
  grid: number,
  startOrder: number,
): {
  placements: FunctionalComponentPlacement[];
  supports: SupportComponentReservation[];
} {
  const ordered = [...block.mains, ...block.supports].sort((a, b) => {
    const mainOrder = Number(a.role !== 'main') - Number(b.role !== 'main');
    return (
      mainOrder || (a.parentId ?? '').localeCompare(b.parentId ?? '') || a.id.localeCompare(b.id)
    );
  });
  let cursorX = reservation.bounds.x + constraints.blockPadding;
  let cursorY = reservation.bounds.y + constraints.blockPadding;
  const placements: FunctionalComponentPlacement[] = [];
  for (const [index, component] of ordered.entries()) {
    const rotation = componentRotation(component);
    const size = renderedSize(component, rotation);
    const origin = { x: snapToGrid(cursorX, grid), y: snapToGrid(cursorY, grid) };
    placements.push({
      componentId: component.id,
      blockId: block.id,
      role: component.role,
      ...(component.parentId ? { parentId: component.parentId } : {}),
      origin,
      rotation,
      combinedBounds: { ...origin, ...size },
      placementOrder: startOrder + index,
    });
    if (constraints.preferredFlow === 'top-to-bottom') {
      cursorY += size.height + constraints.componentSpacing;
    } else {
      cursorX += size.width + constraints.componentSpacing;
    }
  }
  const supportGroups = new Map<string, FunctionalComponentPlacement[]>();
  for (const placement of placements.filter((item) => item.role !== 'main')) {
    const key = `${placement.parentId ?? 'block'}:${placement.role}`;
    const group = supportGroups.get(key) ?? [];
    group.push(placement);
    supportGroups.set(key, group);
  }
  const supports = [...supportGroups.entries()].map(([key, group]) => {
    const [parentId, role] = key.split(':') as [string, FunctionalComponentRole];
    return {
      id: `support:${block.id}:${key}`,
      blockId: block.id,
      ...(parentId !== 'block' ? { parentId } : {}),
      role,
      componentIds: group
        .map((placement) => placement.componentId)
        .sort((a, b) => a.localeCompare(b)),
      bounds:
        combineBounds(group.map((placement) => placement.combinedBounds)) ?? reservation.bounds,
    };
  });
  return { placements, supports };
}

function occupiedArea(regions: readonly FunctionalBlockReservation[]): number {
  return regions.reduce((sum, region) => sum + region.bounds.width * region.bounds.height, 0);
}

function attemptSheet(
  sheet: SchematicSheetGeometry,
  drafts: readonly BlockDraft[],
  input: FunctionalLayoutPlanInput,
  constraints: FunctionalLayoutConstraints,
): SheetAttemptResult {
  const hardKeepouts = input.hardKeepouts ?? [];
  const reservedRegions = input.callerReservedRegions ?? [];
  const occupancy: PlacementConstraintRegion[] = [...(input.existingOccupiedRegions ?? [])];
  const blocks: FunctionalBlockReservation[] = [];
  const placements: FunctionalComponentPlacement[] = [];
  const supportReservations: SupportComponentReservation[] = [];
  const conflicts: LayoutPlannerConflict[] = [];
  for (const block of drafts) {
    const candidate = initialBlockCandidate(sheet, block);
    const check = checkPlacement({
      sheet,
      candidate,
      hardKeepouts,
      reservedRegions,
      occupiedRegions: occupancy,
      minimumClearance: constraints.minimumClearance,
      maxAlternatives: 1,
      searchPreference: 'upper-left',
    });
    const selected = check.accepted ? candidate : check.suggestedAlternatives[0];
    if (!selected) {
      conflicts.push(...conflictSummary(check.conflicts, block.id));
      continue;
    }
    const reservation: FunctionalBlockReservation = {
      blockId: block.id,
      bounds: selected.combinedBounds,
      componentIds: [...block.mains, ...block.supports]
        .map((component) => component.id)
        .sort((a, b) => a.localeCompare(b)),
      supportComponentIds: block.supports
        .map((component) => component.id)
        .sort((a, b) => a.localeCompare(b)),
    };
    blocks.push(reservation);
    occupancy.push({
      id: `block:${block.id}`,
      kind: 'caller-reserved',
      ownerId: block.id,
      bounds: reservation.bounds,
    });
    const placed = placeMembers(block, reservation, constraints, sheet.grid, placements.length);
    placements.push(...placed.placements);
    supportReservations.push(...placed.supports);
  }
  const globalPlacementOrder = [...placements].sort((a, b) => {
    const roleOrder = Number(a.role !== 'main') - Number(b.role !== 'main');
    return (
      roleOrder || a.blockId.localeCompare(b.blockId) || a.componentId.localeCompare(b.componentId)
    );
  });
  globalPlacementOrder.forEach((placement, index) => {
    placement.placementOrder = index;
  });
  const sheetArea = Math.max(1, sheet.drawableBounds.width * sheet.drawableBounds.height);
  const utilization = occupiedArea(blocks) / sheetArea;
  const unsatisfiedConstraints = [...new Set(conflicts.map((conflict) => conflict.code))].sort(
    (a, b) => a.localeCompare(b),
  );
  return {
    sheet,
    blocks,
    supportReservations,
    placements,
    occupancy,
    conflicts,
    attempt: {
      pageSize: sheet.pageSize,
      feasible: conflicts.length === 0 && blocks.length === drafts.length,
      utilization,
      unsatisfiedConstraints,
      searchedBlockIds: drafts.map((draft) => draft.id),
    },
  };
}

function proximityScore(
  placements: readonly FunctionalComponentPlacement[],
  components: readonly FunctionalLayoutComponent[],
  constraints: FunctionalLayoutConstraints,
): { score: number; rationale: string[] } {
  const byId = new Map(placements.map((placement) => [placement.componentId, placement]));
  const distances: Array<{ id: string; distance: number; maximum: number }> = [];
  for (const component of components) {
    if (!component.parentId) continue;
    const child = byId.get(component.id);
    const parent = byId.get(component.parentId);
    if (!child || !parent) continue;
    const childCenter = {
      x: child.combinedBounds.x + child.combinedBounds.width / 2,
      y: child.combinedBounds.y + child.combinedBounds.height / 2,
    };
    const parentCenter = {
      x: parent.combinedBounds.x + parent.combinedBounds.width / 2,
      y: parent.combinedBounds.y + parent.combinedBounds.height / 2,
    };
    const maximum =
      component.minimumProximity ??
      constraints.maximumSupportDistanceByRole?.[component.role] ??
      constraints.maximumSupportDistance;
    distances.push({
      id: component.id,
      distance: Math.hypot(childCenter.x - parentCenter.x, childCenter.y - parentCenter.y),
      maximum,
    });
  }
  if (distances.length === 0)
    return { score: 1, rationale: ['No parent proximity rules were required.'] };
  const score =
    distances.reduce((sum, item) => sum + Math.max(0, 1 - item.distance / item.maximum), 0) /
    distances.length;
  return {
    score,
    rationale: distances.map(
      (item) =>
        `${item.id} is ${item.distance.toFixed(2)} units from its parent (limit ${item.maximum}).`,
    ),
  };
}

function finalScore(
  result: SheetAttemptResult,
  input: FunctionalLayoutPlanInput,
  constraints: FunctionalLayoutConstraints,
): FunctionalLayoutScore {
  const proximity = proximityScore(result.placements, input.components, constraints);
  const target =
    (constraints.minimumReadableUtilization + constraints.maximumReadableUtilization) / 2;
  const utilizationScore = Math.max(0, 1 - Math.abs(result.attempt.utilization - target) / target);
  const clearance = result.conflicts.length === 0 ? 1 : 0;
  const overall = (proximity.score * 0.4 + utilizationScore * 0.3 + clearance * 0.3) * 100;
  return {
    overall: Number(overall.toFixed(2)),
    utilization: Number((utilizationScore * 100).toFixed(2)),
    proximity: Number((proximity.score * 100).toFixed(2)),
    clearance: clearance * 100,
    rationale: [
      `Drawable utilization is ${(result.attempt.utilization * 100).toFixed(2)}%.`,
      ...proximity.rationale,
      result.conflicts.length === 0
        ? 'All page, keep-out, reservation, and occupancy constraints are satisfied.'
        : `${result.conflicts.length} exact constraint conflict(s) remain.`,
    ],
  };
}

export function planFunctionalLayout(input: FunctionalLayoutPlanInput): FunctionalLayoutPlan {
  const constraints = normalizedConstraints(input.constraints);
  const drafts = buildBlockDrafts(input.components, constraints);
  const primary = attemptSheet(input.sheet, drafts, input, constraints);
  const attempts = [primary.attempt];
  let selected = primary;
  let a3FallbackRationale: string | undefined;
  if (
    !primary.attempt.feasible &&
    input.allowA3Fallback === true &&
    input.sheet.pageSize === 'A4' &&
    input.a3FallbackSheet?.pageSize === 'A3'
  ) {
    const fallback = attemptSheet(input.a3FallbackSheet, drafts, input, constraints);
    attempts.push(fallback.attempt);
    if (fallback.attempt.feasible) {
      selected = fallback;
      a3FallbackRationale = `A4 was proven infeasible by constraints: ${primary.attempt.unsatisfiedConstraints.join(', ') || 'block capacity'}. A3 satisfied the same constraints.`;
    }
  }
  const score = finalScore(selected, input, constraints);
  const planCore = {
    selectedPageSize: selected.attempt.feasible ? selected.sheet.pageSize : undefined,
    blockReservations: selected.blocks,
    supportReservations: selected.supportReservations,
    placements: selected.placements,
    conflicts: selected.conflicts,
  };
  return {
    feasible: selected.attempt.feasible,
    deterministic: true,
    layoutHash: stableHash(planCore),
    selectedSheet: selected.sheet,
    blockReservations: selected.blocks,
    supportReservations: selected.supportReservations,
    placements: selected.placements,
    placementOrder: selected.placements
      .slice()
      .sort((a, b) => a.placementOrder - b.placementOrder)
      .map((placement) => placement.componentId),
    occupancyMap: selected.occupancy,
    conflicts: selected.conflicts,
    pageSuitability: {
      attempts,
      ...(selected.attempt.feasible ? { selectedPageSize: selected.sheet.pageSize } : {}),
      ...(a3FallbackRationale ? { a3FallbackRationale } : {}),
    },
    score,
  };
}
