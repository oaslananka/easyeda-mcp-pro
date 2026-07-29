import type {
  LayoutQaBounds,
  LayoutQaEvidenceSource,
  LayoutQaInput,
  LayoutQaIssue,
  LayoutQaPrimitive,
} from './schematic-layout-qa.js';

export interface LayoutQaGeometryThresholds {
  componentClearance: number;
  minimumUtilization: number;
  maximumLocalDensity: number;
}

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

function edgeClearance(a: LayoutQaBounds, b: LayoutQaBounds): number {
  const horizontal = Math.max(b.x - right(a), a.x - right(b), 0);
  const vertical = Math.max(b.y - top(a), a.y - top(b), 0);
  return Math.hypot(horizontal, vertical);
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
    regions.push({
      ownerId: primitive.id,
      bounds: primitive.combinedBounds,
      kind: primitive.primitiveType,
    });
  }
  return regions;
}

function collectBoundaryIssues(input: LayoutQaInput): LayoutQaIssue[] {
  const issues: LayoutQaIssue[] = [];
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
          remediation:
            'Move the complete rendered primitive, including all text, outside the hard keep-out.',
          blocksCommit: true,
          confidence: primitive.geometrySource === 'runtime' ? 1 : 0.85,
        }),
      );
    }
  }
  return issues;
}

function collectComponentSpacingIssues(
  components: LayoutQaPrimitive[],
  componentClearance: number,
): LayoutQaIssue[] {
  const issues: LayoutQaIssue[] = [];
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
        continue;
      }
      const gap = edgeClearance(left.combinedBounds, rightComponent.combinedBounds);
      if (gap >= componentClearance) continue;
      issues.push(
        issue({
          code: 'LOCAL_CROWDING',
          severity: 'warning',
          category: 'readability',
          source: 'exact_geometry',
          message: `${left.id} and ${rightComponent.id} are closer than the component clearance.`,
          affectedPrimitiveIds: [left.id, rightComponent.id],
          measured: gap,
          expected: componentClearance,
          evidence: 'Measured edge clearance is below the configured threshold.',
          remediation: 'Increase spacing between the two components.',
          blocksCommit: false,
          confidence: 1,
        }),
      );
    }
  }
  return issues;
}

function collectComponentTextIssues(
  components: LayoutQaPrimitive[],
  text: Array<{ ownerId: string; bounds: LayoutQaBounds; kind: string }>,
): LayoutQaIssue[] {
  const issues: LayoutQaIssue[] = [];
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
  return issues;
}

function collectTextOverlapIssues(
  text: Array<{ ownerId: string; bounds: LayoutQaBounds; kind: string }>,
): LayoutQaIssue[] {
  const issues: LayoutQaIssue[] = [];
  for (let leftIndex = 0; leftIndex < text.length; leftIndex += 1) {
    const left = text[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < text.length; rightIndex += 1) {
      const rightText = text[rightIndex];
      if (!rightText || !intersects(left.bounds, rightText.bounds)) continue;
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
  return issues;
}

function collectSectionIssues(
  input: LayoutQaInput,
  sections: LayoutQaPrimitive[],
  components: LayoutQaPrimitive[],
): LayoutQaIssue[] {
  const issues: LayoutQaIssue[] = [];
  for (const section of sections) {
    const conflicts = components.filter((component) => {
      if (section.blockId && component.blockId === section.blockId) return false;
      return intersects(section.combinedBounds, component.combinedBounds);
    });
    if (
      !intersects(section.combinedBounds, input.sheet.titleBlockKeepout) &&
      conflicts.length === 0
    )
      continue;
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
  return issues;
}

function collectDensityIssues(
  input: LayoutQaInput,
  components: LayoutQaPrimitive[],
  thresholds: LayoutQaGeometryThresholds,
): LayoutQaIssue[] {
  if (components.length < 3) return [];
  const issues: LayoutQaIssue[] = [];
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
  return issues;
}

export function collectSchematicLayoutGeometryIssues(
  input: LayoutQaInput,
  thresholds: LayoutQaGeometryThresholds,
): LayoutQaIssue[] {
  const components = input.primitives.filter((value) => value.primitiveType === 'component');
  const sections = input.primitives.filter((value) => value.primitiveType === 'section');
  const text = input.primitives.flatMap(textRegions);
  return [
    ...collectBoundaryIssues(input),
    ...collectComponentSpacingIssues(components, thresholds.componentClearance),
    ...collectComponentTextIssues(components, text),
    ...collectTextOverlapIssues(text),
    ...collectSectionIssues(input, sections, components),
    ...collectDensityIssues(input, components, thresholds),
  ];
}
