import { z } from 'zod';
import { type ToolRegistry } from './registry.js';
import type { ToolContext } from './types.js';

/** EasyEDA Pro PCB layer id for the board outline (see isBoardOutlineLayer in the extension). */
const BOARD_OUTLINE_LAYER = 11;
const MM_PER_MIL = 0.0254;
/** Read-back tolerance beyond the drawn line width, in mm. */
const READBACK_TOLERANCE_MM = 0.05;

const outlineInput = z.object({
  projectId: z
    .string()
    .trim()
    .min(1)
    .describe('EasyEDA project UUID of the focused PCB (not its display name).'),
  expectedPcbUuid: z
    .string()
    .trim()
    .min(1)
    .describe('Focused PCB document UUID; the write is refused on any other focused document.'),
  widthMm: z.number().positive().max(1000),
  heightMm: z.number().positive().max(1000),
  xMm: z.number().default(0).describe('X of the first corner, in mm, in EasyEDA native PCB axes.'),
  yMm: z.number().default(0).describe('Y of the first corner, in mm, in EasyEDA native PCB axes.'),
  lineWidthMm: z.number().positive().max(2).default(0.254),
  confirmWrite: z
    .literal(true)
    .describe('Must be the literal boolean true (not the string "true") to allow this write.'),
});

type OutlineInput = z.infer<typeof outlineInput>;

const outlineOutput = z.object({
  success: z.boolean(),
  status: z.string(),
  projectId: z.string(),
  pcbId: z.string(),
  primitiveIds: z.array(z.string()).optional(),
  measuredWidthMm: z.number().optional(),
  measuredHeightMm: z.number().optional(),
  rolledBack: z.boolean().optional(),
  leftoverPrimitiveIds: z.array(z.string()).optional(),
  error: z.string().optional(),
});

type OutlineOutput = z.infer<typeof outlineOutput>;

interface DimensionsReadback {
  widthMm?: number;
  heightMm?: number;
  hasOutline?: boolean;
}

function toMil(mm: number): number {
  return Math.round((mm / MM_PER_MIL) * 1000) / 1000;
}

function hasOutline(data: DimensionsReadback | null | undefined): boolean {
  if (!data) return false;
  if (data.hasOutline !== undefined) return data.hasOutline;
  return (data.widthMm ?? 0) > 0 && (data.heightMm ?? 0) > 0;
}

/** api.call returns the created primitive as { result: { state: { PrimitiveId } } }. */
function primitiveIdOf(value: unknown): string | undefined {
  const state = (value as { result?: { state?: { PrimitiveId?: unknown } } } | null)?.result?.state;
  return typeof state?.PrimitiveId === 'string' && state.PrimitiveId
    ? state.PrimitiveId
    : undefined;
}

function isTargetRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'TARGET_DOCUMENT_MISMATCH' || code === 'TARGET_PROJECT_MISMATCH';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** EasyEDA rectangle polygon source: ['R', x, y, width, height, rotation, cornerRadius] in mil. */
function rectangleSource(
  input: OutlineInput,
): [string, number, number, number, number, number, number] {
  return [
    'R',
    toMil(input.xMm),
    toMil(input.yMm),
    toMil(input.widthMm),
    toMil(input.heightMm),
    0,
    0,
  ];
}

/**
 * Delete what this call created, then confirm by re-reading the board: a native delete that does
 * not throw is not evidence that the outline is gone. Returns the ids that may remain.
 */
async function rollback(ctx: ToolContext, ids: string[], projectId: string): Promise<string[]> {
  if (ids.length === 0) return [];
  try {
    await ctx.bridge.call('pcb.deleteComponent', { primitiveIds: ids });
    const after = (await ctx.bridge.call('board.getDimensions', {
      projectId,
    })) as DimensionsReadback | null;
    return hasOutline(after ?? {}) ? ids : [];
  } catch {
    return ids;
  }
}

type OutlineBase = Pick<OutlineOutput, 'projectId' | 'pcbId'>;

async function readDimensions(ctx: ToolContext, projectId: string): Promise<DimensionsReadback> {
  const result = (await ctx.bridge.call('board.getDimensions', {
    projectId,
  })) as DimensionsReadback | null;
  return result ?? {};
}

function rollbackFailure(
  base: OutlineBase,
  stage: 'create_failed' | 'readback_mismatch',
  leftover: string[],
): OutlineOutput {
  const complete = leftover.length === 0;
  return {
    ...base,
    success: false,
    status: complete ? `${stage}_rolled_back` : `${stage}_rollback_incomplete`,
    rolledBack: complete,
    leftoverPrimitiveIds: complete ? undefined : leftover,
  };
}

/**
 * EasyEDA stores the board outline as one PCB_PrimitivePolyline on the board-outline layer;
 * PCB_PrimitiveLine.create does not create primitives on that layer (live, EasyEDA Pro 4.1.105).
 * The polygon must be built inside the extension, so use the tagged api.call path, as
 * easyeda_pcb_add_region does.
 */
