/**
 * Compares bounded caller-declared fabrication/assembly limits with the
 * existing PCB-constraint summary. A match is never a manufacturing approval.
 */
import type { PcbConstraintInput } from './types.js';

export interface ManufacturerProfile {
  manufacturer: string;
  process: string;
  revision: string;
  source: string;
  limits: {
    minimumFinishedDrillMm?: number;
    minimumAnnularRingMm?: number;
    minimumMaskWebMm?: number;
    minimumCopperEdgeMm?: number;
    maximumBoardWidthMm?: number;
    maximumBoardHeightMm?: number;
    minimumFiducialCount?: number;
    minimumToolingHoleCount?: number;
    minimumPolarityMarkRatio?: number;
    minimumCriticalNetTestpointRatio?: number;
    requireProgrammingHeader?: boolean;
  };
}
export interface ProfileFinding {
  id: string;
  category: 'fabrication' | 'assembly' | 'testability';
  status: 'WARNING' | 'UNKNOWN';
  comparison: 'BELOW_DECLARED_LIMIT' | 'ABOVE_DECLARED_LIMIT' | 'WITHIN_DECLARED_LIMIT' | 'UNKNOWN';
  actual?: number | boolean;
  declared_limit: number | boolean;
  units: 'mm' | 'count' | 'ratio' | 'boolean';
  source_field: string;
  /** Caller-declared process source and revision, repeated for standalone findings. */
  profile_reference: string;
  profile_revision: string;
  /** Availability of this specific reported metric, not generic board connection state. */
  measurement_evidence: 'caller_supplied_unverified' | 'native_partial_unverified' | 'unavailable';
  reason: string;
}
type ProfileComparison = Omit<
  ProfileFinding,
  'profile_reference' | 'profile_revision' | 'measurement_evidence'
>;

export interface ManufacturingProfileReview {
  status: 'WARNING' | 'UNKNOWN';
  source: { manufacturer: string; process: string; revision: string; reference: string };
  input_evidence: 'caller_supplied_unverified' | 'native_partial_unverified';
  findings: ProfileFinding[];
  unknown_workflows: string[];
  manual_review_required: true;
  fabrication_approval: false;
  limitations: string[];
}

type RuleKey = keyof ManufacturerProfile['limits'];
type BoardValue = keyof PcbConstraintInput;
interface Rule {
  id: RuleKey;
  field: BoardValue;
  category: ProfileFinding['category'];
  units: ProfileFinding['units'];
  comparison: 'min' | 'max';
}
const NUMERIC_RULES: readonly Rule[] = [
  {
    id: 'minimumFinishedDrillMm',
    field: 'minDrillMm',
    category: 'fabrication',
    units: 'mm',
    comparison: 'min',
  },
  {
    id: 'minimumAnnularRingMm',
    field: 'minAnnularRingMm',
    category: 'fabrication',
    units: 'mm',
    comparison: 'min',
  },
  {
    id: 'minimumMaskWebMm',
    field: 'minSolderMaskSliverMm',
    category: 'fabrication',
    units: 'mm',
    comparison: 'min',
  },
  {
    id: 'minimumCopperEdgeMm',
    field: 'minCopperToEdgeMm',
    category: 'fabrication',
    units: 'mm',
    comparison: 'min',
  },
  {
    id: 'maximumBoardWidthMm',
    field: 'widthMm',
    category: 'fabrication',
    units: 'mm',
    comparison: 'max',
  },
  {
    id: 'maximumBoardHeightMm',
    field: 'heightMm',
    category: 'fabrication',
    units: 'mm',
    comparison: 'max',
  },
  {
    id: 'minimumFiducialCount',
    field: 'fiducialCount',
    category: 'assembly',
    units: 'count',
    comparison: 'min',
  },
  {
    id: 'minimumToolingHoleCount',
    field: 'toolingHoleCount',
    category: 'assembly',
    units: 'count',
    comparison: 'min',
  },
];

function validReportedScalar(value: number, units: ProfileFinding['units']): boolean {
  return Number.isFinite(value) && value >= 0 && (units !== 'count' || Number.isInteger(value));
}

