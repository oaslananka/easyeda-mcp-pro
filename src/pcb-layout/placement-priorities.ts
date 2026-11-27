import type { NativePadPairFinding } from './placement-pad-evidence.js';
import { nativeCopperLayerCode } from './route-review.js';
import type { PowerTreeIssue } from '../power-tree/index.js';
import type { PlacementFinding, PlacementKind } from './placement-evidence.js';

export type ConstraintSourceKind = 'datasheet-requirement' | 'advisory' | 'unspecified';

/** An explicitly caller-supplied excerpt of easyeda_power_tree_analyze issues. */
export type PlacementPowerIssue = Required<
  Pick<PowerTreeIssue, 'code' | 'severity' | 'componentRef' | 'railName'>
>;

export type PlacementPriorityAction =
  | 'verify-net-mismatch'
  | 'review-declared-requirement'
  | 'review-power-context'
  | 'review-selected-line-width'
  | 'review-observed-warning'
  | 'collect-topology-evidence';

export interface PlacementPriority {
  finding_id: string;
  relation: PlacementKind;
  components: string[];
  action: PlacementPriorityAction;
  constraint_source_kind: ConstraintSourceKind;
  power_context: PlacementPowerIssue[];
  width_deviations?: WidthDeviation[];
  line_path_evidence?: LinePathEvidence[];
  next_step: string;
  electrical_loop_status: 'UNKNOWN';
}

const actions: readonly PlacementPriorityAction[] = [
  'verify-net-mismatch',
  'review-declared-requirement',
  'review-power-context',
  'review-selected-line-width',
  'review-observed-warning',
  'collect-topology-evidence',
];

const topologySteps: Record<PlacementKind, string> = {
  decoupling: 'Verify supply and return pad paths, including plane/via contact.',
  'switching-loop': 'Verify input, switch and return paths against the device topology.',
  crystal: 'Verify separate oscillator pin/load paths and return geometry.',
  'esd-entry': 'Verify connector-to-protection path and protection return path.',
  feedback: 'Verify feedback path and separation from switching current paths.',
  'sensitive-adjacency': 'Verify sensitive net geometry and coupled current paths.',
};

function hasNetMismatch(finding: PlacementFinding): boolean {
  return (finding.pad_pairs ?? []).some(
    (p) =>
      p.evidence === 'native_component_pads' &&
      (p.native_first_net !== p.expected_net || p.native_second_net !== p.expected_net),
  );
}

function correlatedPowerIssues(
  finding: PlacementFinding,
  issues: readonly PlacementPowerIssue[],
): PlacementPowerIssue[] {
  const nets = new Set(
    (finding.pad_pairs ?? [])
      .filter(
        (p) =>
          p.evidence === 'native_component_pads' &&
          p.native_first_net === p.expected_net &&
          p.native_second_net === p.expected_net,
      )
      .map((p) => p.expected_net),
  );
  return issues.filter(
    (issue) =>
      issue.severity !== 'info' &&
      finding.components.includes(issue.componentRef) &&
      nets.has(issue.railName),
  );
}

interface WidthDeviation {
  first_pin: string;
  second_pin: string;
  expected_net: string;
  narrowest_line_ids: string[];
  observed_min_line_width_mm: number;
  declared_min_line_width_mm: number;
}

function widthDeviations(finding: PlacementFinding): WidthDeviation[] {
  return (finding.pad_pairs ?? []).flatMap((p) => {
    const w = p.selected_line_width_review;
    if (w?.status !== 'WARNING' || w.observed_min_line_width_mm === undefined) return [];
    return [
      {
        first_pin: p.first_pin,
        second_pin: p.second_pin,
        expected_net: p.expected_net,
        narrowest_line_ids: [...w.narrowest_line_ids],
        observed_min_line_width_mm: w.observed_min_line_width_mm,
        declared_min_line_width_mm: w.declared_min_line_width_mm,
      },
    ];
  });
}

interface LinePathEvidence {
  first_pin: string;
  second_pin: string;
  expected_net: string;
  native_pad_primitive_ids?: string[];
  evidence:
    'observed_exact_endpoint_chain' | 'native_reported' | 'native_reported_centre' | 'unavailable';
  primitive_ids: string[];
  native_layer?: number;
  electrical_continuity_status: 'UNKNOWN';
}

function exactIdentity(id: string): boolean {
  return id.length > 0 && id.trim() === id;
}

function distinctIdentities(ids: string[]): boolean {
  return ids.length > 0 && ids.every(exactIdentity) && new Set(ids).size === ids.length;
}

function sourcedPadIdentities(p: NativePadPairFinding): string[] | undefined {
  const ids = p.native_pad_primitive_ids;
  return p.evidence === 'native_component_pads' &&
    exactIdentity(p.expected_net) &&
    p.native_first_net === p.expected_net &&
    p.native_second_net === p.expected_net &&
    ids?.length === 2 &&
    distinctIdentities(ids)
    ? ids
    : undefined;
}

