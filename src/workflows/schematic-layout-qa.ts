import { collectSchematicLayoutGeometryIssues } from './schematic-layout-qa-geometry-rules.js';
import { collectSchematicLayoutTopologyIssues } from './schematic-layout-qa-topology-rules.js';

export type LayoutQaSeverity = 'critical' | 'error' | 'warning' | 'info';

export type LayoutQaCategory =
  'electrical' | 'geometry' | 'readability' | 'grouping' | 'wiring' | 'runtime';

export type LayoutQaEvidenceSource =
  | 'exact_geometry'
  | 'derived_geometry'
  | 'runtime_drc'
  | 'runtime_erc'
  | 'expected_topology'
  | 'connectivity_fingerprint'
  | 'visual_heuristic'
  | 'runtime_capability';

export type LayoutQaIssueCode =
  | 'TITLE_BLOCK_OVERLAP'
  | 'PAGE_BOUNDARY_OVERFLOW'
  | 'COMPONENT_OVERLAP'
  | 'COMPONENT_TEXT_OVERLAP'
  | 'TEXT_TEXT_OVERLAP'
  | 'SECTION_BOX_CONFLICT'
  | 'DANGLING_PIN'
  | 'DETACHED_NETPORT'
  | 'EXPECTED_NET_MISMATCH'
  | 'DUPLICATE_REFERENCE'
  | 'DUPLICATE_NET_LABEL'
  | 'RELATED_COMPONENT_DISTANCE'
  | 'EXCESSIVE_WIRE_LENGTH'
  | 'EXCESSIVE_WHITESPACE'
  | 'LOCAL_CROWDING'
  | 'CONNECTIVITY_CHANGED_DURING_COSMETIC_EDIT'
  | 'DOCUMENT_STATE_UNVERIFIED'
  | 'VISUAL_QA_UNAVAILABLE'
  | 'DRC_DESIGN_ISSUE'
  | 'DRC_INTENTIONAL_NC'
  | 'DRC_SYMBOL_MODEL_LIMITATION'
  | 'DRC_MISSING_POWER_FLAG'
  | 'DRC_RUNTIME_LIMITATION'
  | 'ERC_DESIGN_ISSUE'
  | 'ERC_INTENTIONAL_NC'
  | 'ERC_SYMBOL_MODEL_LIMITATION'
  | 'ERC_MISSING_POWER_FLAG'
  | 'ERC_RUNTIME_LIMITATION';

export interface LayoutQaBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutQaPinConnection {
  pin: string;
  netName?: string;
  connected?: boolean;
}

export interface LayoutQaPrimitive {
  id: string;
  primitiveType: 'component' | 'text' | 'label' | 'netport' | 'section' | 'annotation';
  ref?: string;
  netName?: string;
  blockId?: string;
  combinedBounds: LayoutQaBounds;
  bodyBounds?: LayoutQaBounds;
  referenceBounds?: LayoutQaBounds;
  valueBounds?: LayoutQaBounds;
  pinTextBounds?: LayoutQaBounds[];
  labelBounds?: LayoutQaBounds[];
  annotationBounds?: LayoutQaBounds[];
  pinConnections?: LayoutQaPinConnection[];
  connected?: boolean;
  rotation?: number;
  geometrySource?: 'runtime' | 'derived' | 'approximate' | 'not_available';
}

export interface LayoutQaWire {
  id: string;
  netName?: string;
  points?: Array<{ x: number; y: number }>;
  length?: number;
  connectedEndpointCount?: number;
}

export interface LayoutQaRelationship {
  sourceId: string;
  targetId: string;
  kind: 'decoupling' | 'protection' | 'support' | 'signal-flow' | 'custom';
  maxDistance: number;
}

export interface ExpectedPinMapping {
  componentRef: string;
  pin: string;
  netName: string;
}

export type RuntimeDiagnosticClassification =
  | 'design_issue'
  | 'intentional_nc'
  | 'symbol_model_limitation'
  | 'missing_power_flag'
  | 'runtime_limitation';

export interface RuntimeDiagnostic {
  id?: string;
  message: string;
  severity?: LayoutQaSeverity;
  componentId?: string;
  netName?: string;
  classification?: RuntimeDiagnosticClassification;
}

export interface VisualHeuristicFinding {
  code: LayoutQaIssueCode;
  severity: Exclude<LayoutQaSeverity, 'critical'>;
  message: string;
  confidence: number;
  affectedPrimitiveIds?: string[];
  region?: LayoutQaBounds;
  remediation: string;
}

