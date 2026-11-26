import { z } from 'zod';
import {
  nativeCopperLayerCode,
  type NativeTrack,
  type NativeVia,
} from '../pcb-layout/route-review.js';
import type { ToolContext } from './types.js';

const exactId = z
  .string()
  .min(1)
  .max(128)
  .refine((v) => v.trim() === v);
const exactNet = z
  .string()
  .min(1)
  .max(100)
  .refine((v) => v.trim() === v);
const layer = z.number().refine(nativeCopperLayerCode);

const declarationSchema = z.object({
  viaPrimitiveId: exactId,
  expectedNet: exactNet,
  includeViaTypeMetadata: z.literal(true).optional(),
});
type Declaration = z.infer<typeof declarationSchema>;

export const nativeViaAdjacencySchema = z
  .array(declarationSchema)
  .min(1)
  .max(4)
  .refine(
    (items) => new Set(items.map((v) => v.viaPrimitiveId)).size === items.length,
    'Requested via identities must be unique.',
  );

const bridgeReplySchema = z.object({
  evidence: z.literal('native_reciprocal_line_associations'),
  viaPrimitiveId: exactId,
  net: exactNet,
  lines: z.array(z.object({ primitiveId: exactId, layer })).max(16),
  electricalContinuity: z.literal('UNKNOWN'),
  viaTypeMetadata: z.unknown().optional(),
});

const noBlindRule = z.union([z.literal(''), z.null()]);
const nativeTypeMetadataSchema = z
  .object({
    evidence: z.literal('native_reported_via_type'),
    physicalSpanStatus: z.literal('UNKNOWN'),
  })
  .and(
    z.union([
      z.object({
        viaType: z.literal(0),
        designRuleBlindViaName: noBlindRule,
        spanIntent: z.literal('through_outer_layers'),
      }),
      z.object({
        viaType: z.literal(1),
        designRuleBlindViaName: exactId,
        spanIntent: z.literal('blind_rule_unresolved'),
      }),
      z.object({
        viaType: z.literal(2),
        designRuleBlindViaName: noBlindRule,
        spanIntent: z.literal('stitching_span_unresolved'),
      }),
    ]),
  );

const viaTypeResultSchema = z
  .object({
    physical_span_status: z.literal('UNKNOWN'),
  })
  .and(
    z.union([
      z.object({ evidence: z.literal('unavailable'), span_intent: z.literal('unavailable') }),
      z.object({
        evidence: z.literal('native_reported_via_type'),
        native_via_type: z.literal(0),
        design_rule_blind_via_name: noBlindRule,
        span_intent: z.literal('through_outer_layers'),
      }),
      z.object({
        evidence: z.literal('native_reported_via_type'),
        native_via_type: z.literal(1),
        design_rule_blind_via_name: exactId,
        span_intent: z.literal('blind_rule_unresolved'),
      }),
      z.object({
        evidence: z.literal('native_reported_via_type'),
        native_via_type: z.literal(2),
        design_rule_blind_via_name: noBlindRule,
        span_intent: z.literal('stitching_span_unresolved'),
      }),
    ]),
  );
type ViaTypeObservation = z.infer<typeof viaTypeResultSchema>;

function viaTypeMetadata(raw: unknown): ViaTypeObservation {
  const result = nativeTypeMetadataSchema.safeParse(raw);
  if (!result.success)
    return { evidence: 'unavailable', span_intent: 'unavailable', physical_span_status: 'UNKNOWN' };
  const v = result.data;
  return viaTypeResultSchema.parse({
    evidence: v.evidence,
    native_via_type: v.viaType,
    design_rule_blind_via_name: v.designRuleBlindViaName,
    span_intent: v.spanIntent,
    physical_span_status: v.physicalSpanStatus,
  });
}

function optionalViaTypeMetadata(
  d: Declaration,
  raw?: unknown,
): { via_type_metadata?: ViaTypeObservation } {
  return d.includeViaTypeMetadata === true ? { via_type_metadata: viaTypeMetadata(raw) } : {};
}

export const viaAdjacencyResultSchema = z.object({
  via_primitive_id: exactId,
  expected_net: exactNet,
  evidence: z.enum(['native_reciprocal_line_associations', 'unavailable']),
  lines: z.array(z.object({ primitive_id: exactId, native_layer: layer })).max(16),
  cross_layer_candidate: z.boolean(),
  electrical_continuity_status: z.literal('UNKNOWN'),
  reason: z.string().optional(),
  via_type_metadata: viaTypeResultSchema.optional(),
});
type Observation = z.infer<typeof viaAdjacencyResultSchema>;

