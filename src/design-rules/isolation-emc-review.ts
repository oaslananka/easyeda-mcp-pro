/**
 * Explicitly source-scoped insulation/EMC review. An observed shortfall from a
 * caller-declared requirement is a warning, not independent IEC/IPC proof.
 * No protected standard tables or default spacing thresholds are embedded.
 */

export type InsulationPurpose =
  'functional' | 'basic' | 'supplementary' | 'reinforced' | 'unspecified';
export type Environment =
  'controlled-indoor' | 'industrial' | 'outdoor' | 'condensing' | 'unspecified';

export interface StandardReference {
  identifier: string;
  edition: string;
  clause: string;
  source: string;
}

export interface SpacingRequirement {
  minimumMm: number;
  reference: StandardReference;
}

export interface GeometryObservation {
  distanceMm: number;
  evidenceRef: string;
  evidenceKind: 'measured_air_gap' | 'measured_surface_path' | 'estimated';
}

export interface IsolationEmcInput {
  purpose?: InsulationPurpose;
  workingVoltageV?: number;
  transientVoltageV?: number;
  environment?: Environment;
  pollutionDegree?: 1 | 2 | 3 | 4;
  overvoltageCategory?: 'I' | 'II' | 'III' | 'IV';
  materialGroup?: 'I' | 'II' | 'IIIa' | 'IIIb';
  altitudeM?: number;
  safetyStandard?: StandardReference;
  clearanceRequirement?: SpacingRequirement;
  creepageRequirement?: SpacingRequirement;
  airClearance?: GeometryObservation;
  surfaceCreepage?: GeometryObservation;
  boardSlotEvidence?: string;
  coatingEvidence?: string;
  esdEntry?: {
    connectorRef: string;
    protectorRef?: string;
    entryNet?: string;
    returnPathEvidence?: string;
    testStandard?: StandardReference;
  };
  emcReturn?: {
    fastLoopRef?: string;
    returnPlaneEvidence?: string;
    sensitiveCircuitRef?: string;
  };
}

export interface IsolationEmcFinding {
  id: 'AIR_CLEARANCE' | 'SURFACE_CREEPAGE' | 'INSULATION_CONTEXT' | 'ESD_ENTRY' | 'EMC_RETURN';
  status: 'WARNING' | 'UNKNOWN';
  message: string;
  reported_mm?: number;
  declared_min_mm?: number;
  reference?: StandardReference;
  evidence_refs: string[];
  missing: string[];
}

export interface IsolationEmcReview {
  status: 'WARNING' | 'UNKNOWN';
  evidence: 'caller_supplied_unverified';
  safety_certification: false;
  qualified_review_required: boolean;
  context_missing: string[];
  findings: IsolationEmcFinding[];
  limitations: string[];
  source_references: StandardReference[];
  engineering_sign_off: false;
}

function reviewSpacing(
  id: 'AIR_CLEARANCE' | 'SURFACE_CREEPAGE',
  requirement: SpacingRequirement | undefined,
  observation: GeometryObservation | undefined,
): IsolationEmcFinding {
  const missing = [
    ...(requirement === undefined ? ['source-declared minimum distance'] : []),
    ...(observation === undefined ? ['geometry measurement'] : []),
  ];
  const expectedKind = id === 'AIR_CLEARANCE' ? 'measured_air_gap' : 'measured_surface_path';
  if (observation !== undefined && observation.evidenceKind !== expectedKind) {
    missing.push(
      id === 'AIR_CLEARANCE'
        ? 'measured through-air clearance between actual conductors'
        : 'measured along-surface creepage path accounting for geometry and slots',
    );
  }
  const base: IsolationEmcFinding = {
    id,
    status: 'UNKNOWN',
    message:
      'Only explicit, source-declared dimensions are compared; independent safety compliance is not verified.',
    evidence_refs: observation ? [observation.evidenceRef] : [],
    missing,
    ...(requirement
      ? { declared_min_mm: requirement.minimumMm, reference: requirement.reference }
      : {}),
    ...(observation ? { reported_mm: observation.distanceMm } : {}),
  };
  if (missing.length > 0 || !requirement || !observation) return base;
  const violated = observation.distanceMm < requirement.minimumMm;
  return {
    ...base,
    status: violated ? 'WARNING' : 'UNKNOWN',
    message: violated
      ? 'Caller-reported geometry is below its caller-declared, edition-linked minimum; verify the source and board physically.'
      : 'Caller-reported geometry meets its declared minimum, but the source applicability and measurement are unverified.',
  };
}

