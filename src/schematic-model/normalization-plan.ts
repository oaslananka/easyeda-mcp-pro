import { createHash } from 'node:crypto';
import { z } from 'zod';
import { auditImportedDesign } from './audit.js';
import { type CanonicalComponent, type SchematicModel } from './model.js';

export const NormalizationOperationKindSchema = z.enum([
  'normalize-net-name',
  'annotate-reference',
  'set-component-value',
  'set-component-footprint',
  'classify-bom',
]);
export type NormalizationOperationKind = z.infer<typeof NormalizationOperationKindSchema>;

export const NormalizationComponentOverrideSchema = z
  .object({
    componentId: z.string().min(1),
    reference: z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z0-9]*\d+$/, 'Reference must end in a numeric designator')
      .optional(),
    value: z.string().trim().min(1).optional(),
    footprint: z.string().trim().min(1).optional(),
    bomEligible: z.boolean().optional(),
  })
  .strict();
export type NormalizationComponentOverride = z.infer<typeof NormalizationComponentOverrideSchema>;

export const NormalizationPlanOptionsSchema = z
  .object({
    normalizeNetNames: z.boolean().default(true),
    annotateReferences: z.boolean().default(true),
    resolveMetadataExpressions: z.boolean().default(true),
    sourceTruncated: z.boolean().default(false),
    componentOverrides: z.array(NormalizationComponentOverrideSchema).max(500).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.componentOverrides.forEach((override, index) => {
      if (seen.has(override.componentId)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate component override for ${override.componentId}`,
          path: ['componentOverrides', index, 'componentId'],
        });
      }
      seen.add(override.componentId);
    });
  });
export type NormalizationPlanOptions = z.input<typeof NormalizationPlanOptionsSchema>;
export type ParsedNormalizationPlanOptions = z.output<typeof NormalizationPlanOptionsSchema>;

const NormalizationOperationSchema = z.object({
  operationId: z.string().min(1),
  kind: NormalizationOperationKindSchema,
  targetType: z.enum(['net', 'component']),
  targetId: z.string().min(1),
  selector: z.record(z.string(), z.string()),
  before: z.record(z.string(), z.unknown()),
  after: z.record(z.string(), z.unknown()),
  automatic: z.boolean(),
  requiresConfirmation: z.boolean(),
  confidence: z.enum(['high', 'medium', 'low']),
  risk: z.enum(['low', 'medium', 'high']),
  reason: z.string().min(1),
  validationGates: z.array(z.string().min(1)).min(1),
});
export type NormalizationOperation = z.infer<typeof NormalizationOperationSchema>;

const NormalizationPlanDiagnosticSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(['warning', 'error']),
  message: z.string().min(1),
  componentId: z.string().optional(),
  componentRef: z.string().optional(),
  netName: z.string().optional(),
  suggestedAction: z.string().min(1),
  confidence: z.enum(['high', 'medium', 'low']),
});
export type NormalizationPlanDiagnostic = z.infer<typeof NormalizationPlanDiagnosticSchema>;

export const ImportedNormalizationPlanSchema = z.object({
  schemaVersion: z.literal('imported-normalization-plan/v1'),
  planId: z.string().regex(/^norm_[a-f0-9]{16}$/),
  modelHash: z.string().regex(/^[a-f0-9]{64}$/),
  readOnly: z.literal(true),
  status: z.enum(['noop', 'ready', 'review', 'blocked']),
  applicationReady: z.boolean(),
  safeToAutoApply: z.boolean(),
  requiresConfirmation: z.boolean(),
  options: NormalizationPlanOptionsSchema,
  summary: z.object({
    operationCount: z.number().int().nonnegative(),
    automaticOperationCount: z.number().int().nonnegative(),
    confirmationOperationCount: z.number().int().nonnegative(),
    netRenameCount: z.number().int().nonnegative(),
    referenceAnnotationCount: z.number().int().nonnegative(),
    valueUpdateCount: z.number().int().nonnegative(),
    footprintUpdateCount: z.number().int().nonnegative(),
    bomClassificationCount: z.number().int().nonnegative(),
    blockerCount: z.number().int().nonnegative(),
    warningCount: z.number().int().nonnegative(),
  }),
  operations: z.array(NormalizationOperationSchema),
  blockers: z.array(NormalizationPlanDiagnosticSchema),
  warnings: z.array(NormalizationPlanDiagnosticSchema),
  expectedPostconditions: z.array(z.string().min(1)),
});
export type ImportedNormalizationPlan = z.infer<typeof ImportedNormalizationPlanSchema>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function unresolvedExpression(value: string): boolean {
  return /^=\{[^{}]+\}$/.test(value.trim());
}

function operationId(operation: Omit<NormalizationOperation, 'operationId'>): string {
  return `nrmop_${sha256(operation).slice(0, 16)}`;
}

function createOperation(
  operation: Omit<NormalizationOperation, 'operationId'>,
): NormalizationOperation {
  return NormalizationOperationSchema.parse({
    operationId: operationId(operation),
    ...operation,
  });
}

function inferReferencePrefix(component: CanonicalComponent): string | undefined {
  const explicit = /^([A-Za-z][A-Za-z0-9]*)\?$/.exec(component.rawReference.trim());
  if (explicit?.[1]) return explicit[1].toUpperCase();

  const text = [component.deviceName, component.symbolName, component.value]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toUpperCase();
  const rules: Array<[RegExp, string]> = [
    [/\b(?:LED|WS2812|SK6812)\b/, 'LED'],
    [/\b(?:RESISTOR|RES\b|\d+(?:\.\d+)?\s*[KMR]?Ω?)\b/, 'R'],
    [/\b(?:CAPACITOR|CAP\b|\d+(?:\.\d+)?\s*(?:PF|NF|UF|ΜF))\b/, 'C'],
    [/\b(?:INDUCTOR|CHOKE)\b/, 'L'],
    [/\b(?:DIODE|TVS|ZENER)\b/, 'D'],
    [/\b(?:TRANSISTOR|MOSFET|BJT)\b/, 'Q'],
    [/\b(?:CONNECTOR|HEADER|SOCKET|USB-C|USB_C)\b/, 'J'],
    [/\b(?:SWITCH|BUTTON)\b/, 'SW'],
    [/\b(?:FUSE|POLYFUSE)\b/, 'F'],
    [/\b(?:CRYSTAL|OSCILLATOR|XTAL)\b/, 'Y'],
    [/\b(?:TESTPOINT|TEST POINT)\b/, 'TP'],
    [/\b(?:IC|MCU|CPU|RP2040|STM32|ESP32|REGULATOR|DRIVER|OPAMP|FLASH)\b/, 'U'],
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1];
}

function referenceState(components: CanonicalComponent[]) {
  const used = new Set<string>();
  const nextByPrefix = new Map<string, number>();
  for (const component of components) {
    if (!component.annotated || component.componentKind !== 'part') continue;
    const reference = component.reference.toUpperCase();
    used.add(reference);
    const match = /^([A-Z][A-Z0-9]*?)(\d+)$/.exec(reference);
    if (!match?.[1] || !match[2]) continue;
    const number = Number(match[2]);
    nextByPrefix.set(match[1], Math.max(nextByPrefix.get(match[1]) ?? 1, number + 1));
  }
  return { used, nextByPrefix };
}

function allocateReference(prefix: string, state: ReturnType<typeof referenceState>): string {
  let number = state.nextByPrefix.get(prefix) ?? 1;
  let candidate = `${prefix}${number}`;
  while (state.used.has(candidate)) {
    number += 1;
    candidate = `${prefix}${number}`;
  }
  state.used.add(candidate);
  state.nextByPrefix.set(prefix, number + 1);
  return candidate;
}

function diagnosticSort(a: NormalizationPlanDiagnostic, b: NormalizationPlanDiagnostic): number {
  return (
    a.code.localeCompare(b.code) ||
    (a.componentRef ?? '').localeCompare(b.componentRef ?? '') ||
    (a.netName ?? '').localeCompare(b.netName ?? '') ||
    (a.componentId ?? '').localeCompare(b.componentId ?? '')
  );
}

function operationSort(a: NormalizationOperation, b: NormalizationOperation): number {
  return (
    a.kind.localeCompare(b.kind) ||
    a.targetId.localeCompare(b.targetId) ||
    stableJson(a.before).localeCompare(stableJson(b.before)) ||
    a.operationId.localeCompare(b.operationId)
  );
}

export function previewImportedNormalization(
  model: SchematicModel,
  inputOptions: NormalizationPlanOptions = {},
): ImportedNormalizationPlan {
  const parsedOptions = NormalizationPlanOptionsSchema.parse(inputOptions);
  const options: ParsedNormalizationPlanOptions = {
    ...parsedOptions,
    componentOverrides: [...parsedOptions.componentOverrides].sort((a, b) =>
      a.componentId.localeCompare(b.componentId),
    ),
  };
  const audit = auditImportedDesign(model, {
    includeInfo: true,
    sourceTruncated: options.sourceTruncated,
  });
  const operations: NormalizationOperation[] = [];
  const blockers: NormalizationPlanDiagnostic[] = [];
  const warnings: NormalizationPlanDiagnostic[] = [];
  const overrides = new Map(
    options.componentOverrides.map((override) => [override.componentId, override]),
  );
  const knownComponentIds = new Set(
    model.components.map((component) => component.canonicalComponentId),
  );

  if (options.sourceTruncated) {
    blockers.push({
      code: 'SOURCE_COMPONENTS_TRUNCATED',
      severity: 'error',
      message: 'A complete normalization plan cannot be produced from a truncated component list.',
      suggestedAction: 'Repeat the preview with a complete live component inventory.',
      confidence: 'high',
    });
  }

  for (const override of options.componentOverrides) {
    if (!knownComponentIds.has(override.componentId)) {
      blockers.push({
        code: 'OVERRIDE_COMPONENT_NOT_FOUND',
        severity: 'error',
        message: `Override target ${override.componentId} is not present in the canonical model.`,
        componentId: override.componentId,
        suggestedAction: 'Refresh the audit and use a current canonical component ID.',
        confidence: 'high',
      });
    }
  }

  if (audit.summary.duplicateReferenceCount > 0) {
    for (const finding of audit.findings.filter(
      (candidate) => candidate.code === 'DUPLICATE_COMPONENT_REFERENCE',
    )) {
      blockers.push({
        code: 'DUPLICATE_COMPONENT_REFERENCE',
        severity: 'error',
        message: finding.message,
        componentRef: finding.componentRef,
        suggestedAction: finding.suggestedAction,
        confidence: finding.confidence,
      });
    }
  }

  if (options.normalizeNetNames) {
    for (const net of model.nets) {
      if (!net.imported || net.kind === 'power-flag') continue;
      for (const rawNetName of net.rawNetNames) {
        if (rawNetName === net.canonicalNetName) continue;
        operations.push(
          createOperation({
            kind: 'normalize-net-name',
            targetType: 'net',
            targetId: `net:${rawNetName}`,
            selector: { rawNetName },
            before: { netName: rawNetName },
            after: { netName: net.canonicalNetName },
            automatic: true,
            requiresConfirmation: net.rawNetNames.length > 1,
            confidence: net.rawNetNames.length > 1 ? 'medium' : 'high',
            risk: net.rawNetNames.length > 1 ? 'medium' : 'low',
            reason:
              net.rawNetNames.length > 1
                ? 'This imported alias resolves to a canonical net that also has other raw names.'
                : 'This is a recognized imported power or ground alias.',
            validationGates: [
              'canonical-net-membership-unchanged',
              'connected-pin-set-unchanged',
              'native-erc-no-new-errors',
            ],
          }),
        );
      }
    }
  }

  const refState = referenceState(model.components);
  for (const component of [...model.components].sort((a, b) =>
    a.canonicalComponentId.localeCompare(b.canonicalComponentId),
  )) {
    const override = overrides.get(component.canonicalComponentId);
    if (component.componentKind === 'part' && !component.annotated && options.annotateReferences) {
      const proposedReference = override?.reference;
      const prefix = proposedReference ? undefined : inferReferencePrefix(component);
      const reference =
        proposedReference ?? (prefix ? allocateReference(prefix, refState) : undefined);
      if (!reference) {
        blockers.push({
          code: 'REFERENCE_PREFIX_UNRESOLVED',
          severity: 'error',
          message: 'A deterministic reference prefix could not be inferred for this component.',
          componentId: component.canonicalComponentId,
          componentRef: component.reference,
          suggestedAction: 'Provide a component override with an explicit unique reference.',
          confidence: 'high',
        });
      } else if (refState.used.has(reference.toUpperCase()) && proposedReference) {
        blockers.push({
          code: 'REFERENCE_OVERRIDE_CONFLICT',
          severity: 'error',
          message: `Reference override ${reference} conflicts with an existing or proposed reference.`,
          componentId: component.canonicalComponentId,
          componentRef: component.reference,
          suggestedAction: 'Choose a unique reference designator.',
          confidence: 'high',
        });
      } else {
        if (proposedReference) refState.used.add(proposedReference.toUpperCase());
        operations.push(
          createOperation({
            kind: 'annotate-reference',
            targetType: 'component',
            targetId: component.canonicalComponentId,
            selector: {
              componentId: component.canonicalComponentId,
              ...(component.runtimePrimitiveId
                ? { runtimePrimitiveId: component.runtimePrimitiveId }
                : {}),
            },
            before: { reference: component.rawReference },
            after: { reference },
            automatic: !proposedReference,
            requiresConfirmation: Boolean(proposedReference),
            confidence: proposedReference ? 'high' : 'medium',
            risk: 'medium',
            reason: proposedReference
              ? 'The user supplied an explicit reference override.'
              : `The ${prefix} prefix was inferred and the next unused reference was allocated.`,
            validationGates: [
              'component-reference-unique',
              'component-connectivity-unchanged',
              'native-erc-no-new-errors',
            ],
          }),
        );
      }
    }

    if (component.componentKind === 'part') {
      const valueOverride = override?.value;
      const resolvedValueAvailable =
        options.resolveMetadataExpressions &&
        unresolvedExpression(component.rawValue) &&
        !unresolvedExpression(component.value) &&
        component.value.length > 0;
      const valueOverrideChangesState =
        valueOverride !== undefined && valueOverride !== component.rawValue;
      if (valueOverrideChangesState || resolvedValueAvailable) {
        const value = valueOverride ?? component.value;
        operations.push(
          createOperation({
            kind: 'set-component-value',
            targetType: 'component',
            targetId: component.canonicalComponentId,
            selector: { componentId: component.canonicalComponentId },
            before: { value: component.rawValue },
            after: { value },
            automatic: !valueOverride,
            requiresConfirmation: Boolean(valueOverride),
            confidence: 'high',
            risk: 'low',
            reason: valueOverride
              ? 'The user supplied an explicit value override.'
              : 'The imported value expression resolves to concrete metadata.',
            validationGates: ['component-identity-unchanged', 'bom-value-resolved'],
          }),
        );
      } else if (!component.value || unresolvedExpression(component.value)) {
        blockers.push({
          code: 'COMPONENT_VALUE_REQUIRES_INPUT',
          severity: 'error',
          message: 'The component value cannot be normalized without explicit metadata.',
          componentId: component.canonicalComponentId,
          componentRef: component.reference,
          suggestedAction: 'Provide a component override with the intended value.',
          confidence: 'high',
        });
      }

      const footprintOverride = override?.footprint;
      const resolvedFootprintAvailable =
        options.resolveMetadataExpressions &&
        unresolvedExpression(component.rawFootprint) &&
        !unresolvedExpression(component.footprint) &&
        component.footprint.length > 0;
      const footprintOverrideChangesState =
        footprintOverride !== undefined && footprintOverride !== component.rawFootprint;
      if (footprintOverrideChangesState || resolvedFootprintAvailable) {
        const footprint = footprintOverride ?? component.footprint;
        operations.push(
          createOperation({
            kind: 'set-component-footprint',
            targetType: 'component',
            targetId: component.canonicalComponentId,
            selector: { componentId: component.canonicalComponentId },
            before: { footprint: component.rawFootprint },
            after: { footprint },
            automatic: !footprintOverride,
            requiresConfirmation: Boolean(footprintOverride),
            confidence: 'high',
            risk: 'medium',
            reason: footprintOverride
              ? 'The user supplied an explicit footprint override.'
              : 'The imported footprint expression resolves to concrete metadata.',
            validationGates: [
              'component-identity-unchanged',
              'footprint-resolved',
              'pcb-linkage-reviewed',
            ],
          }),
        );
      } else if (!component.footprint || unresolvedExpression(component.footprint)) {
        blockers.push({
          code: 'COMPONENT_FOOTPRINT_REQUIRES_INPUT',
          severity: 'error',
          message: 'The component footprint cannot be normalized without explicit metadata.',
          componentId: component.canonicalComponentId,
          componentRef: component.reference,
          suggestedAction: 'Provide a component override with the intended EasyEDA footprint.',
          confidence: 'high',
        });
      }
    }

    if (['unknown', 'helper'].includes(component.componentKind)) {
      if (override?.bomEligible !== undefined) {
        operations.push(
          createOperation({
            kind: 'classify-bom',
            targetType: 'component',
            targetId: component.canonicalComponentId,
            selector: { componentId: component.canonicalComponentId },
            before: { bomEligible: component.bomEligible, componentKind: component.componentKind },
            after: { bomEligible: override.bomEligible },
            automatic: false,
            requiresConfirmation: true,
            confidence: 'high',
            risk: 'medium',
            reason: 'The user supplied an explicit BOM-classification override.',
            validationGates: ['bom-count-reviewed', 'component-connectivity-unchanged'],
          }),
        );
      } else if (component.reference || component.value || component.footprint) {
        blockers.push({
          code: 'BOM_CLASSIFICATION_REQUIRES_REVIEW',
          severity: 'error',
          message: 'A part-like helper primitive requires an explicit BOM classification.',
          componentId: component.canonicalComponentId,
          componentRef: component.reference,
          suggestedAction: 'Provide a component override with bomEligible true or false.',
          confidence: 'medium',
        });
      }
    }
  }

  for (const net of model.nets.filter((candidate) => candidate.kind === 'power-flag')) {
    warnings.push({
      code: 'POWER_FLAG_PRESERVED',
      severity: 'warning',
      message: 'Power-flag helper names are intentionally excluded from automatic net renaming.',
      netName: net.canonicalNetName,
      suggestedAction: 'Preserve the helper unless a later runtime-specific operation proves safe.',
      confidence: 'high',
    });
  }

  operations.sort(operationSort);
  blockers.sort(diagnosticSort);
  warnings.sort(diagnosticSort);

  const confirmationOperationCount = operations.filter(
    (operation) => operation.requiresConfirmation,
  ).length;
  const applicationReady = blockers.length === 0;
  const requiresConfirmation = confirmationOperationCount > 0 || warnings.length > 0;
  const status: ImportedNormalizationPlan['status'] =
    blockers.length > 0
      ? 'blocked'
      : requiresConfirmation
        ? 'review'
        : operations.length === 0
          ? 'noop'
          : 'ready';
  const modelHash = sha256({
    ...model,
    components: [...model.components].sort((a, b) =>
      a.canonicalComponentId.localeCompare(b.canonicalComponentId),
    ),
    nets: [...model.nets].sort((a, b) => a.canonicalNetName.localeCompare(b.canonicalNetName)),
    diagnostics: [...model.diagnostics].sort((a, b) => stableJson(a).localeCompare(stableJson(b))),
  });
  const planPayload = {
    schemaVersion: 'imported-normalization-plan/v1',
    modelHash,
    options,
    operations,
    blockers,
    warnings,
  };

  return ImportedNormalizationPlanSchema.parse({
    ...planPayload,
    planId: `norm_${sha256(planPayload).slice(0, 16)}`,
    readOnly: true,
    status,
    applicationReady,
    safeToAutoApply: applicationReady && !requiresConfirmation,
    requiresConfirmation,
    summary: {
      operationCount: operations.length,
      automaticOperationCount: operations.filter((operation) => operation.automatic).length,
      confirmationOperationCount,
      netRenameCount: operations.filter((operation) => operation.kind === 'normalize-net-name')
        .length,
      referenceAnnotationCount: operations.filter(
        (operation) => operation.kind === 'annotate-reference',
      ).length,
      valueUpdateCount: operations.filter((operation) => operation.kind === 'set-component-value')
        .length,
      footprintUpdateCount: operations.filter(
        (operation) => operation.kind === 'set-component-footprint',
      ).length,
      bomClassificationCount: operations.filter((operation) => operation.kind === 'classify-bom')
        .length,
      blockerCount: blockers.length,
      warningCount: warnings.length,
    },
    expectedPostconditions: [
      'Canonical net membership is unchanged.',
      'Connected component-pin sets are unchanged.',
      'Component references are unique after annotation.',
      'No new native ERC errors are introduced.',
      'A post-apply canonical model hash is captured for comparison.',
    ],
  });
}
