import { z } from 'zod';
import {
  reviewDifferentialPair,
  type DifferentialPairDeclaration,
} from '../pcb-layout/differential-pair.js';
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

const exactNetSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => value === value.trim(), {
    message: 'Net identity must exactly match the native EasyEDA net name.',
  });

const differentialPairSchema = z
  .object({
    positiveNet: exactNetSchema,
    negativeNet: exactNetSchema,
    protocol: z.enum(['usb2', 'usb3', 'rs485', 'ethernet-10-100', 'ethernet-1000', 'custom']),
    maxSkewMm: z.number().finite().nonnegative().optional(),
    minEdgeGapMm: z.number().finite().nonnegative().optional(),
    maxEdgeGapMm: z.number().finite().positive().optional(),
    targetImpedanceOhms: z.number().finite().positive().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.positiveNet === value.negativeNet) {
      ctx.addIssue({
        code: 'custom',
        path: ['negativeNet'],
        message: 'Differential pair net names must be distinct.',
      });
    }
    if (
      value.minEdgeGapMm !== undefined &&
      value.maxEdgeGapMm !== undefined &&
      value.minEdgeGapMm > value.maxEdgeGapMm
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['minEdgeGapMm'],
        message: 'Minimum edge gap cannot exceed maximum edge gap.',
      });
    }
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
  differentialPair: differentialPairSchema.optional(),
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
const netLengthSchema = z.object({
  net: z.string(),
  coverage: z.enum(['MISSING', 'UNAVAILABLE', 'OBSERVED_SINGLE_CHAIN', 'AMBIGUOUS']),
  segment_count: z.number().int().nonnegative(),
  primitive_ids: z.array(z.string()),
  observed_length_mm: z.number().optional(),
  single_layer: z.number().optional(),
});
const measurementSchema = z.object({
  status: z.enum(['WARNING', 'UNKNOWN', 'WITHIN_DECLARED_LIMIT_REFERENCE']),
  observed_mm: z.number().optional(),
  declared_limit_mm: z.number().optional(),
  note: z.string(),
});
const differentialPairResultSchema = z.object({
  status: z.enum(['WARNING', 'UNKNOWN']),
  nets: z.object({ positive: z.string(), negative: z.string() }),
  protocol: z.string(),
  protocol_guidance: z
    .object({
      source: z.string(),
      caveat: z.string(),
      differential_impedance_reference_ohms: z.number().optional(),
    })
    .nullable(),
  target_impedance_ohms: z.number().optional(),
  impedance_status: z.literal('UNKNOWN'),
  evidence: z.literal('native_segments_not_field_solver_or_full_route'),
  length_units: z.literal('mm'),
  coordinate_units: z.literal('mil'),
  paths: z.object({ positive: netLengthSchema, negative: netLengthSchema }),
  skew: measurementSchema,
  spacing: measurementSchema.extend({
    observed_max_mm: z.number().optional(),
    sample_count: z.number().int().nonnegative(),
  }),
  findings: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['WARNING', 'UNKNOWN']),
      message: z.string(),
      net: z.string().optional(),
      primitive_ids: z.array(z.string()),
    }),
  ),
  limitations: z.array(z.string()),
  engineering_sign_off: z.literal(false),
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
  differential_pair: differentialPairResultSchema.optional(),
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
      'Read bounded native PCB tracks/vias for a focused project; review geometry and optional declared differential net pairs, skew and spacing. Report unknown impedance, planes and incomplete evidence. Read-only; no DRC or fabrication approval.',
    profile: 'core',
    evidence: ['runtime-probe', 'inferred'],
    risk: 'low',
    confirmWrite: false,
    sideEffect: 'read-only',
    group: 'pcb-constraints',
    version: '1.1.0',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema,
    outputSchema,
    handler: async (ctx: ToolContext, params: unknown) => {
      const { projectId, intent, minWidthMm, differentialPair } = inputSchema.parse(params);
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

      const geometry = reviewRouteGeometry({
        tracks,
        vias,
        trackCount,
        viaCount,
        tracksAvailable,
        viasAvailable,
        intent,
        minWidthMm,
      });
      const pair =
        differentialPair === undefined
          ? undefined
          : reviewDifferentialPair(
              differentialPair as DifferentialPairDeclaration,
              tracks,
              vias,
              geometry.input_evidence.collection_complete,
            );

      return {
        project_id: projectId,
        ...geometry,
        ...(pair === undefined
          ? {}
          : {
              differential_pair: pair,
              overall_status: pair.status === 'WARNING' ? 'WARNING' : geometry.overall_status,
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