export interface LayoutQaInput {
  projectId: string;
  sheet: {
    pageBounds: LayoutQaBounds;
    drawableBounds: LayoutQaBounds;
    titleBlockKeepout: LayoutQaBounds;
    hardKeepouts?: Array<{ id: string; bounds: LayoutQaBounds }>;
  };
  primitives: LayoutQaPrimitive[];
  wires?: LayoutQaWire[];
  relationships?: LayoutQaRelationship[];
  expected?: {
    componentRefs?: string[];
    netNames?: string[];
    pinMappings?: ExpectedPinMapping[];
  };
  runtime?: {
    bridgeVerified?: boolean;
    documentVerified?: boolean;
    drcAvailable?: boolean;
    ercAvailable?: boolean;
    drc?: RuntimeDiagnostic[];
    erc?: RuntimeDiagnostic[];
  };
  visual?: {
    captureAvailable: boolean;
    deterministicViewport?: boolean;
    findings?: VisualHeuristicFinding[];
  };
  connectivity?: {
    cosmeticOnly: boolean;
    beforeFingerprint?: string;
    afterFingerprint?: string;
    changedPins?: string[];
    changedWireEndpoints?: string[];
  };
  thresholds?: {
    componentClearance?: number;
    relatedComponentDistance?: number;
    excessiveWireLength?: number;
    minimumUtilization?: number;
    maximumLocalDensity?: number;
  };
}

export interface LayoutQaIssue {
  code: LayoutQaIssueCode;
  severity: LayoutQaSeverity;
  category: LayoutQaCategory;
  source: LayoutQaEvidenceSource;
  message: string;
  affectedPrimitiveIds: string[];
  affectedNets: string[];
  affectedPins: string[];
  region?: LayoutQaBounds;
  measured?: number;
  expected?: number | string;
  evidence: string;
  remediation: string;
  blocksCommit: boolean;
  confidence: number;
}

export interface LayoutQaScores {
  geometry: number;
  readability: number;
  grouping: number;
  spacing: number;
  wiring: number;
  electrical: number;
  runtime: number;
  overall: number;
}

export interface LayoutQaResult {
  projectId: string;
  status: 'pass' | 'fail' | 'inconclusive';
  passed: boolean;
  commitBlocked: boolean;
  issues: LayoutQaIssue[];
  issueCounts: Record<LayoutQaSeverity, number>;
  scores: LayoutQaScores;
  evidence: {
    exactGeometry: boolean;
    runtimeDrc: boolean;
    runtimeErc: boolean;
    fullPageCapture: boolean;
    deterministicCapture: boolean;
  };
  summary: {
    criticalIssueCodes: LayoutQaIssueCode[];
    blockingIssueCodes: LayoutQaIssueCode[];
    topIssues: LayoutQaIssue[];
  };
}

export interface LayoutQaComparison {
  improved: boolean;
  beforeScore: number;
  afterScore: number;
  newIssues: LayoutQaIssue[];
  resolvedIssues: LayoutQaIssue[];
  unchangedIssues: LayoutQaIssue[];
}

const DEFAULT_THRESHOLDS = {
  componentClearance: 8,
  relatedComponentDistance: 160,
  excessiveWireLength: 500,
  minimumUtilization: 0.12,
  maximumLocalDensity: 0.7,
} as const;

const SEVERITY_PENALTY: Record<LayoutQaSeverity, number> = {
  critical: 35,
  error: 18,
  warning: 7,
  info: 2,
};

function issue(
  value: Omit<LayoutQaIssue, 'affectedPrimitiveIds' | 'affectedNets' | 'affectedPins'> &
    Partial<Pick<LayoutQaIssue, 'affectedPrimitiveIds' | 'affectedNets' | 'affectedPins'>>,
): LayoutQaIssue {
  return {
    ...value,
    affectedPrimitiveIds: value.affectedPrimitiveIds ?? [],
    affectedNets: value.affectedNets ?? [],
    affectedPins: value.affectedPins ?? [],
  };
}

function blockingSeverity(severity: LayoutQaSeverity): boolean {
  return severity === 'critical' || severity === 'error';
}

function diagnosticClassification(diagnostic: RuntimeDiagnostic): RuntimeDiagnosticClassification {
  if (diagnostic.classification) return diagnostic.classification;
  const message = diagnostic.message.toLowerCase();
  if (/intentional|no connect|\bnc\b/.test(message)) return 'intentional_nc';
  if (/symbol|model|pin type/.test(message)) return 'symbol_model_limitation';
  if (/power flag|power input|pwr_flag/.test(message)) return 'missing_power_flag';
  if (/unavailable|timeout|runtime|unsupported/.test(message)) return 'runtime_limitation';
  return 'design_issue';
}

function diagnosticCode(
  source: 'DRC' | 'ERC',
  classification: RuntimeDiagnosticClassification,
): LayoutQaIssueCode {
  const suffix: Record<RuntimeDiagnosticClassification, string> = {
    design_issue: 'DESIGN_ISSUE',
    intentional_nc: 'INTENTIONAL_NC',
    symbol_model_limitation: 'SYMBOL_MODEL_LIMITATION',
    missing_power_flag: 'MISSING_POWER_FLAG',
    runtime_limitation: 'RUNTIME_LIMITATION',
  };
  return `${source}_${suffix[classification]}` as LayoutQaIssueCode;
}

