import { z } from 'zod';
import { validatePcbConstraints } from '../pcb-constraints/index.js';
import type { PcbConstraintInput, PcbConstraintIssue } from '../pcb-constraints/types.js';

/** Evidence report only; never an electrical or manufacturing sign-off. */
export const reviewStatusSchema = z.enum(['PASS', 'FAIL', 'WARNING', 'UNKNOWN', 'NOT_APPLICABLE']);

const inputEvidenceSchema = z.object({
  field: z.string(),
  source: z.string(),
  quality: z.enum(['measured', 'supplied', 'unavailable', 'unverified']),
  unit: z.string().optional(),
  age: z.enum(['current_request', 'unverified']),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const findingSchema = z.object({
  id: z.string(),
  rule_id: z.string(),
  rule_revision: z.string(),
  requirement_source: z.string(),
  scope: z.string(),
  status: reviewStatusSchema,
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string(),
  remediation: z.string(),
  confidence: z.enum(['observed', 'derived', 'unverified']),
  evidence_fields: z.array(z.string()),
  affected_entities: z.array(z.string()),
});

export const engineeringReviewSchema = z.object({
  project_id: z.string(),
  overall_status: reviewStatusSchema,
  pcb_context: z.enum(['observed', 'unverified']),
  runtime: z.object({
    bridge_connected: z.boolean(),
    registry_mismatch: z.boolean().nullable(),
    extension_version_mismatch: z.boolean().nullable(),
  }),
  groups: z.object({
    blocking: z.array(z.string()),
    advisories: z.array(z.string()),
    unknowns: z.array(z.string()),
    passed: z.array(z.string()),
    not_applicable: z.array(z.string()),
  }),
  source_version: z.object({
    easyeda: z.string().nullable(),
    extension: z.string().nullable(),
  }),
  observations: z.array(
    z.object({
      method: z.string(),
      status: z.enum(['observed', 'unavailable', 'not_run']),
      guidance: z.string().optional(),
    }),
  ),
  input_evidence: z.array(inputEvidenceSchema),
  findings: z.array(findingSchema),
  summary: z.object({
    PASS: z.number().int().nonnegative(),
    FAIL: z.number().int().nonnegative(),
    WARNING: z.number().int().nonnegative(),
    UNKNOWN: z.number().int().nonnegative(),
    NOT_APPLICABLE: z.number().int().nonnegative(),
  }),
  human_review_required: z.array(z.string()),
  engineering_sign_off: z.literal(false),
});

export type EngineeringReview = z.infer<typeof engineeringReviewSchema>;
export type ReviewFinding = EngineeringReview['findings'][number];
export type ReviewObservation = EngineeringReview['observations'][number];

const OBSERVED_FIELDS: ReadonlyArray<{
  field: keyof PcbConstraintInput;
  source: string;
  unit?: string;
}> = [
  { field: 'widthMm', source: 'board.getDimensions', unit: 'mm' },
  { field: 'heightMm', source: 'board.getDimensions', unit: 'mm' },
  { field: 'hasOutline', source: 'board.getDimensions' },
  { field: 'mountingHoleCount', source: 'board.getDimensions', unit: 'count' },
  { field: 'minDrillMm', source: 'board.getDimensions', unit: 'mm' },
  { field: 'layerCount', source: 'board.getStackup', unit: 'count' },
  { field: 'hasLayerStack', source: 'board.getStackup' },
  { field: 'hasClearanceRules', source: 'board.getDesignRules' },
];

function createFinding(
  id: string,
  status: ReviewFinding['status'],
  message: string,
  remediation: string,
  scope: string,
  confidence: ReviewFinding['confidence'],
  evidenceFields: string[] = [],
): ReviewFinding {
  return {
    id,
    rule_id: id.startsWith('pcb:') ? (id.split(':')[1] ?? id) : id,
    rule_revision: '1.0.0',
    requirement_source:
      scope === 'pcb' ? 'easyeda-mcp-pro/pcb-constraints' : 'easyeda-mcp-pro/engineering-review',
    scope,
    status,
    severity: status === 'FAIL' ? 'error' : status === 'WARNING' ? 'warning' : 'info',
    message,
    remediation,
    confidence,
    evidence_fields: evidenceFields,
    affected_entities: [],
  };
}

function mapIssue(
  issue: PcbConstraintIssue,
  status: 'FAIL' | 'WARNING',
  count: number,
): ReviewFinding {
  return createFinding(
    'pcb:' + issue.code + ':' + (issue.path ?? 'board') + ':' + count,
    status,
    issue.message,
    issue.remediationHint,
    'pcb',
    'derived',
    issue.path ? [issue.path] : [],
  );
}

function summarize(findings: ReviewFinding[]): EngineeringReview['summary'] {
  const counts = { PASS: 0, FAIL: 0, WARNING: 0, UNKNOWN: 0, NOT_APPLICABLE: 0 };
  for (const finding of findings) counts[finding.status]++;
  return counts;
}

type ReviewBuildInput = {
  projectId: string;
  boardData: PcbConstraintInput;
  observations: ReviewObservation[];
  bridgeConnected: boolean;
  registryMismatch?: boolean;
  extensionVersionMismatch?: boolean;
  easyedaVersion?: string;
  extensionVersion?: string;
  evidenceMode: 'native' | 'supplied';
};

/**
 * A native rule verdict must use only fields belonging to a successful
 * current-request method. Retained data from a previous document/tab,
 * disconnected bridge, or mismatched extension cannot prove a violation
 * or a partial PASS. Caller-supplied data retains its own unverified scope.
 */
function currentRuleInputs(input: ReviewBuildInput): PcbConstraintInput {
  if (input.evidenceMode === 'supplied') return input.boardData;
  if (
    !input.bridgeConnected ||
    input.registryMismatch === true ||
    input.extensionVersionMismatch === true
  )
    return {};

  const observedMethods = new Set(
    input.observations.filter((item) => item.status === 'observed').map((item) => item.method),
  );
  const current: Record<string, unknown> = {};
  for (const { field, source } of OBSERVED_FIELDS) {
    const value = input.boardData[field];
    if (observedMethods.has(source) && value !== undefined && value !== null)
      current[field] = value;
  }
  return current as PcbConstraintInput;
}

function hasObservedBoard(input: ReviewBuildInput): boolean {
  return (
    input.evidenceMode === 'native' &&
    input.bridgeConnected &&
    input.registryMismatch !== true &&
    input.extensionVersionMismatch !== true &&
    OBSERVED_FIELDS.some(
      ({ field, source }) =>
        input.boardData[field] !== undefined &&
        input.observations.some((item) => item.method === source && item.status === 'observed'),
    )
  );
}

function collectFindings(
  report: ReturnType<typeof validatePcbConstraints>,
  observedBoard: boolean,
  nativeEvidence: boolean,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const duplicates = new Map<string, number>();

  for (const [issues, status] of [
    [report.errors, 'FAIL'],
    [report.warnings, 'WARNING'],
  ] as const) {
    for (const issue of issues) {
      const key = issue.code + ':' + (issue.path ?? 'board');
      const count = (duplicates.get(key) ?? 0) + 1;
      duplicates.set(key, count);
      findings.push(mapIssue(issue, status, count));
    }
  }

  for (const [index, unknown] of report.unknownChecks.entries()) {
    const missing = [...unknown.missingFields].sort();
    findings.push(
      createFinding(
        'pcb:UNKNOWN:' + unknown.area + ':' + (index + 1),
        'UNKNOWN',
        'Cannot verify ' + unknown.area + ': missing ' + missing.join(', ') + '.',
        'Focus the relevant PCB document and collect supported measurements or provide verified inputs.',
        'pcb',
        'unverified',
        missing,
      ),
    );
  }

  if (nativeEvidence && !observedBoard) {
    findings.push(
      createFinding(
        'context:PCB_NOT_OBSERVED',
        'UNKNOWN',
        'The current PCB document could not be confirmed from native measurements.',
        'Connect the EasyEDA bridge, focus the correct PCB tab and retry.',
        'runtime',
        'unverified',
      ),
    );
  }

  // Native ERC/DRC can refresh editor panels: never silently execute them.
  for (const [name, purpose] of [
    ['DRC', 'PCB design rule check'],
    ['ERC', 'schematic electrical rule check'],
    ['POWER_TREE', 'power integrity and rail requirements'],
  ] as const) {
    findings.push(
      createFinding(
        'coverage:' + name,
        'UNKNOWN',
        purpose + ' was not executed by this read-only review.',
        'Run the corresponding dedicated validation workflow and assess its evidence.',
        'coverage',
        'unverified',
      ),
    );
  }

  if (observedBoard && report.summary.passed > 0) {
    findings.push(
      createFinding(
        'pcb:OBSERVED_CONSTRAINT_SUBSET',
        'PASS',
        String(report.summary.passed) + ' PCB rule checks passed on the available measured subset.',
        'These passes cover only the observed input subset, not the complete design.',
        'pcb',
        'derived',
      ),
    );
  }
  if (report.summary.notApplicable > 0) {
    findings.push(
      createFinding(
        'pcb:NOT_APPLICABLE_COUNT',
        'NOT_APPLICABLE',
        String(report.summary.notApplicable) +
          ' PCB rule checks were skipped by their applicability conditions.',
        'Review whether the rule applicability assumptions match the design.',
        'pcb',
        'derived',
      ),
    );
  }

  return findings;
}

function collectInputEvidence(input: ReviewBuildInput): EngineeringReview['input_evidence'] {
  const nativeEvidence = input.evidenceMode === 'native';
  const sourceMismatch = input.registryMismatch === true || input.extensionVersionMismatch === true;
  return OBSERVED_FIELDS.map(({ field, source, unit }) => {
    const value = input.boardData[field];
    const sourceObserved = input.observations.some(
      (observation) => observation.method === source && observation.status === 'observed',
    );
    const quality =
      value === undefined || value === null
        ? 'unavailable'
        : nativeEvidence && sourceObserved && input.bridgeConnected
          ? sourceMismatch
            ? 'unverified'
            : 'measured'
          : nativeEvidence
            ? 'unverified'
            : 'supplied';
    return {
      field,
      source: quality === 'supplied' ? 'caller_supplied' : source,
      quality,
      unit,
      age: quality === 'measured' ? 'current_request' : 'unverified',
      value:
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
          ? value
          : undefined,
    };
  });
}

function groupFindings(findings: ReviewFinding[]): EngineeringReview['groups'] {
  const groups: EngineeringReview['groups'] = {
    blocking: [],
    advisories: [],
    unknowns: [],
    passed: [],
    not_applicable: [],
  };
  for (const finding of findings) {
    if (finding.status === 'FAIL') groups.blocking.push(finding.id);
    else if (finding.status === 'WARNING') groups.advisories.push(finding.id);
    else if (finding.status === 'UNKNOWN') groups.unknowns.push(finding.id);
    else if (finding.status === 'PASS') groups.passed.push(finding.id);
    else groups.not_applicable.push(finding.id);
  }
  return groups;
}

export function buildEngineeringReview(input: ReviewBuildInput): EngineeringReview {
  // Rule evaluation must never consume stale or unsupported native fields.
  const validatedData = currentRuleInputs(input);
  const report = validatePcbConstraints(validatedData);
  const observedBoard = hasObservedBoard({ ...input, boardData: validatedData });
  const findings = collectFindings(report, observedBoard, input.evidenceMode === 'native');
  if (input.registryMismatch === true || input.extensionVersionMismatch === true) {
    findings.push(
      createFinding(
        'context:SOURCE_VERSION_MISMATCH',
        'UNKNOWN',
        'The bridge extension identity or exposed method registry does not match the active MCP server.',
        'Reconnect an extension built from the compatible exact source and re-run native inspection.',
        'runtime',
        'unverified',
      ),
    );
  }
  findings.sort((a, b) => a.id.localeCompare(b.id));
  const summary = summarize(findings);
  const overall_status =
    summary.FAIL > 0
      ? 'FAIL'
      : summary.UNKNOWN > 0
        ? 'UNKNOWN'
        : summary.WARNING > 0
          ? 'WARNING'
          : 'PASS';
  const input_evidence = collectInputEvidence(input);
  return {
    project_id: input.projectId,
    overall_status,
    pcb_context: observedBoard ? 'observed' : 'unverified',
    runtime: {
      bridge_connected: input.bridgeConnected,
      registry_mismatch: input.registryMismatch ?? null,
      extension_version_mismatch: input.extensionVersionMismatch ?? null,
    },
    groups: groupFindings(findings),
    source_version: {
      easyeda: input.easyedaVersion ?? null,
      extension: input.extensionVersion ?? null,
    },
    observations: input.observations,
    input_evidence,
    findings,
    summary,
    human_review_required: [
      'Run and assess the native DRC/ERC outputs in their correct document tabs.',
      'Confirm datasheet, stackup, assembly process and manufacturer-specific constraints.',
      'Have a qualified engineer review electrical safety and fabrication readiness.',
    ],
    engineering_sign_off: false,
  };
}
