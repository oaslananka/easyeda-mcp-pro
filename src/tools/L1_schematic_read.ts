import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';

const searchDeviceInputSchema = z.object({
  key: z.string(),
  libraryUuid: z.string().optional(),
  classification: z.union([z.string(), z.array(z.string())]).optional(),
  symbolType: z.string().optional(),
  itemsOfPage: z.number().int().default(20),
  page: z.number().int().default(1),
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
      projectId: z.string(),
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
      'List all components in the schematic with their properties including primitive ID, ' +
      'reference, value, footprint, LCSC part number, manufacturer, datasheet, and placement ' +
      '(x/y/rotation). The primitive ID is required by modify_primitive, delete_primitive, and ' +
      'component_pins, which only accept real IDs, not reference designators.',
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
      projectId: z.string(),
      limit: z.number().int().min(1).max(500).default(100),
      offset: z.number().int().min(0).default(0),
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
          datasheet: z.string().optional(),
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
        const comps = result as Array<{
          primitiveId?: string;
          reference?: string;
          value?: string;
          footprint?: string;
          lcsc?: string;
          manufacturer?: string;
          datasheet?: string;
          x?: number;
          y?: number;
          rotation?: number;
        }>;
        return {
          project_id: projectId,
          components: (comps ?? []).map((c) => ({
            primitiveId: c.primitiveId,
            reference: c.reference ?? '',
            value: c.value ?? '',
            footprint: c.footprint ?? '',
            lcsc: c.lcsc,
            manufacturer: c.manufacturer,
            datasheet: c.datasheet,
            x: c.x,
            y: c.y,
            rotation: c.rotation,
          })),
          total: comps?.length ?? 0,
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
      'List wire segments in the schematic with their primitive ID, line coordinates, net ' +
      'name, color, and line style. The primitive ID is required by delete_primitive and ' +
      'modify_primitive, which only accept real IDs — there is no way to resolve a wire to its ' +
      'ID from schematic_nets alone.',
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
      projectId: z.string(),
      limit: z.number().int().min(1).max(50).default(50),
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
      const { projectId, limit } = params as { projectId: string; limit: number };
      try {
        const result = await ctx.bridge.call('system.inspectWires', { limit });
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
      projectId: z.string(),
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
    description: 'Search for schematic symbols/devices in the EasyEDA library by keywords.',
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
      const { key, libraryUuid, classification, symbolType, itemsOfPage, page } =
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
        const devices = Array.isArray(result) ? result.map(normalizeSearchDeviceItem) : [];
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
      'Get exact pin numbers, names, and coordinates for a schematic component by its primitive ID.',
    profile: 'core',
    evidence: ['official-docs', 'runtime-probe'],
    risk: 'low',
    confirmWrite: false,
    group: 'schematic',
    version: '1.0.0',
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
        }),
      ),
      success: z.boolean(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { primitiveId } = params as { primitiveId: string };
      try {
        const result = await ctx.bridge.call<{ path: string; args: unknown[] }, unknown>(
          'api.call',
          {
            path: 'SCH_PrimitiveComponent.getAllPinsByPrimitiveId',
            args: [primitiveId],
          },
        );
        const resultObj = result as { result?: Array<Record<string, unknown>> } | undefined;
        const pins = Array.isArray(resultObj?.result) ? resultObj.result : [];
        return {
          primitiveId,
          pins: pins.map((p: Record<string, unknown>) => {
            const state = p.state as Record<string, unknown> | undefined;
            return {
              pinNumber:
                p.pinNumber !== undefined ? String(p.pinNumber) : String(state?.PinNumber ?? ''),
              pinName: p.pinName !== undefined ? String(p.pinName) : String(state?.PinName ?? ''),
              x: p.x !== undefined ? Number(p.x) : Number(state?.X ?? 0),
              y: p.y !== undefined ? Number(p.y) : Number(state?.Y ?? 0),
              rotation:
                p.rotation !== undefined ? Number(p.rotation) : Number(state?.Rotation ?? 0),
              pinLength:
                p.pinLength !== undefined ? Number(p.pinLength) : Number(state?.PinLength ?? 0),
            };
          }),
          success: true,
        };
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
    name: 'easyeda_schematic_validate_netlist',
    title: 'Validate netlist',
    description:
      'Validate the EasyEDA Pro schematic netlist for connectivity issues. ' +
      'Reports net names, connected component references and pins, floating pins, ' +
      'graphical wires without netlist connectivity, and mismatches between visual wires ' +
      'and actual SCH_Net/SCH_Netlist entries. This is a read-only diagnostic tool.',
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
          warnings?: string[];
        };
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
          valid: data.warnings?.length === 0,
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