function diagnosticSeverity(
  diagnostic: RuntimeDiagnostic,
  classification: RuntimeDiagnosticClassification,
): LayoutQaSeverity {
  if (classification === 'runtime_limitation') return 'warning';
  if (classification === 'intentional_nc' || classification === 'symbol_model_limitation')
    return 'info';
  return diagnostic.severity ?? 'error';
}

function issueIdentity(value: LayoutQaIssue): string {
  return [
    value.code,
    [...value.affectedPrimitiveIds].sort((a, b) => a.localeCompare(b)).join(','),
    [...value.affectedNets].sort((a, b) => a.localeCompare(b)).join(','),
    [...value.affectedPins].sort((a, b) => a.localeCompare(b)).join(','),
  ].join('|');
}

function scoreDimension(issues: LayoutQaIssue[], categories: LayoutQaCategory[]): number {
  const penalty = issues
    .filter((value) => categories.includes(value.category))
    .reduce((sum, value) => sum + SEVERITY_PENALTY[value.severity], 0);
  return Math.max(0, 100 - penalty);
}

function collectRuntimeDiagnostics(
  source: 'DRC' | 'ERC',
  diagnostics: RuntimeDiagnostic[],
): LayoutQaIssue[] {
  return diagnostics.map((diagnostic) => {
    const classification = diagnosticClassification(diagnostic);
    const severity = diagnosticSeverity(diagnostic, classification);
    return issue({
      code: diagnosticCode(source, classification),
      severity,
      category: classification === 'runtime_limitation' ? 'runtime' : 'electrical',
      source: source === 'DRC' ? 'runtime_drc' : 'runtime_erc',
      message: diagnostic.message,
      affectedPrimitiveIds: diagnostic.componentId ? [diagnostic.componentId] : [],
      affectedNets: diagnostic.netName ? [diagnostic.netName] : [],
      evidence: `${source} diagnostic classified as ${classification}.`,
      remediation:
        classification === 'intentional_nc'
          ? 'Document the intentional no-connect and keep it explicit in the design intent.'
          : classification === 'symbol_model_limitation'
            ? 'Review the symbol pin model and record the limitation before waiving it.'
            : classification === 'missing_power_flag'
              ? 'Add or correct the required power flag, then rerun ERC.'
              : classification === 'runtime_limitation'
                ? 'Restore the runtime check and rerun QA; do not treat this result as a pass.'
                : `Correct the ${source} finding and rerun the native check.`,
      blocksCommit: blockingSeverity(severity) && classification === 'design_issue',
      confidence: diagnostic.classification ? 1 : 0.8,
    });
  });
}

