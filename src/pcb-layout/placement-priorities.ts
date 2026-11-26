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
  | 'review-observed-warning'
  | 'collect-topology-evidence';

export interface PlacementPriority {
  finding_id: string;
  relation: PlacementKind;
  components: string[];
  action: PlacementPriorityAction;
  constraint_source_kind: ConstraintSourceKind;
  power_context: PlacementPowerIssue[];
  next_step: string;
  electrical_loop_status: 'UNKNOWN';
}

const actions: readonly PlacementPriorityAction[] = [
  'verify-net-mismatch',
  'review-declared-requirement',
  'review-power-context',
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

function selectAction(
  finding: PlacementFinding,
  sourceKind: ConstraintSourceKind,
  context: PlacementPowerIssue[],
): PlacementPriorityAction {
  if (hasNetMismatch(finding)) return 'verify-net-mismatch';
  if (finding.status === 'WARNING' && sourceKind === 'datasheet-requirement') {
    return 'review-declared-requirement';
  }
  if (context.length) return 'review-power-context';
  if (finding.status === 'WARNING') return 'review-observed-warning';
  return 'collect-topology-evidence';
}

const actionSteps: Record<PlacementPriorityAction, string> = {
  'verify-net-mismatch': 'Check the declared pin/net identity against the source schematic.',
  'review-declared-requirement':
    'Verify the caller-declared datasheet requirement and observed deviation.',
  'review-power-context':
    'Review the matched caller-supplied power-tree issue alongside native geometry.',
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
      const action = selectAction(finding, sourceKind, context);
      return {
        finding_id: finding.id,
        relation: finding.relation,
        components: [...finding.components],
        action,
        constraint_source_kind: sourceKind,
        power_context: context,
        next_step: actionSteps[action] + ' ' + topologySteps[finding.relation],
        electrical_loop_status: 'UNKNOWN',
      };
    })
    .sort((a, b) => actions.indexOf(a.action) - actions.indexOf(b.action));
}
