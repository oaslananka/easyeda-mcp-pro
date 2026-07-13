import { type ToolContext } from '../tools/types.js';
import { gatherLivePrimitiveBounds } from './live-primitive-bounds.js';
import {
  inferSchematicSheetGeometry,
  defaultTitleBlockKeepout,
} from '../workflows/schematic-safe-region.js';
import {
  planFunctionalLayout,
  type FunctionalComponentRole,
  type FunctionalLayoutComponent,
  type FunctionalLayoutConstraints,
  type FunctionalLayoutPlan,
} from '../layout/planner.js';
import type { PlacementConstraintRegion } from '../layout/placement.js';
import type { PrimitiveRotation } from './primitive-bounds.js';
import type { SchematicBounds, SchematicSheetGeometry } from '../schematic-engine/geometry.js';

export interface LiveFunctionalLayoutComponentInput {
  primitiveId: string;
  blockId: string;
  role: FunctionalComponentRole;
  parentId?: string;
  preferredRotation?: PrimitiveRotation;
  allowedRotations?: readonly PrimitiveRotation[];
  minimumProximity?: number;
}

export interface GatherLiveFunctionalLayoutPlanOptions {
  a3FallbackAllowed?: boolean;
  constraints?: Partial<FunctionalLayoutConstraints>;
  /** Extra caller-supplied hard keepouts, in addition to the inferred title-block region. */
  hardKeepouts?: readonly PlacementConstraintRegion[];
}

/**
 * Builds the engine's richer SchematicSheetGeometry (bounds/drawableBounds/
 * titleBlockBounds) from the same sheet-info-derived width/height/margin logic
 * already proven correct by easyeda_schematic_layout_qa, rather than
 * re-deriving page geometry a second, possibly-inconsistent way.
 *
 * EasyEDA's live schematic coordinates put the page's top-left reference point
 * at (0, 0) with content extending in +X (right) and -Y (downward) -- observed
 * across every live design read this session (all real component Y values are
 * <= 0). `yAxis: 'up'` here documents that increasing Y visually goes up, i.e.
 * the page rectangle spans y in [-height, 0].
 */
export function buildEngineSheetGeometry(rawSheetInfo: unknown): SchematicSheetGeometry {
  const inferred = inferSchematicSheetGeometry(rawSheetInfo);
  const margin = Math.max(10, Math.round(Math.min(inferred.width, inferred.height) * 0.03));
  const bounds: SchematicBounds = {
    x: 0,
    y: -inferred.height,
    width: inferred.width,
    height: inferred.height,
  };
  const drawableBounds: SchematicBounds = {
    x: bounds.x + margin,
    y: bounds.y + margin,
    width: Math.max(0, bounds.width - margin * 2),
    height: Math.max(0, bounds.height - margin * 2),
  };
  const legacyTitleBlock = defaultTitleBlockKeepout(inferred);
  const titleBlockBounds: SchematicBounds = {
    x: legacyTitleBlock.x,
    y: bounds.y + (inferred.height - legacyTitleBlock.y - legacyTitleBlock.height),
    width: legacyTitleBlock.width,
    height: legacyTitleBlock.height,
  };
  return {
    bounds,
    drawableBounds,
    grid: 10,
    units: inferred.unit,
    pageSize: inferred.width >= 1500 ? 'A3' : 'A4',
    coordinateOrigin: { x: 0, y: 0, yAxis: 'up', source: 'live-readback' },
    geometrySource: inferred.source === 'sheet-info' ? 'live-readback' : 'derived',
    titleBlockBounds,
  };
}

/**
 * Reads sheet geometry, real placed-component bounds (via the #271
 * primitive-bounds engine), and a caller-supplied functional inventory from
 * the live bridge, then runs the deterministic layout planner
 * (`planFunctionalLayout`) against them.
 *
 * Components not present in `components` are treated as pre-existing,
 * unrelated occupied regions -- the planner must never place a new block on
 * top of them (acceptance criterion: existing primitives are never
 * overwritten).
 */
export async function gatherLiveFunctionalLayoutPlan(
  ctx: ToolContext,
  projectId: string,
  components: readonly LiveFunctionalLayoutComponentInput[],
  options: GatherLiveFunctionalLayoutPlanOptions = {},
): Promise<FunctionalLayoutPlan> {
  const sheetInfoResult = await ctx.bridge.call<{ projectId: string }, unknown>(
    'schematic.getSheetInfo',
    { projectId },
  );
  const sheet = buildEngineSheetGeometry(sheetInfoResult);

  const requestedIds = new Set(components.map((c) => c.primitiveId));
  const allBounds = await gatherLivePrimitiveBounds(ctx, projectId);

  const layoutComponents: FunctionalLayoutComponent[] = [];
  for (const input of components) {
    const item = allBounds.items.find((i) => i.id === input.primitiveId);
    const size = item?.combinedBounds
      ? { width: item.combinedBounds.width, height: item.combinedBounds.height }
      : { width: 10, height: 10 };
    layoutComponents.push({
      id: input.primitiveId,
      blockId: input.blockId,
      role: input.role,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      renderedSize: size,
      ...(input.preferredRotation !== undefined
        ? { preferredRotation: input.preferredRotation }
        : {}),
      ...(input.allowedRotations ? { allowedRotations: input.allowedRotations } : {}),
      ...(input.minimumProximity !== undefined ? { minimumProximity: input.minimumProximity } : {}),
    });
  }

  const existingOccupiedRegions: PlacementConstraintRegion[] = allBounds.items
    .filter((item) => !requestedIds.has(item.id) && item.combinedBounds)
    .map((item) => ({
      id: `existing:${item.id}`,
      kind: 'existing-object' as const,
      ownerId: item.id,
      bounds: item.combinedBounds as SchematicBounds,
    }));

  const hardKeepouts: PlacementConstraintRegion[] = [
    {
      id: 'title-block',
      kind: 'title-block' as const,
      bounds: sheet.titleBlockBounds ?? { x: 0, y: 0, width: 0, height: 0 },
    },
    ...(options.hardKeepouts ?? []),
  ];

  return planFunctionalLayout({
    sheet,
    allowA3Fallback: options.a3FallbackAllowed ?? false,
    components: layoutComponents,
    hardKeepouts,
    existingOccupiedRegions,
    ...(options.constraints ? { constraints: options.constraints } : {}),
  });
}