function observedLinePath(
  base: LinePathEvidence,
  evidence: LinePathEvidence['evidence'],
  ids: string[],
  layer: number | undefined,
): LinePathEvidence {
  if (ids.length > 1200 || !distinctIdentities(ids) || !nativeCopperLayerCode(layer)) return base;
  return { ...base, evidence, primitive_ids: [...ids], native_layer: layer };
}

/** Summarizes already source-bound line evidence; never performs a second native read. */
export function linePathEvidence(p: NativePadPairFinding): LinePathEvidence {
  const ids = sourcedPadIdentities(p);
  const base: LinePathEvidence = {
    first_pin: p.first_pin,
    second_pin: p.second_pin,
    expected_net: p.expected_net,
    ...(ids ? { native_pad_primitive_ids: [...ids] } : {}),
    evidence: 'unavailable',
    primitive_ids: [],
    electrical_continuity_status: 'UNKNOWN',
  };
  if (!ids) return base;
  const exact = p.route_chain;
  if (exact?.evidence === 'observed_exact_endpoint_chain') {
    return observedLinePath(base, exact.evidence, exact.primitive_ids, exact.native_layer);
  }
  const association = p.native_pad_associations;
  const chain = association?.associated_route_chain;
  if (
    association &&
    association.evidence !== 'unavailable' &&
    chain?.evidence === 'observed_associated_endpoint_chain'
  ) {
    return observedLinePath(base, association.evidence, chain.primitive_ids, chain.native_layer);
  }
  return base;
}

function priorityNextStep(
  action: PlacementPriorityAction,
  relation: PlacementKind,
  paths: readonly LinePathEvidence[],
): string {
  const observed = paths.filter((p) => p.evidence !== 'unavailable').length;
  let step = actionSteps[action];
  if (action === 'collect-topology-evidence' && observed > 0) {
    step =
      observed === paths.length
        ? 'Review the observed line chains and collect remaining physical contact and return-path evidence.'
        : 'Review the observed line chains. Collect the missing line-chain evidence and remaining physical contact and return-path evidence.';
  }
  return step + ' ' + topologySteps[relation];
}

function selectAction(
  finding: PlacementFinding,
  sourceKind: ConstraintSourceKind,
  context: PlacementPowerIssue[],
  widths: WidthDeviation[],
): PlacementPriorityAction {
  if (hasNetMismatch(finding)) return 'verify-net-mismatch';
  if (finding.status === 'WARNING' && sourceKind === 'datasheet-requirement') {
    return 'review-declared-requirement';
  }
  if (context.length) return 'review-power-context';
  if (widths.length) return 'review-selected-line-width';
  if (finding.status === 'WARNING') return 'review-observed-warning';
  return 'collect-topology-evidence';
}

const actionSteps: Record<PlacementPriorityAction, string> = {
  'verify-net-mismatch': 'Check the declared pin/net identity against the source schematic.',
  'review-declared-requirement':
    'Verify the caller-declared datasheet requirement and observed deviation.',
  'review-power-context':
    'Review the matched caller-supplied power-tree issue alongside native geometry.',
  'review-selected-line-width':
    'Review the exact narrow selected line segments against the caller-declared width criterion.',
  'review-observed-warning': 'Review the observed deviation and the supplied constraint source.',
  'collect-topology-evidence':
    'Collect missing current-path evidence; do not infer a physical failure.',
};

/** Orders next review actions, not physical severity. Original findings are never changed. */
export function rankPlacementReview(
  findings: readonly PlacementFinding[],
  provenance: ReadonlyMap<string, ConstraintSourceKind>,
  issues: readonly PlacementPowerIssue[],
): PlacementPriority[] {
  return findings
    .map((finding): PlacementPriority => {
      const sourceKind = provenance.get(finding.id) ?? 'unspecified';
      const context = correlatedPowerIssues(finding, issues);
      const widths = widthDeviations(finding);
      const action = selectAction(finding, sourceKind, context, widths);
      const paths = (finding.pad_pairs ?? []).map(linePathEvidence);
      return {
        finding_id: finding.id,
        relation: finding.relation,
        components: [...finding.components],
        action,
        constraint_source_kind: sourceKind,
        power_context: context,
        ...(widths.length ? { width_deviations: widths } : {}),
        ...(paths.length ? { line_path_evidence: paths } : {}),
        next_step: priorityNextStep(action, finding.relation, paths),
        electrical_loop_status: 'UNKNOWN',
      };
    })
    .sort((a, b) => actions.indexOf(a.action) - actions.indexOf(b.action));
}
