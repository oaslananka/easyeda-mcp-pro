import { type ToolContext } from '../tools/types.js';
import {
  computePrimitiveBoundsBatch,
  type PrimitiveBoundsBatchResult,
  type PrimitiveBoundsInput,
} from './primitive-bounds.js';
import { type SchematicBounds } from '../schematic-engine/geometry.js';

interface BridgeComponentItem {
  primitiveId?: string;
  reference?: string;
  component_kind?: string;
  x?: number;
  y?: number;
  rotation?: number;
}

interface BridgeComponentPage {
  total?: number;
  items?: BridgeComponentItem[];
}

interface RawPrimitiveBBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface BridgePrimitiveBoundsResponse {
  items?: Array<{ primitiveId: string; bounds: RawPrimitiveBBox | null }>;
  combined?: RawPrimitiveBBox | null;
}

function bboxToSchematicBounds(box: RawPrimitiveBBox): SchematicBounds {
  return {
    x: box.minX,
    y: box.minY,
    width: box.maxX - box.minX,
    height: box.maxY - box.minY,
  };
}

const ROTATIONS = new Set([0, 90, 180, 270]);

function normalizeRotation(rotation: number | undefined): 0 | 90 | 180 | 270 {
  const normalized = ((Math.round(rotation ?? 0) % 360) + 360) % 360;
  return (ROTATIONS.has(normalized) ? normalized : 0) as 0 | 90 | 180 | 270;
}

/**
 * Page through schematic.listComponents to collect every component's identity
 * and placement metadata (needed for the result's origin/rotation fields --
 * the bounds themselves are already sheet-space, courtesy of the runtime's own
 * SCH_Primitive.getPrimitivesBBox).
 */
async function listAllComponents(
  ctx: ToolContext,
  projectId: string,
  pageSize = 500,
): Promise<BridgeComponentItem[]> {
  const all: BridgeComponentItem[] = [];
  let offset = 0;
  for (;;) {
    const page = await ctx.bridge.call<
      { projectId: string; limit: number; offset: number },
      BridgeComponentPage
    >('schematic.listComponents', { projectId, limit: pageSize, offset });
    const items = page?.items ?? [];
    all.push(...items);
    const total = page?.total ?? items.length;
    offset += items.length;
    if (items.length === 0 || offset >= total) break;
  }
  return all;
}

export interface GatherLivePrimitiveBoundsOptions {
  /** Restrict to these primitiveIds; defaults to every component on the sheet. */
  primitiveIds?: string[];
}

/**
 * Read real rendered (sheet-space, rotation/mirror-aware) bounding boxes for
 * schematic primitives from the live bridge.
 *
 * Verified against a live EasyEDA Pro session (2026-07): component designator
 * and value text are not independently addressable primitives -- they are
 * rendered as attribute strings on the component itself (`sch_PrimitiveText`
 * only enumerates free-floating sheet annotations, and `getPrimitivesInRegion`
 * is an unimplemented stub in this runtime build) -- so `reference`/`value`
 * segments are always `not_available` here. `body` is real runtime geometry.
 */
export async function gatherLivePrimitiveBounds(
  ctx: ToolContext,
  projectId: string,
  options: GatherLivePrimitiveBoundsOptions = {},
): Promise<PrimitiveBoundsBatchResult> {
  const components = await listAllComponents(ctx, projectId);
  const requested = new Set(options.primitiveIds);
  const selected = options.primitiveIds
    ? components.filter((c) => c.primitiveId && requested.has(c.primitiveId))
    : components;

  const ids = selected
    .map((c) => c.primitiveId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  const raw = await ctx.bridge.call<{ primitiveIds: string[] }, BridgePrimitiveBoundsResponse>(
    'schematic.primitiveBounds',
    { primitiveIds: ids },
  );
  const boundsById = new Map((raw?.items ?? []).map((item) => [item.primitiveId, item.bounds]));

  const inputs: PrimitiveBoundsInput[] = selected
    .filter((c): c is BridgeComponentItem & { primitiveId: string } => !!c.primitiveId)
    .map((component) => {
      const box = boundsById.get(component.primitiveId);
      return {
        id: component.primitiveId,
        primitiveType: component.component_kind ?? 'component',
        origin: { x: component.x ?? 0, y: component.y ?? 0 },
        rotation: normalizeRotation(component.rotation),
        units: 'mil',
        grid: 10,
        coordinateOrigin: { x: 0, y: 0, yAxis: 'down' as const, source: 'runtime' as const },
        ...(box
          ? {
              body: {
                id: component.primitiveId,
                bounds: bboxToSchematicBounds(box),
                space: 'sheet' as const,
                geometrySource: 'runtime' as const,
              },
            }
          : {}),
      } satisfies PrimitiveBoundsInput;
    });

  return computePrimitiveBoundsBatch(inputs);
}
