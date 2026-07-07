import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';
import { planComponentGroupPlacement, planRoutePath } from '../pcb-layout/index.js';

const layoutPointSchema = z.object({ x: z.number(), y: z.number() });
const layoutBoardSchema = z.object({
  widthMm: z.number().positive(),
  heightMm: z.number().positive(),
});
const layoutRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  widthMm: z.number().positive(),
  heightMm: z.number().positive(),
  name: z.string().optional(),
});
export const layoutIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string(),
  remediationHint: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export const layoutOperationSchema = z.object({
  method: z.string(),
  params: z.record(z.string(), z.unknown()),
});
export const layoutApplyResultSchema = z.object({
  method: z.string(),
  success: z.boolean(),
  primitiveId: z.string().optional(),
  error: z.string().optional(),
});

export async function applyLayoutOperations(
  ctx: ToolContext,
  operations: Array<{ method: string; params: Record<string, unknown> }>,
) {
  const results: Array<{ method: string; success: boolean; primitiveId?: string; error?: string }> =
    [];
  for (const operation of operations) {
    try {
      const result = await ctx.bridge.call<
        Record<string, unknown>,
        { primitiveId?: string; result?: string }
      >(operation.method, operation.params);
      const data = result as { primitiveId?: string; result?: string } | string;
      results.push({
        method: operation.method,
        success: true,
        primitiveId:
          typeof data === 'string' ? data : (data?.primitiveId ?? data?.result ?? undefined),
      });
    } catch (error) {
      results.push({
        method: operation.method,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  return results;
}

function registerPcbWriteTools(
  registry: { register: (def: ToolDefinition) => void },
  _config: EnvConfig,
) {
  registry.register({
    name: 'easyeda_pcb_place_component_group',
    title: 'Plan or apply grouped PCB component placement',
    description:
      'Create a high-level, constraint-checked placement plan for a group of components and optionally apply it after explicit confirmation.',
    profile: 'full',
    evidence: ['inferred'],
    risk: 'high',
    confirmWrite: true,
    group: 'pcb-write',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: z.object({
      projectId: z.string().optional(),
      mode: z.enum(['preview', 'apply']).default('preview'),
      board: layoutBoardSchema,
      anchor: layoutPointSchema,
      columns: z.number().int().positive().optional(),
      spacingMm: z.number().nonnegative().optional(),
      layer: z.number().int().default(1),
      minSpacingMm: z.number().nonnegative().optional(),
      components: z.array(
        z.object({
          ref: z.string(),
          primitiveId: z.string().optional(),
          footprint: z.string().optional(),
          widthMm: z.number().positive(),
          heightMm: z.number().positive(),
          rotation: z.number().optional(),
          fixed: z.boolean().optional(),
        }),
      ),
      keepouts: z.array(layoutRectSchema).optional(),
      confirmWrite: z.boolean().optional(),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      project_id: z.string(),
      transaction_id: z.string(),
      mode: z.string(),
      applied: z.boolean(),
      blocked: z.boolean(),
      placements: z.array(
        z.object({
          ref: z.string(),
          primitiveId: z.string().optional(),
          footprint: z.string().optional(),
          x: z.number(),
          y: z.number(),
          rotation: z.number(),
          layer: z.number(),
          widthMm: z.number(),
          heightMm: z.number(),
          bbox: layoutRectSchema,
        }),
      ),
      operations: z.array(layoutOperationSchema),
      apply_results: z.array(layoutApplyResultSchema).optional(),
      issues: z.array(layoutIssueSchema),
      summary: z.string(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as Parameters<typeof planComponentGroupPlacement>[0];
      const plan = planComponentGroupPlacement(p);
      if (p.mode !== 'apply') {
        return {
          success: !plan.blocked,
          project_id: plan.projectId,
          transaction_id: plan.transactionId,
          mode: plan.mode,
          applied: false,
          blocked: plan.blocked,
          placements: plan.placements,
          operations: plan.operations,
          issues: plan.issues,
          summary: plan.summary,
        };
      }
      if (plan.blocked) {
        return {
          success: false,
          project_id: plan.projectId,
          transaction_id: plan.transactionId,
          mode: plan.mode,
          applied: false,
          blocked: true,
          placements: plan.placements,
          operations: plan.operations,
          issues: plan.issues,
          summary: plan.summary,
          error: 'Placement plan contains blocking constraint errors.',
        };
      }
      if (p.confirmWrite !== true) {
        return {
          success: false,
          project_id: plan.projectId,
          transaction_id: plan.transactionId,
          mode: plan.mode,
          applied: false,
          blocked: true,
          placements: plan.placements,
          operations: plan.operations,
          issues: plan.issues,
          summary: 'Apply blocked because confirmWrite=true was not provided.',
          error: 'confirmWrite=true is required to apply grouped component placement.',
        };
      }
      const applyResults = await applyLayoutOperations(ctx, plan.operations);
      const failed = applyResults.some((result) => !result.success);
      return {
        success: !failed,
        project_id: plan.projectId,
        transaction_id: plan.transactionId,
        mode: plan.mode,
        applied: !failed,
        blocked: false,
        placements: plan.placements,
        operations: plan.operations,
        apply_results: applyResults,
        issues: plan.issues,
        summary: failed
          ? 'Placement apply failed before all operations completed.'
          : `Applied ${applyResults.length} placement operation(s).`,
        error: applyResults.find((result) => !result.success)?.error,
      };
    },
  });

  registry.register({
    name: 'easyeda_pcb_route_path_plan',
    title: 'Plan or apply constrained PCB route path',
    description:
      'Create a high-level, constraint-checked route path plan for one net and optionally apply it after explicit confirmation.',
    profile: 'full',
    evidence: ['inferred'],
    risk: 'high',
    confirmWrite: true,
    group: 'pcb-write',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: z.object({
      projectId: z.string().optional(),
      mode: z.enum(['preview', 'apply']).default('preview'),
      board: layoutBoardSchema.optional(),
      netName: z.string(),
      layer: z.number().int(),
      widthMm: z.number().positive(),
      waypoints: z.array(layoutPointSchema),
      keepouts: z.array(layoutRectSchema).optional(),
      maxLengthMm: z.number().positive().optional(),
      minWidthMm: z.number().positive().optional(),
      confirmWrite: z.boolean().optional(),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      project_id: z.string(),
      transaction_id: z.string(),
      mode: z.string(),
      applied: z.boolean(),
      blocked: z.boolean(),
      net_name: z.string(),
      layer: z.number(),
      width_mm: z.number(),
      path_length_mm: z.number(),
      operations: z.array(layoutOperationSchema),
      apply_results: z.array(layoutApplyResultSchema).optional(),
      issues: z.array(layoutIssueSchema),
      summary: z.string(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as Parameters<typeof planRoutePath>[0];
      const plan = planRoutePath(p);
      const base = {
        project_id: plan.projectId,
        transaction_id: plan.transactionId,
        mode: plan.mode,
        applied: false,
        blocked: plan.blocked,
        net_name: plan.netName,
        layer: plan.layer,
        width_mm: plan.widthMm,
        path_length_mm: plan.pathLengthMm,
        operations: plan.operations,
        issues: plan.issues,
      };
      if (p.mode !== 'apply') return { success: !plan.blocked, ...base, summary: plan.summary };
      if (plan.blocked) {
        return {
          success: false,
          ...base,
          blocked: true,
          summary: plan.summary,
          error: 'Route plan contains blocking constraint errors.',
        };
      }
      if (p.confirmWrite !== true) {
        return {
          success: false,
          ...base,
          blocked: true,
          summary: 'Apply blocked because confirmWrite=true was not provided.',
          error: 'confirmWrite=true is required to apply route path plan.',
        };
      }
      const applyResults = await applyLayoutOperations(ctx, plan.operations);
      const failed = applyResults.some((result) => !result.success);
      return {
        success: !failed,
        ...base,
        applied: !failed,
        blocked: false,
        apply_results: applyResults,
        summary: failed
          ? 'Route apply failed before all operations completed.'
          : `Applied ${applyResults.length} route operation(s).`,
        error: applyResults.find((result) => !result.success)?.error,
      };
    },
  });

  registry.register({
    name: 'easyeda_pcb_place_component',
    title: 'Place component on PCB',
    description:
      'Place a component footprint on the active PCB layout. CAUTION: the native create() call ' +
      'needs 6 args but this tool sends only 5 (footprint, x, y, rotation, layer) — ' +
      'live-confirmed mismatch, not yet resolved. Verify placement visually before trusting it.',
    profile: 'full',
    evidence: ['inferred'],
    risk: 'high',
    confirmWrite: true,
    group: 'pcb-write',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: z.object({
      footprint: z.string(),
      x: z.number(),
      y: z.number(),
      rotation: z.number().default(0),
      layer: z.number().default(1),
      confirmWrite: z.literal(true),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      primitiveId: z.string().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as {
        footprint: string;
        x: number;
        y: number;
        rotation: number;
        layer: number;
      };
      try {
        const result = await ctx.bridge.call<
          Record<string, unknown>,
          { primitiveId?: string; result?: string }
        >('pcb.placeComponent', {
          footprint: p.footprint,
          x: p.x,
          y: p.y,
          rotation: p.rotation,
          layer: p.layer,
        });
        const data = result as { primitiveId?: string; result?: string } | string;
        return {
          success: true,
          primitiveId:
            typeof data === 'string' ? data : (data?.primitiveId ?? data?.result ?? undefined),
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_pcb_add_track',
    title: 'Add PCB track',
    description:
      'Draw a copper track/trace on the PCB board. A multi-point path is written as one line ' +
      'segment per consecutive point pair (all sharing netName, so they form one electrical ' +
      'track — same coordinate/name merge model as schematic wires).',
    profile: 'full',
    evidence: ['runtime-probe'],
    risk: 'high',
    confirmWrite: true,
    group: 'pcb-write',
    version: '2.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: z.object({
      points: z.array(z.object({ x: z.number(), y: z.number() })).min(2),
      layer: z.number(),
      width: z.number(),
      netName: z.string().optional(),
      confirmWrite: z.literal(true),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      primitiveId: z.string().optional(),
      primitiveIds: z.array(z.string()).optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as {
        points: Array<{ x: number; y: number }>;
        layer: number;
        width: number;
        netName?: string;
      };
      try {
        const result = await ctx.bridge.call<
          Record<string, unknown>,
          { primitiveId?: string; primitiveIds?: string[] }
        >('pcb.addTrack', {
          points: p.points,
          layer: p.layer,
          width: p.width,
          netName: p.netName,
        });
        return {
          success: true,
          primitiveId: result?.primitiveId,
          primitiveIds: result?.primitiveIds,
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_pcb_add_via',
    title: 'Add PCB via',
    description:
      'Place a via to connect different copper layers on the PCB board. outerDiameter/holeSize ' +
      'are passed through to the native API unconverted (same native unit as x/y) — their ' +
      'real-world scale was not independently verified against a known physical dimension, so ' +
      'confirm the resulting via size visually before trusting it.',
    profile: 'full',
    evidence: ['runtime-probe'],
    risk: 'high',
    confirmWrite: true,
    group: 'pcb-write',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: z.object({
      x: z.number(),
      y: z.number(),
      outerDiameter: z.number(),
      holeSize: z.number(),
      netName: z.string().optional(),
      confirmWrite: z.literal(true),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      primitiveId: z.string().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as {
        x: number;
        y: number;
        outerDiameter: number;
        holeSize: number;
        netName?: string;
      };
      try {
        const result = await ctx.bridge.call<
          Record<string, unknown>,
          { primitiveId?: string; result?: string }
        >('pcb.addVia', {
          x: p.x,
          y: p.y,
          outerDiameter: p.outerDiameter,
          holeSize: p.holeSize,
          netName: p.netName,
        });
        const data = result as { primitiveId?: string; result?: string } | string;
        return {
          success: true,
          primitiveId:
            typeof data === 'string' ? data : (data?.primitiveId ?? data?.result ?? undefined),
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_pcb_add_zone',
    title: 'Add PCB copper zone/pour',
    description:
      'Create a copper pour zone on a layer with clearance settings. CAUTION: the native ' +
      'create() call needs 9 args but this tool sends only 4 (points, layer, netName, ' +
      'clearance) — live-confirmed mismatch, not yet resolved. Verify visually before trusting it.',
    profile: 'full',
    evidence: ['inferred'],
    risk: 'high',
    confirmWrite: true,
    group: 'pcb-write',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: z.object({
      points: z.array(z.object({ x: z.number(), y: z.number() })),
      layer: z.number(),
      netName: z.string().optional(),
      clearance: z.number().optional(),
      confirmWrite: z.literal(true),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      primitiveId: z.string().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as {
        points: Array<{ x: number; y: number }>;
        layer: number;
        netName?: string;
        clearance?: number;
      };
      try {
        const flatPoints = p.points.flatMap((pt) => [pt.x, pt.y]);
        const result = await ctx.bridge.call<
          Record<string, unknown>,
          { primitiveId?: string; result?: string }
        >('pcb.addZone', {
          points: flatPoints,
          layer: p.layer,
          netName: p.netName,
          clearance: p.clearance,
        });
        const data = result as { primitiveId?: string; result?: string } | string;
        return {
          success: true,
          primitiveId:
            typeof data === 'string' ? data : (data?.primitiveId ?? data?.result ?? undefined),
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_pcb_delete_component',
    title: 'Delete PCB components',
    description: 'Delete components from the PCB layout by their primitive IDs.',
    profile: 'full',
    evidence: ['official-docs'],
    risk: 'high',
    confirmWrite: true,
    group: 'pcb-write',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
    },
    inputSchema: z.object({
      primitiveIds: z.array(z.string()),
      confirmWrite: z.literal(true),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      deletedCount: z.number().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as { primitiveIds: string[] };
      try {
        await ctx.bridge.call<Record<string, unknown>, { primitiveId?: string; result?: string }>(
          'pcb.deleteComponent',
          {
            primitiveIds: p.primitiveIds,
          },
        );
        return {
          success: true,
          deletedCount: p.primitiveIds.length,
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_pcb_modify_component',
    title: 'Modify PCB component properties',
    description: 'Modify component properties in the PCB layout.',
    profile: 'full',
    evidence: ['official-docs'],
    risk: 'high',
    confirmWrite: true,
    group: 'pcb-write',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: z.object({
      primitiveId: z.string(),
      property: z.record(z.string(), z.unknown()),
      confirmWrite: z.literal(true),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as { primitiveId: string; property: Record<string, unknown> };
      try {
        await ctx.bridge.call<Record<string, unknown>, { primitiveId?: string; result?: string }>(
          'pcb.modifyComponent',
          {
            primitiveId: p.primitiveId,
            property: p.property,
          },
        );
        return {
          success: true,
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

export { registerPcbWriteTools };
