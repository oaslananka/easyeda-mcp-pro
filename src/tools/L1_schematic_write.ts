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
    const result = await ctx.bridge.call<
      { projectId: string; limit: number; offset: number },
      { total?: number; items?: SchematicComponentSnapshot[] } | SchematicComponentSnapshot[]
    >('schematic.listComponents', {
      projectId: 'active',
      limit: 500,
      offset: 0,
    });
    // The bridge returns { total, items }, not a bare array — accept both
    // shapes defensively (a bare-array response previously made this always
    // return undefined, silently disabling the collision guard and the
    // before/after component-count diff in verifyAfterWrite).
    if (Array.isArray(result)) return result;
    if (result && Array.isArray(result.items)) return result.items;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Loose match for "was this placement attempted right before the bridge call failed" —
 *  used only to decide whether a timeout/error is worth reconciling against real state. */
function looksLikeTimeoutOrUnconfirmed(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /timed out|timeout/i.test(err.message);
}

/**
 * After a placeComponent call errors (typically a timeout), check whether the
 * write actually landed anyway before reporting failure — the EasyEDA-side
 * operation can complete after the bridge's own timeout fires, and blindly
 * reporting failure invites the caller to retry, creating a duplicate
 * component under a second designator (see easyeda-workflow skill's
 * "known write-safety caveats"). Matches on device identity + placement
 * coordinates within `collisionRadius` against the current component list.
 */
function findMatchingPlacedComponent(
  components: SchematicComponentSnapshot[] | undefined,
  deviceItem: { uuid: string; libraryUuid: string },
  x: number,
  y: number,
  toleranceRadius: number,
): SchematicComponentSnapshot | undefined {
  for (const component of components ?? []) {
    if (component.deviceUuid !== deviceItem.uuid) continue;
    const point = schematicWriteComponentPoint(component);
    if (!point) continue;
    if (Math.hypot(point.x - x, point.y - y) <= toleranceRadius) return component;
  }
  return undefined;
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
  confirmWrite: z.literal(true).describe('Must be the literal boolean true (not the string "true") to allow this write.'),
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
  confirmWrite: z.literal(true).describe('Must be the literal boolean true (not the string "true") to allow this write.'),
});

const addTextInputSchema = z.object({
  x: z.number(),
  y: z.number(),
  content: z.string().min(1),
  rotation: z.number().optional(),
  color: z.string().optional(),
  fontName: z.string().optional(),
  fontSize: z.number().positive().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  alignMode: z.number().int().min(0).max(8).optional(),
  confirmWrite: z.literal(true).describe('Must be the literal boolean true (not the string "true") to allow this write.'),
});

const addRectangleInputSchema = z.object({
  x: z.number().describe('Top-left X coordinate'),
  y: z.number().describe('Top-left Y coordinate'),
  width: z.number().positive(),
  height: z.number().positive(),
  cornerRadius: z.number().nonnegative().optional(),
  rotation: z.number().optional(),
  color: z.string().optional().describe('Border/line color, hex string (e.g. "#FF0000")'),
  fillColor: z.string().optional().describe('Fill color, hex string, or "none" for unfilled'),
  lineWidth: z.number().positive().optional(),
  lineType: z.number().int().nonnegative().optional(),
  fillStyle: z.string().optional(),
  confirmWrite: z.literal(true).describe('Must be the literal boolean true (not the string "true") to allow this write.'),
});

const addCircleInputSchema = z.object({
  centerX: z.number(),
  centerY: z.number(),
  radius: z.number().positive(),
  color: z.string().optional(),
  fillColor: z.string().optional().describe('Fill color, hex string, or "none" for unfilled'),
  lineWidth: z.number().positive().optional(),
  lineType: z.number().int().nonnegative().optional(),
  fillStyle: z.string().optional(),
  confirmWrite: z.literal(true).describe('Must be the literal boolean true (not the string "true") to allow this write.'),
});

const addPolygonInputSchema = z.object({
  points: z.array(z.object({ x: z.number(), y: z.number() })).min(3),
  color: z.string().optional(),
  fillColor: z.string().optional().describe('Fill color, hex string, or "none" for unfilled'),
  lineWidth: z.number().positive().optional(),
  lineType: z.number().int().nonnegative().optional(),
  confirmWrite: z.literal(true).describe('Must be the literal boolean true (not the string "true") to allow this write.'),
});

