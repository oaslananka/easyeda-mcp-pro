import type { PlacementFinding, PlacementRelation } from './placement-evidence.js';
import type { NativePadPairDeclaration, NativePadPairFinding } from './placement-pad-evidence.js';
import { linePathEvidence } from './placement-priorities.js';

export const switchingLoopRoles = ['input', 'switch', 'return'] as const;
type Role = (typeof switchingLoopRoles)[number];
type Relation = PlacementRelation & { switchingLoopLeg?: Role };

interface DeclaredLeg {
  role: Role;
  index: number;
  first: string;
  second: string;
  pair: NativePadPairDeclaration;
  source: string;
}

function declaredLeg(relation: Relation, index: number): DeclaredLeg | undefined {
  const pair = relation.padPairs?.[0];
  if (
    !relation.switchingLoopLeg ||
    relation.kind !== 'switching-loop' ||
    relation.padPairs?.length !== 1 ||
    !pair ||
    !relation.constraintSource
  )
    return;
  return {
    role: relation.switchingLoopLeg,
    index,
    first: relation.first,
    second: relation.second,
    pair,
    source: relation.constraintSource,
  };
}

/** A declared, directed nonsynchronous buck commutation loop, not inferred topology. */
export function selectSwitchingLoopLegs(
  relations: readonly Relation[],
): [DeclaredLeg, DeclaredLeg, DeclaredLeg] | undefined {
  const selected = relations.flatMap((relation, index) =>
    relation.switchingLoopLeg ? [{ relation, index }] : [],
  );
  if (selected.length !== 3) return;
  const legs = switchingLoopRoles.map((role) => {
    const match = selected.find(({ relation }) => relation.switchingLoopLeg === role);
    return match && declaredLeg(match.relation, match.index);
  });
  const [input, sw, ret] = legs;
  if (!input || !sw || !ret) return;
  if (
    new Set([input.first, input.second, sw.second]).size !== 3 ||
    input.second !== sw.first ||
    sw.second !== ret.first ||
    ret.second !== input.first ||
    new Set([input.pair.expectedNet, sw.pair.expectedNet, ret.pair.expectedNet]).size !== 3 ||
    input.pair.secondPin === sw.pair.firstPin ||
    sw.pair.secondPin === ret.pair.firstPin ||
    ret.pair.secondPin === input.pair.firstPin
  )
    return;
  return [input, sw, ret];
}

/** Check shared raw pad identities before per-pair validation discards an aliased collection. */
export function switchingPadIdentitiesConsistent(
  legs: readonly DeclaredLeg[],
  observations: ReadonlyMap<string, unknown>,
): boolean {
  const components = new Set(legs.flatMap((leg) => [leg.first, leg.second]));
  const ids = new Set<string>();
  for (const component of components) {
    const pads = observations.get(component);
    if (!Array.isArray(pads)) continue;
    if (pads.length > 128) return false;
    for (const pad of pads) {
      const id: unknown = pad?.primitiveId;
      if (typeof id !== 'string' || !id || id !== id.trim()) continue;
      if (ids.has(id)) return false;
      ids.add(id);
    }
  }
  return true;
}

function matchingPair(
  leg: DeclaredLeg,
  findings: readonly PlacementFinding[],
): NativePadPairFinding | undefined {
  const finding = findings[leg.index];
  const pair = finding?.pad_pairs?.[0];
  if (
    finding?.evidence !== 'native_component_origins' ||
    finding.relation !== 'switching-loop' ||
    finding.components[0] !== leg.first ||
    finding.components[1] !== leg.second ||
    finding.pad_pairs?.length !== 1 ||
    pair?.first_pin !== leg.pair.firstPin ||
    pair.second_pin !== leg.pair.secondPin ||
    pair.expected_net !== leg.pair.expectedNet
  )
    return;
  return pair;
}

function summarizeLeg(leg: DeclaredLeg, pair: NativePadPairFinding | undefined) {
  const path = linePathEvidence(
    pair ?? {
      first_pin: leg.pair.firstPin,
      second_pin: leg.pair.secondPin,
      expected_net: leg.pair.expectedNet,
      status: 'UNKNOWN',
      evidence: 'unavailable',
      reasons: [],
      electrical_loop_status: 'UNKNOWN',
    },
  );
  const wrongNet =
    pair?.evidence === 'native_component_pads' &&
    (pair.native_first_net !== pair.expected_net || pair.native_second_net !== pair.expected_net);
  return {
    ...path,
    role: leg.role,
    components: [leg.first, leg.second],
    constraint_source: leg.source,
    next_action: wrongNet
      ? ('verify-declared-net' as const)
      : path.evidence === 'unavailable'
        ? ('collect-line-path-evidence' as const)
        : ('review-observed-line-chain' as const),
  };
}

/** Groups per-pair observations without deriving physical loop length, area, or continuity. */
export function reviewSwitchingLoopTopology(
  legs: readonly DeclaredLeg[],
  findings: readonly PlacementFinding[],
  complete: boolean,
) {
  const pairs = legs.map((leg) => matchingPair(leg, findings));
  const padIds = pairs.flatMap((pair) => pair?.native_pad_primitive_ids ?? []);
  const usable = complete && new Set(padIds).size === padIds.length;
  const observations = legs.map((leg, index) =>
    summarizeLeg(leg, usable ? pairs[index] : undefined),
  );
  const missing = observations
    .filter((leg) => leg.evidence === 'unavailable')
    .map((leg) => leg.role);
  return {
    evidence:
      missing.length === 0
        ? ('all_line_chains_observed' as const)
        : missing.length === observations.length
          ? ('unavailable' as const)
          : ('partial_line_chains_observed' as const),
    legs: observations,
    missing_roles: missing,
    electrical_loop_status: 'UNKNOWN' as const,
    engineering_sign_off: false as const,
    limitations: [
      'Roles are caller-declared for a nonsynchronous buck commutation loop; component function and circuit topology are not verified.',
      'Selected same-layer line chains do not prove physical contact, a closed electrical loop, loop area, return-current geometry, inductance, or placement adequacy.',
      'An unavailable line chain is not evidence of disconnection; collect remaining plane, via and physical contact evidence.',
    ],
  };
}
