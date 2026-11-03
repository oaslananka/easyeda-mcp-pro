import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';

type BoardFeatureName = 'vias' | 'tracks' | 'zones' | 'fills' | 'regions' | 'pads' | 'components';

type BoardFeatureData = Partial<Record<BoardFeatureName, number>> & {
  unknownFeatures?: string[];
};

const BOARD_FEATURE_NAMES: BoardFeatureName[] = [
  'vias',
  'tracks',
  'zones',
  'fills',
  'regions',
  'pads',
  'components',
];

function listUnknownBoardFeatures(data: BoardFeatureData | null): BoardFeatureName[] {
  if (data?.unknownFeatures) {
    return BOARD_FEATURE_NAMES.filter((name) => data.unknownFeatures?.includes(name));
  }
  return BOARD_FEATURE_NAMES.filter((name) => data?.[name] === undefined);
}

function listUnknownDimensionFields(
  data: {
    drilledPadCount?: number;
    platedDrillPadCount?: number;
    unplatedDrillPadCount?: number;
    minDrillMm?: number;
    unknownFields?: string[];
  } | null,
): string[] {
  const isUnknown = (key: string, value: number | undefined): boolean =>
    data?.unknownFields ? data.unknownFields.includes(key) : value === undefined;
  return [
    'mounting_hole_count',
    ...(isUnknown('drilledPadCount', data?.drilledPadCount) ? ['drilled_pad_count'] : []),
    ...(isUnknown('platedDrillPadCount', data?.platedDrillPadCount)
      ? ['plated_drill_pad_count']
      : []),
    ...(isUnknown('unplatedDrillPadCount', data?.unplatedDrillPadCount)
      ? ['unplated_drill_pad_count']
      : []),
    ...(isUnknown('minDrillMm', data?.minDrillMm) ? ['min_drill_mm'] : []),
  ];
}

interface BoardDimensionsData {
  widthMm?: number;
  heightMm?: number;
  shape?: string;
  drilledPadCount?: number;
  platedDrillPadCount?: number;
  unplatedDrillPadCount?: number;
  minDrillMm?: number;
  unknownFields?: string[];
  areaMm2?: number;
  hasOutline?: boolean;
}

interface BoardDimensionsResult {
  project_id: string;
  width_mm?: number;
  height_mm?: number;
  shape?: string;
  drilled_pad_count?: number;
  plated_drill_pad_count?: number;
  unplated_drill_pad_count?: number;
  min_drill_mm?: number;
  area_mm2?: number;
  has_outline: boolean;
  unknown_fields: string[];
  not_available?: boolean;
  error?: string;
}

function boardHasOutline(data: BoardDimensionsData): boolean {
  if (data.hasOutline !== undefined) return data.hasOutline;
  return (data.widthMm ?? 0) > 0 && (data.heightMm ?? 0) > 0;
}

function mapBoardDimensions(
  projectId: string,
  input: BoardDimensionsData | null,
): BoardDimensionsResult {
  const data = input ?? {};
  const hasOutline = boardHasOutline(data);
  const result: BoardDimensionsResult = {
    project_id: projectId,
    width_mm: data.widthMm,
    height_mm: data.heightMm,
    shape: data.shape,
    drilled_pad_count: data.drilledPadCount,
    plated_drill_pad_count: data.platedDrillPadCount,
    unplated_drill_pad_count: data.unplatedDrillPadCount,
    min_drill_mm: data.minDrillMm,
    area_mm2: data.areaMm2,
    has_outline: hasOutline,
    unknown_fields: listUnknownDimensionFields(data),
  };
  if (!hasOutline) {
    result.not_available = true;
    result.error = 'No board outline was found in the active PCB document.';
  }
  return result;
}

