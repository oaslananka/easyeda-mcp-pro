import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';

const deviceItemSchema = z
  .object({
    libraryUuid: z.string(),
    uuid: z.string(),
  })
  .passthrough();

const placeComponentInputSchema = z.object({
  deviceItem: deviceItemSchema,
  x: z.number(),
  y: z.number(),
  subPartName: z.string().optional(),
  rotation: z.number().optional(),
  mirror: z.boolean().optional(),
  addIntoBom: z.boolean().optional(),
  addIntoPcb: z.boolean().optional(),
  confirmWrite: z.literal(true),
});

const addWireInputSchema = z.object({
  points: z.array(
    z.object({
      x: z.number(),
      y: z.number(),
    }),
  ),
  netName: z.string().optional(),
  color: z.string().optional(),
  lineWidth: z.number().optional(),
  lineType: z.string().optional(),
  confirmWrite: z.literal(true),
});

const deletePrimitiveInputSchema = z.object({
  primitiveIds: z.array(z.string()),
  confirmWrite: z.literal(true),
});

const modifyPrimitiveInputSchema = z.object({
  primitiveId: z.string(),
  property: z.record(z.string(), z.unknown()),
  confirmWrite: z.literal(true),
});

function registerSchematicWriteTools(
  registry: { register: (def: ToolDefinition) => void },
  _config: EnvConfig,
) {
  registry.register({
    name: 'easyeda_schematic_place_component',
    title: 'Place schematic component',
    description: 'Place a library component/device on the active schematic sheet.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: placeComponentInputSchema,
    outputSchema: z.object({
      success: z.boolean(),
      component: z.unknown().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = placeComponentInputSchema.parse(params);
      try {
        const result = await ctx.bridge.call('schematic.placeComponent', {
          deviceItem: p.deviceItem,
          x: p.x,
          y: p.y,
          subPartName: p.subPartName,
          rotation: p.rotation,
          mirror: p.mirror,
          addIntoBom: p.addIntoBom,
          addIntoPcb: p.addIntoPcb,
        });
        return {
          success: true,
          component: result,
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
    name: 'easyeda_schematic_add_wire',
    title: 'Add schematic wire',
    description: 'Add a wire segment connecting schematic coordinates/pins.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: addWireInputSchema,
    outputSchema: z.object({
      success: z.boolean(),
      wire: z.unknown().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = addWireInputSchema.parse(params);
      try {
        const result = await ctx.bridge.call('schematic.addWire', {
          points: p.points,
          netName: p.netName,
          color: p.color,
          lineWidth: p.lineWidth,
          lineType: p.lineType,
        });
        return {
          success: true,
          wire: result,
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
    name: 'easyeda_schematic_delete_primitive',
    title: 'Delete schematic primitives',
    description:
      'Delete components, wires, or other drawing objects from the schematic by their primitive UUIDs.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: deletePrimitiveInputSchema,
    outputSchema: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { primitiveIds } = deletePrimitiveInputSchema.parse(params);
      try {
        await ctx.bridge.call('schematic.deletePrimitive', { primitiveIds });
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

  registry.register({
    name: 'easyeda_schematic_modify_primitive',
    title: 'Modify schematic primitive',
    description:
      'Modify properties (value, reference, attributes, etc.) of a schematic component/object.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: modifyPrimitiveInputSchema,
    outputSchema: z.object({
      success: z.boolean(),
      result: z.unknown().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { primitiveId, property } = modifyPrimitiveInputSchema.parse(params);
      try {
        const result = await ctx.bridge.call('schematic.modifyPrimitive', {
          primitiveId,
          property,
        });
        return {
          success: true,
          result,
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
    name: 'easyeda_schematic_create_net_flag',
    title: 'Create net flag',
    description:
      'Create a named schematic net flag at specified coordinates. This controlled write declares real SCH_Net connectivity in the EasyEDA Pro netlist.',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID'),
      netName: z.string().min(1).describe('The net name to assign (e.g. VCC, GND, TEST_NET)'),
      x: z.number().describe('X coordinate on the schematic canvas'),
      y: z.number().describe('Y coordinate on the schematic canvas'),
      rotation: z.number().optional().describe('Rotation in degrees (0, 90, 180, 270)'),
      identification: z
        .enum(['Power', 'Ground', 'AnalogGround', 'ProtectGround'])
        .optional()
        .describe(
          'Power-flag identification. When set, places an EasyEDA power/ground flag symbol of this type. ' +
            'When omitted, places a generic named net label instead.',
        ),
      confirmWrite: z.literal(true),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      netFlag: z
        .object({
          primitiveId: z.string(),
          netName: z.string(),
        })
        .optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as {
        projectId: string;
        netName: string;
        x: number;
        y: number;
        rotation?: number;
        identification?: string;
      };
      try {
        const result = await ctx.bridge.call('schematic.createNetFlag', {
          projectId: p.projectId,
          netName: p.netName,
          x: p.x,
          y: p.y,
          rotation: p.rotation,
          identification: p.identification,
        });
        const data = result as { primitiveId?: string; netName?: string };
        return {
          success: true,
          netFlag: {
            primitiveId: data.primitiveId ?? '',
            netName: data.netName ?? p.netName,
          },
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
    name: 'easyeda_schematic_create_net_port',
    title: 'Create net port',
    description:
      'Place a hierarchical net port (off-sheet connector) on the schematic. ' +
      'Net ports create named connections that span multiple schematic sheets, ' +
      'appearing as real SCH_Net entries in the netlist.',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID'),
      netName: z.string().min(1).describe('The net name for the port (e.g. VCC, GND, DATA_BUS)'),
      x: z.number().describe('X coordinate on the schematic canvas'),
      y: z.number().describe('Y coordinate on the schematic canvas'),
      portType: z
        .enum(['input', 'output', 'bidirectional', 'triState', 'passive'])
        .optional()
        .describe('Electrical type of the port'),
      rotation: z.number().optional().describe('Rotation in degrees (0, 90, 180, 270)'),
      confirmWrite: z.literal(true),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      netPort: z
        .object({
          primitiveId: z.string(),
          netName: z.string(),
        })
        .optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as {
        projectId: string;
        netName: string;
        x: number;
        y: number;
        portType?: string;
        rotation?: number;
      };
      try {
        const result = await ctx.bridge.call('schematic.createNetPort', {
          projectId: p.projectId,
          netName: p.netName,
          x: p.x,
          y: p.y,
          portType: p.portType,
          rotation: p.rotation,
        });
        const data = result as { primitiveId?: string; netName?: string };
        return {
          success: true,
          netPort: {
            primitiveId: data.primitiveId ?? '',
            netName: data.netName ?? p.netName,
          },
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
    name: 'easyeda_schematic_connect_pin_to_net',
    title: 'Connect pin to net',
    description:
      'Connect a specific component pin to a named net. This creates an actual SCH_Netlist entry ' +
      'associating the pin with the net. If the net does not exist yet, it is created on the fly. ' +
      'This is the core tool for populating the real EasyEDA netlist with pin-to-net connectivity.',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID'),
      primitiveId: z.string().describe('The primitive ID of the component'),
      pinNumber: z
        .string()
        .describe('The pin number or pin name on the component (e.g. "1", "VCC", "GND")'),
      netName: z
        .string()
        .min(1)
        .describe('The net name to connect the pin to (e.g. VCC, GND, DATA0)'),
      confirmWrite: z.literal(true),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      connection: z
        .object({
          primitiveId: z.string(),
          pinNumber: z.string(),
          netName: z.string(),
        })
        .optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as {
        projectId: string;
        primitiveId: string;
        pinNumber: string;
        netName: string;
      };
      try {
        const result = await ctx.bridge.call('schematic.connectPinToNet', {
          projectId: p.projectId,
          primitiveId: p.primitiveId,
          pinNumber: p.pinNumber,
          netName: p.netName,
        });
        const data = result as { connected?: boolean };
        return {
          success: data?.connected !== false,
          connection: {
            primitiveId: p.primitiveId,
            pinNumber: p.pinNumber,
            netName: p.netName,
          },
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
    name: 'easyeda_schematic_connect_pins_by_net',
    title: 'Connect pins by net',
    description:
      'Connect multiple component pins to a named net in a single operation. ' +
      'All specified pins will be assigned to the same net, creating SCH_Netlist entries. ' +
      'If the net does not exist, it is created. This is the bulk equivalent of connect_pin_to_net.',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID'),
      netName: z.string().min(1).describe('The net name to assign pins to'),
      pins: z
        .array(
          z.object({
            primitiveId: z.string().describe('The primitive ID of the component'),
            pinNumber: z.string().describe('The pin number or name'),
          }),
        )
        .min(1)
        .max(500)
        .describe('List of component pins to connect to the net'),
      confirmWrite: z.literal(true),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      connections: z
        .array(
          z.object({
            primitiveId: z.string(),
            pinNumber: z.string(),
            netName: z.string(),
          }),
        )
        .optional(),
      count: z.number().int().nonnegative(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as {
        projectId: string;
        netName: string;
        pins: Array<{ primitiveId: string; pinNumber: string }>;
      };
      try {
        const result = await ctx.bridge.call('schematic.connectPinsByNet', {
          projectId: p.projectId,
          netName: p.netName,
          pins: p.pins,
        });
        const data = result as { count?: number };
        const count = data?.count ?? p.pins.length;

        return {
          success: true,
          connections: p.pins.map((pin) => ({
            primitiveId: pin.primitiveId,
            pinNumber: pin.pinNumber,
            netName: p.netName,
          })),
          count,
        };
      } catch (err) {
        return {
          success: false,
          count: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_project_save',
    title: 'Save project',
    description:
      'Explicitly save the current EasyEDA Pro project. This ensures all netlist changes, ' +
      'net flags, pin connections, and other mutations are persisted to the project file. ' +
      'Save is never implicit — the caller must explicitly request it. Requires confirmWrite.',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: z.object({
      projectId: z.string().describe('The project/schematic ID to save'),
      confirmWrite: z.literal(true),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      project_id: z.string(),
      saved_at: z.string().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId } = params as { projectId: string };
      try {
        const result = await ctx.bridge.call('project.save', { projectId });
        const data = result as { savedAt?: string };
        return {
          success: true,
          project_id: projectId,
          saved_at: data.savedAt ?? new Date().toISOString(),
        };
      } catch (err) {
        return {
          success: false,
          project_id: projectId,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

export { registerSchematicWriteTools };
