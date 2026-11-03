import { z } from 'zod';
import { type EnvConfig } from '../config/env.js';
import {
  reviewRouteGeometry,
  type NativeTrack,
  type NativeVia,
} from '../pcb-layout/route-review.js';
import { type ToolContext, type ToolDefinition } from './types.js';

const WINDOW = 200;

const projectIdSchema = z
  .string()
  .min(1)
  .refine((id) => id === id.trim(), {
    message: 'projectId must match the exact native project UUID without surrounding whitespace.',
  });

const inputSchema = z.object({
  projectId: projectIdSchema,
  intent: z.enum(['general', 'high-speed']).default('general'),
  minWidthMm: z
    .number()
    .finite()
    .positive()
    .optional()
    .describe(
      'Optional caller-supplied minimum route width in millimeters; not native DRC or fabricator evidence.',
    ),
});

const nativeTrackSchema = z.object({
  primitiveId: z.string().optional(),
  net: z.string().optional(),
  layer: z.number().finite().optional(),
  startX: z.number().finite().optional(),
  startY: z.number().finite().optional(),
  endX: z.number().finite().optional(),
  endY: z.number().finite().optional(),
  width: z.number().finite().optional(),
});
const nativeViaSchema = z.object({
  primitiveId: z.string().optional(),
  net: z.string().optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  diameter: z.number().finite().optional(),
  holeDiameter: z.number().finite().optional(),
});
const trackListSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(nativeTrackSchema).max(WINDOW),
});
const viaListSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(nativeViaSchema).max(WINDOW),
});
const findingSchema = z.object({
  id: z.string(),
  rule_id: z.enum([
    'TRACE_WIDTH_BELOW_CONTEXT_MINIMUM',
    'TRACK_GEOMETRY_UNAVAILABLE',
    'RIGHT_ANGLE_STYLE_REVIEW',
    'VIA_ANNULAR_GEOMETRY',
    'VIA_CURRENT_CAPACITY_UNKNOWN',
    'REFERENCE_PLANE_UNVERIFIED',
    'COPPER_CLEARANCE_UNVERIFIED',
    'NATIVE_COLLECTION_INCOMPLETE',
  ]),
  status: z.enum(['WARNING', 'ADVISORY', 'UNKNOWN']),
  message: z.string(),
  net: z.string().optional(),
  layer: z.number().optional(),
  primitive_ids: z.array(z.string()),
  position_mil: z.object({ x: z.number(), y: z.number() }).optional(),
  width_mm: z.number().optional(),
  threshold_mm: z.number().optional(),
  deflection_degrees: z.number().optional(),
});
const outputSchema = z.object({
  project_id: projectIdSchema,
  overall_status: z.enum(['WARNING', 'UNKNOWN']),
  coordinate_unit: z.literal('mil'),
  width_unit: z.literal('mm'),
  method: z.literal('NATIVE_TRACK_SEGMENT_GEOMETRY'),
  reference: z.string(),
  review_intent: z.enum(['general', 'high-speed']),
  input_evidence: z.object({
    tracks: z.enum(['observed', 'unavailable']),
    vias: z.enum(['observed', 'unavailable']),
    collection_complete: z.boolean(),
  }),
  coverage: z.object({
    requested_track_count: z.number().int().nonnegative(),
    returned_track_count: z.number().int().nonnegative(),
    requested_via_count: z.number().int().nonnegative(),
    returned_via_count: z.number().int().nonnegative(),
    findings_truncated: z.boolean(),
  }),
  findings: z.array(findingSchema).max(60),
  limitations: z.array(z.string()),
  runtime: z.object({
    bridge_connected: z.boolean(),
    registry_mismatch: z.boolean(),
    extension_version_mismatch: z.boolean(),
    easyeda_version: z.string().nullable(),
    extension_version: z.string().nullable(),
  }),
  errors: z.array(z.string()),
  engineering_sign_off: z.literal(false),
});

type NativeCollection = {
  total: number;
  items: NativeTrack[] | NativeVia[];
};

async function readBoundedCollection(
  ctx: ToolContext,
  projectId: string,
  method: 'pcb.listTracks' | 'pcb.listVias',
): Promise<NativeCollection> {
  // Native readProjectScoped verifies the focused PCB's project and document
  // identity both before and after the primitive enumeration.
  const data = await ctx.bridge.call(method, { projectId, limit: WINDOW, offset: 0 });
  const parsed = (method === 'pcb.listTracks' ? trackListSchema : viaListSchema).parse(data);
  if (parsed.total < parsed.items.length) {
    throw new Error(method + ': native total is smaller than returned item count');
  }
  return parsed;
}

/**
 * Read-only per-request bounded snapshot. Unavailable or incomplete primitive
 * evidence cannot establish a passing clearance/plane/return-path verdict.
 */
export function registerPcbRouteReviewTools(
  registry: { register: (def: ToolDefinition) => void },
  _config: EnvConfig,
): void {
  registry.register({
    name: 'easyeda_pcb_route_geometry_review',
    title: 'Review observed PCB route geometry and evidence gaps',
    description:
      'Read up to 200 native PCB track segments and vias for a focused project, review trace widths and context-specific 90-degree bends, and report unknown clearance/return-path evidence. Does not run DRC, edit copper, or certify routing.',
    profile: 'core',
    evidence: ['runtime-probe', 'inferred'],
    risk: 'low',
    confirmWrite: false,
    sideEffect: 'read-only',
    group: 'pcb-constraints',
    version: '1.0.0',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema,
    outputSchema,
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, intent, minWidthMm } = inputSchema.parse(params);
      const sourceMismatch =
        ctx.bridge.registryMismatch === true || ctx.bridge.extensionVersionMismatch === true;
      const errors: string[] = [];
      let tracks: NativeTrack[] = [];
      let vias: NativeVia[] = [];
      let trackCount = 0;
      let viaCount = 0;
      let tracksAvailable = false;
      let viasAvailable = false;

      if (!ctx.bridge.connected || sourceMismatch) {
        errors.push(
          !ctx.bridge.connected
            ? 'Native bridge is disconnected; route measurements are unavailable.'
            : 'Native bridge extension or method registry mismatches this server.',
        );
      } else {
        const [trackRead, viaRead] = await Promise.allSettled([
          readBoundedCollection(ctx, projectId, 'pcb.listTracks'),
          readBoundedCollection(ctx, projectId, 'pcb.listVias'),
        ]);
        if (trackRead.status === 'fulfilled') {
          tracks = trackRead.value.items as NativeTrack[];
          trackCount = trackRead.value.total;
          tracksAvailable = true;
        } else {
          errors.push('pcb.listTracks: ' + String(trackRead.reason));
        }
        if (viaRead.status === 'fulfilled') {
          vias = viaRead.value.items as NativeVia[];
          viaCount = viaRead.value.total;
          viasAvailable = true;
        } else {
          errors.push('pcb.listVias: ' + String(viaRead.reason));
        }
      }

      return {
        project_id: projectId,
        ...reviewRouteGeometry({
          tracks,
          vias,
          trackCount,
          viaCount,
          tracksAvailable,
          viasAvailable,
          intent,
          minWidthMm,
        }),
        runtime: {
          bridge_connected: ctx.bridge.connected,
          registry_mismatch: ctx.bridge.registryMismatch === true,
          extension_version_mismatch: ctx.bridge.extensionVersionMismatch === true,
          easyeda_version: ctx.bridge.easyedaVersion ?? null,
          extension_version: ctx.bridge.extensionVersion ?? null,
        },
        errors,
      };
    },
  });
}