interface RouteSource {
  tracks: NativeTrack[];
  vias: NativeVia[];
  complete: boolean;
  focusedPcbId?: string;
}

function unavailable(d: Declaration, reason: string): Observation {
  return {
    via_primitive_id: d.viaPrimitiveId,
    expected_net: d.expectedNet,
    evidence: 'unavailable',
    lines: [],
    cross_layer_candidate: false,
    electrical_continuity_status: 'UNKNOWN',
    reason,
    ...optionalViaTypeMetadata(d),
  };
}

function validVia(d: Declaration, source: RouteSource): boolean {
  const matches = source.vias.filter((v) => v.primitiveId === d.viaPrimitiveId);
  return (
    matches.length === 1 &&
    matches[0]?.net === d.expectedNet &&
    !source.tracks.some((t) => t.primitiveId === d.viaPrimitiveId)
  );
}

function observed(d: Declaration, raw: unknown, source: RouteSource): Observation {
  const reply = bridgeReplySchema.safeParse(raw);
  if (
    !reply.success ||
    reply.data.viaPrimitiveId !== d.viaPrimitiveId ||
    reply.data.net !== d.expectedNet
  )
    return unavailable(d, 'Native reciprocal adjacency unavailable or identity mismatch.');
  const lines = reply.data.lines;
  if (
    new Set(lines.map((t) => t.primitiveId)).size !== lines.length ||
    lines.some((t) => !matchesTrack(t, d.expectedNet, source))
  )
    return unavailable(d, 'Native line identity does not match the route inventory.');
  return {
    via_primitive_id: d.viaPrimitiveId,
    expected_net: d.expectedNet,
    evidence: 'native_reciprocal_line_associations',
    lines: lines.map((t) => ({ primitive_id: t.primitiveId, native_layer: t.layer })),
    cross_layer_candidate: new Set(lines.map((t) => t.layer)).size > 1,
    electrical_continuity_status: 'UNKNOWN',
    ...optionalViaTypeMetadata(d, reply.data.viaTypeMetadata),
  };
}

function matchesTrack(
  t: { primitiveId: string; layer: number },
  net: string,
  source: RouteSource,
): boolean {
  const matches = source.tracks.filter((x) => x.primitiveId === t.primitiveId);
  return (
    matches.length === 1 &&
    matches[0]?.net === net &&
    matches[0]?.layer === t.layer &&
    !source.vias.some((v) => v.primitiveId === t.primitiveId)
  );
}

/** Explicitly selected via observations; no graph, physical continuity, or design writes. */
export async function reviewViaAdjacency(
  ctx: ToolContext,
  projectId: string,
  declarations: Declaration[],
  source: RouteSource,
  readFocus: () => Promise<string | undefined>,
): Promise<Observation[]> {
  if (
    !source.complete ||
    !source.focusedPcbId ||
    !ctx.bridge.connected ||
    ctx.bridge.registryMismatch ||
    ctx.bridge.extensionVersionMismatch
  )
    return declarations.map((d) =>
      unavailable(d, 'Complete source-bound route inventory unavailable.'),
    );
  const matchesFocus = async () => (await readFocus()) === source.focusedPcbId;
  const results: Observation[] = [];
  for (const d of declarations) {
    if (!validVia(d, source)) {
      results.push(unavailable(d, 'Requested via identity/net unavailable in route inventory.'));
      continue;
    }
    if (!(await matchesFocus()))
      return declarations.map((v) =>
        unavailable(v, 'Focused PCB changed during adjacency review.'),
      );
    try {
      const raw = await ctx.bridge.call(
        'pcb.listViaLineAdjacency',
        { projectId, ...d },
        { timeoutMs: 12000 },
      );
      results.push(observed(d, raw, source));
    } catch {
      results.push(unavailable(d, 'Native beta adjacency getter unavailable.'));
    }
    if (!(await matchesFocus()))
      return declarations.map((v) =>
        unavailable(v, 'Focused PCB changed during adjacency review.'),
      );
  }
  return results;
}

export async function optionalViaAdjacencyReview(
  ctx: ToolContext,
  projectId: string,
  declarations: Declaration[] | undefined,
  source: RouteSource,
  readFocus: () => Promise<string | undefined>,
): Promise<{ via_adjacency_review?: Observation[] }> {
  return declarations === undefined
    ? {}
    : {
        via_adjacency_review: await reviewViaAdjacency(
          ctx,
          projectId,
          declarations,
          source,
          readFocus,
        ),
      };
}
