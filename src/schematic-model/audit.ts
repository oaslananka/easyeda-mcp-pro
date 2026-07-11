import { z } from 'zod';
import { type CanonicalComponent, type SchematicModel } from './model.js';

export const ImportedAuditSeveritySchema = z.enum(['info', 'warning', 'error']);
export type ImportedAuditSeverity = z.infer<typeof ImportedAuditSeveritySchema>;

export const ImportedAuditFindingSchema = z.object({
  code: z.string().min(1),
  severity: ImportedAuditSeveritySchema,
  message: z.string().min(1),
  componentId: z.string().optional(),
  componentRef: z.string().optional(),
  netName: z.string().optional(),
  rawNetNames: z.array(z.string()).optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
  suggestedAction: z.string().min(1),
  confidence: z.enum(['high', 'medium', 'low']),
});
export type ImportedAuditFinding = z.infer<typeof ImportedAuditFindingSchema>;

export const ImportedDesignAuditSchema = z.object({
  schemaVersion: z.literal('imported-design-audit/v1'),
  status: z.enum(['clean', 'review', 'blocked']),
  readOnly: z.literal(true),
  safeToNormalize: z.boolean(),
  modelSummary: z.object({
    componentCount: z.number().int().nonnegative(),
    bomComponentCount: z.number().int().nonnegative(),
    electricalComponentCount: z.number().int().nonnegative(),
    netCount: z.number().int().nonnegative(),
    importedComponentCount: z.number().int().nonnegative(),
  }),
  summary: z.object({
    findingCount: z.number().int().nonnegative(),
    errorCount: z.number().int().nonnegative(),
    warningCount: z.number().int().nonnegative(),
    infoCount: z.number().int().nonnegative(),
    importedNetCount: z.number().int().nonnegative(),
    aliasedNetCount: z.number().int().nonnegative(),
    unannotatedComponentCount: z.number().int().nonnegative(),
    missingFootprintCount: z.number().int().nonnegative(),
    missingValueCount: z.number().int().nonnegative(),
    duplicateReferenceCount: z.number().int().nonnegative(),
    ambiguousBomCount: z.number().int().nonnegative(),
    unresolvedExpressionCount: z.number().int().nonnegative(),
  }),
  findings: z.array(ImportedAuditFindingSchema),
  normalizationPreview: z.object({
    netAliases: z.array(
      z.object({
        canonicalNetName: z.string(),
        rawNetNames: z.array(z.string()),
        kind: z.enum(['signal', 'power', 'ground', 'power-flag', 'unnamed']),
        rules: z.array(z.string()),
      }),
    ),
    componentRepairs: z.array(
      z.object({
        componentId: z.string(),
        reference: z.string(),
        actions: z.array(
          z.enum([
            'annotate-reference',
            'assign-footprint',
            'assign-value',
            'resolve-value-expression',
            'resolve-footprint-expression',
            'review-bom-classification',
          ]),
        ),
      }),
    ),
  }),
});
export type ImportedDesignAudit = z.infer<typeof ImportedDesignAuditSchema>;

export interface AuditImportedDesignOptions {
  includeInfo?: boolean;
  sourceTruncated?: boolean;
}

function unresolvedExpression(value: string): boolean {
  return /^=\{[^{}]+\}$/.test(value.trim());
}

function componentRepairActions(component: CanonicalComponent) {
  const actions: ImportedDesignAudit['normalizationPreview']['componentRepairs'][number]['actions'] =
    [];
  if (component.componentKind === 'part') {
    if (!component.annotated) actions.push('annotate-reference');
    if (!component.footprint) actions.push('assign-footprint');
    if (!component.value) actions.push('assign-value');
    if (unresolvedExpression(component.value)) actions.push('resolve-value-expression');
    if (unresolvedExpression(component.footprint)) actions.push('resolve-footprint-expression');
  }
  if (
    ['unknown', 'helper'].includes(component.componentKind) &&
    (component.reference || component.value || component.footprint)
  ) {
    actions.push('review-bom-classification');
  }
  return actions;
}

function findingSort(a: ImportedAuditFinding, b: ImportedAuditFinding): number {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return (
    rank[a.severity] - rank[b.severity] ||
    a.code.localeCompare(b.code) ||
    (a.componentRef ?? '').localeCompare(b.componentRef ?? '') ||
    (a.netName ?? '').localeCompare(b.netName ?? '')
  );
}

function isAmbiguousBomPrimitive(component: CanonicalComponent): boolean {
  return (
    ['unknown', 'helper'].includes(component.componentKind) &&
    Boolean(component.reference || component.value || component.footprint)
  );
}

