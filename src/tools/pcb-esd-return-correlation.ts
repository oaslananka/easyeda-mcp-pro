import { z } from 'zod';
import type { PlacementFinding, PlacementRelation } from '../pcb-layout/placement-evidence.js';
import type { NativePadPairFinding } from '../pcb-layout/placement-pad-evidence.js';
import { switchingPadIdentitiesConsistent } from '../pcb-layout/placement-switching-topology.js';
import type { NativeTrack, NativeVia } from '../pcb-layout/route-review.js';
import {
  nativeViaPourAnnulusSchema,
  optionalViaPourAnnulusReview,
  viaPourAnnulusResultSchema,
} from './pcb-via-pour-annulus-review.js';
import {
  optionalViaAdjacencyReview,
  viaAdjacencyResultSchema,
} from './pcb-via-adjacency-review.js';
import type { ToolContext } from './types.js';

const fields = nativeViaPourAnnulusSchema.shape;
const viaSelection = z.object({
  viaPrimitiveId: fields.viaPrimitiveId,
  diameterMm: fields.diameterMm,
  drillDiameterMm: fields.drillDiameterMm,
  source: fields.source,
});
export const esdReturnViaPairSchema = z
  .object({
    pourPrimitiveId: fields.pourPrimitiveId,
    fillId: fields.fillId,
    expectedLayer: fields.expectedLayer,
    transform: fields.transform,
    vias: z.tuple([viaSelection, viaSelection]),
  })
  .refine(
    (d) =>
      new Set([d.pourPrimitiveId, ...d.vias.map((v) => v.viaPrimitiveId)]).size === 3 &&
      d.vias.every((v) => v.drillDiameterMm < v.diameterMm),
    'Select distinct vias, a distinct pour and positive annular dimensions.',
  );

type Relation = PlacementRelation & { esdReturnViaPair?: z.infer<typeof esdReturnViaPairSchema> };
type Adj = z.infer<typeof viaAdjacencyResultSchema>;
type Annulus = z.infer<typeof viaPourAnnulusResultSchema>;
type RawContacts = { first: unknown; second: unknown };
export type EsdPadContacts = Map<NativePadPairFinding, RawContacts>;

export function selectEsdReturn(relations: readonly Relation[]) {
  const matches = relations.flatMap((relation, index) =>
    relation.esdReturnViaPair ? [{ relation, index, selection: relation.esdReturnViaPair }] : [],
  );
  if (matches.length !== 1 || !matches[0]) return;
  const { relation, index, selection } = matches[0];
  const pair = relation.padPairs?.[0];
  if (
    relation.kind !== 'esd-entry' ||
    relation.first === relation.second ||
    relation.padPairs?.length !== 1 ||
    !pair ||
    !relation.constraintSource
  )
    return;
  return { relation, index, selection, pair, constraintSource: relation.constraintSource };
}

type Selected = NonNullable<ReturnType<typeof selectEsdReturn>>;
export type EsdReturnSource = {
  tracks: NativeTrack[];
  vias: NativeVia[];
  complete: boolean;
  focusedPcbId?: string;
  pads?: Map<string, unknown>;
  contacts?: EsdPadContacts;
};
const endpointBase = {
  component: z.string(),
  pin: z.string(),
  via_primitive_id: z.string(),
};
const endpointSchema = z.discriminatedUnion('evidence', [
  z.object({
    ...endpointBase,
    evidence: z.literal('selected_contour_candidate'),
    native_pad_primitive_id: z.string(),
    line_primitive_id: z.string(),
    line_native_layer: z.number(),
    witness: viaPourAnnulusResultSchema.shape.witness.unwrap(),
    next_action: z.literal('review-physical-return-path'),
  }),
  z.object({
    ...endpointBase,
    evidence: z.literal('unavailable'),
    reason: z.enum([
      'source-unavailable',
      'reciprocal-anchor-unavailable',
      'contour-candidate-unavailable',
    ]),
    next_action: z.literal('collect-return-evidence'),
  }),
]);
type Endpoint = z.infer<typeof endpointSchema>;
export const esdReturnViaEvidenceSchema = z.object({
  evidence: z.enum([
    'both_selected_contour_candidates',
    'partial_selected_contour_candidates',
    'unavailable',
  ]),
  expected_net: z.string(),
  constraint_source: z.string(),
  pour_primitive_id: z.string(),
  fill_id: z.string(),
  native_layer: z.number(),
  endpoints: z.tuple([endpointSchema, endpointSchema]),
  electrical_continuity_status: z.literal('UNKNOWN'),
  physical_span_status: z.literal('UNKNOWN'),
  engineering_sign_off: z.literal(false),
  limitations: z.array(z.string()),
});
type Result = z.infer<typeof esdReturnViaEvidenceSchema>;