function numericFindingReason(
  validLimit: boolean,
  numeric: number | undefined,
  violated: boolean,
): string {
  if (!validLimit)
    return 'The caller-declared process limit is invalid; no comparison is possible.';
  if (numeric === undefined)
    return 'The requested board measurement is unavailable; no absence or process capability is inferred.';
  return violated
    ? 'Caller-reported board metric conflicts with the declared, unverified manufacturer process limit.'
    : 'Caller-reported metric meets the declared limit; source validity, complete geometry and manufacturing acceptance remain unverified.';
}

function reportedRatio(
  numerator: number | undefined,
  denominator: number | undefined,
): number | undefined {
  return numerator !== undefined &&
    denominator !== undefined &&
    Number.isInteger(numerator) &&
    Number.isInteger(denominator) &&
    denominator > 0 &&
    numerator >= 0 &&
    numerator <= denominator
    ? numerator / denominator
    : undefined;
}

function ratioFindingReason(
  validLimit: boolean,
  ratio: number | undefined,
  violated: boolean,
): string {
  if (!validLimit)
    return 'The caller-declared coverage ratio limit is invalid; no comparison is possible.';
  if (ratio === undefined)
    return 'The complete relevant inventory or valid numerator is unavailable; no absent feature is inferred.';
  return violated
    ? 'Caller-reported feature coverage is below the declared process requirement.'
    : 'Caller-reported feature coverage meets its declared threshold, but inventory completeness and physical accessibility are unverified.';
}

function compareNumeric(rule: Rule, limit: number, data: PcbConstraintInput): ProfileComparison {
  const validLimit = validReportedScalar(limit, rule.units);
  const candidate = data[rule.field];
  const numeric =
    typeof candidate === 'number' && validReportedScalar(candidate, rule.units)
      ? candidate
      : undefined;
  const violate =
    validLimit &&
    numeric !== undefined &&
    (rule.comparison === 'min' ? numeric < limit : numeric > limit);
  return {
    id: rule.id,
    category: rule.category,
    status: violate ? 'WARNING' : 'UNKNOWN',
    comparison:
      numeric === undefined || !validLimit
        ? 'UNKNOWN'
        : violate
          ? rule.comparison === 'min'
            ? 'BELOW_DECLARED_LIMIT'
            : 'ABOVE_DECLARED_LIMIT'
          : 'WITHIN_DECLARED_LIMIT',
    ...(numeric !== undefined ? { actual: numeric } : {}),
    declared_limit: limit,
    units: rule.units,
    source_field: rule.field,
    reason: numericFindingReason(validLimit, numeric, violate),
  };
}

function ratioFinding(
  id: RuleKey,
  numerator: number | undefined,
  denominator: number | undefined,
  limit: number,
  category: ProfileFinding['category'],
  name: string,
): ProfileComparison {
  const ratio = reportedRatio(numerator, denominator);
  const validLimit = Number.isFinite(limit) && limit >= 0 && limit <= 1;
  const violated = validLimit && ratio !== undefined && ratio < limit;
  return {
    id,
    category,
    status: violated ? 'WARNING' : 'UNKNOWN',
    comparison:
      ratio === undefined || !validLimit
        ? 'UNKNOWN'
        : violated
          ? 'BELOW_DECLARED_LIMIT'
          : 'WITHIN_DECLARED_LIMIT',
    ...(ratio !== undefined ? { actual: ratio } : {}),
    declared_limit: limit,
    units: 'ratio',
    source_field: name,
    reason: ratioFindingReason(validLimit, ratio, violated),
  };
}
function countUniqueNames(data: PcbConstraintInput): { numerator?: number; denominator?: number } {
  if (!data.criticalNetNames || !data.testPointNets) return {};
  const required = new Set(
    data.criticalNetNames.map((n) => n.trim().toUpperCase()).filter(Boolean),
  );
  const observed = new Set(data.testPointNets.map((n) => n.trim().toUpperCase()).filter(Boolean));
  if (required.size === 0 || required.size !== data.criticalNetNames.length) return {};
  return {
    numerator: [...required].filter((n) => observed.has(n)).length,
    denominator: required.size,
  };
}