export function evaluateSchematicLayoutQa(input: LayoutQaInput): LayoutQaResult {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
  const issues = collectSchematicLayoutGeometryIssues(input, thresholds);
  issues.push(
    ...collectSchematicLayoutTopologyIssues(input, {
      relatedComponentDistance: thresholds.relatedComponentDistance,
      excessiveWireLength: thresholds.excessiveWireLength,
    }),
  );

  const connectivity = input.connectivity;
  if (
    connectivity?.cosmeticOnly &&
    connectivity.beforeFingerprint &&
    connectivity.afterFingerprint &&
    connectivity.beforeFingerprint !== connectivity.afterFingerprint
  ) {
    issues.push(
      issue({
        code: 'CONNECTIVITY_CHANGED_DURING_COSMETIC_EDIT',
        severity: 'critical',
        category: 'electrical',
        source: 'connectivity_fingerprint',
        message: 'A cosmetic-only edit changed the normalized connectivity fingerprint.',
        affectedPins: connectivity.changedPins ?? [],
        affectedPrimitiveIds: connectivity.changedWireEndpoints ?? [],
        evidence: 'Before and after connectivity hashes differ.',
        remediation: 'Roll back the cosmetic batch and inspect the structured fingerprint diff.',
        blocksCommit: true,
        confidence: 1,
      }),
    );
  }

  const runtime = input.runtime;
  if (runtime?.bridgeVerified === false || runtime?.documentVerified === false) {
    issues.push(
      issue({
        code: 'DOCUMENT_STATE_UNVERIFIED',
        severity: 'error',
        category: 'runtime',
        source: 'runtime_capability',
        message: 'Bridge or active-document state could not be verified after the write.',
        evidence: 'Post-write runtime verification did not confirm both bridge and document state.',
        remediation:
          'Restore the bridge/document state and repeat readback before retrying any write.',
        blocksCommit: true,
        confidence: 1,
      }),
    );
  }
  issues.push(...collectRuntimeDiagnostics('DRC', runtime?.drc ?? []));
  issues.push(...collectRuntimeDiagnostics('ERC', runtime?.erc ?? []));

  if (!input.visual?.captureAvailable) {
    issues.push(
      issue({
        code: 'VISUAL_QA_UNAVAILABLE',
        severity: 'warning',
        category: 'runtime',
        source: 'runtime_capability',
        message: 'Full-page capture or visual QA was unavailable.',
        evidence: 'No fit-to-page image evidence was supplied to the QA run.',
        remediation:
          'Capture the complete page and rerun visual QA; do not interpret this run as visual approval.',
        blocksCommit: false,
        confidence: 1,
      }),
    );
  }
  for (const finding of input.visual?.findings ?? []) {
    issues.push(
      issue({
        code: finding.code,
        severity: finding.severity,
        category: 'readability',
        source: 'visual_heuristic',
        message: finding.message,
        affectedPrimitiveIds: finding.affectedPrimitiveIds,
        region: finding.region,
        evidence: `Visual heuristic confidence ${finding.confidence.toFixed(2)}.`,
        remediation: finding.remediation,
        blocksCommit: false,
        confidence: finding.confidence,
      }),
    );
  }

  const scoresWithoutOverall = {
    geometry: scoreDimension(issues, ['geometry']),
    readability: scoreDimension(issues, ['readability']),
    grouping: scoreDimension(issues, ['grouping']),
    spacing: scoreDimension(
      issues.filter((value) => value.code === 'LOCAL_CROWDING'),
      ['readability'],
    ),
    wiring: scoreDimension(issues, ['wiring']),
    electrical: scoreDimension(issues, ['electrical']),
    runtime: scoreDimension(issues, ['runtime']),
  };
  const overall = Math.round(
    Object.values(scoresWithoutOverall).reduce((sum, value) => sum + value, 0) /
      Object.values(scoresWithoutOverall).length,
  );
  const commitBlocked = issues.some((value) => value.blocksCommit);
  const inconclusive =
    !commitBlocked &&
    (!input.visual?.captureAvailable ||
      runtime?.drcAvailable === false ||
      runtime?.ercAvailable === false);
  const status: LayoutQaResult['status'] = commitBlocked
    ? 'fail'
    : inconclusive
      ? 'inconclusive'
      : 'pass';
  const issueCounts: Record<LayoutQaSeverity, number> = {
    critical: 0,
    error: 0,
    warning: 0,
    info: 0,
  };
  for (const value of issues) issueCounts[value.severity] += 1;
  const severityOrder: Record<LayoutQaSeverity, number> = {
    critical: 0,
    error: 1,
    warning: 2,
    info: 3,
  };
  const sorted = [...issues].sort(
    (left, rightValue) =>
      severityOrder[left.severity] - severityOrder[rightValue.severity] ||
      left.code.localeCompare(rightValue.code),
  );

  return {
    projectId: input.projectId,
    status,
    passed: status === 'pass',
    commitBlocked,
    issues,
    issueCounts,
    scores: { ...scoresWithoutOverall, overall },
    evidence: {
      exactGeometry: input.primitives.every((value) => value.geometrySource === 'runtime'),
      runtimeDrc: runtime?.drcAvailable === true,
      runtimeErc: runtime?.ercAvailable === true,
      fullPageCapture: input.visual?.captureAvailable === true,
      deterministicCapture: input.visual?.deterministicViewport === true,
    },
    summary: {
      criticalIssueCodes: [
        ...new Set(
          issues.filter((value) => value.severity === 'critical').map((value) => value.code),
        ),
      ],
      blockingIssueCodes: [
        ...new Set(issues.filter((value) => value.blocksCommit).map((value) => value.code)),
      ],
      topIssues: sorted.slice(0, 10),
    },
  };
}

export function compareSchematicLayoutQa(
  before: LayoutQaResult,
  after: LayoutQaResult,
): LayoutQaComparison {
  const beforeMap = new Map(before.issues.map((value) => [issueIdentity(value), value]));
  const afterMap = new Map(after.issues.map((value) => [issueIdentity(value), value]));
  const newIssues = [...afterMap]
    .filter(([identity]) => !beforeMap.has(identity))
    .map(([, value]) => value);
  const resolvedIssues = [...beforeMap]
    .filter(([identity]) => !afterMap.has(identity))
    .map(([, value]) => value);
  const unchangedIssues = [...afterMap]
    .filter(([identity]) => beforeMap.has(identity))
    .map(([, value]) => value);
  return {
    improved:
      after.scores.overall > before.scores.overall &&
      after.summary.blockingIssueCodes.length <= before.summary.blockingIssueCodes.length,
    beforeScore: before.scores.overall,
    afterScore: after.scores.overall,
    newIssues,
    resolvedIssues,
    unchangedIssues,
  };
}