function uniqueIds(ids: readonly string[]): boolean {
  return ids.every((id) => id.length > 0 && id === id.trim()) && new Set(ids).size === ids.length;
}

function matchingFinding(
  selected: Selected,
  finding: PlacementFinding | undefined,
  source: EsdReturnSource,
) {
  return source.complete &&
    source.pads &&
    finding?.evidence === 'native_component_origins' &&
    finding.relation === 'esd-entry' &&
    finding.components[0] === selected.relation.first &&
    finding.components[1] === selected.relation.second &&
    finding.primitive_ids.length === 2 &&
    switchingPadIdentitiesConsistent([selected.relation], source.pads)
    ? finding
    : undefined;
}

function matchingPadPair(selected: Selected, finding: PlacementFinding) {
  const p = finding.pad_pairs?.[0];
  if (
    p?.evidence !== 'native_component_pads' ||
    p.first_pin !== selected.pair.firstPin ||
    p.second_pin !== selected.pair.secondPin ||
    p.expected_net !== selected.pair.expectedNet ||
    p.native_first_net !== p.expected_net ||
    p.native_second_net !== p.expected_net ||
    p.native_pad_primitive_ids?.length !== 2 ||
    p.native_pad_layer_codes?.length !== 2 ||
    !p.native_pad_associations ||
    p.native_pad_associations.evidence === 'unavailable'
  )
    return;
  return { pair: p, padIds: p.native_pad_primitive_ids };
}

function validPair(
  selected: Selected,
  candidate: PlacementFinding | undefined,
  source: EsdReturnSource,
) {
  const finding = matchingFinding(selected, candidate, source);
  if (!finding) return;
  const matched = matchingPadPair(selected, finding);
  if (!matched) return;
  const baseIds = [...finding.primitive_ids, ...matched.padIds, selected.selection.pourPrimitiveId];
  const ids = [...baseIds, ...selected.selection.vias.map((v) => v.viaPrimitiveId)];
  if (
    !uniqueIds(ids) ||
    source.tracks.some((t) => t.primitiveId && ids.includes(t.primitiveId)) ||
    source.vias.some((v) => v.primitiveId && baseIds.includes(v.primitiveId))
  )
    return;
  return matched.pair;
}

