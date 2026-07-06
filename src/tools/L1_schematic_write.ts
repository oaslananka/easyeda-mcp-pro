import { z } from 'zod';
import { type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';

const deviceItemSchema = z
  .object({
    libraryUuid: z.string(),
    uuid: z.string(),
  })
  .passthrough();

type SchematicComponentSnapshot = Record<string, unknown>;

type PlacementGuardResult = {
  collision_checked: boolean;
  collision_radius: number;
  warnings: string[];
  nearby_components: SchematicComponentSnapshot[];
};

function schematicWriteNumberField(
  item: SchematicComponentSnapshot,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function schematicWriteComponentPoint(
  item: SchematicComponentSnapshot,
): { x: number; y: number } | undefined {
  const directX = schematicWriteNumberField(item, ['x', 'X', 'canvasX', 'positionX']);
  const directY = schematicWriteNumberField(item, ['y', 'Y', 'canvasY', 'positionY']);
  if (directX !== undefined && directY !== undefined) return { x: directX, y: directY };

  const position = item.position;
  if (position && typeof position === 'object' && !Array.isArray(position)) {
    const pos = position as SchematicComponentSnapshot;
    const x = schematicWriteNumberField(pos, ['x', 'X']);
    const y = schematicWriteNumberField(pos, ['y', 'Y']);
    if (x !== undefined && y !== undefined) return { x, y };
  }

  const bbox = item.bbox ?? item.boundingBox;
  if (bbox && typeof bbox === 'object' && !Array.isArray(bbox)) {
    const box = bbox as SchematicComponentSnapshot;
    const x1 = schematicWriteNumberField(box, ['x', 'left', 'minX']);
    const y1 = schematicWriteNumberField(box, ['y', 'top', 'minY']);
    const x2 = schematicWriteNumberField(box, ['x2', 'right', 'maxX']);
    const y2 = schematicWriteNumberField(box, ['y2', 'bottom', 'maxY']);
    if (x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined) {
      return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
    }
  }

  return undefined;
}

function schematicWritePlacementGuard(
  components: SchematicComponentSnapshot[] | undefined,
  x: number,
  y: number,
  collisionRadius: number,
): PlacementGuardResult {
  const nearby: SchematicComponentSnapshot[] = [];
  for (const component of components ?? []) {
    const point = schematicWriteComponentPoint(component);
    if (!point) continue;
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance <= collisionRadius) nearby.push({ ...component, distance });
  }

  return {
    collision_checked: true,
    collision_radius: collisionRadius,
    warnings:
      nearby.length > 0
        ? [
            `Placement is within ${collisionRadius} schematic units of ${nearby.length} existing component(s). Review before applying.`,
          ]
        : [],
    nearby_components: nearby,
  };
}

async function readSchematicComponentsForVerification(
  ctx: ToolContext,
): Promise<SchematicComponentSnapshot[] | undefined> {
  try {
    const result = await ctx.bridge.call('schematic.listComponents', {
      projectId: 'active',
      limit: 500,
      offset: 0,
    });
    return Array.isArray(result) ? (result as SchematicComponentSnapshot[]) : undefined;
  } catch {
    return undefined;
  }
}

const placeComponentInputSchema = z.object({
  deviceItem: deviceItemSchema,
  x: z.number(),
  y: z.number(),
  subPartName: z.string().optional(),
  rotation: z.number().optional(),
  mirror: z.boolean().optional(),
  addIntoBom: z.boolean().optional(),
  addIntoPcb: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  verifyAfterWrite: z.boolean().optional(),
  checkPlacementCollision: z.boolean().optional(),
  collisionRadius: z.number().positive().optional(),
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
      dry_run: z.boolean().optional(),
      placement_guard: z.unknown().optional(),
      verification: z.unknown().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = placeComponentInputSchema.parse(params);
      try {
        const shouldReadBefore = Boolean(
          p.dryRun || p.verifyAfterWrite || p.checkPlacementCollision,
        );
        const beforeComponents = shouldReadBefore
          ? await readSchematicComponentsForVerification(ctx)
          : undefined;
        const collisionRadius = p.collisionRadius ?? 25;
        const placementGuard = p.checkPlacementCollision
          ? schematicWritePlacementGuard(beforeComponents, p.x, p.y, collisionRadius)
          : undefined;

        if (p.dryRun) {
          return {
            success: true,
            dry_run: true,
            placement_guard: placementGuard,
            verification: {
              applied: false,
              before_component_count: beforeComponents?.length,
              requested: {
                deviceItem: p.deviceItem,
                x: p.x,
                y: p.y,
                rotation: p.rotation,
                mirror: p.mirror,
                subPartName: p.subPartName,
              },
            },
          };
        }

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

        if (!p.verifyAfterWrite && !placementGuard) {
          return {
            success: true,
            component: result,
          };
        }

        const afterComponents = p.verifyAfterWrite
          ? await readSchematicComponentsForVerification(ctx)
          : undefined;
        return {
          success: true,
          component: result,
          placement_guard: placementGuard,
          verification: p.verifyAfterWrite
            ? {
                applied: true,
                before_component_count: beforeComponents?.length,
                after_component_count: afterComponents?.length,
                component_count_delta:
                  beforeComponents && afterComponents
                    ? afterComponents.length - beforeComponents.length
                    : undefined,
                readback_available: Boolean(afterComponents),
              }
            : undefined,
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
    description:
      'Add a wire segment connecting schematic coordinates/pins. This is the tool that creates ' +
      'real, native EasyEDA electrical connectivity (unlike connect_pin_to_net). Fails with a ' +
      'NET_COLLISION error if the requested path would touch a coordinate already used by a ' +
      'different net, since EasyEDA auto-merges wires sharing a coordinate and that would ' +
      'silently short the two nets together.',
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
      'Modify properties (value, reference, attributes, etc.) of a schematic component/object. ' +
      'Only the fields you pass in `property` are changed — the current value of every other ' +
      'field (designator, manufacturer, supplier, otherProperty, etc.) is read back first and ' +
      'preserved, so a partial update will not wipe unrelated properties.',
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
    title: 'Connect pin to net (logical, non-authoritative)',
    description:
      'Records a logical association between a component pin and a net name as a custom pin ' +
      'property. This does NOT create real EasyEDA netlist/wire connectivity — it is invisible ' +
      'to ERC, ratsnest, and autorouting, and only self-consistent with schematic_nets/' +
      'validate_netlist (which read the same custom property). To create genuine electrical ' +
      'connectivity, use easyeda_schematic_add_wire instead. Use this tool only for bookkeeping ' +
      'that does not need to survive real netlist operations.',
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
      real: z.boolean().optional(),
      warning: z.string().optional(),
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
        const data = result as { connected?: boolean; real?: boolean; warning?: string };
        return {
          success: data?.connected !== false,
          real: data?.real,
          warning: data?.warning,
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
    title: 'Connect pins by net (logical, non-authoritative)',
    description:
      'Records logical pin/net associations as custom pin properties for multiple pins in one ' +
      'call. Like connect_pin_to_net, this does NOT create real EasyEDA netlist/wire ' +
      'connectivity — it is invisible to ERC, ratsnest, and autorouting. To create genuine ' +
      'electrical connectivity, use easyeda_schematic_add_wire instead. This is the bulk ' +
      'equivalent of connect_pin_to_net, with the same non-authoritative caveat.',
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
      real: z.boolean().optional(),
      warning: z.string().optional(),
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
        const data = result as { count?: number; real?: boolean; warning?: string };
        const count = data?.count ?? p.pins.length;

        return {
          success: true,
          real: data?.real,
          warning: data?.warning,
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
