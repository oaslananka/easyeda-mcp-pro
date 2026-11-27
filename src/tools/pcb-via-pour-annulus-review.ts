import { z } from 'zod';
import { reviewViaContourWitness } from '../pcb-layout/copper-contact-candidates.js';
import {
  nativeCopperLayerCode,
  type NativeTrack,
  type NativeVia,
} from '../pcb-layout/route-review.js';
import type { ToolContext } from './types.js';

const id = z
  .string()
  .min(1)
  .max(128)
  .refine((v) => v.trim() === v);
const positive = z.number().finite().positive().max(1_000_000);
const finite = z.number().finite().min(-1_000_000).max(1_000_000);
const provenance = z.string().trim().min(3).max(200);
const layer = z.number().refine(nativeCopperLayerCode);
const transform = z.object({ scale: positive, invertY: z.boolean(), source: provenance });
export const nativeViaPourAnnulusSchema = z
  .object({
    viaPrimitiveId: id,
    pourPrimitiveId: id,
    fillId: id,
    expectedNet: id,
    expectedLayer: layer,
    transform,
    diameterMm: positive,
    drillDiameterMm: positive,
    source: provenance,
  })
  .refine(
    (d) => d.viaPrimitiveId !== d.pourPrimitiveId && d.drillDiameterMm < d.diameterMm,
    'Distinct native identities and positive annulus required.',
  );
