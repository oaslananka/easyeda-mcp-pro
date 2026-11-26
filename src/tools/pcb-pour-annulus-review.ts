import { z } from 'zod';
import { reviewCopperAnnulusCandidates } from '../pcb-layout/copper-contact-candidates.js';
import type { ToolContext } from './types.js';

const exactId = z
  .string()
  .min(1)
  .max(128)
  .refine((v) => v.trim() === v);
const positive = z.number().finite().positive().max(1_000_000);
const source = z.string().trim().min(3).max(200);
const layer = z.union([z.literal(1), z.literal(2)]);
const transformSchema = z.object({ scale: positive, invertY: z.boolean(), source });
const padIdentity = z.object({
  componentPrimitiveId: exactId,
  designator: exactId,
  padNumber: exactId,
  primitiveId: exactId,
});
const drillDeclaration = padIdentity.extend({
  diameterMm: positive,
  nativeHoleMmPerUnit: positive,
  source,
});
export const nativePourAnnulusSchema = z
  .object({
    pourPrimitiveId: exactId,
    expectedNet: exactId,
    expectedLayer: layer,
    transform: transformSchema,
    pads: z.array(drillDeclaration).min(1).max(8),
  })
  .refine(
    (d) =>
      new Set(d.pads.map((p) => p.primitiveId)).size === d.pads.length &&
      new Set(d.pads.map((p) => JSON.stringify([p.componentPrimitiveId, p.padNumber]))).size ===
        d.pads.length &&
      d.pads.every(
        (p) =>
          p.primitiveId !== d.pourPrimitiveId &&
          p.componentPrimitiveId !== d.pourPrimitiveId &&
          p.primitiveId !== p.componentPrimitiveId,
      ),
    'Exact, distinct source and pad identities required.',
  );
type Declaration = z.infer<typeof nativePourAnnulusSchema>;

const nativePadSchema = padIdentity.extend({
  net: exactId,
  layer: z.literal(12),
  x: z.number().finite().min(-1_000_000).max(1_000_000),
  y: z.number().finite().min(-1_000_000).max(1_000_000),
  pad: z.tuple([z.literal('ELLIPSE'), positive, positive]),
  hole: z.union([
    z.tuple([z.literal('ROUND'), positive]),
    z.tuple([z.literal('ROUND'), positive, positive]),
  ]),
  metallization: z.literal(true),
  heatWelding: z.null(),
  holeOffsetX: z.literal(0),
  holeOffsetY: z.literal(0),
  specialPad: z.union([z.null(), z.array(z.never()).max(0)]),
});
const replySchema = z.object({
  evidence: z.literal('native_source_linked_filled_region'),
  pourPrimitiveId: exactId,
  net: exactId,
  layer,
  fill: z.object({
    id: exactId,
    fill: z.literal(true),
    lineWidth: z.literal(0),
    path: z.object({
      complexPolygon: z
        .array(
          z
            .array(z.union([z.literal('L'), z.number().finite().min(-1_000_000).max(1_000_000)]))
            .min(9)
            .max(8193),
        )
        .length(1),
    }),
  }),
  pads: z.array(nativePadSchema).min(1).max(8),
  electricalContinuity: z.literal('UNKNOWN'),
});
const resultPadSchema = z.object({
  primitiveId: exactId,
  component_primitive_id: exactId,
  designator: exactId,
  pad_number: exactId,
  status: z.enum(['GEOMETRIC_OVERLAP_CANDIDATE', 'UNKNOWN']),
  reason: z.string(),
  electrical_continuity_status: z.literal('UNKNOWN'),
  fill_id: exactId.optional(),
  drill_source: source.optional(),
  drill_diameter_mm: positive.optional(),
  native_hole_mm_per_unit: positive.optional(),
  witness: z
    .object({ x_mm: z.number().finite(), y_mm: z.number().finite(), minimum_margin_mm: positive })
    .optional(),
});
export const pourAnnulusResultSchema = z.object({
  evidence: z.enum(['native_source_linked_filled_region', 'unavailable']),
  pour_primitive_id: exactId,
  expected_net: exactId,
  expected_layer: layer,
  native_layer: layer.optional(),
  method: z.literal('READ_ONLY_FILLED_COPPER_ROUND_ANNULUS_SCREEN'),
  coordinate_frame: z.literal('native_pad_mm'),
  transform: transformSchema.optional(),
  overall_status: z.literal('UNKNOWN'),
  engineering_sign_off: z.literal(false),
  pads: z.array(resultPadSchema).max(8),
  limitations: z.array(z.string()),
});
type Result = z.infer<typeof pourAnnulusResultSchema>;
const limitations = [
  'Caller-declared coordinate transform and drill sources are not independently authenticated by this review.',
  'A bounded interior geometric witness is not electrical contact, plating, common return-path, or current capacity proof.',
  'No witness does not establish disconnection; unsupported geometry and unavailable source remain UNKNOWN.',
  'Independent native reads are focus-bound, not an atomic board snapshot.',
];

