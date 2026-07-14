import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';

function registerBoardTools(
  registry: { register: (def: ToolDefinition) => void },
  _config: EnvConfig,
) {
  registry.register({
    name: 'easyeda_board_layers',
    title: 'List PCB layers',
    description:
      'List all layers in the PCB design including signal, power, plane, and mechanical layers.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'board',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      layers: z.array(
        z.object({
          name: z.string(),
          type: z.string(),
          color: z.string().optional(),
          visible: z.boolean(),
          order: z.number().int().nonnegative().optional(),
        }),
      ),
      total: z.number().int().nonnegative(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId } = params as { projectId: string };
      try {
        const result = await ctx.bridge.call('board.listLayers', { projectId });
        const layers = result as Array<{
          name?: string;
          type?: string;
          color?: string;
          visible?: boolean;
          order?: number;
        }>;
        return {
          project_id: projectId,
          layers: (layers ?? []).map((l) => ({
            name: l.name ?? '',
            type: l.type ?? '',
            color: l.color,
            visible: l.visible ?? true,
            order: l.order,
          })),
          total: layers?.length ?? 0,
        };
      } catch (err) {
        return {
          project_id: projectId,
          layers: [],
          total: 0,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_board_stackup',
    title: 'Get board stackup',
    description:
      'Get the PCB layer stackup including thickness, material, and dielectric constants.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'board',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      total_layers: z.number().int().nonnegative(),
      board_thickness_mm: z.number().nonnegative().optional(),
      layers: z.array(
        z.object({
          name: z.string(),
          type: z.string(),
          thickness_mm: z.number().nonnegative().optional(),
          material: z.string().optional(),
          dielectric_constant: z.number().nonnegative().optional(),
          copper_weight_oz: z.number().nonnegative().optional(),
        }),
      ),
      data_source: z.enum(['physical_stackup', 'copper_layer_count_only']).optional(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId } = params as { projectId: string };
      try {
        const result = await ctx.bridge.call('board.getStackup', { projectId });
        const data = result as {
          totalLayers?: number;
          boardThicknessMm?: number;
          available?: boolean;
          source?: 'physical_stackup' | 'copper_layer_count_only';
          layers?: Array<{
            name?: string;
            type?: string;
            thicknessMm?: number;
            material?: string;
            dielectricConstant?: number;
            copperWeightOz?: number;
          }>;
        };
        return {
          project_id: projectId,
          total_layers: data.totalLayers ?? data.layers?.length ?? 0,
          board_thickness_mm: data.boardThicknessMm,
          layers: (data.layers ?? []).map((l) => ({
            name: l.name ?? '',
            type: l.type ?? '',
            thickness_mm: l.thicknessMm,
            material: l.material,
            dielectric_constant: l.dielectricConstant,
            copper_weight_oz: l.copperWeightOz,
          })),
          data_source: data.source,
          not_available: data.available === false ? true : undefined,
          error:
            data.available === false
              ? 'Physical PCB stackup details are unavailable; only the copper-layer count was verified.'
              : undefined,
        };
      } catch (err) {
        return {
          project_id: projectId,
          total_layers: 0,
          layers: [],
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_board_dimensions',
    title: 'Get board dimensions',
    description: 'Get the PCB board outline dimensions, shape, and mounting hole information.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'board',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      width_mm: z.number().nonnegative().optional(),
      height_mm: z.number().nonnegative().optional(),
      shape: z.string().optional(),
      mounting_hole_count: z.number().int().nonnegative(),
      area_mm2: z.number().nonnegative().optional(),
      has_outline: z.boolean(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId } = params as { projectId: string };
      try {
        const result = await ctx.bridge.call('board.getDimensions', { projectId });
        const data = result as {
          widthMm?: number;
          heightMm?: number;
          shape?: string;
          mountingHoleCount?: number;
          areaMm2?: number;
          hasOutline?: boolean;
        } | null;
        const hasOutline =
          data?.hasOutline ?? ((data?.widthMm ?? 0) > 0 && (data?.heightMm ?? 0) > 0);
        return {
          project_id: projectId,
          width_mm: data?.widthMm,
          height_mm: data?.heightMm,
          shape: data?.shape,
          mounting_hole_count: data?.mountingHoleCount ?? 0,
          area_mm2: data?.areaMm2,
          has_outline: hasOutline,
          not_available: hasOutline ? undefined : true,
          error: hasOutline ? undefined : 'No board outline was found in the active PCB document.',
        };
      } catch (err) {
        return {
          project_id: projectId,
          mounting_hole_count: 0,
          has_outline: false,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_board_features',
    title: 'Get board features',
    description: 'Get counts of board features including vias, tracks, copper zones, and pads.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'board',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      vias: z.number().int().nonnegative(),
      tracks: z.number().int().nonnegative(),
      zones: z.number().int().nonnegative(),
      pads: z.number().int().nonnegative(),
      components: z.number().int().nonnegative().optional(),
      not_available: z.boolean().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId } = params as { projectId: string };
      try {
        const result = await ctx.bridge.call('board.getFeatures', { projectId });
        const data = result as {
          vias?: number;
          tracks?: number;
          zones?: number;
          pads?: number;
          components?: number;
        } | null;
        return {
          project_id: projectId,
          vias: data?.vias ?? 0,
          tracks: data?.tracks ?? 0,
          zones: data?.zones ?? 0,
          pads: data?.pads ?? 0,
          components: data?.components,
        };
      } catch (err) {
        return {
          project_id: projectId,
          vias: 0,
          tracks: 0,
          zones: 0,
          pads: 0,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

export { registerBoardTools };
