import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';
import { fetchComponentPins } from './schematic-helpers.js';
import { scanSheetForPinCollisions } from '../workflows/collision.js';
import { planSafeSchematicRegion } from '../workflows/schematic-safe-region.js';

const schematicRegionPreferenceSchema = z.enum([
  'upper-left',
  'upper-center',
  'upper-right',
  'center-left',
  'center',
  'center-right',
  'lower-left',
  'lower-center',
  'lower-right',
]);

const searchDeviceInputSchema = z.object({
  key: z
    .string()
    .describe('Search keyword(s), matched against device name/description in the library'),
  libraryUuid: z.string().optional(),
  classification: z.union([z.string(), z.array(z.string())]).optional(),
  symbolType: z.string().optional(),
  itemsOfPage: z.number().int().default(20),
  page: z.number().int().default(1),
  minimal: z
    .boolean()
    .optional()
    .describe(
      'When true, return only uuid/libraryUuid/name/pin_count/symbol_type per device instead of ' +
        'the full library metadata object — use this when the goal is just picking a deviceItem ' +
        'for place_component, to avoid paying for fields you will not read.',
    ),
});

const _deviceItemSchema = z
  .object({
    libraryUuid: z.string(),
    uuid: z.string(),
  })
  .passthrough();

type SearchDeviceItem = Record<string, unknown>;

const searchDevicePinCountKeys = [
  'pin_count',
  'pinCount',
  'pinsCount',
  'pinNumber',
  'pin_num',
  'pinNum',
  'PinCount',
] as const;

const searchDevicePinArrayKeys = ['pins', 'pinList', 'pin_list', 'symbolPins'] as const;

const searchDeviceSymbolTypeKeys = [
  'symbol_type',
  'symbolType',
  'type',
  'deviceType',
  'symbol_type_name',
  'SymbolType',
] as const;

function searchDeviceStringMetadata(
  item: SearchDeviceItem,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function searchDeviceNumberMetadata(
  item: SearchDeviceItem,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      if (Number.isInteger(parsed) && parsed >= 0) return parsed;
    }
  }
  return undefined;
}

function searchDeviceArrayLengthMetadata(
  item: SearchDeviceItem,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = item[key];
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
}

const searchDeviceNameKeys = ['name', 'title', 'deviceName', 'symbolName', 'className'] as const;

function normalizeSearchDeviceItem(item: unknown): SearchDeviceItem {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { raw: item };

  const normalized: SearchDeviceItem = { ...(item as SearchDeviceItem) };
  const pinCount =
    searchDeviceNumberMetadata(normalized, searchDevicePinCountKeys) ??
    searchDeviceArrayLengthMetadata(normalized, searchDevicePinArrayKeys);
  if (pinCount !== undefined) normalized.pin_count = pinCount;

  const symbolType = searchDeviceStringMetadata(normalized, searchDeviceSymbolTypeKeys);
  if (symbolType) normalized.symbol_type = symbolType;

  return normalized;
}

/** Projects a normalized device item down to just enough to pick a deviceItem for
 *  place_component — see the `minimal` input flag. */
function minimalSearchDeviceItem(item: SearchDeviceItem): SearchDeviceItem {
  const minimal: SearchDeviceItem = {};
  if (typeof item.uuid === 'string') minimal.uuid = item.uuid;
  if (typeof item.libraryUuid === 'string') minimal.libraryUuid = item.libraryUuid;
  const name = searchDeviceStringMetadata(item, searchDeviceNameKeys);
  if (name) minimal.name = name;
  if (item.pin_count !== undefined) minimal.pin_count = item.pin_count;
  if (item.symbol_type !== undefined) minimal.symbol_type = item.symbol_type;
  return minimal;
}