async function drawOutline(
  ctx: ToolContext,
  input: OutlineInput,
  base: OutlineBase,
): Promise<{ created: string[] } | { failure: OutlineOutput }> {
  try {
    const result = await ctx.bridge.call('api.call', {
      expectedPcbUuid: input.expectedPcbUuid,
      expectedProjectUuid: input.projectId,
      path: 'PCB_PrimitivePolyline.create',
      args: [
        '',
        BOARD_OUTLINE_LAYER,
        { $polygon: rectangleSource(input) },
        toMil(input.lineWidthMm),
        false,
      ],
    });
    const id = primitiveIdOf(result);
    if (!id) {
      return {
        failure: {
          ...base,
          success: false,
          status: 'create_unverified',
          error:
            'Native polyline create returned no primitive ID; inspect the PCB before retrying.',
        },
      };
    }
    return { created: [id] };
  } catch (error) {
    // A guard refusal happens before any write; any other error leaves the outcome unknown
    // (the polyline may exist without an id to delete), so never claim a rollback here.
    return {
      failure: {
        ...base,
        success: false,
        status: isTargetRefusal(error) ? 'target_mismatch' : 'create_unverified',
        error: errorText(error),
      },
    };
  }
}

function matchesRequest(after: DimensionsReadback, input: OutlineInput): boolean {
  const tolerance = input.lineWidthMm + READBACK_TOLERANCE_MM;
  return (
    hasOutline(after) &&
    Math.abs((after.widthMm ?? 0) - input.widthMm) <= tolerance &&
    Math.abs((after.heightMm ?? 0) - input.heightMm) <= tolerance
  );
}

/** A guarded PCB read: the extension rejects it unless the expected PCB and project are focused. */
async function confirmTarget(
  ctx: ToolContext,
  input: OutlineInput,
): Promise<{ status: string; error: string } | undefined> {
  try {
    // The tool sends expectedProjectUuid itself, so the registry does not check this capability.
    const status = (await ctx.bridge.call('system.getStatus', {})) as {
      documentProjectGuard?: unknown;
    } | null;
    if (status?.documentProjectGuard !== true) {
      return {
        status: 'guard_unavailable',
        error: 'The active extension does not support focused-project guards; no write attempted.',
      };
    }
    await ctx.bridge.call('pcb.listTracks', {
      projectId: input.projectId,
      expectedPcbUuid: input.expectedPcbUuid,
      expectedProjectUuid: input.projectId,
      limit: 1,
      offset: 0,
    });
    return undefined;
  } catch (error) {
    return {
      status: isTargetRefusal(error) ? 'target_mismatch' : 'target_unverified',
      error: errorText(error),
    };
  }
}

async function setBoardOutline(ctx: ToolContext, input: OutlineInput): Promise<OutlineOutput> {
  const base: OutlineBase = { projectId: input.projectId, pcbId: input.expectedPcbUuid };

  // board.getDimensions reads whatever PCB is focused; confirm it is the expected one first.
  const target = await confirmTarget(ctx, input);
  if (target) return { ...base, success: false, ...target };

  let before: DimensionsReadback;
  try {
    before = await readDimensions(ctx, input.projectId);
  } catch (error) {
    return { ...base, success: false, status: 'precheck_unavailable', error: errorText(error) };
  }
  if (hasOutline(before)) {
    // Never stack a second outline on a board that already has one.
    return {
      ...base,
      success: false,
      status: 'outline_exists',
      measuredWidthMm: before.widthMm,
      measuredHeightMm: before.heightMm,
    };
  }

  const drawn = await drawOutline(ctx, input, base);
  if ('failure' in drawn) return drawn.failure;

  let after: DimensionsReadback;
  try {
    after = await readDimensions(ctx, input.projectId);
  } catch (error) {
    // The lines exist but cannot be verified; leave them and say so.
    return {
      ...base,
      success: false,
      status: 'readback_unavailable',
      primitiveIds: drawn.created,
      error: errorText(error),
    };
  }

  const measured = { measuredWidthMm: after.widthMm, measuredHeightMm: after.heightMm };
  if (!matchesRequest(after, input)) {
    const leftover = await rollback(ctx, drawn.created, input.projectId);
    return { ...rollbackFailure(base, 'readback_mismatch', leftover), ...measured };
  }
  return {
    ...base,
    success: true,
    status: 'outline_created',
    primitiveIds: drawn.created,
    ...measured,
  };
}

export function registerPcbOutlineTools(registry: ToolRegistry): void {
  registry.register({
    name: 'easyeda_pcb_set_board_outline',
    title: 'Create a rectangular board outline with read-back',
    description:
      'Draw a rectangular board outline (one board-outline polyline) on the focused PCB when it has ' +
      'none, then verify the measured size. Requires confirmWrite and expectedPcbUuid; deletes and ' +
      're-reads if the size does not match.',
    profile: 'pro',
    evidence: ['runtime-probe'],
    risk: 'high',
    confirmWrite: true,
    sideEffect: 'design-mutation',
    group: 'pcb-write',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: outlineInput,
    outputSchema: outlineOutput,
    handler: async (ctx: ToolContext, params: unknown) =>
      setBoardOutline(ctx, outlineInput.parse(params)),
  });
}
