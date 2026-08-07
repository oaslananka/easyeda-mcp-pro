import type {
  LayoutQaBounds,
  LayoutQaInput,
  LayoutQaIssue,
  LayoutQaPrimitive,
  LayoutQaWire,
} from './schematic-layout-qa.js';

export interface LayoutQaTopologyThresholds {
  relatedComponentDistance: number;
  excessiveWireLength: number;
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

function center(rect: LayoutQaBounds): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function distance(a: LayoutQaBounds, b: LayoutQaBounds): number {
  const ac = center(a);
  const bc = center(b);
  return Math.hypot(ac.x - bc.x, ac.y - bc.y);
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

function collectPrimitiveConnectionIssues(primitives: LayoutQaPrimitive[]): LayoutQaIssue[] {
  const issues: LayoutQaIssue[] = [];
  for (const primitive of primitives) {
    for (const pin of primitive.pinConnections ?? []) {
      if (pin.connected !== false && pin.netName) continue;
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
    if (primitive.primitiveType !== 'netport' || primitive.connected !== false) continue;
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
  return issues;
}

function collectDuplicateIdentityIssues(primitives: LayoutQaPrimitive[]): LayoutQaIssue[] {
  const issues: LayoutQaIssue[] = [];
  const refs = new Map<string, string[]>();
  const netLabels = new Map<string, string[]>();
  for (const primitive of primitives) {
    if (primitive.ref) refs.set(primitive.ref, [...(refs.get(primitive.ref) ?? []), primitive.id]);
    if (
      primitive.netName &&
      (primitive.primitiveType === 'label' || primitive.primitiveType === 'netport')
    ) {
      netLabels.set(primitive.netName, [...(netLabels.get(primitive.netName) ?? []), primitive.id]);
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
  return issues;
}

function componentByReference(input: LayoutQaInput): Map<string, LayoutQaPrimitive> {
  return new Map(
    input.primitives
      .filter((value) => value.primitiveType === 'component' && value.ref)
      .map((value) => [value.ref as string, value]),
  );
}

function collectExpectedComponentIssues(
  componentRefs: string[],
  byRef: Map<string, LayoutQaPrimitive>,
): LayoutQaIssue[] {
  const issues: LayoutQaIssue[] = [];
  for (const ref of componentRefs) {
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
  return issues;
}

function collectExpectedPinMappingIssues(
  input: LayoutQaInput,
  byRef: Map<string, LayoutQaPrimitive>,
): LayoutQaIssue[] {
  const issues: LayoutQaIssue[] = [];
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
  return issues;
}

function actualNetNames(input: LayoutQaInput): Set<string> {
  const names = new Set<string>();
  for (const primitive of input.primitives) {
    if (primitive.netName) names.add(primitive.netName);
    for (const pin of primitive.pinConnections ?? []) {
      if (pin.netName) names.add(pin.netName);
    }
  }
  for (const wire of input.wires ?? []) {
    if (wire.netName) names.add(wire.netName);
  }
  return names;
}

function collectExpectedNetIssues(input: LayoutQaInput): LayoutQaIssue[] {
  const issues: LayoutQaIssue[] = [];
  const names = actualNetNames(input);
  for (const netName of input.expected?.netNames ?? []) {
    if (names.has(netName)) continue;
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
  return issues;
}

function collectExpectedTopologyIssues(input: LayoutQaInput): LayoutQaIssue[] {
  const byRef = componentByReference(input);
  return [
    ...collectExpectedComponentIssues(input.expected?.componentRefs ?? [], byRef),
    ...collectExpectedPinMappingIssues(input, byRef),
    ...collectExpectedNetIssues(input),
  ];
}

function collectRelationshipIssues(
  input: LayoutQaInput,
  relatedComponentDistance: number,
): LayoutQaIssue[] {
  const issues: LayoutQaIssue[] = [];
  const byId = new Map<string, LayoutQaPrimitive>();
  const byRef = new Map<string, LayoutQaPrimitive>();
  for (const primitive of input.primitives) {
    byId.set(primitive.id, primitive);
    if (primitive.ref) byRef.set(primitive.ref, primitive);
  }
  const resolveEndpoint = (key: string): LayoutQaPrimitive | undefined =>
    byId.get(key) ?? byRef.get(key);

  for (const relationship of input.relationships ?? []) {
    const source = resolveEndpoint(relationship.sourceId);
    const target = resolveEndpoint(relationship.targetId);
    if (!source || !target) continue;
    const measured = distance(source.combinedBounds, target.combinedBounds);
    const maximum = relationship.maxDistance || relatedComponentDistance;
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
  return issues;
}

function collectWireIssues(wires: LayoutQaWire[], excessiveWireLength: number): LayoutQaIssue[] {
  const issues: LayoutQaIssue[] = [];
  for (const wire of wires) {
    const measured = wireLength(wire);
    if (measured <= excessiveWireLength) continue;
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
        expected: excessiveWireLength,
        evidence: 'Orthogonal path length exceeds the workflow threshold.',
        remediation:
          'Move related blocks closer or replace the cross-sheet route with an explicit net label.',
        blocksCommit: false,
        confidence: 1,
      }),
    );
  }
  return issues;
}

export function collectSchematicLayoutTopologyIssues(
  input: LayoutQaInput,
  thresholds: LayoutQaTopologyThresholds,
): LayoutQaIssue[] {
  return [
    ...collectPrimitiveConnectionIssues(input.primitives),
    ...collectDuplicateIdentityIssues(input.primitives),
    ...collectExpectedTopologyIssues(input),
    ...collectRelationshipIssues(input, thresholds.relatedComponentDistance),
    ...collectWireIssues(input.wires ?? [], thresholds.excessiveWireLength),
  ];
}