type Declaration = z.infer<typeof nativeViaPourAnnulusSchema>;
const viaSchema = z.object({
  primitiveId: id,
  net: id,
  x: finite,
  y: finite,
  diameter: positive,
  holeDiameter: positive,
  viaType: z.literal(0),
});
const replySchema = z.object({
  evidence: z.literal('native_source_linked_via_contour'),
  pourPrimitiveId: id,
  net: id,
  layer,
  fill: z.object({
    id,
    fill: z.literal(true),
    lineWidth: z.literal(0),
    path: z.object({
      complexPolygon: z
        .array(
          z
            .array(z.union([z.literal('L'), finite]))
            .min(9)
            .max(16385),
        )
        .length(1),
    }),
  }),
  availableFillIds: z.array(id).min(1).max(32),
  via: viaSchema,
  electricalContinuity: z.literal('UNKNOWN'),
});
export const viaPourAnnulusResultSchema = z.object({
  via_primitive_id: id,
  pour_primitive_id: id,
  fill_id: id,
  expected_net: id,
  expected_layer: layer,
  evidence: z.enum(['native_source_linked_via_contour', 'unavailable']),
  status: z.enum(['GEOMETRIC_OVERLAP_CANDIDATE', 'UNKNOWN']),
  available_fill_ids: z.array(id).max(32),
  physical_span_status: z.literal('UNKNOWN'),
  electrical_continuity_status: z.literal('UNKNOWN'),
  engineering_sign_off: z.literal(false),
  coordinate_frame: z.literal('native_via_mm'),
  limitations: z.array(z.string()),
  transform,
  diameter_mm: positive,
  drill_diameter_mm: positive,
  dimension_source: provenance,
  reason: z.string(),
  witness: z
    .object({ x_mm: z.number().finite(), y_mm: z.number().finite(), minimum_margin_mm: positive })
    .optional(),
});
type Result = z.infer<typeof viaPourAnnulusResultSchema>;
interface RouteSource {
  complete: boolean;
  focusedPcbId?: string;
  tracks: NativeTrack[];
  vias: NativeVia[];
}
function base(d: Declaration) {
  return {
    via_primitive_id: d.viaPrimitiveId,
    pour_primitive_id: d.pourPrimitiveId,
    fill_id: d.fillId,
    expected_net: d.expectedNet,
    expected_layer: d.expectedLayer,
    transform: d.transform,
    diameter_mm: d.diameterMm,
    drill_diameter_mm: d.drillDiameterMm,
    dimension_source: d.source,
    physical_span_status: 'UNKNOWN' as const,
    electrical_continuity_status: 'UNKNOWN' as const,
    engineering_sign_off: false as const,
    coordinate_frame: 'native_via_mm' as const,
    limitations: [
      'Caller-supplied calibration and dimension sources are not independently authenticated.',
      'Selected individual filled contour only; other fill IDs are identities, not a verified union.',
      'Native nominal annulus does not establish layer flashing, plating or physical continuity.',
      'Independent reads are focus-bound, not an atomic board snapshot.',
    ],
  };
}
function unavailable(d: Declaration, reason: string): Result {
  return { ...base(d), evidence: 'unavailable', status: 'UNKNOWN', available_fill_ids: [], reason };
}
function matchingVia(d: Declaration, source: RouteSource) {
  const matches = source.vias.filter((v) => v.primitiveId === d.viaPrimitiveId);
  if (
    matches.length !== 1 ||
    matches[0]?.net !== d.expectedNet ||
    source.tracks.some(
      (t) => t.primitiveId === d.viaPrimitiveId || t.primitiveId === d.pourPrimitiveId,
    ) ||
    source.vias.some((v) => v.primitiveId === d.pourPrimitiveId)
  )
    return;
  return matches[0];
}
function matchesReply(d: Declaration, r: z.infer<typeof replySchema>, v: NativeVia) {
  return (
    r.pourPrimitiveId === d.pourPrimitiveId &&
    r.net === d.expectedNet &&
    r.layer === d.expectedLayer &&
    r.fill.id === d.fillId &&
    r.availableFillIds.includes(d.fillId) &&
    new Set(r.availableFillIds).size === r.availableFillIds.length &&
    r.via.primitiveId === d.viaPrimitiveId &&
    r.via.net === d.expectedNet &&
    r.via.x === v.x &&
    r.via.y === v.y &&
    r.via.diameter === v.diameter &&
    r.via.holeDiameter === v.holeDiameter
  );
}
function observed(d: Declaration, raw: unknown, v: NativeVia): Result {
  const parsed = replySchema.safeParse(raw);
  if (!parsed.success || !matchesReply(d, parsed.data, v))
    return unavailable(d, 'Native selected contour or via identity/geometry mismatch.');
  const r = parsed.data;
  const witness = reviewViaContourWitness({
    ...r.via,
    contour: r.fill.path.complexPolygon[0],
    transform: d.transform,
    diameterMm: d.diameterMm,
    drillDiameterMm: d.drillDiameterMm,
  });
  return {
    ...base(d),
    evidence: r.evidence,
    available_fill_ids: r.availableFillIds,
    status: witness ? 'GEOMETRIC_OVERLAP_CANDIDATE' : 'UNKNOWN',
    reason: witness
      ? 'Individual contour interior geometry only; not native flashing, physical span or electrical contact.'
      : 'No supported bounded interior witness; not evidence of disconnection.',
    ...(witness ? { witness } : {}),
  };
}
export async function optionalViaPourAnnulusReview(
  ctx: ToolContext,
  projectId: string,
  d: Declaration | undefined,
  source: RouteSource,
  readFocus: () => Promise<string | undefined>,
): Promise<{ native_via_pour_annulus_review?: Result }> {
  if (!d) return {};
  return { native_via_pour_annulus_review: await review(ctx, projectId, d, source, readFocus) };
}
async function review(
  ctx: ToolContext,
  projectId: string,
  d: Declaration,
  source: RouteSource,
  readFocus: () => Promise<string | undefined>,
): Promise<Result> {
  if (
    !source.complete ||
    !source.focusedPcbId ||
    !ctx.bridge.connected ||
    ctx.bridge.registryMismatch ||
    ctx.bridge.extensionVersionMismatch
  )
    return unavailable(d, 'Complete source-bound PCB inventory unavailable.');
  const via = matchingVia(d, source);
  if (!via) return unavailable(d, 'Requested via identity/net unavailable in route inventory.');
  if ((await readFocus()) !== source.focusedPcbId)
    return unavailable(d, 'Focused PCB changed before contour review.');
  try {
    const raw = await ctx.bridge.call(
      'pcb.listPourAnnulusGeometry',
      {
        projectId,
        kind: 'via',
        viaPrimitiveId: d.viaPrimitiveId,
        pourPrimitiveId: d.pourPrimitiveId,
        fillId: d.fillId,
        expectedNet: d.expectedNet,
        expectedLayer: d.expectedLayer,
      },
      { timeoutMs: 15000 },
    );
    if ((await readFocus()) !== source.focusedPcbId)
      return unavailable(d, 'Focused PCB changed during contour review.');
    return observed(d, raw, via);
  } catch {
    return unavailable(d, 'Native beta source-linked contour getter unavailable.');
  }
}
