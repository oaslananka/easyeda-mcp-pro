import { z } from 'zod';
import type { PlacementFinding } from '../pcb-layout/placement-evidence.js';
import type { reviewSwitchingLoopTopology } from '../pcb-layout/placement-switching-topology.js';
import type { pourAnnulusResultSchema } from './pcb-pour-annulus-review.js';

type Annulus = z.infer<typeof pourAnnulusResultSchema>;
type ReturnLeg = ReturnType<typeof reviewSwitchingLoopTopology>['legs'][number];
const common = {
  expected_net: z.string(),
  electrical_continuity_status: z.literal('UNKNOWN'),
  engineering_sign_off: z.literal(false),
  limitation: z.string(),
};
export const switchingReturnPourEvidenceSchema = z.discriminatedUnion('evidence', [
  z.object({
    ...common,
    evidence: z.literal('same_contour_pad_overlap_candidates'),
    pour_primitive_id: z.string(),
    fill_id: z.string(),
    native_layer: z.union([z.literal(1), z.literal(2)]),
    native_pad_primitive_ids: z.array(z.string()).length(2),
    next_action: z.literal('review-physical-return-path'),
  }),
  z.object({
    ...common,
    evidence: z.literal('unavailable'),
    reason: z.enum([
      'return-identity-unavailable',
      'pour-source-unavailable',
      'return-pad-mismatch',
      'same-contour-witness-unavailable',
    ]),
    next_action: z.literal('verify-return-pad-pour-evidence'),
  }),
]);
type Evidence = z.infer<typeof switchingReturnPourEvidenceSchema>;
type UnavailableReason = Extract<Evidence, { evidence: 'unavailable' }>['reason'];
const limitation =
  'Same-contour geometric overlap candidates are not physical contact, a common electrical return path, current capacity or electrical loop proof. Native reads are focus-bound, not an atomic board snapshot.';

function exactReturnPads(leg: ReturnLeg, finding: PlacementFinding | undefined, annulus: Annulus) {
  const ids = leg.native_pad_primitive_ids;
  if (!ids || finding?.primitive_ids.length !== 2) return;
  const pins = [leg.first_pin, leg.second_pin];
  const matched = ids.map((id, i) =>
    annulus.pads.filter(
      (p) =>
        p.primitiveId === id &&
        p.component_primitive_id === finding.primitive_ids[i] &&
        p.designator === leg.components[i] &&
        p.pad_number === pins[i],
    ),
  );
  if (matched.some((p) => p.length !== 1)) return;
  return matched.flat();
}

function sameContourFill(pads: Annulus['pads']): string | undefined {
  const [a, b] = pads;
  if (
    !a?.fill_id ||
    !b ||
    a.fill_id !== b.fill_id ||
    pads.some((p) => p.status !== 'GEOMETRIC_OVERLAP_CANDIDATE' || !p.witness)
  )
    return;
  return a.fill_id;
}

/** Correlate already source-validated results; never re-read or infer connectivity. */
export function correlateSwitchingReturnPour(
  leg: ReturnLeg | undefined,
  finding: PlacementFinding | undefined,
  annulus: Annulus | undefined,
): { return_pour_evidence?: Evidence } {
  if (!annulus || !leg) return {};
  const base = {
    expected_net: leg.expected_net,
    electrical_continuity_status: 'UNKNOWN' as const,
    engineering_sign_off: false as const,
    limitation,
  };
  const unavailable = (reason: UnavailableReason): { return_pour_evidence: Evidence } => ({
    return_pour_evidence: {
      ...base,
      evidence: 'unavailable',
      reason,
      next_action: 'verify-return-pad-pour-evidence',
    },
  });
  if (!leg.native_pad_primitive_ids || finding?.evidence !== 'native_component_origins')
    return unavailable('return-identity-unavailable');
  if (
    annulus.evidence !== 'native_source_linked_filled_region' ||
    annulus.native_layer === undefined ||
    annulus.native_layer !== annulus.expected_layer
  )
    return unavailable('pour-source-unavailable');
  if (annulus.expected_net !== leg.expected_net) return unavailable('return-pad-mismatch');
  const pads = exactReturnPads(leg, finding, annulus);
  if (!pads) return unavailable('return-pad-mismatch');
  const fillId = sameContourFill(pads);
  if (!fillId) return unavailable('same-contour-witness-unavailable');
  return {
    return_pour_evidence: {
      ...base,
      evidence: 'same_contour_pad_overlap_candidates',
      pour_primitive_id: annulus.pour_primitive_id,
      fill_id: fillId,
      native_layer: annulus.native_layer,
      native_pad_primitive_ids: leg.native_pad_primitive_ids,
      next_action: 'review-physical-return-path',
    },
  };
}
