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
      'List all components in the schematic with their properties including reference, value, footprint, LCSC part number, manufacturer, and datasheet.',
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
          reference: z.string(),
          value: z.string(),
          footprint: z.string(),
          lcsc: z.string().optional(),
          manufacturer: z.string().optional(),
          datasheet: z.string().optional(),
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
          reference?: string;
          value?: string;
          footprint?: string;
          lcsc?: string;
          manufacturer?: string;
          datasheet?: string;
        }>;
        return {
          project_id: projectId,
          components: (comps ?? []).map((c) => ({
            reference: c.reference ?? '',
            value: c.value ?? '',
            footprint: c.footprint ?? '',
            lcsc: c.lcsc,
            manufacturer: c.manufacturer,
            datasheet: c.datasheet,
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
      devices: z.array(z.unknown()),
      total: z.number().int().nonnegative(),
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
        const devices = Array.isArray(result) ? result : [];
        return {
          devices,
          total: devices.length,
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
        const pins = Array.isArray(resultObj?.result) ? resultObj!.result : [];
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
          floatingPins?: Array<{ primitiveId?: string; pinNumber?: string }>;
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
