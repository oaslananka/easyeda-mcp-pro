export type LayoutQaSeverity = 'critical' | 'error' | 'warning' | 'info';

export type LayoutQaCategory =
  | 'electrical'
  | 'geometry'
  | 'readability'
  | 'grouping'
  | 'wiring'
  | 'runtime';

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

function right(rect: LayoutQaBounds): number {
  return rect.x + rect.width;
}

function top(rect: LayoutQaBounds): number {
  return rect.y + rect.height;
}

function intersects(a: LayoutQaBounds, b: LayoutQaBounds): boolean {
  return a.x < right(b) && right(a) > b.x && a.y < top(b) && top(a) > b.y;
}

function contains(outer: LayoutQaBounds, inner: LayoutQaBounds): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    right(inner) <= right(outer) &&
    top(inner) <= top(outer)
  );
}

function area(rect: LayoutQaBounds): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function intersectionArea(a: LayoutQaBounds, b: LayoutQaBounds): number {
  const width = Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(top(a), top(b)) - Math.max(a.y, b.y));
  return width * height;
}

function center(rect: LayoutQaBounds): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function distance(a: LayoutQaBounds, b: LayoutQaBounds): number {
  const ac = center(a);
  const bc = center(b);
  return Math.hypot(ac.x - bc.x, ac.y - bc.y);
}

function edgeClearance(a: LayoutQaBounds, b: LayoutQaBounds): number {
  const horizontal = Math.max(b.x - right(a), a.x - right(b), 0);
  const vertical = Math.max(b.y - top(a), a.y - top(b), 0);
  return Math.hypot(horizontal, vertical);
}

function wireLength(wire: LayoutQaWire): number {
  if (wire.length !== undefined) return wire.length;
  const points = wire.points ?? [];
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const current = points[index];
    const previous = points[index - 1];
    if (!current || !previous) continue;
    length += Math.abs(current.x - previous.x);
    length += Math.abs(current.y - previous.y);
  }
  return length;
}

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

function geometrySource(primitive: LayoutQaPrimitive): LayoutQaEvidenceSource {
  return primitive.geometrySource === 'runtime' ? 'exact_geometry' : 'derived_geometry';
}

function textRegions(
  primitive: LayoutQaPrimitive,
): Array<{ ownerId: string; bounds: LayoutQaBounds; kind: string }> {
  const regions: Array<{ ownerId: string; bounds: LayoutQaBounds; kind: string }> = [];
  if (primitive.referenceBounds)
    regions.push({ ownerId: primitive.id, bounds: primitive.referenceBounds, kind: 'reference' });
  if (primitive.valueBounds)
    regions.push({ ownerId: primitive.id, bounds: primitive.valueBounds, kind: 'value' });
  for (const bounds of primitive.pinTextBounds ?? [])
    regions.push({ ownerId: primitive.id, bounds, kind: 'pin-text' });
  for (const bounds of primitive.labelBounds ?? [])
    regions.push({ ownerId: primitive.id, bounds, kind: 'label' });
  for (const bounds of primitive.annotationBounds ?? [])
    regions.push({ ownerId: primitive.id, bounds, kind: 'annotation' });
  if (
    (primitive.primitiveType === 'text' ||
      primitive.primitiveType === 'label' ||
      primitive.primitiveType === 'annotation') &&
    regions.length === 0
  ) {
    regions.push({ ownerId: primitive.id, bounds: primitive.combinedBounds, kind: primitive.primitiveType });
  }
  return regions;
}

function blockingSeverity(severity: LayoutQaSeverity): boolean {
  return severity === 'critical' || severity === 'error';
}

function diagnosticClassification(
  diagnostic: RuntimeDiagnostic,
): RuntimeDiagnosticClassification {
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
    [...value.affectedPrimitiveIds].sort().join(','),
    [...value.affectedNets].sort().join(','),
    [...value.affectedPins].sort().join(','),
  ].join('|');
}