const rawLineContacts = z.object({
  connected: z
    .array(
      z.object({
        primitiveId: z.string(),
        nativeType: z.string(),
        net: z.string(),
        layer: z.number(),
      }),
    )
    .max(128),
});
function reciprocalAnchor(
  p: NativePadPairFinding,
  raw: unknown,
  adjacency: Adj | undefined,
  i: number,
) {
  if (
    adjacency?.evidence !== 'native_reciprocal_line_associations' ||
    adjacency.expected_net !== p.expected_net
  )
    return;
  const contacts = rawLineContacts.safeParse(raw);
  if (!contacts.success) return;
  const ids =
    i === 0
      ? p.native_pad_associations?.first_primitive_ids
      : p.native_pad_associations?.second_primitive_ids;
  const layer = p.native_pad_layer_codes?.[i];
  const matches = adjacency.lines.filter(
    (l) =>
      ids?.includes(l.primitive_id) &&
      l.native_layer === layer &&
      contacts.data.connected.some(
        (c) =>
          c.primitiveId === l.primitive_id &&
          c.nativeType === 'Line' &&
          c.net === p.expected_net &&
          c.layer === l.native_layer,
      ),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function contourWitness(selected: Selected, i: 0 | 1, ann: Annulus | undefined) {
  const { selection, pair } = selected;
  if (
    ann?.via_primitive_id !== selection.vias[i].viaPrimitiveId ||
    !ann ||
    ann.evidence !== 'native_source_linked_via_contour' ||
    ann.status !== 'GEOMETRIC_OVERLAP_CANDIDATE' ||
    ann.expected_net !== pair.expectedNet ||
    ann.pour_primitive_id !== selection.pourPrimitiveId ||
    ann.fill_id !== selection.fillId ||
    ann.expected_layer !== selection.expectedLayer
  )
    return;
  return ann.witness;
}

function endpoint(
  selected: Selected,
  i: 0 | 1,
  p: NativePadPairFinding | undefined,
  raw: RawContacts | undefined,
  adj: Adj | undefined,
  ann: Annulus | undefined,
): Endpoint {
  const v = selected.selection.vias[i];
  const base = {
    component: i === 0 ? selected.relation.first : selected.relation.second,
    pin: i === 0 ? selected.pair.firstPin : selected.pair.secondPin,
    via_primitive_id: v.viaPrimitiveId,
  };
  const unavailable = (
    reason:
      'source-unavailable' | 'reciprocal-anchor-unavailable' | 'contour-candidate-unavailable',
  ): Endpoint => ({
    ...base,
    evidence: 'unavailable',
    reason,
    next_action: 'collect-return-evidence',
  });
  const pad = p?.native_pad_primitive_ids?.[i];
  if (!p || !pad || !raw) return unavailable('source-unavailable');
  const anchor =
    adj?.via_primitive_id === v.viaPrimitiveId
      ? reciprocalAnchor(p, i === 0 ? raw.first : raw.second, adj, i)
      : undefined;
  if (!anchor) return unavailable('reciprocal-anchor-unavailable');
  const witness = contourWitness(selected, i, ann);
  if (!witness) return unavailable('contour-candidate-unavailable');
  return {
    ...base,
    evidence: 'selected_contour_candidate',
    native_pad_primitive_id: pad,
    line_primitive_id: anchor.primitive_id,
    line_native_layer: anchor.native_layer,
    witness,
    next_action: 'review-physical-return-path',
  };
}

function result(selected: Selected, endpoints: [Endpoint, Endpoint]): Result {
  const count = endpoints.filter((e) => e.evidence === 'selected_contour_candidate').length;
  return {
    evidence:
      count === 2
        ? 'both_selected_contour_candidates'
        : count === 1
          ? 'partial_selected_contour_candidates'
          : 'unavailable',
    expected_net: selected.pair.expectedNet,
    constraint_source: selected.constraintSource,
    pour_primitive_id: selected.selection.pourPrimitiveId,
    fill_id: selected.selection.fillId,
    native_layer: selected.selection.expectedLayer,
    endpoints,
    electrical_continuity_status: 'UNKNOWN',
    physical_span_status: 'UNKNOWN',
    engineering_sign_off: false,
    limitations: [
      'Caller-selected ESD return identities and sources are not independently authenticated as circuit function.',
      'Reciprocal native line associations and individual annular witnesses on the same selected contour identity are separate focus-bound reads, not an atomic plane or proof of physical contact, flashing, return current or electrical continuity.',
      'Unavailable evidence is not proof of disconnection. No ESD immunity or engineering approval is established.',
    ],
  };
}

async function sourceStillCurrent(
  ctx: ToolContext,
  source: EsdReturnSource,
  readFocus: () => Promise<string | undefined>,
) {
  return (
    !!source.focusedPcbId &&
    (await readFocus()) === source.focusedPcbId &&
    ctx.bridge.connected &&
    !ctx.bridge.registryMismatch &&
    !ctx.bridge.extensionVersionMismatch
  );
}

/** Reuse existing bounded source validators, with one final focus check across all reads. */
export async function reviewEsdReturn(
  ctx: ToolContext,
  projectId: string,
  selected: Selected,
  finding: PlacementFinding | undefined,
  source: EsdReturnSource,
  readFocus: () => Promise<string | undefined>,
): Promise<Result> {
  const unavailable = () =>
    result(selected, [
      endpoint(selected, 0, undefined, undefined, undefined, undefined),
      endpoint(selected, 1, undefined, undefined, undefined, undefined),
    ]);
  const p = validPair(selected, finding, source);
  if (!p || !(await sourceStillCurrent(ctx, source, readFocus))) return unavailable();
  const raw = source.contacts?.get(p);
  if (!raw) return unavailable();
  const { vias, ...contour } = selected.selection;
  const { via_adjacency_review: adjacency } = await optionalViaAdjacencyReview(
    ctx,
    projectId,
    vias.map((v) => ({ viaPrimitiveId: v.viaPrimitiveId, expectedNet: p.expected_net })),
    source,
    readFocus,
  );
  const annuli = [];
  for (const v of vias) {
    const r = await optionalViaPourAnnulusReview(
      ctx,
      projectId,
      { ...contour, ...v, expectedNet: p.expected_net },
      source,
      readFocus,
    );
    annuli.push(r.native_via_pour_annulus_review);
  }
  if (!(await sourceStillCurrent(ctx, source, readFocus))) return unavailable();
  const a = endpoint(selected, 0, p, raw, adjacency?.[0], annuli[0]);
  const b = endpoint(selected, 1, p, raw, adjacency?.[1], annuli[1]);
  if (
    a.evidence === 'selected_contour_candidate' &&
    b.evidence === 'selected_contour_candidate' &&
    a.line_primitive_id === b.line_primitive_id
  )
    return unavailable();
  return result(selected, [a, b]);
}
