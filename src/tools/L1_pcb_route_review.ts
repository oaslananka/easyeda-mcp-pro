import {
  reviewNativePadAssociations,
  unknownNativePadAssociations,
} from '../pcb-layout/placement-pad-connectivity.js';
import { z } from 'zod';
import {
  reviewPlacementRelations,
  type NativePlacement,
  type PlacementRelation,
} from '../pcb-layout/placement-evidence.js';
import {
  reviewDifferentialPair,
  type DifferentialPairDeclaration,
} from '../pcb-layout/differential-pair.js';
import { reviewNativePlacementPadPair } from '../pcb-layout/placement-pad-evidence.js';
import { type EnvConfig } from '../config/env.js';
import { reviewNativeTraceCurrent } from '../pcb-layout/native-trace-current.js';
import {
  reviewRouteGeometry,
  type NativeTrack,
  type NativeVia,
} from '../pcb-layout/route-review.js';
import { type ToolContext, type ToolDefinition } from './types.js';

const WINDOW = 200;
const MAX_ROUTE_TRACKS = 1_200;
const MAX_ROUTE_VIAS = 600;
const MAX_PLACEMENT_COMPONENTS = 1_200;

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
    constraintSource: z.string().trim().min(3).max(200).optional(),
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

const exactFootprintNameSchema = z
  .string()
  .min(1)
  .max(180)
  .refine((value) => value === value.trim(), {
    message:
      'Expected footprint name must exactly match its native identity without surrounding whitespace.',
  });

const nativePadPairSchema = z.object({
  firstPin: z
    .string()
    .min(1)
    .max(32)
    .refine((value) => value === value.trim()),
  secondPin: z
    .string()
    .min(1)
    .max(32)
    .refine((value) => value === value.trim()),
  expectedNet: exactNetSchema,
  maxCenterDistanceMm: z.number().finite().positive().optional(),
});

const placementRelationSchema = z
  .object({
    first: exactNetSchema.describe('Exact native PCB component designator, e.g. U1.'),
    second: exactNetSchema.describe('Exact second PCB component designator, e.g. C1.'),
    padPairs: z.array(nativePadPairSchema).min(1).max(2).optional(),
    kind: z.enum([
      'decoupling',
      'switching-loop',
      'crystal',
      'esd-entry',
      'feedback',
      'sensitive-adjacency',
    ]),
    maxCenterDistanceMm: z.number().finite().positive().optional(),
    requireSameLayer: z.boolean().optional(),
    firstRotationDeg: z.number().finite().optional(),
    rotationToleranceDeg: z.number().finite().min(0).max(180).optional(),
    secondRotationDeg: z.number().finite().optional(),
    secondRotationToleranceDeg: z.number().finite().min(0).max(180).optional(),
    firstFootprintName: exactFootprintNameSchema.optional(),
    secondFootprintName: exactFootprintNameSchema.optional(),
    constraintSource: z.string().trim().min(3).max(200).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.first === value.second) {
      ctx.addIssue({
        code: 'custom',
        path: ['second'],
        message: 'Two distinct component designators are required.',
      });
    }
    if (value.secondRotationToleranceDeg !== undefined && value.secondRotationDeg === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['secondRotationToleranceDeg'],
        message: 'Declare the second component rotation target first.',
      });
    }
    if (value.rotationToleranceDeg !== undefined && value.firstRotationDeg === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['rotationToleranceDeg'],
        message: 'Declare the expected rotation first.',
      });
    }
    if (
      (value.maxCenterDistanceMm !== undefined ||
        value.requireSameLayer === true ||
        value.firstRotationDeg !== undefined ||
        value.secondRotationDeg !== undefined ||
        value.padPairs !== undefined ||
        value.firstFootprintName !== undefined ||
        value.secondFootprintName !== undefined) &&
      !value.constraintSource
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['constraintSource'],
        message: 'An explicit caller-supplied source is required for any placement constraint.',
      });
    }
  });