function registerSchematicReadTools(
  registry: { register: (def: ToolDefinition) => void },
  _config: EnvConfig,
) {
  registry.register({
    name: 'easyeda_schematic_nets',
    title: 'List schematic nets',
    description: 'List all nets in the schematic with their node connections.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID'),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      nets: z.array(
        z.object({
          net_name: z.string(),
          node_count: z.number().int().nonnegative(),
          nodes: z.array(
            z.object({
              component_ref: z.string(),
              pin: z.string(),
            }),
          ),
        }),
      ),
      total: z.number().int().nonnegative(),
      not_available: z.boolean().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId } = params as { projectId: string };
      try {
        const result = await ctx.bridge.call('schematic.listNets', { projectId });
        const nets = result as Array<{
          netName?: string;
          nodes?: Array<{ component?: string; pin?: string }>;
        }>;
        return {
          project_id: projectId,
          nets: (nets ?? []).map((n) => ({
            net_name: n.netName ?? '',
            node_count: n.nodes?.length ?? 0,
            nodes: (n.nodes ?? []).map((nd) => ({
              component_ref: nd.component ?? '',
              pin: nd.pin ?? '',
            })),
          })),
          total: nets?.length ?? 0,
        };
      } catch (err) {
        return {
          project_id: projectId,
          nets: [],
          total: 0,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_components',
    title: 'List schematic components',
    description:
      'List schematic components: primitiveId, reference, value, footprint, x/y/rotation, and ' +
      'device identity for cloning — deviceUuid+deviceLibraryUuid (a place_component deviceItem ' +
      'in this project), deviceName, symbolName, lcsc, manufacturerId.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID'),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      components: z.array(
        z.object({
          primitiveId: z.string().optional(),
          reference: z.string(),
          value: z.string(),
          footprint: z.string(),
          lcsc: z.string().optional(),
          manufacturer: z.string().optional(),
          manufacturerId: z.string().optional(),
          datasheet: z.string().optional(),
          deviceUuid: z.string().optional(),
          deviceLibraryUuid: z.string().optional(),
          deviceName: z.string().optional(),
          symbolName: z.string().optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          rotation: z.number().optional(),
        }),
      ),
      total: z.number().int().nonnegative(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, limit, offset } = params as {
        projectId: string;
        limit: number;
        offset: number;
      };
      try {
        const result = await ctx.bridge.call('schematic.listComponents', {
          projectId,
          limit,
          offset,
        });
        const { total: bridgeTotal, items } = result as {
          total?: number;
          items?: Array<{
            primitiveId?: string;
            reference?: string;
            value?: string;
            footprint?: string;
            lcsc?: string;
            manufacturer?: string;
            manufacturerId?: string;
            datasheet?: string;
            deviceUuid?: string;
            deviceLibraryUuid?: string;
            deviceName?: string;
            symbolName?: string;
            x?: number;
            y?: number;
            rotation?: number;
          }>;
        };
        const comps = items ?? [];
        return {
          project_id: projectId,
          components: comps.map((c) => ({
            primitiveId: c.primitiveId,
            reference: c.reference ?? '',
            value: c.value ?? '',
            footprint: c.footprint ?? '',
            lcsc: c.lcsc,
            manufacturer: c.manufacturer,
            manufacturerId: c.manufacturerId,
            datasheet: c.datasheet,
            deviceUuid: c.deviceUuid,
            deviceLibraryUuid: c.deviceLibraryUuid,
            deviceName: c.deviceName,
            symbolName: c.symbolName,
            x: c.x,
            y: c.y,
            rotation: c.rotation,
          })),
          total: bridgeTotal ?? comps.length,
        };
      } catch (err) {
        return {
          project_id: projectId,
          components: [],
          total: 0,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_wires',
    title: 'List schematic wires',
    description:
      'List wire segments: primitiveId, line coordinates, net name, color, style. Page with ' +
      'offset (check total) past the 50-wire-per-call cap. primitiveId is required by ' +
      'delete_primitive/modify_primitive — schematic_nets alone cannot resolve a wire ID.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID'),
      limit: z.coerce.number().int().min(1).max(50).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      wires: z.array(
        z.object({
          primitiveId: z.string().optional(),
          line: z.unknown().optional(),
          net: z.string().optional(),
          color: z.string().nullable().optional(),
          lineWidth: z.number().nullable().optional(),
          lineType: z.unknown().optional(),
        }),
      ),
      total: z.number().int().nonnegative(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, limit, offset } = params as {
        projectId: string;
        limit: number;
        offset: number;
      };
      try {
        const result = await ctx.bridge.call('system.inspectWires', { limit, offset });
        const data = result as {
          total?: number;
          samples?: Array<{
            primitiveId?: string;
            line?: unknown;
            net?: string;
            color?: string | null;
            lineWidth?: number | null;
            lineType?: unknown;
          }>;
        };
        return {
          project_id: projectId,
          wires: (data.samples ?? []).map((w) => ({
            primitiveId: w.primitiveId,
            line: w.line,
            net: w.net,
            color: w.color,
            lineWidth: w.lineWidth,
            lineType: w.lineType,
          })),
          total: data.total ?? data.samples?.length ?? 0,
        };
      } catch (err) {
        return {
          project_id: projectId,
          wires: [],
          total: 0,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_net_detail',
    title: 'Get schematic net detail',
    description:
      'Get full details for a specific net in the schematic including all connected pins and components.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID'),
      netName: z.string(),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      net_name: z.string(),
      node_count: z.number().int().nonnegative(),
      nodes: z.array(
        z.object({
          component_ref: z.string(),
          pin: z.string(),
        }),
      ),
      not_available: z.boolean().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, netName } = params as { projectId: string; netName: string };
      try {
        const result = await ctx.bridge.call('schematic.getNetDetail', { projectId, netName });
        const net = result as {
          netName?: string;
          nodes?: Array<{ component?: string; pin?: string }>;
        };
        if (!net) {
          return {
            project_id: projectId,
            net_name: netName,
            node_count: 0,
            nodes: [],
            not_available: true,
          };
        }
        return {
          project_id: projectId,
          net_name: net.netName ?? netName,
          node_count: net.nodes?.length ?? 0,
          nodes: (net.nodes ?? []).map((nd) => ({
            component_ref: nd.component ?? '',
            pin: nd.pin ?? '',
          })),
        };
      } catch (err) {
        return {
          project_id: projectId,
          net_name: netName,
          node_count: 0,
          nodes: [],
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_search_device',
    title: 'Search library device',
    description:
      'Search for schematic symbols/devices in the EasyEDA library by keywords. Full results ' +
      "carry the library's complete metadata object per device; pass minimal:true to get back " +
      'only uuid/libraryUuid/name/pin_count/symbol_type when that is all you need.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: searchDeviceInputSchema,
    outputSchema: z.object({
      devices: z.array(
        z
          .object({
            pin_count: z.number().int().nonnegative().optional(),
            symbol_type: z.string().optional(),
          })
          .passthrough(),
      ),
      total: z.number().int().nonnegative(),
      /** Where the result came from. Always 'local_library' — this tool queries the
       *  active EasyEDA Pro session's device library, not vendor/supplier catalogs. */
      provider_tier: z.literal('local_library').optional(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { key, libraryUuid, classification, symbolType, itemsOfPage, page, minimal } =
        searchDeviceInputSchema.parse(params);
      try {
        const result = await ctx.bridge.call('schematic.searchDevice', {
          key,
          libraryUuid,
          classification,
          symbolType,
          itemsOfPage,
          page,
        });
        const normalized = Array.isArray(result) ? result.map(normalizeSearchDeviceItem) : [];
        const devices = minimal ? normalized.map(minimalSearchDeviceItem) : normalized;
        return {
          devices,
          total: devices.length,
          provider_tier: 'local_library' as const,
        };
      } catch (err) {
        return {
          devices: [],
          total: 0,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_sheet_info',
    title: 'Get schematic sheet info',
    description:
      'Return read-only active schematic sheet metadata including page size, frame, origin, and grid hints for safer component placement.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().optional(),
    }),
    outputSchema: z.object({
      project_id: z.string().optional(),
      sheet: z.unknown().optional(),
      page_size: z
        .object({
          width: z.number().optional(),
          height: z.number().optional(),
          unit: z.string().optional(),
        })
        .optional(),
      frame: z.unknown().optional(),
      origin: z.unknown().optional(),
      grid: z.unknown().optional(),
      raw: z.unknown().optional(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId } = z.object({ projectId: z.string().optional() }).parse(params ?? {});
      try {
        const result = await ctx.bridge.call('schematic.getSheetInfo', { projectId });
        const root =
          result && typeof result === 'object' && !Array.isArray(result)
            ? (result as Record<string, unknown>)
            : {};
        const current =
          root.currentPage &&
          typeof root.currentPage === 'object' &&
          !Array.isArray(root.currentPage)
            ? (root.currentPage as Record<string, unknown>)
            : root;
        const readNumber = (keys: string[]): number | undefined => {
          for (const key of keys) {
            const value = current[key] ?? root[key];
            if (typeof value === 'number' && Number.isFinite(value)) return value;
            if (typeof value === 'string') {
              const parsed = Number(value.trim());
              if (Number.isFinite(parsed)) return parsed;
            }
          }
          return undefined;
        };
        const readString = (keys: string[]): string | undefined => {
          for (const key of keys) {
            const value = current[key] ?? root[key];
            if (typeof value === 'string' && value.trim()) return value;
          }
          return undefined;
        };
        return {
          project_id: projectId,
          sheet: current,
          page_size: {
            width: readNumber(['width', 'pageWidth', 'paperWidth', 'w']),
            height: readNumber(['height', 'pageHeight', 'paperHeight', 'h']),
            unit: readString(['unit', 'units', 'pageUnit']),
          },
          frame: current.frame ?? current.titleBlock ?? root.frame,
          origin: current.origin ?? current.canvasOrigin ?? root.origin,
          grid: current.grid ?? current.gridSize ?? root.grid,
          raw: result,
        };
      } catch (err) {
        return {
          project_id: projectId,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_plan_safe_region',
    title: 'Plan safe schematic drawing region',
    description:
      'Compute a safe schematic drawing region before placing components. Uses live sheet info when available, assumes EasyEDA bottom-left coordinates, reserves the default lower-right title-block keep-out, and returns an anchor/bounds plan that avoids title-block overlap.',
    profile: 'core',
    evidence: ['runtime-probe', 'inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().optional(),
      contentWidth: z
        .number()
        .positive()
        .describe('Estimated width of the planned circuit block in EasyEDA coordinates'),
      contentHeight: z
        .number()
        .positive()
        .describe('Estimated height of the planned circuit block in EasyEDA coordinates'),
      preferredRegion: schematicRegionPreferenceSchema.default('upper-left'),
      margin: z.number().positive().optional(),
      titleBlockKeepout: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number().positive(),
          height: z.number().positive(),
        })
        .optional()
        .describe(
          'Optional explicit title-block keep-out rectangle when the sheet template is known',
        ),
    }),
    outputSchema: z.object({
      project_id: z.string().optional(),
      blocked: z.boolean(),
      preferred_region: z.string(),
      sheet: z.object({
        width: z.number(),
        height: z.number(),
        unit: z.string(),
        origin: z.string(),
        source: z.string(),
      }),
      usable_bounds: z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      }),
      requested_bounds: z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      }),
      bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
      anchor: z.object({ x: z.number(), y: z.number() }),
      keepouts: z.array(
        z.object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
          kind: z.string(),
        }),
      ),
      warnings: z.array(z.string()),
      issues: z.array(z.object({ code: z.string(), message: z.string() })),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = z
        .object({
          projectId: z.string().optional(),
          contentWidth: z.number().positive(),
          contentHeight: z.number().positive(),
          preferredRegion: schematicRegionPreferenceSchema.default('upper-left'),
          margin: z.number().positive().optional(),
          titleBlockKeepout: z
            .object({
              x: z.number(),
              y: z.number(),
              width: z.number().positive(),
              height: z.number().positive(),
            })
            .optional(),
        })
        .parse(params ?? {});
      let sheetInfo: unknown;
      try {
        sheetInfo = await ctx.bridge.call('schematic.getSheetInfo', { projectId: p.projectId });
      } catch {
        // Degrade to the conservative A4 default rather than blocking preview
        // planning, because this tool is often used before a live sheet is fully ready.
        sheetInfo = undefined;
      }
      const plan = planSafeSchematicRegion({
        sheetInfo,
        contentWidth: p.contentWidth,
        contentHeight: p.contentHeight,
        preferredRegion: p.preferredRegion,
        margin: p.margin,
        titleBlockKeepout: p.titleBlockKeepout,
      });
      return {
        project_id: p.projectId,
        blocked: plan.blocked,
        preferred_region: plan.preferredRegion,
        sheet: plan.sheet,
        usable_bounds: plan.usableBounds,
        requested_bounds: plan.requestedBounds,
        bounds: plan.bounds,
        anchor: plan.anchor,
        keepouts: plan.keepouts,
        warnings: plan.warnings,
        issues: plan.issues,
      };
    },
  });

  registry.register({
    name: 'easyeda_schematic_verify_write',
    title: 'Verify schematic write result',
    description:
      'Read back schematic state after an agent-authored write. Returns component-count delta evidence and optional netlist validation so agents can confirm a placement or connection before continuing.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().optional(),
      netName: z.string().optional(),
      beforeComponentCount: z.number().int().nonnegative().optional(),
      expectedComponentCountDelta: z.number().int().optional(),
      includeWireCheck: z.boolean().optional(),
    }),
    outputSchema: z.object({
      project_id: z.string().optional(),
      net_name: z.string().optional(),
      components_available: z.boolean(),
      component_count: z.number().int().nonnegative().optional(),
      component_count_delta: z.number().int().optional(),
      component_delta_matches: z.boolean().optional(),
      netlist_available: z.boolean(),
      netlist_validation: z.unknown().optional(),
      warnings: z.array(z.string()),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = z
        .object({
          projectId: z.string().optional(),
          netName: z.string().optional(),
          beforeComponentCount: z.number().int().nonnegative().optional(),
          expectedComponentCountDelta: z.number().int().optional(),
          includeWireCheck: z.boolean().optional(),
        })
        .parse(params ?? {});
      const warnings: string[] = [];
      let componentCount: number | undefined;
      let componentCountDelta: number | undefined;
      let componentDeltaMatches: boolean | undefined;
      let componentsAvailable = false;
      let netlistAvailable = false;
      let netlistValidation: unknown;

      try {
        const components = await ctx.bridge.call('schematic.listComponents', {
          projectId: p.projectId,
          limit: 500,
          offset: 0,
        });
        if (Array.isArray(components)) {
          componentsAvailable = true;
          componentCount = components.length;
          if (p.beforeComponentCount !== undefined) {
            componentCountDelta = componentCount - p.beforeComponentCount;
            if (p.expectedComponentCountDelta !== undefined) {
              componentDeltaMatches = componentCountDelta === p.expectedComponentCountDelta;
              if (!componentDeltaMatches) {
                warnings.push(
                  `Expected component-count delta ${p.expectedComponentCountDelta}, got ${componentCountDelta}.`,
                );
              }
            }
          }
        } else {
          warnings.push('Component read-back returned a non-array response.');
        }
      } catch (err) {
        warnings.push(
          `Component read-back unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      try {
        netlistValidation = await ctx.bridge.call('schematic.validateNetlist', {
          projectId: p.projectId,
          netName: p.netName,
          includeWireCheck: p.includeWireCheck ?? false,
        });
        netlistAvailable = true;
      } catch (err) {
        warnings.push(
          `Netlist validation unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return {
        project_id: p.projectId,
        net_name: p.netName,
        components_available: componentsAvailable,
        component_count: componentCount,
        component_count_delta: componentCountDelta,
        component_delta_matches: componentDeltaMatches,
        netlist_available: netlistAvailable,
        netlist_validation: netlistValidation,
        warnings,
      };
    },
  });
  registry.register({
    name: 'easyeda_schematic_component_pins',
    title: 'Get component pins',
    description:
      'Get exact pin numbers, names, coordinates, and native pinType for a schematic component ' +
      "by its primitive ID. pinType is EasyEDA's own symbol-library field and is unreliably " +
      'authored (often "Undefined" even on real ICs) — treat it as a weak hint, not ground truth.',
    profile: 'core',
    evidence: ['official-docs', 'runtime-probe'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.1.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      primitiveId: z.string(),
    }),
    outputSchema: z.object({
      primitiveId: z.string(),
      pins: z.array(
        z.object({
          pinNumber: z.string(),
          pinName: z.string(),
          x: z.number(),
          y: z.number(),
          rotation: z.number(),
          pinLength: z.number(),
          pinType: z.string().optional(),
        }),
      ),
      success: z.boolean(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { primitiveId } = params as { primitiveId: string };
      try {
        const pins = await fetchComponentPins(ctx, primitiveId);
        return { primitiveId, pins, success: true };
      } catch (err) {
        return {
          primitiveId,
          pins: [],
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_check_collisions',
    title: 'Check for pin-coordinate collisions across the sheet',
    description:
      "Scan every component's real pin coordinates and report any (x,y) shared by two or more " +
      'components — a silent-short risk the native NET_COLLISION guard misses for never-wired ' +
      'pins. Run after manual placement outside easyeda_workflow_* tools (which reconcile this ' +
      'automatically).',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID'),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      collisions: z.array(
        z.object({
          x: z.number(),
          y: z.number(),
          pins: z.array(
            z.object({
              primitiveId: z.string(),
              pinNumber: z.string(),
              pinName: z.string(),
            }),
          ),
        }),
      ),
      collision_count: z.number().int().nonnegative(),
      success: z.boolean(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId } = params as { projectId: string };
      try {
        const collisions = await scanSheetForPinCollisions(ctx, projectId);
        return {
          project_id: projectId,
          collisions,
          collision_count: collisions.length,
          success: true,
        };
      } catch (err) {
        return {
          project_id: projectId,
          collisions: [],
          collision_count: 0,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_validate_netlist',
    title: 'Validate netlist',
    description:
      'Validate the schematic netlist: inferred nets, connected refs/pins, floating pins, plus a ' +
      'cross-check with native ERC (native_erc). `valid` needs BOTH the inference clean AND ' +
      'native ERC 0 errors — inference alone false-positives when pins overlap without a wire.',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID'),
      includeWireCheck: z
        .boolean()
        .default(false)
        .describe('When true, also check for graphical wires without netlist connectivity'),
    }),
    outputSchema: z.object({
      project_id: z.string(),
      netlist: z.array(
        z.object({
          net_name: z.string(),
          connected_refs: z.array(z.string()),
          connected_pins: z.array(z.string()),
          has_net_flag: z.boolean(),
        }),
      ),
      total_nets: z.number().int().nonnegative(),
      floating_pins: z.array(
        z.object({
          primitiveId: z.string(),
          designator: z.string().optional(),
          pinNumber: z.string(),
        }),
      ),
      wires_without_netlist: z
        .array(
          z.object({
            wireId: z.string(),
            netName: z.string().optional(),
          }),
        )
        .optional(),
      native_erc: z
        .object({
          error_count: z.number().int().nonnegative(),
          warning_count: z.number().int().nonnegative(),
          passed: z.boolean(),
        })
        .optional(),
      valid: z.boolean(),
      warnings: z.array(z.string()),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, includeWireCheck } = params as {
        projectId: string;
        includeWireCheck: boolean;
      };
      try {
        const result = await ctx.bridge.call('schematic.validateNetlist', {
          projectId,
          includeWireCheck,
        });
        const data = result as {
          nets?: Array<{
            netName?: string;
            refs?: string[];
            pins?: string[];
            hasNetFlag?: boolean;
          }>;
          floatingPins?: Array<{ primitiveId?: string; designator?: string; pinNumber?: string }>;
          wiresWithoutNetlist?: Array<{ wireId?: string; netName?: string }>;
          nativeErc?: { errorCount?: number; warningCount?: number; passed?: boolean };
          warnings?: string[];
        };
        const nativeErcPassed = data.nativeErc?.passed ?? true;
        return {
          project_id: projectId,
          netlist: (data.nets ?? []).map((n) => ({
            net_name: n.netName ?? '',
            connected_refs: n.refs ?? [],
            connected_pins: n.pins ?? [],
            has_net_flag: n.hasNetFlag ?? false,
          })),
          total_nets: data.nets?.length ?? 0,
          floating_pins: (data.floatingPins ?? []).map((fp) => ({
            primitiveId: fp.primitiveId ?? '',
            designator: fp.designator,
            pinNumber: fp.pinNumber ?? '',
          })),
          wires_without_netlist: data.wiresWithoutNetlist
            ? data.wiresWithoutNetlist.map((w) => ({
                wireId: w.wireId ?? '',
                netName: w.netName,
              }))
            : undefined,
          native_erc: data.nativeErc
            ? {
                error_count: data.nativeErc.errorCount ?? 0,
                warning_count: data.nativeErc.warningCount ?? 0,
                passed: data.nativeErc.passed ?? false,
              }
            : undefined,
          // Authoritative: only valid when the inference is clean AND EasyEDA's
          // native ERC reports zero errors (overlapping-but-unwired pins pass
          // the inference but fail native ERC).
          valid: data.warnings?.length === 0 && nativeErcPassed,
          warnings: data.warnings ?? [],
        };
      } catch (err) {
        return {
          project_id: projectId,
          netlist: [],
          total_nets: 0,
          floating_pins: [],
          valid: false,
          warnings: [],
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

export { registerSchematicReadTools };