function requestedPad(p: Declaration['pads'][number]) {
  return {
    componentPrimitiveId: p.componentPrimitiveId,
    designator: p.designator,
    padNumber: p.padNumber,
    primitiveId: p.primitiveId,
  };
}
function resultIdentity(p: Declaration['pads'][number]) {
  return {
    primitiveId: p.primitiveId,
    component_primitive_id: p.componentPrimitiveId,
    designator: p.designator,
    pad_number: p.padNumber,
  };
}
function base(d: Declaration) {
  return {
    pour_primitive_id: d.pourPrimitiveId,
    expected_net: d.expectedNet,
    expected_layer: d.expectedLayer,
    method: 'READ_ONLY_FILLED_COPPER_ROUND_ANNULUS_SCREEN' as const,
    coordinate_frame: 'native_pad_mm' as const,
    overall_status: 'UNKNOWN' as const,
    engineering_sign_off: false as const,
    limitations,
  };
}
function unavailable(d: Declaration, reason: string): Result {
  return {
    ...base(d),
    evidence: 'unavailable',
    pads: d.pads.map((p) => ({
      ...resultIdentity(p),
      status: 'UNKNOWN',
      reason,
      electrical_continuity_status: 'UNKNOWN',
    })),
  };
}
function matchesReply(d: Declaration, reply: z.infer<typeof replySchema>): boolean {
  return (
    reply.pourPrimitiveId === d.pourPrimitiveId &&
    reply.net === d.expectedNet &&
    reply.layer === d.expectedLayer &&
    reply.pads.length === d.pads.length &&
    d.pads.every((p, i) => {
      const actual = reply.pads[i];
      return (
        actual?.primitiveId === p.primitiveId &&
        actual.componentPrimitiveId === p.componentPrimitiveId &&
        actual.padNumber === p.padNumber &&
        actual.designator === p.designator &&
        actual.net === d.expectedNet
      );
    })
  );
}
function observed(d: Declaration, raw: unknown): Result {
  const parsed = replySchema.safeParse(raw);
  if (!parsed.success || !matchesReply(d, parsed.data))
    return unavailable(d, 'Native source/selected pad identity or geometry unavailable.');
  const r = parsed.data;
  const result = reviewCopperAnnulusCandidates({
    pourNet: r.net,
    pourLayer: r.layer,
    pouredRegions: [r.fill],
    pads: r.pads,
    transform: d.transform,
    drills: d.pads,
  });
  return {
    ...base(d),
    evidence: 'native_source_linked_filled_region',
    native_layer: r.layer,
    transform: d.transform,
    pads: d.pads.map((p, i) => {
      const outcome = result.pads[i];
      return outcome
        ? { ...outcome, ...resultIdentity(p) }
        : {
            ...resultIdentity(p),
            status: 'UNKNOWN',
            reason: 'Pad geometry unavailable.',
            electrical_continuity_status: 'UNKNOWN',
          };
    }),
  };
}

/** A single explicit native pour and at most eight exact caller-declared pads. */
export async function optionalPourAnnulusReview(
  ctx: ToolContext,
  projectId: string,
  d: Declaration | undefined,
  source: { complete: boolean; focusedPcbId?: string },
  readFocus: () => Promise<string | undefined>,
): Promise<{ native_pour_annulus_review?: Result }> {
  if (!d) return {};
  const result = await review(ctx, projectId, d, source, readFocus);
  return { native_pour_annulus_review: result };
}
async function review(
  ctx: ToolContext,
  projectId: string,
  d: Declaration,
  source: { complete: boolean; focusedPcbId?: string },
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
  if ((await readFocus()) !== source.focusedPcbId)
    return unavailable(d, 'Focused PCB changed before annulus review.');
  try {
    const raw = await ctx.bridge.call(
      'pcb.listPourAnnulusGeometry',
      {
        projectId,
        pourPrimitiveId: d.pourPrimitiveId,
        expectedNet: d.expectedNet,
        expectedLayer: d.expectedLayer,
        pads: d.pads.map(requestedPad),
      },
      { timeoutMs: 15000 },
    );
    if ((await readFocus()) !== source.focusedPcbId)
      return unavailable(d, 'Focused PCB changed during annulus review.');
    return observed(d, raw);
  } catch {
    return unavailable(d, 'Native beta source-linked geometry getter unavailable.');
  }
}