function unavailableBoardDimensions(projectId: string, error: unknown) {
  return {
    project_id: projectId,
    has_outline: false,
    unknown_fields: [
      'mounting_hole_count',
      'drilled_pad_count',
      'plated_drill_pad_count',
      'unplated_drill_pad_count',
      'min_drill_mm',
    ],
    not_available: true,
    error: error instanceof Error ? error.message : String(error),
  };
}

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
    name: 'easyeda_board_design_rules',
    title: 'Get active PCB design rules',
    description:
      'Read the active EasyEDA DRC profile and its global safe-spacing matrix. Net-class membership and per-net overrides are reported separately and are not inferred.',
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
      active_rule_configuration_name: z.string().optional(),
      has_clearance_rules: z.boolean().optional(),
      minimum_clearance_mm: z.number().nonnegative().optional(),
      clearance_rule_count: z.number().int().nonnegative().optional(),
      active_spacing_matrices: z.array(z.string()),
      data_source: z.literal('active_rule_configuration'),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId } = params as { projectId: string };
      try {
        const result = await ctx.bridge.call('board.getDesignRules', { projectId });
        const data = result as {
          available?: boolean;
          activeRuleConfigurationName?: string;
          hasClearanceRules?: boolean;
          minimumClearanceMm?: number;
          clearanceRuleCount?: number;
          activeSpacingMatrices?: string[];
        } | null;
        return {
          project_id: projectId,
          active_rule_configuration_name: data?.activeRuleConfigurationName,
          has_clearance_rules: data?.hasClearanceRules,
          minimum_clearance_mm: data?.minimumClearanceMm,
          clearance_rule_count: data?.clearanceRuleCount,
          active_spacing_matrices: data?.activeSpacingMatrices ?? [],
          data_source: 'active_rule_configuration' as const,
          not_available: data?.available === false ? true : undefined,
        };
      } catch (err) {
        return {
          project_id: projectId,
          active_spacing_matrices: [],
          data_source: 'active_rule_configuration' as const,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_board_dimensions',
    title: 'Get board dimensions',
    description:
      'Get the PCB outline dimensions, native drilled-pad counts and minimum drill diameter. Mounting-hole classification is reported as unknown unless explicit evidence exists.',
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
      mounting_hole_count: z.number().int().nonnegative().optional(),
      drilled_pad_count: z.number().int().nonnegative().optional(),
      plated_drill_pad_count: z.number().int().nonnegative().optional(),
      unplated_drill_pad_count: z.number().int().nonnegative().optional(),
      min_drill_mm: z.number().nonnegative().optional(),
      area_mm2: z.number().nonnegative().optional(),
      has_outline: z.boolean(),
      unknown_fields: z
        .array(
          z.enum([
            'mounting_hole_count',
            'drilled_pad_count',
            'plated_drill_pad_count',
            'unplated_drill_pad_count',
            'min_drill_mm',
          ]),
        )
        .optional(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId } = params as { projectId: string };
      try {
        const result = await ctx.bridge.call('board.getDimensions', { projectId });
        return mapBoardDimensions(projectId, result as BoardDimensionsData | null);
      } catch (error) {
        return unavailableBoardDimensions(projectId, error);
      }
    },
  });

  registry.register({
    name: 'easyeda_board_features',
    title: 'Get board features',
    description:
      'Get counts of board features. zones counts copper Pour boundaries only; native Fill and ' +
      'Region primitives are reported separately as fills and regions.',
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
      vias: z.number().int().nonnegative().optional(),
      tracks: z.number().int().nonnegative().optional(),
      zones: z.number().int().nonnegative().optional(),
      fills: z.number().int().nonnegative().optional(),
      regions: z.number().int().nonnegative().optional(),
      pads: z.number().int().nonnegative().optional(),
      unknown_features: z.array(
        z.enum(['vias', 'tracks', 'zones', 'fills', 'regions', 'pads', 'components']),
      ),
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
          fills?: number;
          regions?: number;
          pads?: number;
          components?: number;
          unknownFeatures?: string[];
        } | null;
        const unknownFeatures = listUnknownBoardFeatures(data);
        return {
          project_id: projectId,
          vias: data?.vias,
          tracks: data?.tracks,
          zones: data?.zones,
          fills: data?.fills,
          regions: data?.regions,
          pads: data?.pads,
          components: data?.components,
          unknown_features: unknownFeatures,
        };
      } catch (err) {
        return {
          project_id: projectId,
          unknown_features: ['vias', 'tracks', 'zones', 'fills', 'regions', 'pads', 'components'],
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

export { registerBoardTools };
