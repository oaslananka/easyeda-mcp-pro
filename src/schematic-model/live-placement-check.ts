import { type ToolContext } from '../tools/types.js';
import { gatherLivePrimitiveBounds } from './live-primitive-bounds.js';
import { buildEngineSheetGeometry } from './live-functional-layout.js';
import {
  checkPlacement,
  selectSafeRegion,
  type PlacementCheckResult,
  type PlacementConstraintRegion,
  type SafeRegionPreference,
  type SafeRegionResult,
} from '../layout/placement.js';
import type { PrimitiveRotation } from './primitive-bounds.js';
import type { SchematicBounds } from '../schematic-engine/geometry.js';

export interface LivePlacementCandidateInput {
  width: number;
  height: number;
  /** Omit x/y to search for a safe region instead of validating a specific spot. */
  x?: number;
  y?: number;
  rotation?: PrimitiveRotation;
  preference?: SafeRegionPreference;
}

export interface GatherLivePlacementCheckOptions {
  /** Extra caller-defined reserved regions, beyond the inferred title block. */
  reservedRegions?: readonly PlacementConstraintRegion[];
  minimumClearance?: number;
  /** primitiveIds to exclude from the live occupied-region set (e.g. the component being moved). */
  excludePrimitiveIds?: readonly string[];
}

export type LivePlacementCheckResult =
  | ({ mode: 'check-placement' } & PlacementCheckResult)
  | ({ mode: 'select-safe-region' } & SafeRegionResult);

/**
 * Reads live sheet geometry and every other placed primitive's real rendered
 * bounds, then either validates a specific candidate placement (`checkPlacement`)
 * or searches for a safe region for a given size (`selectSafeRegion`) --
 * read-only, no writes. Existing unrelated primitives are read as occupied
 * regions and are never treated as free space.
 */
export async function gatherLivePlacementCheck(
  ctx: ToolContext,
  projectId: string,
  candidate: LivePlacementCandidateInput,
  options: GatherLivePlacementCheckOptions = {},
): Promise<LivePlacementCheckResult> {
  const sheetInfoResult = await ctx.bridge.call<{ projectId: string }, unknown>(
    'schematic.getSheetInfo',
    { projectId },
  );
  const sheet = buildEngineSheetGeometry(sheetInfoResult);

  const excluded = new Set(options.excludePrimitiveIds ?? []);
  const allBounds = await gatherLivePrimitiveBounds(ctx, projectId);
  const occupiedRegions: PlacementConstraintRegion[] = allBounds.items
    .filter((item) => !excluded.has(item.id) && item.combinedBounds)
    .map((item) => ({
      id: `existing:${item.id}`,
      kind: 'existing-object' as const,
      ownerId: item.id,
      bounds: item.combinedBounds as SchematicBounds,
    }));

  const rotation = candidate.rotation ?? 0;

  if (candidate.x !== undefined && candidate.y !== undefined) {
    const origin = { x: candidate.x, y: candidate.y };
    const result = checkPlacement({
      sheet,
      candidate: {
        origin,
        rotation,
        combinedBounds: { ...origin, width: candidate.width, height: candidate.height },
      },
      reservedRegions: options.reservedRegions,
      occupiedRegions,
      ...(options.minimumClearance !== undefined
        ? { minimumClearance: options.minimumClearance }
        : {}),
      searchPreference: candidate.preference,
    });
    return { mode: 'check-placement', ...result };
  }

  const result = selectSafeRegion({
    sheet,
    size: { width: candidate.width, height: candidate.height },
    rotation,
    preference: candidate.preference,
    reservedRegions: options.reservedRegions,
    occupiedRegions,
    ...(options.minimumClearance !== undefined
      ? { minimumClearance: options.minimumClearance }
      : {}),
  });
  return { mode: 'select-safe-region', ...result };
}