function componentFindings(component: CanonicalComponent): ImportedAuditFinding[] {
  const findings: ImportedAuditFinding[] = [];
  const isPart = component.componentKind === 'part';

  if (isPart && !component.annotated) {
    findings.push({
      code: 'COMPONENT_UNANNOTATED',
      severity: 'warning',
      message: 'A real component does not have a stable reference designator.',
      componentId: component.canonicalComponentId,
      componentRef: component.reference,
      evidence: { rawReference: component.rawReference },
      suggestedAction: 'Assign a unique reference designator before automated reconciliation.',
      confidence: 'high',
    });
  }
  if (isPart && !component.footprint) {
    findings.push({
      code: 'COMPONENT_MISSING_FOOTPRINT',
      severity: 'warning',
      message: 'A BOM-eligible component has no resolved footprint.',
      componentId: component.canonicalComponentId,
      componentRef: component.reference,
      suggestedAction: 'Assign or map the intended EasyEDA footprint.',
      confidence: 'high',
    });
  }
  if (isPart && !component.value) {
    findings.push({
      code: 'COMPONENT_MISSING_VALUE',
      severity: 'warning',
      message: 'A BOM-eligible component has no resolved value or device name.',
      componentId: component.canonicalComponentId,
      componentRef: component.reference,
      suggestedAction: 'Set a value or map the imported value attribute.',
      confidence: 'medium',
    });
  }
  if (isPart && unresolvedExpression(component.value)) {
    findings.push({
      code: 'COMPONENT_VALUE_EXPRESSION_UNRESOLVED',
      severity: 'warning',
      message: 'The component value is still an unresolved metadata expression.',
      componentId: component.canonicalComponentId,
      componentRef: component.reference,
      evidence: { rawValue: component.rawValue, resolvedValue: component.value },
      suggestedAction: 'Map the referenced imported attribute to a concrete value.',
      confidence: 'high',
    });
  }
  if (isPart && unresolvedExpression(component.footprint)) {
    findings.push({
      code: 'COMPONENT_FOOTPRINT_EXPRESSION_UNRESOLVED',
      severity: 'warning',
      message: 'The component footprint is still an unresolved metadata expression.',
      componentId: component.canonicalComponentId,
      componentRef: component.reference,
      evidence: { rawFootprint: component.rawFootprint, resolvedFootprint: component.footprint },
      suggestedAction: 'Map the referenced imported attribute to a concrete footprint.',
      confidence: 'high',
    });
  }
  if (isAmbiguousBomPrimitive(component)) {
    findings.push({
      code: 'BOM_CLASSIFICATION_AMBIGUOUS',
      severity: 'warning',
      message: 'This imported primitive has part-like metadata but an ambiguous component type.',
      componentId: component.canonicalComponentId,
      componentRef: component.reference,
      evidence: {
        componentKind: component.componentKind,
        value: component.value,
        footprint: component.footprint,
      },
      suggestedAction: 'Review whether this primitive should be included in the BOM.',
      confidence: 'medium',
    });
  }
  return findings;
}

function duplicateReferenceFindings(components: CanonicalComponent[]): ImportedAuditFinding[] {
  const groups = new Map<string, CanonicalComponent[]>();
  for (const component of components) {
    if (component.componentKind !== 'part' || !component.annotated) continue;
    const key = component.reference.toUpperCase();
    const group = groups.get(key) ?? [];
    group.push(component);
    groups.set(key, group);
  }

  const findings: ImportedAuditFinding[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const reference = group[0]?.reference ?? '';
    findings.push({
      code: 'DUPLICATE_COMPONENT_REFERENCE',
      severity: 'error',
      message: `Reference ${reference} is assigned to multiple BOM components.`,
      componentRef: reference,
      evidence: { componentIds: group.map((component) => component.canonicalComponentId) },
      suggestedAction: 'Re-annotate the duplicate components with unique references.',
      confidence: 'high',
    });
  }
  return findings;
}

