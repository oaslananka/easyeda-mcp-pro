/**
 * Pin-coordinate collision detection for schematic component placement.
 *
 * EasyEDA merges any two primitives that land on the exact same (x,y) canvas point,
 * regardless of net name, the moment either one is wired — so a newly-placed component
 * whose pin coincides with an unrelated component's pin is a silent-short risk even
 * before any wire is drawn. The bridge's own `NET_COLLISION` guard only catches this for
 * pins that are already part of a net (see `easyeda-bridge-extension/src/dispatcher.ts`'s
 * `collectPinCoordinateNets`) — a virgin, never-wired pin is invisible to it. This module
 * closes that gap by reading every placed component's real pin coordinates directly
 * (`SCH_PrimitiveComponent.getAllPinsByPrimitiveId` via `fetchComponentPins`), independent
 * of net membership.
 *
 * @module
 */

import { type ToolContext } from '../tools/types.js';
import { fetchComponentPins } from '../tools/schematic-helpers.js';

export interface CollisionPinRef {
  primitiveId: string;
  pinNumber: string;
  pinName: string;
}

export interface PinCollision {
  x: number;
  y: number;
  pins: CollisionPinRef[];
}

interface SheetComponentRef {
  primitiveId: string;
}

/** Round to the same precision the bridge's own coordinate-key helper uses. */
function pointKey(x: number, y: number): string {
  return `${Math.round(x * 1000) / 1000},${Math.round(y * 1000) / 1000}`;
}

/** Page through `schematic.listComponents` and return every component's primitiveId. */
async function listAllComponentIds(
  ctx: ToolContext,
  projectId: string,
): Promise<SheetComponentRef[]> {
  const pageSize = 500;
  const all: SheetComponentRef[] = [];
  let offset = 0;
  for (;;) {
    const result = await ctx.bridge.call<
      { projectId: string; limit: number; offset: number },
      { total?: number; items?: Array<{ primitiveId?: string }> }
    >('schematic.listComponents', { projectId, limit: pageSize, offset });
    const items = result?.items ?? [];
    for (const item of items) {
      if (item.primitiveId) all.push({ primitiveId: item.primitiveId });
    }
    const total = result?.total ?? items.length;
    offset += items.length;
    if (items.length === 0 || offset >= total) break;
  }
  return all;
}

/**
 * Build a coordinate -> pins map for the given components. Fetches every component's
 * pin list individually (one bridge round-trip each) — intentionally unfiltered by net
 * membership, since that's exactly the blind spot this closes.
 */
interface PointBucket {
  x: number;
  y: number;
  pins: CollisionPinRef[];
}

async function buildPinCoordinateMap(
  ctx: ToolContext,
  components: SheetComponentRef[],
): Promise<Map<string, PointBucket>> {
  const map = new Map<string, PointBucket>();
  for (const component of components) {
    const pins = await fetchComponentPins(ctx, component.primitiveId);
    for (const pin of pins) {
      const key = pointKey(pin.x, pin.y);
      const bucket = map.get(key) ?? { x: pin.x, y: pin.y, pins: [] };
      bucket.pins.push({
        primitiveId: component.primitiveId,
        pinNumber: pin.pinNumber,
        pinName: pin.pinName,
      });
      map.set(key, bucket);
    }
  }
  return map;
}

function collisionsFromMap(
  map: Map<string, PointBucket>,
  onlyInvolving?: Set<string>,
): PinCollision[] {
  const collisions: PinCollision[] = [];
  for (const bucket of map.values()) {
    const distinctPrimitives = new Set(bucket.pins.map((p) => p.primitiveId));
    if (distinctPrimitives.size < 2) continue;
    if (onlyInvolving && ![...distinctPrimitives].some((id) => onlyInvolving.has(id))) continue;
    collisions.push({ x: bucket.x, y: bucket.y, pins: bucket.pins });
  }
  return collisions;
}

/**
 * Full-sheet pin-coordinate collision scan. Read-only — used both standalone
 * (`easyeda_schematic_check_collisions`) and as the basis for the workflow-apply
 * reconcile step below.
 */
export async function scanSheetForPinCollisions(
  ctx: ToolContext,
  projectId: string,
): Promise<PinCollision[]> {
  const components = await listAllComponentIds(ctx, projectId);
  const map = await buildPinCoordinateMap(ctx, components);
  return collisionsFromMap(map);
}

export interface ReconcilePlacementResult {
  /** Collisions that could not be resolved by nudging — caller should block/report these. */
  unresolvedCollisions: PinCollision[];
  /** primitiveId -> final {x, y} for every candidate that was moved during reconcile. */
  movedComponents: Map<string, { x: number; y: number }>;
}

const NUDGE_ATTEMPTS = 3;
const NUDGE_STEP = 30;

/**
 * Post-placement reconcile: check the newly-placed `candidatePrimitiveIds` for pin-coordinate
 * collisions against every other component on the sheet, and nudge (re-`modifyPrimitive`) any
 * offender by a fixed offset up to `NUDGE_ATTEMPTS` times. Safe to call only *before* any wires
 * are connected to the candidates — moving a component after it's wired does not move its wires
 * (see the dispatcher's `modifyPrimitive` limitation) and would itself create the exact hazard
 * this function exists to prevent.
 */
export async function reconcilePlacementCollisions(
  ctx: ToolContext,
  projectId: string,
  candidatePrimitiveIds: string[],
  candidatePositions: Map<string, { x: number; y: number }>,
): Promise<ReconcilePlacementResult> {
  const candidateSet = new Set(candidatePrimitiveIds);
  const movedComponents = new Map<string, { x: number; y: number }>();
  if (candidateSet.size === 0) {
    return { unresolvedCollisions: [], movedComponents };
  }

  const components = await listAllComponentIds(ctx, projectId);

  for (let attempt = 0; attempt <= NUDGE_ATTEMPTS; attempt += 1) {
    const map = await buildPinCoordinateMap(ctx, components);
    const collisions = collisionsFromMap(map, candidateSet);
    if (collisions.length === 0) {
      return { unresolvedCollisions: [], movedComponents };
    }
    if (attempt === NUDGE_ATTEMPTS) {
      return { unresolvedCollisions: collisions, movedComponents };
    }

    const offendingCandidates = new Set(
      collisions.flatMap((collision) =>
        collision.pins.map((p) => p.primitiveId).filter((id) => candidateSet.has(id)),
      ),
    );
    for (const primitiveId of offendingCandidates) {
      const current = candidatePositions.get(primitiveId);
      if (!current) continue;
      const nudged = {
        x: current.x + NUDGE_STEP * (attempt + 1),
        y: current.y + NUDGE_STEP * (attempt + 1),
      };
      await ctx.bridge.call('schematic.modifyPrimitive', {
        primitiveId,
        property: { x: nudged.x, y: nudged.y },
      });
      candidatePositions.set(primitiveId, nudged);
      movedComponents.set(primitiveId, nudged);
    }
  }

  return { unresolvedCollisions: [], movedComponents };
}