function manualFindings(
  profile: ManufacturerProfile,
  data: PcbConstraintInput,
): ProfileComparison[] {
  const output: ProfileComparison[] = [];
  const marks = profile.limits.minimumPolarityMarkRatio;
  if (marks !== undefined) {
    output.push(
      ratioFinding(
        'minimumPolarityMarkRatio',
        data.polarityMarkCount,
        data.polarizedComponentCount,
        marks,
        'assembly',
        'polarityMarkCount / polarizedComponentCount',
      ),
    );
  }
  const points = profile.limits.minimumCriticalNetTestpointRatio;
  if (points !== undefined) {
    const coverage = countUniqueNames(data);
    output.push(
      ratioFinding(
        'minimumCriticalNetTestpointRatio',
        coverage.numerator,
        coverage.denominator,
        points,
        'testability',
        'criticalNetNames / testPointNets',
      ),
    );
  }
  if (profile.limits.requireProgrammingHeader === true) {
    const observed = data.hasProgrammingHeader;
    output.push({
      id: 'requireProgrammingHeader',
      category: 'testability',
      status: observed === false ? 'WARNING' : 'UNKNOWN',
      comparison:
        observed === false
          ? 'BELOW_DECLARED_LIMIT'
          : observed === true
            ? 'WITHIN_DECLARED_LIMIT'
            : 'UNKNOWN',
      ...(observed !== undefined ? { actual: observed } : {}),
      declared_limit: true,
      units: 'boolean',
      source_field: 'hasProgrammingHeader',
      reason:
        observed === false
          ? 'Declared programming access is explicitly absent from the supplied project data.'
          : 'Actual connector mapping, probe access and device-programming usability are not live verified.',
    });
  }
  return output;
}

export function reviewManufacturerProfile(
  profile: ManufacturerProfile,
  boardData: PcbConstraintInput,
  source: ManufacturingProfileReview['input_evidence'],
): ManufacturingProfileReview {
  const comparisons = [
    ...NUMERIC_RULES.flatMap((rule) => {
      const limit = profile.limits[rule.id];
      return typeof limit === 'number' ? [compareNumeric(rule, limit, boardData)] : [];
    }),
    ...manualFindings(profile, boardData),
  ];
  const findings: ProfileFinding[] = comparisons.map((finding) => ({
    ...finding,
    profile_reference: profile.source,
    profile_revision: profile.revision,
    measurement_evidence: finding.actual === undefined ? 'unavailable' : source,
  }));
  return {
    status: findings.some((f) => f.status === 'WARNING') ? 'WARNING' : 'UNKNOWN',
    source: {
      manufacturer: profile.manufacturer,
      process: profile.process,
      revision: profile.revision,
      reference: profile.source,
    },
    input_evidence: source,
    findings,
    unknown_workflows: [
      'Minimum trace width/space is not in the existing native board-summary response.',
      'Actual footprint pad/courtyard geometry, assembly side, component rotation and silk/pad overlap require source-specific inspection.',
      'Mounting-hole semantics cannot be inferred from drilled-pad counts.',
      'Testpoint accessibility, fiducial placement, programming pin continuity and tooling usability need actual geometry and assembly readback.',
      'BOM to MPN/package/footprint mapping, fabrication outputs, pick-and-place rotation and actual manufacturer capability are unverified.',
    ],
    manual_review_required: true,
    fabrication_approval: false,
    limitations: [
      'Process profile, manufacturer revision and source are caller declarations, not authenticated factory capabilities.',
      'Board-data summaries are partial and do not prove entire-board geometry, NC drill output, footprint geometry or solder-mask manufacturability.',
      'A within-declared-bound result remains UNKNOWN for fabrication approval; only an observed declared conflict produces WARNING.',
      'This review does not trigger production export, order placement, factory communication or PCB mutation.',
    ],
  };
}