function netFindings(
  net: SchematicModel['nets'][number],
  includeInfo: boolean,
): ImportedAuditFinding[] {
  const findings: ImportedAuditFinding[] = [];
  if (net.kind === 'unnamed') {
    findings.push({
      code: 'NET_NAME_EMPTY',
      severity: 'warning',
      message: 'A net has no stable name after normalization.',
      netName: net.canonicalNetName,
      rawNetNames: net.rawNetNames,
      suggestedAction: 'Assign an explicit net name or verify that the unnamed net is intentional.',
      confidence: 'high',
    });
  }
  if (includeInfo && net.imported) {
    findings.push({
      code: 'IMPORTED_NET_ALIAS',
      severity: 'info',
      message: `Imported net alias resolves to ${net.canonicalNetName}.`,
      netName: net.canonicalNetName,
      rawNetNames: net.rawNetNames,
      evidence: { normalizationRules: net.normalizationRules, kind: net.kind },
      suggestedAction: 'Review the preview before applying any display-name normalization.',
      confidence: 'high',
    });
  }
  if (includeInfo && net.rawNetNames.length > 1) {
    findings.push({
      code: 'NET_ALIASES_MERGED',
      severity: 'info',
      message: `Multiple raw names resolve to canonical net ${net.canonicalNetName}.`,
      netName: net.canonicalNetName,
      rawNetNames: net.rawNetNames,
      suggestedAction: 'Confirm that the aliases represent one intended electrical net.',
      confidence: 'medium',
    });
  }
  if (includeInfo && net.kind === 'power-flag') {
    findings.push({
      code: 'POWER_FLAG_NET_DETECTED',
      severity: 'info',
      message: 'An imported power-flag helper net was detected and excluded from signal semantics.',
      netName: net.canonicalNetName,
      rawNetNames: net.rawNetNames,
      suggestedAction: 'Keep it as a power assertion helper, not a user signal net.',
      confidence: 'high',
    });
  }
  return findings;
}

function sourceTruncatedFinding(): ImportedAuditFinding {
  return {
    code: 'SOURCE_COMPONENTS_TRUNCATED',
    severity: 'warning',
    message: 'The live component inventory was truncated, so this audit is incomplete.',
    suggestedAction: 'Repeat the audit with a complete component inventory before normalization.',
    confidence: 'high',
  };
}

function auditStatus(errorCount: number, warningCount: number): ImportedDesignAudit['status'] {
  if (errorCount > 0) return 'blocked';
  if (warningCount > 0) return 'review';
  return 'clean';
}

function countFindingCodes(findings: ImportedAuditFinding[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.code, (counts.get(finding.code) ?? 0) + 1);
  return counts;
}

export function auditImportedDesign(
  model: SchematicModel,
  options: AuditImportedDesignOptions = {},
): ImportedDesignAudit {
  const includeInfo = options.includeInfo ?? true;
  const sourceTruncated = options.sourceTruncated ?? false;
  const findings = [
    ...model.components.flatMap(componentFindings),
    ...duplicateReferenceFindings(model.components),
    ...model.nets.flatMap((net) => netFindings(net, includeInfo)),
    ...(sourceTruncated ? [sourceTruncatedFinding()] : []),
  ];
  findings.sort(findingSort);

  const errorCount = findings.filter((finding) => finding.severity === 'error').length;
  const warningCount = findings.filter((finding) => finding.severity === 'warning').length;
  const infoCount = findings.filter((finding) => finding.severity === 'info').length;
  const codeCounts = countFindingCodes(findings);
  const componentRepairs = model.components
    .map((component) => ({
      componentId: component.canonicalComponentId,
      reference: component.reference,
      actions: componentRepairActions(component),
    }))
    .filter((repair) => repair.actions.length > 0);
  const unresolvedExpressionCount =
    (codeCounts.get('COMPONENT_VALUE_EXPRESSION_UNRESOLVED') ?? 0) +
    (codeCounts.get('COMPONENT_FOOTPRINT_EXPRESSION_UNRESOLVED') ?? 0);

  return ImportedDesignAuditSchema.parse({
    schemaVersion: 'imported-design-audit/v1',
    status: auditStatus(errorCount, warningCount),
    readOnly: true,
    safeToNormalize: errorCount === 0 && !sourceTruncated,
    modelSummary: model.summary,
    summary: {
      findingCount: findings.length,
      errorCount,
      warningCount,
      infoCount,
      importedNetCount: model.nets.filter((net) => net.imported).length,
      aliasedNetCount: model.nets.filter((net) => net.rawNetNames.length > 1).length,
      unannotatedComponentCount: codeCounts.get('COMPONENT_UNANNOTATED') ?? 0,
      missingFootprintCount: codeCounts.get('COMPONENT_MISSING_FOOTPRINT') ?? 0,
      missingValueCount: codeCounts.get('COMPONENT_MISSING_VALUE') ?? 0,
      duplicateReferenceCount: codeCounts.get('DUPLICATE_COMPONENT_REFERENCE') ?? 0,
      ambiguousBomCount: codeCounts.get('BOM_CLASSIFICATION_AMBIGUOUS') ?? 0,
      unresolvedExpressionCount,
    },
    findings,
    normalizationPreview: {
      netAliases: model.nets
        .filter((net) => net.imported || net.rawNetNames.length > 1)
        .map((net) => ({
          canonicalNetName: net.canonicalNetName,
          rawNetNames: net.rawNetNames,
          kind: net.kind,
          rules: net.normalizationRules,
        })),
      componentRepairs,
    },
  });
}