const nativeTraceCurrentDeclarationSchema = z.object({
  net: exactNetSchema,
  currentA: z.number().finite().positive(),
  temperatureRiseC: z.number().finite().positive(),
  layer: z.enum(['external', 'internal']),
  copperWeightOz: z.number().finite().positive(),
  environment: z.enum(['still-air', 'forced-air', 'vacuum', 'unspecified']).optional(),
  manufacturerMinWidthMm: z.number().finite().positive().optional(),
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
  minClearanceMm: z
    .number()
    .finite()
    .positive()
    .optional()
    .describe(
      'Optional caller-supplied minimum same-layer, different-net line-edge clearance in millimeters; not an active native DRC or fabricator limit.',
    ),
  differentialPair: differentialPairSchema.optional(),
  placementRelations: z.array(placementRelationSchema).min(1).max(8).optional(),
  includeNativePadContacts: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Opt in to narrowly scoped beta native pad.getConnectedPrimitives(false) read-only association evidence for declared pad pairs. Associations never certify electrical continuity.',
    ),
  traceCurrent: nativeTraceCurrentDeclarationSchema
    .optional()
    .describe(
      'Optional source-bound native net-width check against a caller-declared empirical current reference; never a thermal design pass.',
    ),
});

const nativeComponentSchema = z.object({
  primitiveId: z.string().optional(),
  designator: z.string().optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  layer: z.number().finite().optional(),
  rotation: z.number().finite().optional(),
  footprintName: z.string().optional(),
});
const componentListSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(nativeComponentSchema).max(WINDOW),
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
    'TRACE_CLEARANCE_BELOW_CONTEXT_MINIMUM',
    'OBSERVED_TRACK_COPPER_OVERLAP',
    'TRACK_GEOMETRY_UNAVAILABLE',
    'RIGHT_ANGLE_STYLE_REVIEW',
    'VIA_ANNULAR_GEOMETRY',
    'VIA_GEOMETRY_UNAVAILABLE',
    'VIA_LAYER_TRANSITION_CANDIDATE',
    'VIA_CURRENT_CAPACITY_UNKNOWN',
    'REFERENCE_PLANE_UNVERIFIED',
    'COPPER_CLEARANCE_UNVERIFIED',
    'NATIVE_COLLECTION_INCOMPLETE',
  ]),
  status: z.enum(['WARNING', 'ADVISORY', 'UNKNOWN']),
  message: z.string(),
  net: z.string().optional(),
  other_net: z.string().optional(),
  layer: z.number().optional(),
  native_layers: z.array(z.number()).optional(),
  primitive_ids: z.array(z.string()),
  observed_edge_gap_mm: z.number().optional(),
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
  constraint_source: z.string().nullable(),
  impedance_status: z.literal('UNKNOWN'),
  evidence: z.literal('native_segments_not_field_solver_or_full_route'),
  length_units: z.literal('mm'),
  coordinate_units: z.literal('mil'),
  paths: z.object({ positive: netLengthSchema, negative: netLengthSchema }),
  skew: measurementSchema,
  spacing: measurementSchema.extend({
    observed_max_mm: z.number().optional(),
    sample_count: z.number().int().nonnegative(),
    observed_contact_count: z.number().int().nonnegative().optional(),
    sampled_positive_length_mm: z.number().nonnegative().optional(),
    sampled_negative_length_mm: z.number().nonnegative().optional(),
    sample_coverage_complete: z.boolean().optional(),
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

const placementReviewSchema = z.object({
  status: z.enum(['WARNING', 'UNKNOWN']),
  method: z.literal('NATIVE_COMPONENT_ORIGIN_RELATIONSHIPS'),
  coordinate_unit: z.literal('mil'),
  distance_unit: z.literal('mm'),
  input_evidence: z.object({
    components: z.enum(['observed', 'unavailable']),
    native_total: z.number().int().nonnegative(),
    returned_count: z.number().int().nonnegative(),
    collection_complete: z.boolean(),
  }),
  findings: z
    .array(
      z.object({
        id: z.string(),
        relation: placementRelationSchema.shape.kind,
        components: z.array(z.string()),
        primitive_ids: z.array(z.string()),
        status: z.enum(['WARNING', 'UNKNOWN']),
        evidence: z.enum(['caller_declared_unverified', 'native_component_origins']),
        measured_center_distance_mm: z.number().optional(),
        declared_max_center_distance_mm: z.number().optional(),
        native_layers: z.array(z.number()).optional(),
        first_rotation_deg: z.number().optional(),
        second_rotation_deg: z.number().optional(),
        declared_first_rotation_deg: z.number().optional(),
        declared_second_rotation_deg: z.number().optional(),
        first_footprint_name: z.string().optional(),
        second_footprint_name: z.string().optional(),
        declared_first_footprint_name: z.string().optional(),
        declared_second_footprint_name: z.string().optional(),
        constraint_source: z.string().optional(),
        reasons: z.array(z.string()),
        electrical_loop_status: z.literal('UNKNOWN'),
        pad_pairs: z
          .array(
            z.object({
              first_pin: z.string(),
              second_pin: z.string(),
              expected_net: z.string(),
              status: z.enum(['WARNING', 'UNKNOWN']),
              evidence: z.enum(['native_component_pads', 'unavailable']),
              native_first_net: z.string().optional(),
              native_second_net: z.string().optional(),
              native_pad_layer_codes: z.array(z.number()).optional(),
              measured_pad_center_distance_mm: z.number().finite().nonnegative().optional(),
              declared_max_pad_center_distance_mm: z.number().finite().positive().optional(),
              reasons: z.array(z.string()),
              electrical_loop_status: z.literal('UNKNOWN'),
              native_pad_associations: z
                .object({
                  evidence: z.enum(['native_reported', 'unavailable']),
                  first_primitive_ids: z.array(z.string()),
                  second_primitive_ids: z.array(z.string()),
                  shared_primitive_ids: z.array(z.string()),
                  reasons: z.array(z.string()),
                  electrical_continuity_status: z.literal('UNKNOWN'),
                })
                .optional(),
              route_chain: z
                .object({
                  evidence: z.enum(['observed_exact_endpoint_chain', 'unavailable']),
                  selection: z.enum(['fewest_segments', 'unavailable']),
                  primitive_ids: z.array(z.string()),
                  native_layer: z.number().optional(),
                  observed_centerline_length_mm: z.number().finite().nonnegative().optional(),
                  reasons: z.array(z.string()),
                  electrical_continuity_status: z.literal('UNKNOWN'),
                })
                .optional(),
            }),
          )
          .max(2)
          .optional(),
      }),
    )
    .max(8),
  limitations: z.array(z.string()),
  engineering_sign_off: z.literal(false),
});

const nativeTraceCurrentResultSchema = z.object({
  net: z.string(),
  status: z.enum(['WARNING', 'UNKNOWN']),
  method: z.literal('IPC2221_EMPIRICAL_REFERENCE'),
  geometry_source: z.literal('pcb.listTracks'),
  geometry_evidence: z.enum(['observed_bounded_segments', 'unavailable']),
  source_versions: z.object({ easyeda: z.string().nullable(), extension: z.string().nullable() }),
  width_unit: z.literal('mm'),
  declaration: nativeTraceCurrentDeclarationSchema,
  model_source: z.string(),
  empirical_reference_width_mm: z.number().finite().positive(),
  observed_narrowest_segment_width_mm: z.number().finite().positive().optional(),
  observed_primitive_ids: z.array(z.string()),
  findings: z.array(
    z.object({
      id: z.enum([
        'NATIVE_GEOMETRY_UNKNOWN',
        'THERMAL_REFERENCE_SHORTFALL',
        'FABRICATION_DECLARATION_SHORTFALL',
        'THERMAL_ADEQUACY_UNKNOWN',
        'VIA_CURRENT_UNKNOWN',
      ]),
      status: z.enum(['WARNING', 'UNKNOWN']),
      message: z.string(),
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
  placement_review: placementReviewSchema.optional(),
  trace_current_review: nativeTraceCurrentResultSchema.optional(),
  engineering_sign_off: z.literal(false),
});

type NativeCollection = {
  total: number;
  items: NativeTrack[] | NativeVia[];
};

async function readComponentCollection(ctx: ToolContext, projectId: string) {
  // Component inventories over one native page must not be silently discarded.
  // Each page is a separate live getAll() call, not an atomic snapshot; changed
  // totals fail closed here and duplicate IDs/designators fail closed in the
  // placement reviewer. Counts above the budget remain visibly incomplete.
  const items: z.infer<typeof nativeComponentSchema>[] = [];
  let total = 0;
  while (items.length < MAX_PLACEMENT_COMPONENTS) {
    const offset = items.length;
    const limit = Math.min(WINDOW, MAX_PLACEMENT_COMPONENTS - offset);
    const response = await ctx.bridge.call('pcb.listComponents', { projectId, limit, offset });
    const parsed = componentListSchema.parse(response);
    if (offset > 0 && parsed.total !== total) {
      throw new Error('pcb.listComponents: native total changed across pages');
    }
    total = parsed.total;
    if (total < offset + parsed.items.length) {
      throw new Error('pcb.listComponents: native total smaller than returned items');
    }
    items.push(...parsed.items);
    // A short page cannot prove that a higher reported total was enumerated.
    if (items.length === total || parsed.items.length < limit) break;
  }
  return { total, items };
}

async function readBoundedCollection(
  ctx: ToolContext,
  projectId: string,
  method: 'pcb.listTracks' | 'pcb.listVias',
): Promise<NativeCollection> {
  // Each native enumeration is project/document-scoped, but separate pages are
  // not atomic. Reject changed totals and let duplicate/invalid ids fail closed
  // during geometry review; never claim coverage beyond this bounded budget.
  const maxRows = method === 'pcb.listTracks' ? MAX_ROUTE_TRACKS : MAX_ROUTE_VIAS;
  const items: Array<NativeTrack | NativeVia> = [];
  let total = 0;
  while (items.length < maxRows) {
    const offset = items.length;
    const limit = Math.min(WINDOW, maxRows - offset);
    const data = await ctx.bridge.call(method, { projectId, limit, offset });
    const parsed = (method === 'pcb.listTracks' ? trackListSchema : viaListSchema).parse(data);
    if (offset > 0 && parsed.total !== total) {
      throw new Error(method + ': native total changed across native pages');
    }
    total = parsed.total;
    if (total < offset + parsed.items.length) {
      throw new Error(method + ': native total is smaller than returned item count');
    }
    items.push(...parsed.items);
    if (items.length === total || parsed.items.length < limit) break;
  }
  return { total, items: items as NativeTrack[] | NativeVia[] };
}

async function collectRouteEvidence(ctx: ToolContext, projectId: string, sourceMismatch: boolean) {
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
  return { tracks, vias, trackCount, viaCount, tracksAvailable, viasAvailable, errors };
}

async function collectPlacementEvidence(
  ctx: ToolContext,
  projectId: string,
  requested: boolean,
  sourceMismatch: boolean,
  errors: string[],
) {
  let placementComponents: NativePlacement[] = [];
  let placementTotal = 0;
  let placementAvailable = false;
  if (requested && ctx.bridge.connected && !sourceMismatch) {
    try {
      const observed = await readComponentCollection(ctx, projectId);
      placementComponents = observed.items;
      placementTotal = observed.total;
      placementAvailable = true;
    } catch (error) {
      errors.push('pcb.listComponents: ' + String(error));
    }
  }
  return { placementComponents, placementTotal, placementAvailable };
}

/**
 * Optional, bounded native component pad reads. A document/project re-focus
 * before or after the getters invalidates every observation in this request.
 */
async function readPlacementPadObservations(
  ctx: ToolContext,
  projectId: string,
  relations: PlacementRelation[],
  components: NativePlacement[],
  complete: boolean,
  errors: string[],
): Promise<Map<string, unknown>> {
  const data = new Map<string, unknown>();
  if (!complete || !ctx.bridge.connected) return data;
  const declared = relations.filter((r) => r.padPairs?.length);
  if (!declared.length) return data;
  const projectAndDocMatch = async () => {
    const [projectResponse, docResponse] = await Promise.all([
      ctx.bridge.call('api.read', { path: 'DMT_Project.getCurrentProjectInfo', args: [] }),
      ctx.bridge.call('api.read', { path: 'DMT_SelectControl.getCurrentDocumentInfo', args: [] }),
    ]);
    const project = (projectResponse as { result?: { uuid?: string } }).result;
    const doc = (
      docResponse as {
        result?: { documentType?: number; parentProjectUuid?: string };
      }
    ).result;
    return (
      project?.uuid === projectId && doc?.documentType === 3 && doc.parentProjectUuid === projectId
    );
  };
  try {
    if (!(await projectAndDocMatch())) {
      errors.push('Native project or focused PCB does not match the requested pad review source.');
      return data;
    }
    const wanted = new Set(declared.flatMap((r) => [r.first, r.second]));
    for (const component of components) {
      if (!component.designator || !wanted.has(component.designator) || !component.primitiveId)
        continue;
      try {
        const reply = await ctx.bridge.call('api.read', {
          path: 'PCB_PrimitiveComponent.getAllPinsByPrimitiveId',
          args: [component.primitiveId],
          maxDepth: 6,
        });
        data.set(component.designator, (reply as { result?: unknown }).result);
      } catch (error) {
        errors.push('Native component pad getter unavailable: ' + String(error));
      }
    }
    if (!(await projectAndDocMatch())) {
      errors.push(
        'Native project or document changed during pad inventory; observations discarded.',
      );
      data.clear();
    }
  } catch (error) {
    errors.push('Native project/document identity could not be verified: ' + String(error));
    data.clear();
  }
  return data;
}

async function readNativePairAssociations(
  ctx: ToolContext,
  projectId: string,
  ids: { first: string; second: string },
  pair: { firstPin: string; secondPin: string; expectedNet: string },
) {
  if (!ctx.bridge.connected || ctx.bridge.registryMismatch || ctx.bridge.extensionVersionMismatch) {
    return unknownNativePadAssociations('Native bridge version/source is not verified.');
  }
  const focusedDocument = async (): Promise<string | undefined> => {
    const response = (await ctx.bridge.call('api.read', {
      path: 'DMT_SelectControl.getCurrentDocumentInfo',
      args: [],
    })) as { result?: { uuid?: string; documentType?: number; parentProjectUuid?: string } };
    const doc = response?.result;
    return doc?.documentType === 3 && doc.parentProjectUuid === projectId ? doc.uuid : undefined;
  };
  try {
    const before = await focusedDocument();
    if (!before) return unknownNativePadAssociations('Focused PCB identity is unavailable.');
    const first = await ctx.bridge.call(
      'pcb.listComponentPadConnections',
      {
        projectId,
        componentPrimitiveId: ids.first,
        padNumber: pair.firstPin,
      },
      { timeoutMs: 12000 },
    );
    const second = await ctx.bridge.call(
      'pcb.listComponentPadConnections',
      {
        projectId,
        componentPrimitiveId: ids.second,
        padNumber: pair.secondPin,
      },
      { timeoutMs: 12000 },
    );
    const after = await focusedDocument();
    if (!after || before !== after) {
      return unknownNativePadAssociations(
        'Focused PCB changed during native pad connection reads.',
      );
    }
    return reviewNativePadAssociations(first, second, {
      firstComponentId: ids.first,
      secondComponentId: ids.second,
      firstPin: pair.firstPin,
      secondPin: pair.secondPin,
      net: pair.expectedNet,
    });
  } catch {
    return unknownNativePadAssociations('Native beta pad connections getter unavailable.');
  }
}

async function enrichPlacementPadEvidence(
  ctx: ToolContext,
  projectId: string,
  relations: PlacementRelation[],
  components: NativePlacement[],
  placement: ReturnType<typeof reviewPlacementRelations>,
  errors: string[],
  routeSource: { tracks: NativeTrack[]; complete: boolean },
  includeNativePadContacts: boolean,
) {
  if (!relations.some((r) => r.padPairs?.length)) return;
  // The beta read is opt-in and capped at four pad pairs per invocation.
  const boundedContactReads =
    relations.reduce((total, relation) => total + (relation.padPairs?.length ?? 0), 0) <= 4;
  const observations = await readPlacementPadObservations(
    ctx,
    projectId,
    relations,
    components,
    placement.input_evidence.collection_complete,
    errors,
  );
  for (const [index, relation] of relations.entries()) {
    const finding = placement.findings[index];
    if (!finding || !relation.padPairs?.length) continue;
    const first = components.find((c) => c.designator === relation.first);
    const second = components.find((c) => c.designator === relation.second);
    const ids =
      first?.primitiveId && second?.primitiveId
        ? { first: first.primitiveId, second: second.primitiveId }
        : undefined;
    finding.pad_pairs = await Promise.all(
      relation.padPairs.map(async (pair) => {
        const found = reviewNativePlacementPadPair(
          pair,
          ids,
          observations.has(relation.first) && observations.has(relation.second)
            ? { first: observations.get(relation.first), second: observations.get(relation.second) }
            : undefined,
          routeSource,
        );
        if (includeNativePadContacts) {
          found.native_pad_associations =
            !boundedContactReads ||
            !ids ||
            found.evidence !== 'native_component_pads' ||
            found.native_first_net !== pair.expectedNet ||
            found.native_second_net !== pair.expectedNet
              ? unknownNativePadAssociations(
                  'Native pad identity/net source unavailable, mismatched or contact read budget exceeded.',
                )
              : await readNativePairAssociations(ctx, projectId, ids, pair);
        }
        return found;
      }),
    );
    if (finding.pad_pairs.some((pad) => pad.status === 'WARNING')) {
      finding.status = 'WARNING';
      placement.status = 'WARNING';
    }
  }
}

function optionalNativeCurrentReview(
  declaration: z.infer<typeof nativeTraceCurrentDeclarationSchema> | undefined,
  route: Awaited<ReturnType<typeof collectRouteEvidence>>,
  collectionComplete: boolean,
  ctx: ToolContext,
) {
  if (declaration === undefined) return undefined;
  return reviewNativeTraceCurrent({
    declaration,
    tracks: route.tracks,
    trackCount: route.trackCount,
    collectionComplete,
    easyedaVersion: ctx.bridge.easyedaVersion,
    extensionVersion: ctx.bridge.extensionVersion,
  });
}

function aggregateReviewStatus(
  geometry: 'WARNING' | 'UNKNOWN',
  ...components: Array<'WARNING' | 'UNKNOWN' | undefined>
): 'WARNING' | 'UNKNOWN' {
  return geometry === 'WARNING' || components.includes('WARNING') ? 'WARNING' : 'UNKNOWN';
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
      'Read native PCB tracks/vias in 200-row pages, bounded at 1200 tracks and 600 vias, plus opt-in source-declared component-origin/pad-pair and exact native endpoint-chain observations. Incomplete/non-atomic evidence remains UNKNOWN; no DRC or fabrication approval.',
    profile: 'core',
    evidence: ['runtime-probe', 'inferred'],
    risk: 'low',
    confirmWrite: false,
    sideEffect: 'read-only',
    group: 'pcb-constraints',
    version: '1.5.1',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema,
    outputSchema,
    handler: async (ctx: ToolContext, params: unknown) => {
      const {
        projectId,
        intent,
        minWidthMm,
        minClearanceMm,
        differentialPair,
        placementRelations,
        includeNativePadContacts,
        traceCurrent,
      } = inputSchema.parse(params);
      const sourceMismatch =
        ctx.bridge.registryMismatch === true || ctx.bridge.extensionVersionMismatch === true;
      const route = await collectRouteEvidence(ctx, projectId, sourceMismatch);
      const { tracks, vias, trackCount, viaCount, tracksAvailable, viasAvailable, errors } = route;
      const componentEvidence = await collectPlacementEvidence(
        ctx,
        projectId,
        placementRelations !== undefined,
        sourceMismatch,
        errors,
      );
      const { placementComponents, placementTotal, placementAvailable } = componentEvidence;

      const geometry = reviewRouteGeometry({
        tracks,
        vias,
        trackCount,
        viaCount,
        tracksAvailable,
        viasAvailable,
        intent,
        minWidthMm,
        minClearanceMm,
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

      const nativeCurrent = optionalNativeCurrentReview(
        traceCurrent,
        route,
        geometry.input_evidence.collection_complete,
        ctx,
      );
      const placement =
        placementRelations === undefined
          ? undefined
          : reviewPlacementRelations(
              placementRelations as PlacementRelation[],
              placementComponents,
              placementTotal,
              placementAvailable,
            );

      if (placement && placementRelations) {
        await enrichPlacementPadEvidence(
          ctx,
          projectId,
          placementRelations as PlacementRelation[],
          placementComponents,
          placement,
          errors,
          { tracks, complete: geometry.input_evidence.collection_complete },
          includeNativePadContacts,
        );
      }

      return {
        project_id: projectId,
        ...geometry,
        ...(placement === undefined ? {} : { placement_review: placement }),
        ...(pair === undefined ? {} : { differential_pair: pair }),
        ...(nativeCurrent === undefined ? {} : { trace_current_review: nativeCurrent }),
        overall_status: aggregateReviewStatus(
          geometry.overall_status,
          placement?.status,
          pair?.status,
          nativeCurrent?.status,
        ),
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
