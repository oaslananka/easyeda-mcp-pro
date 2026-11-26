import { z } from 'zod';
import {
  reviewSensitiveLineSpacing,
  type SensitiveLineSpacingReview,
} from '../pcb-layout/sensitive-line-spacing.js';
import {
  nativeCopperLayerCode,
  type NativeTrack,
  type NativeVia,
} from '../pcb-layout/route-review.js';

const exactNet = z
  .string()
  .min(1)
  .max(100)
  .refine((v) => v.trim() === v);
const declaration = z
  .object({
    sensitiveNet: exactNet,
    otherNet: exactNet,
    context: z.enum(['sensitive-adjacency', 'feedback']),
    constraintSource: z
      .string()
      .min(3)
      .max(200)
      .refine((v) => v.trim() === v),
    minEdgeGapMm: z.number().finite().positive().optional(),
  })
  .refine((v) => v.sensitiveNet !== v.otherNet, 'Distinct exact net names are required.');
export const sensitiveLineSpacingSchema = z
  .array(declaration)
  .min(1)
  .max(4)
  .refine(
    (items) =>
      new Set(items.map((v) => JSON.stringify([v.sensitiveNet, v.otherNet].sort()))).size ===
      items.length,
    'Requested unordered net pairs must be unique.',
  );
export const sensitiveLineSpacingResultSchema = z.object({
  sensitive_net: exactNet,
  other_net: exactNet,
  context: z.enum(['sensitive-adjacency', 'feedback']),
  constraint_source: z.string(),
  declared_min_edge_gap_mm: z.number().finite().positive().optional(),
  evidence: z.enum(['observed_same_layer_lines', 'unavailable']),
  status: z.enum(['WARNING', 'UNKNOWN']),
  line_counts: z.object({
    sensitive: z.number().int().nonnegative(),
    other: z.number().int().nonnegative(),
  }),
  compared_pair_count: z.number().int().nonnegative(),
  closest: z
    .object({
      primitive_ids: z.tuple([z.string(), z.string()]),
      native_layer: z.number().refine(nativeCopperLayerCode),
      observed_edge_gap_mm: z.number().finite(),
    })
    .optional(),
  electrical_isolation_status: z.literal('UNKNOWN'),
  engineering_sign_off: z.literal(false),
  reason: z.string(),
});
interface Source {
  tracks: NativeTrack[];
  vias: NativeVia[];
  complete: boolean;
  focusedPcbId?: string;
}

export async function optionalSensitiveLineSpacingReview(
  declarations: z.infer<typeof sensitiveLineSpacingSchema> | undefined,
  source: Source,
  readFocus: () => Promise<string | undefined>,
): Promise<{ sensitive_line_spacing_review?: SensitiveLineSpacingReview[] }> {
  if (declarations === undefined) return {};
  const viaIds = new Set(source.vias.map((v) => v.primitiveId));
  const complete =
    source.complete &&
    !!source.focusedPcbId &&
    !source.tracks.some((t) => viaIds.has(t.primitiveId)) &&
    (await readFocus()) === source.focusedPcbId;
  return {
    sensitive_line_spacing_review: declarations.map((d) =>
      reviewSensitiveLineSpacing(d, source.tracks, complete),
    ),
  };
}

export function sensitiveLineSpacingStatus(
  reviews: SensitiveLineSpacingReview[] | undefined,
): 'WARNING' | 'UNKNOWN' | undefined {
  return reviews?.some((r) => r.status === 'WARNING') ? 'WARNING' : undefined;
}