function scoreDimension(
  issues: LayoutQaIssue[],
  categories: LayoutQaCategory[],
): number {
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
  const issues: LayoutQaIssue[] = [];
  const components = input.primitives.filter((value) => value.primitiveType === 'component');
  const sections = input.primitives.filter((value) => value.primitiveType === 'section');
  const text = input.primitives.flatMap(textRegions);
  const hardKeepouts = [
    { id: 'title-block', bounds: input.sheet.titleBlockKeepout },
    ...(input.sheet.hardKeepouts ?? []),
  ];

  for (const primitive of input.primitives) {
    if (!contains(input.sheet.drawableBounds, primitive.combinedBounds)) {
      issues.push(
        issue({
          code: 'PAGE_BOUNDARY_OVERFLOW',
          severity: 'critical',
          category: 'geometry',
          source: geometrySource(primitive),
          message: `${primitive.id} extends outside the drawable sheet bounds.`,
          affectedPrimitiveIds: [primitive.id],
          region: primitive.combinedBounds,
          evidence: 'Combined rendered bounds are not contained by drawableBounds.',
          remediation: 'Move or resize the primitive inside the drawable page boundary.',
          blocksCommit: true,
          confidence: primitive.geometrySource === 'runtime' ? 1 : 0.85,
        }),
      );
    }
    for (const keepout of hardKeepouts) {
      if (!intersects(primitive.combinedBounds, keepout.bounds)) continue;
      issues.push(
        issue({
          code: keepout.id === 'title-block' ? 'TITLE_BLOCK_OVERLAP' : 'PAGE_BOUNDARY_OVERFLOW',
          severity: 'critical',
          category: 'geometry',
          source: geometrySource(primitive),
          message: `${primitive.id} intersects hard keep-out ${keepout.id}.`,
          affectedPrimitiveIds: [primitive.id],
          region: primitive.combinedBounds,
          evidence: `Rendered combined bounds intersect ${keepout.id}.`,
          remediation: 'Move the complete rendered primitive, including all text, outside the hard keep-out.',
          blocksCommit: true,
          confidence: primitive.geometrySource === 'runtime' ? 1 : 0.85,
        }),
      );
    }
  }

  for (let leftIndex = 0; leftIndex < components.length; leftIndex += 1) {
    const left = components[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < components.length; rightIndex += 1) {
      const rightComponent = components[rightIndex];
      if (!rightComponent) continue;
      if (intersects(left.combinedBounds, rightComponent.combinedBounds)) {
        issues.push(
          issue({
            code: 'COMPONENT_OVERLAP',
            severity: 'critical',
            category: 'geometry',
            source:
              left.geometrySource === 'runtime' && rightComponent.geometrySource === 'runtime'
                ? 'exact_geometry'
                : 'derived_geometry',
            message: `${left.id} overlaps ${rightComponent.id}.`,
            affectedPrimitiveIds: [left.id, rightComponent.id],
            measured: intersectionArea(left.combinedBounds, rightComponent.combinedBounds),
            expected: 0,
            evidence: 'Rendered combined bounding boxes intersect.',
            remediation: 'Replan the components with the configured minimum clearance.',
            blocksCommit: true,
            confidence: 1,
          }),
        );
      } else {
        const gap = edgeClearance(left.combinedBounds, rightComponent.combinedBounds);
        if (gap < thresholds.componentClearance) {
          issues.push(
            issue({
              code: 'LOCAL_CROWDING',
              severity: 'warning',
              category: 'readability',
              source: 'exact_geometry',
              message: `${left.id} and ${rightComponent.id} are closer than the component clearance.`,
              affectedPrimitiveIds: [left.id, rightComponent.id],
              measured: gap,
              expected: thresholds.componentClearance,
              evidence: 'Measured edge clearance is below the configured threshold.',
              remediation: 'Increase spacing between the two components.',
              blocksCommit: false,
              confidence: 1,
            }),
          );
        }
      }
    }
  }

  for (const component of components) {
    const body = component.bodyBounds ?? component.combinedBounds;
    for (const region of text) {
      if (region.ownerId === component.id && region.kind === 'pin-text') continue;
      if (!intersects(body, region.bounds)) continue;
      issues.push(
        issue({
          code: 'COMPONENT_TEXT_OVERLAP',
          severity: 'critical',
          category: 'geometry',
          source: geometrySource(component),
          message: `${component.id} body overlaps ${region.kind} text from ${region.ownerId}.`,
          affectedPrimitiveIds: [...new Set([component.id, region.ownerId])],
          region: region.bounds,
          evidence: 'Component body bounds intersect a rendered text bound.',
          remediation: 'Move the text or component while preserving electrical connectivity.',
          blocksCommit: true,
          confidence: 1,
        }),
      );
    }
  }

  for (let leftIndex = 0; leftIndex < text.length; leftIndex += 1) {
    const left = text[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < text.length; rightIndex += 1) {
      const rightText = text[rightIndex];
      if (!rightText) continue;
      if (!intersects(left.bounds, rightText.bounds)) continue;
      issues.push(
        issue({
          code: 'TEXT_TEXT_OVERLAP',
          severity: 'error',
          category: 'readability',
          source: 'exact_geometry',
          message: `${left.kind} text from ${left.ownerId} overlaps ${rightText.kind} text from ${rightText.ownerId}.`,
          affectedPrimitiveIds: [...new Set([left.ownerId, rightText.ownerId])],
          region: left.bounds,
          evidence: 'Rendered text bounds intersect.',
          remediation: 'Reposition text using the configured text clearance.',
          blocksCommit: true,
          confidence: 1,
        }),
      );
    }
  }

  for (const section of sections) {
    const conflicts = components.filter((component) => {
      if (section.blockId && component.blockId === section.blockId) return false;
      return intersects(section.combinedBounds, component.combinedBounds);
    });
    if (intersects(section.combinedBounds, input.sheet.titleBlockKeepout) || conflicts.length > 0) {
      issues.push(
        issue({
          code: 'SECTION_BOX_CONFLICT',
          severity: 'error',
          category: 'geometry',
          source: geometrySource(section),
          message: `${section.id} conflicts with circuitry or the title-block keep-out.`,
          affectedPrimitiveIds: [section.id, ...conflicts.map((value) => value.id)],
          region: section.combinedBounds,
          evidence: 'Section bounds intersect an unrelated component or hard keep-out.',
          remediation: 'Resize or move the section after all member components are placed.',
          blocksCommit: true,
          confidence: 1,
        }),
      );
    }
  }

  const refs = new Map<string, string[]>();
  const netLabels = new Map<string, string[]>();
  for (const primitive of input.primitives) {
    if (primitive.ref) refs.set(primitive.ref, [...(refs.get(primitive.ref) ?? []), primitive.id]);
    if (
      primitive.netName &&
      (primitive.primitiveType === 'label' || primitive.primitiveType === 'netport')
    ) {
      netLabels.set(primitive.netName, [...(netLabels.get(primitive.netName) ?? []), primitive.id]);
    }
    for (const pin of primitive.pinConnections ?? []) {
      if (pin.connected === false || !pin.netName) {
        issues.push(
          issue({
            code: 'DANGLING_PIN',
            severity: 'error',
            category: 'electrical',
            source: 'expected_topology',
            message: `${primitive.ref ?? primitive.id} pin ${pin.pin} is dangling.`,
            affectedPrimitiveIds: [primitive.id],
            affectedPins: [`${primitive.ref ?? primitive.id}.${pin.pin}`],
            evidence: 'Pin readback has no connected net membership.',
            remediation: 'Connect the pin or declare an intentional no-connect explicitly.',
            blocksCommit: true,
            confidence: 1,
          }),
        );
      }
    }
    if (primitive.primitiveType === 'netport' && primitive.connected === false) {
      issues.push(
        issue({
          code: 'DETACHED_NETPORT',
          severity: 'error',
          category: 'wiring',
          source: 'exact_geometry',
          message: `${primitive.id} is not attached to a wire or bus.`,
          affectedPrimitiveIds: [primitive.id],
          affectedNets: primitive.netName ? [primitive.netName] : [],
          evidence: 'Netport readback reports no wire/bus attachment.',
          remediation: 'Attach the netport to a visible wire stub or replace it with local wiring.',
          blocksCommit: true,
          confidence: 1,
        }),
      );
    }
  }

  for (const [ref, ids] of refs) {
    if (ids.length < 2) continue;
    issues.push(
      issue({
        code: 'DUPLICATE_REFERENCE',
        severity: 'error',
        category: 'electrical',
        source: 'expected_topology',
        message: `Reference ${ref} is used by ${ids.length} components.`,
        affectedPrimitiveIds: ids,
        evidence: 'Reference-designator inventory contains duplicates.',
        remediation: 'Assign unique reference designators and rerun topology validation.',
        blocksCommit: true,
        confidence: 1,
      }),
    );
  }

  for (const [netName, ids] of netLabels) {
    if (ids.length < 2) continue;
    issues.push(
      issue({
        code: 'DUPLICATE_NET_LABEL',
        severity: 'warning',
        category: 'wiring',
        source: 'expected_topology',
        message: `Net ${netName} has ${ids.length} visible labels/netports.`,
        affectedPrimitiveIds: ids,
        affectedNets: [netName],
        evidence: 'Visible label inventory contains repeated net names.',
        remediation: 'Remove redundant labels or document why multiple local labels are required.',
        blocksCommit: false,
        confidence: 1,
      }),
    );
  }

  const byRef = new Map(
    components.filter((value) => value.ref).map((value) => [value.ref as string, value]),
  );
  for (const ref of input.expected?.componentRefs ?? []) {
    if (byRef.has(ref)) continue;
    issues.push(
      issue({
        code: 'EXPECTED_NET_MISMATCH',
        severity: 'error',
        category: 'electrical',
        source: 'expected_topology',
        message: `Expected component ${ref} is missing.`,
        expected: ref,
        evidence: 'Template component inventory does not match readback.',
        remediation: 'Restore the expected component before accepting the workflow result.',
        blocksCommit: true,
        confidence: 1,
      }),
    );
  }
  for (const mapping of input.expected?.pinMappings ?? []) {
    const component = byRef.get(mapping.componentRef);
    const actual = component?.pinConnections?.find((value) => value.pin === mapping.pin)?.netName;
    if (actual === mapping.netName) continue;
    issues.push(
      issue({
        code: 'EXPECTED_NET_MISMATCH',
        severity: 'critical',
        category: 'electrical',
        source: 'expected_topology',
        message: `${mapping.componentRef}.${mapping.pin} is on ${actual ?? 'no net'}; expected ${mapping.netName}.`,
        affectedPrimitiveIds: component ? [component.id] : [],
        affectedNets: [mapping.netName, ...(actual ? [actual] : [])],
        affectedPins: [`${mapping.componentRef}.${mapping.pin}`],
        expected: mapping.netName,
        evidence: 'Readback pin-to-net membership differs from the workflow template.',
        remediation: 'Correct the connection and verify the complete expected pin map.',
        blocksCommit: true,
        confidence: 1,
      }),
    );
  }

  const actualNetNames = new Set<string>();
  for (const primitive of input.primitives) {
    if (primitive.netName) actualNetNames.add(primitive.netName);
    for (const pin of primitive.pinConnections ?? []) {
      if (pin.netName) actualNetNames.add(pin.netName);
    }
  }
  for (const wire of input.wires ?? []) {
    if (wire.netName) actualNetNames.add(wire.netName);
  }
  for (const netName of input.expected?.netNames ?? []) {
    if (actualNetNames.has(netName)) continue;
    issues.push(
      issue({
        code: 'EXPECTED_NET_MISMATCH',
        severity: 'error',
        category: 'electrical',
        source: 'expected_topology',
        message: `Expected net ${netName} is missing from readback.`,
        affectedNets: [netName],
        expected: netName,
        evidence: 'Expected net inventory differs from normalized readback.',
        remediation: 'Restore the expected net and verify each required pin membership.',
        blocksCommit: true,
        confidence: 1,
      }),
    );
  }

  const byId = new Map<string, LayoutQaPrimitive>();
  const relationshipRefMap = new Map<string, LayoutQaPrimitive>();
  for (const primitive of input.primitives) {
    byId.set(primitive.id, primitive);
    if (primitive.ref) relationshipRefMap.set(primitive.ref, primitive);
  }
  const resolveRelationshipEndpoint = (key: string): LayoutQaPrimitive | undefined =>
    byId.get(key) ?? relationshipRefMap.get(key);
  for (const relationship of input.relationships ?? []) {
    const source = resolveRelationshipEndpoint(relationship.sourceId);
    const target = resolveRelationshipEndpoint(relationship.targetId);
    if (!source || !target) continue;
    const measured = distance(source.combinedBounds, target.combinedBounds);
    const maximum = relationship.maxDistance || thresholds.relatedComponentDistance;
    if (measured <= maximum) continue;
    issues.push(
      issue({
        code: 'RELATED_COMPONENT_DISTANCE',
        severity: 'warning',
        category: 'grouping',
        source: 'exact_geometry',
        message: `${relationship.sourceId} is too far from related ${relationship.targetId}.`,
        affectedPrimitiveIds: [relationship.sourceId, relationship.targetId],
        measured,
        expected: maximum,
        evidence: `${relationship.kind} relationship exceeds its maximum center distance.`,
        remediation: 'Replan the support component inside its parent functional block.',
        blocksCommit: false,
        confidence: 1,
      }),
    );
  }

  for (const wire of input.wires ?? []) {
    const measured = wireLength(wire);
    if (measured > thresholds.excessiveWireLength) {
      issues.push(
        issue({
          code: 'EXCESSIVE_WIRE_LENGTH',
          severity: 'warning',
          category: 'wiring',
          source: 'exact_geometry',
          message: `${wire.id} exceeds the configured wire-length threshold.`,
          affectedPrimitiveIds: [wire.id],
          affectedNets: wire.netName ? [wire.netName] : [],
          measured,
          expected: thresholds.excessiveWireLength,
          evidence: 'Orthogonal path length exceeds the workflow threshold.',
          remediation: 'Move related blocks closer or replace the cross-sheet route with an explicit net label.',
          blocksCommit: false,
          confidence: 1,
        }),
      );
    }
  }

  if (components.length >= 3) {
    const occupiedArea = components.reduce(
      (sum, component) => sum + area(component.combinedBounds),
      0,
    );
    const utilization = occupiedArea / Math.max(1, area(input.sheet.drawableBounds));
    if (utilization < thresholds.minimumUtilization) {
      issues.push(
        issue({
          code: 'EXCESSIVE_WHITESPACE',
          severity: 'warning',
          category: 'readability',
          source: 'exact_geometry',
          message: 'Component utilization is below the configured page threshold.',
          measured: utilization,
          expected: thresholds.minimumUtilization,
          evidence: 'Total component rendered area divided by drawable page area is too low.',
          remediation: 'Consolidate functional blocks or use a smaller sheet when constraints allow.',
          blocksCommit: false,
          confidence: 0.9,
        }),
      );
    }

    const columns = 4;
    const rows = 4;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const cell: LayoutQaBounds = {
          x: input.sheet.drawableBounds.x + (input.sheet.drawableBounds.width * column) / columns,
          y: input.sheet.drawableBounds.y + (input.sheet.drawableBounds.height * row) / rows,
          width: input.sheet.drawableBounds.width / columns,
          height: input.sheet.drawableBounds.height / rows,
        };
        const used = components.reduce(
          (sum, component) => sum + intersectionArea(cell, component.combinedBounds),
          0,
        );
        const density = used / Math.max(1, area(cell));
        if (density <= thresholds.maximumLocalDensity) continue;
        issues.push(
          issue({
            code: 'LOCAL_CROWDING',
            severity: 'warning',
            category: 'readability',
            source: 'exact_geometry',
            message: 'A local page region exceeds the configured density threshold.',
            region: cell,
            measured: density,
            expected: thresholds.maximumLocalDensity,
            evidence: 'Rendered component area within a normalized page cell is too dense.',
            remediation: 'Redistribute the affected functional block while preserving relationships.',
            blocksCommit: false,
            confidence: 0.9,
          }),
        );
      }
    }
  }

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
        remediation: 'Restore the bridge/document state and repeat readback before retrying any write.',
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
        remediation: 'Capture the complete page and rerun visual QA; do not interpret this run as visual approval.',
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
    (!input.visual?.captureAvailable || runtime?.drcAvailable === false || runtime?.ercAvailable === false);
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
