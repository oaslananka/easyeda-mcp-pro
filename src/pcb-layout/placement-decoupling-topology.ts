import type { NativePadPairDeclaration, NativePadPairFinding } from './placement-pad-evidence.js';

export interface DecouplingLegs {
  supplyNet: string;
  returnNet: string;
}

interface LegObservation {
  expected_net: string;
  pad_pair_index: number;
  evidence: 'observed_line_chain' | 'unavailable';
}

export interface DecouplingTopology {
  evidence: 'both_line_chains_observed' | 'one_line_chain_observed' | 'unavailable';
  supply: LegObservation;
  return: LegObservation;
  electrical_loop_status: 'UNKNOWN';
  limitations: string[];
}

/** Validate explicit functional roles; never infer roles from net names or proximity. */
export function validDecouplingLegs(
  kind: string,
  legs: DecouplingLegs,
  pairs: readonly NativePadPairDeclaration[] | undefined,
): boolean {
  if (kind !== 'decoupling' || legs.supplyNet === legs.returnNet || pairs?.length !== 2)
    return false;
  const [a, b] = pairs;
  if (!a || !b || a.firstPin === b.firstPin || a.secondPin === b.secondPin) return false;
  return (
    pairs.some((p) => p.expectedNet === legs.supplyNet) &&
    pairs.some((p) => p.expectedNet === legs.returnNet)
  );
}

function hasCentreChain(observed: NativePadPairFinding): boolean {
  const associations = observed.native_pad_associations;
  const chain = associations?.associated_route_chain;
  return (
    associations?.evidence === 'native_reported_centre' &&
    chain?.evidence === 'observed_associated_endpoint_chain' &&
    chain.primitive_ids.length > 0
  );
}

function matchesLeg(
  declared: NativePadPairDeclaration | undefined,
  observed: NativePadPairFinding | undefined,
): boolean {
  if (!declared || !observed || observed.evidence !== 'native_component_pads') return false;
  const ids = observed.native_pad_primitive_ids;
  return (
    ids?.length === 2 &&
    ids[0] !== ids[1] &&
    observed.first_pin === declared.firstPin &&
    observed.second_pin === declared.secondPin &&
    observed.expected_net === declared.expectedNet &&
    observed.native_first_net === declared.expectedNet &&
    observed.native_second_net === declared.expectedNet &&
    hasCentreChain(observed)
  );
}

function legObservation(
  net: string,
  declarations: readonly NativePadPairDeclaration[],
  findings: readonly NativePadPairFinding[],
  complete: boolean,
): LegObservation {
  const index = declarations.findIndex((p) => p.expectedNet === net);
  return {
    expected_net: net,
    pad_pair_index: index,
    evidence:
      complete && matchesLeg(declarations[index], findings[index])
        ? 'observed_line_chain'
        : 'unavailable',
  };
}

/** Groups independently validated line observations, not a measured current loop. */
export function reviewDecouplingTopology(
  legs: DecouplingLegs,
  declarations: readonly NativePadPairDeclaration[],
  findings: readonly NativePadPairFinding[],
  complete: boolean,
): DecouplingTopology {
  const ids = findings.flatMap((p) => p.native_pad_primitive_ids ?? []);
  const usable = complete && new Set(ids).size === ids.length;
  const supply = legObservation(legs.supplyNet, declarations, findings, usable);
  const ret = legObservation(legs.returnNet, declarations, findings, usable);
  const count =
    Number(supply.evidence === 'observed_line_chain') +
    Number(ret.evidence === 'observed_line_chain');
  return {
    evidence:
      count === 2
        ? 'both_line_chains_observed'
        : count === 1
          ? 'one_line_chain_observed'
          : 'unavailable',
    supply,
    return: ret,
    electrical_loop_status: 'UNKNOWN',
    limitations: [
      'Supply and return roles are caller-declared, not a verified circuit model.',
      'Centre-only pad associations and same-layer line endpoint chains do not prove a closed electrical loop, plane continuity, physical path length, or placement adequacy.',
    ],
  };
}