const deletePrimitiveInputSchema = z.object({
  primitiveIds: z.array(z.string()),
  confirmWrite: z.literal(true).describe('Must be the literal boolean true (not the string "true") to allow this write.'),
});

const modifyPrimitiveInputSchema = z.object({
  primitiveId: z.string(),
  property: z.record(z.string(), z.unknown()),
  confirmWrite: z.literal(true).describe('Must be the literal boolean true (not the string "true") to allow this write.'),
});

function registerSchematicWriteTools(
  registry: { register: (def: ToolDefinition) => void },
  _config: EnvConfig,
) {
  registry.register({
    name: 'easyeda_schematic_place_component',
    title: 'Place schematic component',
    description:
      'Place a library component/device on the active schematic sheet. Auto-assigns the next ' +
      'free designator ("R?" → "R1") — check the returned value, duplicate "R?" merge into one ' +
      'node. On a timeout error, auto-reconciles against the sheet before reporting failure (see ' +
      'reconciled/unconfirmed) — do not blindly retry.',
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
      /** True when a bridge error (typically a timeout) was reconciled by finding a matching
       *  component already on the sheet — the placement likely succeeded despite the error. */
      reconciled: z.boolean().optional(),
      /** True when an error looked like a timeout but no matching component was found on
       *  re-check — genuinely unknown whether the write landed; do not assume either way. */
      unconfirmed: z.boolean().optional(),
      warning: z.string().optional(),
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
        if (looksLikeTimeoutOrUnconfirmed(err)) {
          const afterComponents = await readSchematicComponentsForVerification(ctx);
          const match = findMatchingPlacedComponent(
            afterComponents,
            p.deviceItem,
            p.x,
            p.y,
            p.collisionRadius ?? 25,
          );
          if (match) {
            return {
              success: true,
              component: match,
              reconciled: true,
              warning:
                `Bridge call errored ("${err instanceof Error ? err.message : String(err)}") but ` +
                `a matching component (primitiveId "${String(match.primitiveId ?? '')}") was found ` +
                'on the sheet afterward — the placement likely succeeded despite the error. Do not retry this placement.',
            };
          }
          return {
            success: false,
            unconfirmed: true,
            error: err instanceof Error ? err.message : String(err),
            warning:
              'This looks like a timeout, not a confirmed failure. No matching component was ' +
              'found on re-check, but the write may still be landing. Verify with ' +
              'schematic_components/schematic_nets before retrying — retrying an unconfirmed ' +
              'placement risks creating a duplicate.',
          };
        }
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
      'Add a wire connecting schematic coordinates/pins — real native connectivity. Same ' +
      '`netName` connects pins globally: separate stubs sharing one name merge into one net (no ' +
      "label needed). NET_COLLISION guards touched points against a foreign net's wire, pin, or " +
      'flag/port — not mid-segment crossings.',
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
    name: 'easyeda_schematic_add_text',
    title: 'Add schematic text label',
    description:
      'Place free-standing text on the schematic sheet (section headers, notes, block labels) — ' +
      'cosmetic/organizational, not a net label. color must be a hex string and fontName a real ' +
      'font (e.g. "Arial") — untyped placeholders create nothing despite returning ok.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: addTextInputSchema,
    outputSchema: z.object({
      success: z.boolean(),
      text: z.unknown().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = addTextInputSchema.parse(params);
      try {
        const result = await ctx.bridge.call('schematic.addText', {
          x: p.x,
          y: p.y,
          content: p.content,
          rotation: p.rotation,
          color: p.color,
          fontName: p.fontName,
          fontSize: p.fontSize,
          bold: p.bold,
          italic: p.italic,
          underline: p.underline,
          alignMode: p.alignMode,
        });
        return { success: true, text: result };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_add_rectangle',
    title: 'Add schematic rectangle',
    description:
      'Draw a rectangle on the schematic sheet — section dividers/grouping boxes for organizing ' +
      'a busy schematic into labeled functional blocks (pair with add_text for the title). ' +
      'Cosmetic only. x/y is the top-left corner; fillColor "none" leaves it unfilled.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: addRectangleInputSchema,
    outputSchema: z.object({
      success: z.boolean(),
      rectangle: z.unknown().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = addRectangleInputSchema.parse(params);
      try {
        const result = await ctx.bridge.call('schematic.addRectangle', {
          x: p.x,
          y: p.y,
          width: p.width,
          height: p.height,
          cornerRadius: p.cornerRadius,
          rotation: p.rotation,
          color: p.color,
          fillColor: p.fillColor,
          lineWidth: p.lineWidth,
          lineType: p.lineType,
          fillStyle: p.fillStyle,
        });
        return { success: true, rectangle: result };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_add_circle',
    title: 'Add schematic circle',
    description:
      'Draw a circle on the schematic sheet — decorative marker or custom symbol element. ' +
      'Cosmetic only, no electrical meaning. fillColor "none" leaves it unfilled.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: addCircleInputSchema,
    outputSchema: z.object({
      success: z.boolean(),
      circle: z.unknown().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = addCircleInputSchema.parse(params);
      try {
        const result = await ctx.bridge.call('schematic.addCircle', {
          centerX: p.centerX,
          centerY: p.centerY,
          radius: p.radius,
          color: p.color,
          fillColor: p.fillColor,
          lineWidth: p.lineWidth,
          lineType: p.lineType,
          fillStyle: p.fillStyle,
        });
        return { success: true, circle: result };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_add_polygon',
    title: 'Add schematic polygon',
    description:
      'Draw a closed polygon on the schematic sheet from 3+ vertices — custom decorative shapes, ' +
      'callout arrows, or block diagram elements. Cosmetic only, no electrical meaning.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: addPolygonInputSchema,
    outputSchema: z.object({
      success: z.boolean(),
      polygon: z.unknown().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = addPolygonInputSchema.parse(params);
      try {
        const result = await ctx.bridge.call('schematic.addPolygon', {
          points: p.points,
          color: p.color,
          fillColor: p.fillColor,
          lineWidth: p.lineWidth,
          lineType: p.lineType,
        });
        return { success: true, polygon: result };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
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
      'Modify a schematic component/object: only fields in property change; others are read back ' +
      'and preserved, so partial updates never wipe unrelated data. Also moves net flags/ports — ' +
      'pass x/y, rotation 0/90/180/270, or mirror to shift a VCC/GND flag label off a crowded ' +
      'pin, keeping it over its wire.',
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
      'Create a named net flag/label. With `identification` (Power/Ground/AnalogGround/' +
      'ProtectGround) it places a power-flag symbol binding to a coincident pin (use for ' +
      'VCC/GND). Without it, a generic net label — cosmetic only; connect pins with add_wire ' +
      'stubs sharing one netName.',
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
      confirmWrite: z.literal(true).describe('Must be the literal boolean true (not the string "true") to allow this write.'),
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
      confirmWrite: z.literal(true).describe('Must be the literal boolean true (not the string "true") to allow this write.'),
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
      'Create real EasyEDA connectivity for a pin: draws a short wire stub from its exact ' +
      'coordinate, tagged with netName. Same-netName wires merge globally, so this joins the pin ' +
      'to everything else on that net — visible to ERC, ratsnest, and autorouting.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '2.0.0',
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
      stubLength: z
        .number()
        .positive()
        .optional()
        .describe('Length of the wire stub drawn outward from the pin. Defaults to 10.'),
      confirmWrite: z.literal(true).describe('Must be the literal boolean true (not the string "true") to allow this write.'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      real: z.boolean().optional(),
      created_primitive_id: z.string().optional(),
      endpoint: z.object({ x: z.number(), y: z.number() }).optional(),
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
        stubLength?: number;
      };
      try {
        const result = await ctx.bridge.call('schematic.connectPinToNet', {
          projectId: p.projectId,
          primitiveId: p.primitiveId,
          pinNumber: p.pinNumber,
          netName: p.netName,
          stubLength: p.stubLength,
        });
        const data = result as {
          connected?: boolean;
          real?: boolean;
          primitiveId?: string;
          endpoint?: { x: number; y: number };
        };
        return {
          success: data?.connected !== false,
          real: data?.real,
          created_primitive_id: data?.primitiveId,
          endpoint: data?.endpoint,
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
      'Bulk variant of connect_pin_to_net: draws a real wire stub from each pin, tagged with ' +
      'netName, so all listed pins (and anything else already on that net) merge into one net. ' +
      'Visible to ERC, ratsnest, and autorouting. A pin that fails (e.g. collision) is reported ' +
      'in failures rather than aborting the batch.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '2.0.0',
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
      stubLength: z
        .number()
        .positive()
        .optional()
        .describe('Length of the wire stub drawn outward from each pin. Defaults to 10.'),
      confirmWrite: z.literal(true).describe('Must be the literal boolean true (not the string "true") to allow this write.'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      real: z.boolean().optional(),
      created_primitive_ids: z.array(z.string()).optional(),
      failures: z
        .array(
          z.object({
            primitiveId: z.string(),
            pinNumber: z.string(),
            error: z.string(),
          }),
        )
        .optional(),
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
        stubLength?: number;
      };
      try {
        const result = await ctx.bridge.call('schematic.connectPinsByNet', {
          projectId: p.projectId,
          netName: p.netName,
          pins: p.pins,
          stubLength: p.stubLength,
        });
        const data = result as {
          count?: number;
          real?: boolean;
          createdPrimitiveIds?: string[];
          failures?: Array<{ primitiveId: string; pinNumber: string; error: string }>;
        };
        const count = data?.count ?? p.pins.length;

        return {
          success: true,
          real: data?.real,
          created_primitive_ids: data?.createdPrimitiveIds,
          failures: data?.failures,
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
      confirmWrite: z.literal(true).describe('Must be the literal boolean true (not the string "true") to allow this write.'),
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

  registry.register({
    name: 'easyeda_schematic_set_title_block',
    title: 'Set schematic title block fields',
    description:
      'Update schematic title block text fields (Company, Version, Drawn, Reviewed, Page Size). ' +
      'Only these 5 are exposed — writing Symbol/Border/Device/etc once corrupted a real title ' +
      'block; those are read-only natively and must be fixed via the EasyEDA Pro UI.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '1.1.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: z.object({
      fields: z
        .record(
          z.enum(['Company', 'Version', 'Drawn', 'Reviewed', 'Page Size']),
          z.object({
            showTitle: z.boolean().optional(),
            showValue: z.boolean().optional(),
            value: z.union([z.string(), z.number()]).optional(),
          }),
        )
        .describe(
          'Map of title block field name to the sub-fields to change, e.g. { "Company": { "value": "ACME", "showValue": true } }',
        ),
      showTitleBlock: z.boolean().optional().describe('Show/hide the whole title block'),
      confirmWrite: z.literal(true).describe('Must be the literal boolean true (not the string "true") to allow this write.'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const p = params as {
        fields: Record<
          string,
          { showTitle?: boolean; showValue?: boolean; value?: string | number }
        >;
        showTitleBlock?: boolean;
      };
      try {
        const result = await ctx.bridge.call('schematic.setTitleBlock', {
          fields: p.fields,
          showTitleBlock: p.showTitleBlock,
        });
        const data = result as { success?: boolean };
        return { success: data?.success ?? false };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  registry.register({
    name: 'easyeda_schematic_sync_to_pcb',
    title: 'Request schematic-to-PCB sync (needs human approval)',
    description:
      'Request a schematic-to-PCB sync (SCH_Document.importChanges). CAUTION (live-verified): ' +
      "opens a confirmation dialog in EasyEDA Pro's UI a HUMAN must approve — success here only " +
      'means the request was sent, not that components appeared. Ask the user to approve the ' +
      'dialog, then verify with pcb_components.',
    profile: 'core',
    evidence: ['runtime-probe'],
    risk: 'medium',
    confirmWrite: true,
    group: 'schematic',
    version: '2.0.0',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.object({
      projectId: z.string().optional(),
      confirmWrite: z.literal(true).describe('Must be the literal boolean true (not the string "true") to allow this write.'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      requested: z.boolean().optional(),
      note: z.string().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId } = params as { projectId?: string };
      try {
        const result = await ctx.bridge.call('schematic.syncToPcb', { projectId });
        const data = result as { synced?: boolean };
        return {
          success: true,
          requested: data?.synced ?? true,
          note: 'EasyEDA opened a confirmation dialog in its UI — ask the user to approve it, then verify with pcb_components before assuming the sync completed.',
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

export { registerSchematicWriteTools };
