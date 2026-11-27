import type { PlacementFinding, PlacementRelation } from './placement-evidence.js';
import type { NativePadPairDeclaration, NativePadPairFinding } from './placement-pad-evidence.js';
import { linePathEvidence } from './placement-priorities.js';
import { switchingPadIdentitiesConsistent } from './placement-switching-topology.js';

export const crystalNetworkRoles = [
  'oscillator-in',
  'oscillator-out',
  'load-in',
  'load-out',
] as const;
type Role = (typeof crystalNetworkRoles)[number];
type Relation = PlacementRelation & { crystalNetworkLeg?: Role };

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
    !relation.crystalNetworkLeg ||
    relation.kind !== 'crystal' ||
    relation.padPairs?.length !== 1 ||
    !pair ||
    !relation.constraintSource
  )
    return;
  return {
    role: relation.crystalNetworkLeg,
    index,
    first: relation.first,
    second: relation.second,
    pair,
    source: relation.constraintSource,
  };
}

/** Explicit two-pin oscillator and two distinct load components; no inference from net names. */
export function selectCrystalNetworkLegs(relations: readonly Relation[]) {
  const selected = relations.flatMap((relation, index) =>
    relation.crystalNetworkLeg ? [{ relation, index }] : [],
  );
  if (selected.length !== 4) return;
  const [input, output, loadIn, loadOut] = crystalNetworkRoles.map((role) => {
    const match = selected.find(({ relation }) => relation.crystalNetworkLeg === role);
    return match && declaredLeg(match.relation, match.index);
  });
  if (!input || !output || !loadIn || !loadOut) return;
  if (
    new Set([input.first, input.second, loadIn.second, loadOut.second]).size !== 4 ||
    input.first !== output.first ||
    input.second !== output.second ||
    input.pair.firstPin === output.pair.firstPin ||
    input.pair.secondPin === output.pair.secondPin ||
    input.pair.expectedNet === output.pair.expectedNet ||
    !matchesLoad(input, loadIn) ||
    !matchesLoad(output, loadOut)
  )
    return;
  return [input, output, loadIn, loadOut] as const;
}

function matchesLoad(signal: DeclaredLeg, load: DeclaredLeg): boolean {
  return (
    signal.second === load.first &&
    signal.pair.secondPin === load.pair.firstPin &&
    signal.pair.expectedNet === load.pair.expectedNet
  );
}

function matchingPair(
  leg: DeclaredLeg,
  finding: PlacementFinding | undefined,
): NativePadPairFinding | undefined {
  const pair = finding?.pad_pairs?.[0];
  if (
    finding?.evidence !== 'native_component_origins' ||
    finding.relation !== 'crystal' ||
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

/** One-to-one identity mapping, allowing the same logical crystal pad to recur. */
function addIdentity(
  forward: Map<string, string>,
  reverse: Map<string, string>,
  logical: string,
  native: string,
): boolean {
  if (
    !native ||
    native.trim() !== native ||
    (forward.has(logical) && forward.get(logical) !== native) ||
    (reverse.has(native) && reverse.get(native) !== logical)
  )
    return false;
  forward.set(logical, native);
  reverse.set(native, logical);
  return true;
}

function groupIdentitiesConsistent(
  legs: readonly DeclaredLeg[],
  findings: readonly PlacementFinding[],
  pairs: readonly (NativePadPairFinding | undefined)[],
) {
  const componentIds = new Map<string, string>();
  const componentNames = new Map<string, string>();
  const padIds = new Map<string, string>();
  const padNames = new Map<string, string>();
  for (const [i, leg] of legs.entries()) {
    const finding = findings[leg.index];
    if (finding?.evidence === 'native_component_origins') {
      const [first, second] = finding.primitive_ids;
      if (
        !first ||
        !second ||
        !addIdentity(componentIds, componentNames, leg.first, first) ||
        !addIdentity(componentIds, componentNames, leg.second, second)
      )
        return false;
    }
    const ids = pairs[i]?.native_pad_primitive_ids;
    if (!ids) continue;
    const [first, second] = ids;
    if (
      !first ||
      !second ||
      !addIdentity(padIds, padNames, JSON.stringify([leg.first, leg.pair.firstPin]), first) ||
      !addIdentity(padIds, padNames, JSON.stringify([leg.second, leg.pair.secondPin]), second)
    )
      return false;
  }
  return true;
}

function summarizeLeg(leg: DeclaredLeg, pair: NativePadPairFinding | undefined) {
  const path = linePathEvidence(
    pair ?? {
      first_pin: leg.pair.firstPin,
      second_pin: leg.pair.secondPin,
      expected_net: leg.pair.expectedNet,
      evidence: 'unavailable',
      status: 'UNKNOWN',
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

/** Group the existing bounded observations, never sum shared segments or certify oscillator behavior. */
export function reviewCrystalNetworkTopology(
  legs: readonly DeclaredLeg[],
  findings: readonly PlacementFinding[],
  pads: ReadonlyMap<string, unknown>,
  complete: boolean,
) {
  const pairs = legs.map((leg) => matchingPair(leg, findings[leg.index]));
  const usable =
    complete &&
    switchingPadIdentitiesConsistent(legs, pads) &&
    groupIdentitiesConsistent(legs, findings, pairs);
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
    electrical_continuity_status: 'UNKNOWN' as const,
    engineering_sign_off: false as const,
    limitations: [
      'Roles are caller-declared; crystal function, load capacitance and circuit topology are not verified.',
      'Selected line chains can share segments. They do not establish physical pad contact, electrical continuity, ground return, oscillator startup, drive level, EMI or placement adequacy.',
      'Unavailable line evidence is not proof of disconnection.',
    ],
  };
}