function missingContext(input: IsolationEmcInput): string[] {
  const missing: string[] = [];
  if (input.purpose === undefined || input.purpose === 'unspecified') {
    missing.push('insulation purpose (functional/basic/supplementary/reinforced)');
  }
  if (input.workingVoltageV === undefined) missing.push('working voltage');
  if (input.transientVoltageV === undefined) missing.push('transient/impulse voltage');
  if (input.environment === undefined || input.environment === 'unspecified') {
    missing.push('environment and condensation exposure');
  }
  if (input.pollutionDegree === undefined) missing.push('pollution degree');
  if (input.overvoltageCategory === undefined) missing.push('overvoltage category');
  if (input.materialGroup === undefined) missing.push('insulating material group / CTI');
  if (input.altitudeM === undefined) missing.push('installation altitude');
  if (input.safetyStandard === undefined)
    missing.push('applicable safety standard, edition and clause');
  return missing;
}

function reviewEsd(input: NonNullable<IsolationEmcInput['esdEntry']>): IsolationEmcFinding {
  const missing = [
    ...(input.protectorRef ? [] : ['declared ESD protection component']),
    ...(input.entryNet ? [] : ['connector entry net']),
    ...(input.returnPathEvidence
      ? []
      : ['verified short ESD return path and actual copper geometry']),
  ];
  return {
    id: 'ESD_ENTRY',
    status: 'UNKNOWN',
    message:
      'Connector/TVS designators are not proof of placement, discharge routing or IEC 61000-4-2 immunity performance.',
    ...(input.testStandard ? { reference: input.testStandard } : {}),
    evidence_refs: input.returnPathEvidence ? [input.returnPathEvidence] : [],
    missing,
  };
}

function reviewEmc(input: NonNullable<IsolationEmcInput['emcReturn']>): IsolationEmcFinding {
  return {
    id: 'EMC_RETURN',
    status: 'UNKNOWN',
    message:
      'Names of loops, planes and sensitive parts do not establish measured EMI or continuous high-frequency return paths.',
    evidence_refs: input.returnPlaneEvidence ? [input.returnPlaneEvidence] : [],
    missing: [
      ...(input.fastLoopRef ? [] : ['fast-current loop identity']),
      ...(input.returnPlaneEvidence ? [] : ['verified reference-plane/return-current geometry']),
      ...(input.sensitiveCircuitRef ? [] : ['sensitive circuit identity']),
    ],
  };
}

function uniqueReferences(input: IsolationEmcInput): StandardReference[] {
  const sources = [
    input.safetyStandard,
    input.clearanceRequirement?.reference,
    input.creepageRequirement?.reference,
    input.esdEntry?.testStandard,
  ].filter((source): source is StandardReference => source !== undefined);
  return sources.filter(
    (source, i) =>
      sources.findIndex(
        (other) =>
          other.identifier === source.identifier &&
          other.edition === source.edition &&
          other.clause === source.clause &&
          other.source === source.source,
      ) === i,
  );
}

export function reviewIsolationEmc(input: IsolationEmcInput): IsolationEmcReview {
  const context_missing = missingContext(input);
  const findings: IsolationEmcFinding[] = [
    reviewSpacing('AIR_CLEARANCE', input.clearanceRequirement, input.airClearance),
    reviewSpacing('SURFACE_CREEPAGE', input.creepageRequirement, input.surfaceCreepage),
    {
      id: 'INSULATION_CONTEXT',
      status: 'UNKNOWN',
      message:
        'Voltage, material, environment and standard applicability must be checked by a qualified design reviewer; no insulation classification is certified.',
      evidence_refs: [
        ...(input.boardSlotEvidence ? [input.boardSlotEvidence] : []),
        ...(input.coatingEvidence ? [input.coatingEvidence] : []),
      ],
      missing: context_missing,
    },
  ];
  if (input.esdEntry) findings.push(reviewEsd(input.esdEntry));
  if (input.emcReturn) findings.push(reviewEmc(input.emcReturn));
  const qualified = ['basic', 'supplementary', 'reinforced'].includes(input.purpose ?? '');
  return {
    status: findings.some((finding) => finding.status === 'WARNING') ? 'WARNING' : 'UNKNOWN',
    evidence: 'caller_supplied_unverified',
    safety_certification: false,
    qualified_review_required: qualified || context_missing.length > 0,
    context_missing,
    findings,
    limitations: [
      'IEC/IPC numeric tables are not embedded; requirement, edition, applicability and geometry are independently caller-declared, not checked against licensed standards.',
      'Air clearance is the shortest through-air route; creepage is the shortest distance along the insulation surface. A direct PCB XY gap is not automatically a creepage path.',
      'Slots, cutouts, conformal coating, encapsulation and barriers change geometry and applicability but cannot be inferred or certified from provided names or descriptions.',
      'Environmental conditions, pollution degree, overvoltage, material group/CTI, altitude, insulation class and equipment safety context require qualified human verification.',
      'ESD advice does not establish IEC 61000-4-2 test results; EMC/EMI compliance requires appropriate measurement or laboratory evidence.',
      'No PCB primitives were read and no DRC, field solver, safety inspection, EMC measurement or physical acceptance was performed.',
    ],
    source_references: uniqueReferences(input),
    engineering_sign_off: false,
  };
}
