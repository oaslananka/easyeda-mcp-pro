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

function isAsciiLetter(char: string): boolean {
  return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z');
}

function isAsciiDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isAsciiAlphaNumeric(char: string): boolean {
  return isAsciiLetter(char) || isAsciiDigit(char);
}

function trailingDigitStart(value: string): number {
  let index = value.length;
  while (index > 0 && isAsciiDigit(value.charAt(index - 1))) index -= 1;
  return index;
}

function isValidReference(value: string): boolean {
  const digitStart = trailingDigitStart(value);
  if (digitStart === value.length || digitStart === 0 || !isAsciiLetter(value.charAt(0)))
    return false;
  for (let index = 1; index < digitStart; index += 1) {
    if (!isAsciiAlphaNumeric(value.charAt(index))) return false;
  }
  return true;
}

function splitReference(value: string): { prefix: string; number: number } | undefined {
  const digitStart = trailingDigitStart(value);
  if (digitStart === value.length) return undefined;
  const prefix = value.slice(0, digitStart);
  if (!isValidReference(value)) return undefined;
  return { prefix, number: Number(value.slice(digitStart)) };
}

export const NormalizationComponentOverrideSchema = z
  .object({
    componentId: z.string().min(1),
    reference: z
      .string()
      .trim()
      .refine(isValidReference, { message: 'Reference must end in a numeric designator' })
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

function placeholderReferencePrefix(rawReference: string): string | undefined {
  const value = rawReference.trim();
  if (!value.endsWith('?')) return undefined;
  const prefix = value.slice(0, -1);
  if (!prefix || !isAsciiLetter(prefix.charAt(0))) return undefined;
  for (let index = 1; index < prefix.length; index += 1) {
    if (!isAsciiAlphaNumeric(prefix.charAt(index))) return undefined;
  }
  return prefix.toUpperCase();
}

function isReferenceTokenCharacter(char: string): boolean {
  return (
    isAsciiAlphaNumeric(char) ||
    char === '.' ||
    char === '_' ||
    char === '+' ||
    char === '-' ||
    char === 'Μ' ||
    char === 'Ω'
  );
}

function referenceTokens(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  for (const char of text) {
    if (isReferenceTokenCharacter(char)) {
      current += char;
      continue;
    }
    if (current) tokens.push(current);
    current = '';
  }
  if (current) tokens.push(current);
  return tokens;
}

function containsAnyToken(tokens: ReadonlySet<string>, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => tokens.has(candidate));
}

function numericSuffix(token: string): string | undefined {
  const normalized = token.replaceAll('Ω', '');
  let index = normalized.startsWith('+') || normalized.startsWith('-') ? 1 : 0;
  const numberStart = index;
  while (isAsciiDigit(normalized.charAt(index))) index += 1;
  if (normalized.charAt(index) === '.') {
    index += 1;
    while (isAsciiDigit(normalized.charAt(index))) index += 1;
  }
  if (index === numberStart) return undefined;
  return normalized.slice(index);
}

function passiveValuePrefix(tokens: string[]): string | undefined {
  for (const token of tokens) {
    const suffix = numericSuffix(token);
    if (suffix === undefined) continue;
    if (['PF', 'NF', 'UF', 'ΜF'].includes(suffix)) return 'C';
    if (['', 'K', 'M', 'R'].includes(suffix)) return 'R';
  }
  return undefined;
}

function inferReferencePrefix(component: CanonicalComponent): string | undefined {
  const explicit = placeholderReferencePrefix(component.rawReference);
  if (explicit) return explicit;

  const text = [component.deviceName, component.symbolName, component.value]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toUpperCase();
  const tokens = referenceTokens(text);
  const tokenSet = new Set(tokens);
  const rules: Array<[readonly string[], string]> = [
    [['LED', 'WS2812', 'SK6812'], 'LED'],
    [['RESISTOR', 'RES'], 'R'],
    [['CAPACITOR', 'CAP'], 'C'],
    [['INDUCTOR', 'CHOKE'], 'L'],
    [['DIODE', 'TVS', 'ZENER'], 'D'],
    [['TRANSISTOR', 'MOSFET', 'BJT'], 'Q'],
    [['CONNECTOR', 'HEADER', 'SOCKET', 'USB-C', 'USB_C'], 'J'],
    [['SWITCH', 'BUTTON'], 'SW'],
    [['FUSE', 'POLYFUSE'], 'F'],
    [['CRYSTAL', 'OSCILLATOR', 'XTAL'], 'Y'],
    [['TESTPOINT'], 'TP'],
    [
      ['IC', 'MCU', 'CPU', 'RP2040', 'STM32', 'ESP32', 'REGULATOR', 'DRIVER', 'OPAMP', 'FLASH'],
      'U',
    ],
  ];
  for (const [keywords, prefix] of rules) {
    if (containsAnyToken(tokenSet, keywords)) return prefix;
  }
  if (text.includes('TEST POINT')) return 'TP';
  return passiveValuePrefix(tokens);
}

function referenceState(components: CanonicalComponent[]) {
  const used = new Set<string>();
  const nextByPrefix = new Map<string, number>();
  for (const component of components) {
    if (!component.annotated || component.componentKind !== 'part') continue;
    const reference = component.reference.toUpperCase();
    used.add(reference);
    const parsed = splitReference(reference);
    if (!parsed) continue;
    nextByPrefix.set(
      parsed.prefix,
      Math.max(nextByPrefix.get(parsed.prefix) ?? 1, parsed.number + 1),
    );
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

type ComponentOverride = ParsedNormalizationPlanOptions['componentOverrides'][number];

interface PlanCollections {
  operations: NormalizationOperation[];
  blockers: NormalizationPlanDiagnostic[];
  warnings: NormalizationPlanDiagnostic[];
}

function parsePlanOptions(inputOptions: NormalizationPlanOptions): ParsedNormalizationPlanOptions {
  const parsed = NormalizationPlanOptionsSchema.parse(inputOptions);
  return {
    ...parsed,
    componentOverrides: [...parsed.componentOverrides].sort((a, b) =>
      a.componentId.localeCompare(b.componentId),
    ),
  };
}

function addSourceTruncationBlocker(
  options: ParsedNormalizationPlanOptions,
  blockers: NormalizationPlanDiagnostic[],
): void {
  if (!options.sourceTruncated) return;
  blockers.push({
    code: 'SOURCE_COMPONENTS_TRUNCATED',
    severity: 'error',
    message: 'A complete normalization plan cannot be produced from a truncated component list.',
    suggestedAction: 'Repeat the preview with a complete live component inventory.',
    confidence: 'high',
  });
}

function addOverrideTargetBlockers(
  model: SchematicModel,
  options: ParsedNormalizationPlanOptions,
  blockers: NormalizationPlanDiagnostic[],
): void {
  const knownComponentIds = new Set(
    model.components.map((component) => component.canonicalComponentId),
  );
  for (const override of options.componentOverrides) {
    if (knownComponentIds.has(override.componentId)) continue;
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

function addDuplicateReferenceBlockers(
  model: SchematicModel,
  options: ParsedNormalizationPlanOptions,
  blockers: NormalizationPlanDiagnostic[],
): void {
  const audit = auditImportedDesign(model, {
    includeInfo: true,
    sourceTruncated: options.sourceTruncated,
  });
  for (const finding of audit.findings) {
    if (finding.code !== 'DUPLICATE_COMPONENT_REFERENCE') continue;
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

function addNetRenameOperations(
  model: SchematicModel,
  options: ParsedNormalizationPlanOptions,
  operations: NormalizationOperation[],
): void {
  if (!options.normalizeNetNames) return;
  for (const net of model.nets) {
    if (!net.imported || net.kind === 'power-flag') continue;
    const aliasesMerged = net.rawNetNames.length > 1;
    const reason = aliasesMerged
      ? 'This imported alias resolves to a canonical net that also has other raw names.'
      : 'This is a recognized imported power or ground alias.';
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
          requiresConfirmation: aliasesMerged,
          confidence: aliasesMerged ? 'medium' : 'high',
          risk: aliasesMerged ? 'medium' : 'low',
          reason,
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

function componentSelector(component: CanonicalComponent): Record<string, string> {
  const selector: Record<string, string> = { componentId: component.canonicalComponentId };
  if (component.runtimePrimitiveId) selector.runtimePrimitiveId = component.runtimePrimitiveId;
  return selector;
}

function addReferencePlan(
  component: CanonicalComponent,
  override: ComponentOverride | undefined,
  options: ParsedNormalizationPlanOptions,
  state: ReturnType<typeof referenceState>,
  collections: PlanCollections,
): void {
  if (component.componentKind !== 'part' || component.annotated || !options.annotateReferences) {
    return;
  }

  const proposedReference = override?.reference;
  const prefix = proposedReference ? undefined : inferReferencePrefix(component);
  let reference = proposedReference;
  if (!reference && prefix) reference = allocateReference(prefix, state);

  if (!reference) {
    collections.blockers.push({
      code: 'REFERENCE_PREFIX_UNRESOLVED',
      severity: 'error',
      message: 'A deterministic reference prefix could not be inferred for this component.',
      componentId: component.canonicalComponentId,
      componentRef: component.reference,
      suggestedAction: 'Provide a component override with an explicit unique reference.',
      confidence: 'high',
    });
    return;
  }
  if (proposedReference && state.used.has(reference.toUpperCase())) {
    collections.blockers.push({
      code: 'REFERENCE_OVERRIDE_CONFLICT',
      severity: 'error',
      message: `Reference override ${reference} conflicts with an existing or proposed reference.`,
      componentId: component.canonicalComponentId,
      componentRef: component.reference,
      suggestedAction: 'Choose a unique reference designator.',
      confidence: 'high',
    });
    return;
  }

  if (proposedReference) state.used.add(proposedReference.toUpperCase());
  const reason = proposedReference
    ? 'The user supplied an explicit reference override.'
    : `The ${prefix} prefix was inferred and the next unused reference was allocated.`;
  collections.operations.push(
    createOperation({
      kind: 'annotate-reference',
      targetType: 'component',
      targetId: component.canonicalComponentId,
      selector: componentSelector(component),
      before: { reference: component.rawReference },
      after: { reference },
      automatic: !proposedReference,
      requiresConfirmation: Boolean(proposedReference),
      confidence: proposedReference ? 'high' : 'medium',
      risk: 'medium',
      reason,
      validationGates: [
        'component-reference-unique',
        'component-connectivity-unchanged',
        'native-erc-no-new-errors',
      ],
    }),
  );
}

function resolvedMetadataAvailable(
  rawValue: string,
  resolvedValue: string,
  options: ParsedNormalizationPlanOptions,
): boolean {
  return (
    options.resolveMetadataExpressions &&
    unresolvedExpression(rawValue) &&
    !unresolvedExpression(resolvedValue) &&
    resolvedValue.length > 0
  );
}

function addValuePlan(
  component: CanonicalComponent,
  override: ComponentOverride | undefined,
  options: ParsedNormalizationPlanOptions,
  collections: PlanCollections,
): void {
  if (component.componentKind !== 'part') return;
  const valueOverride = override?.value;
  const overrideChangesState = valueOverride !== undefined && valueOverride !== component.rawValue;
  const resolvedAvailable = resolvedMetadataAvailable(component.rawValue, component.value, options);

  if (overrideChangesState || resolvedAvailable) {
    const value = valueOverride ?? component.value;
    collections.operations.push(
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
    return;
  }

  if (component.value && !unresolvedExpression(component.value)) return;
  collections.blockers.push({
    code: 'COMPONENT_VALUE_REQUIRES_INPUT',
    severity: 'error',
    message: 'The component value cannot be normalized without explicit metadata.',
    componentId: component.canonicalComponentId,
    componentRef: component.reference,
    suggestedAction: 'Provide a component override with the intended value.',
    confidence: 'high',
  });
}

function addFootprintPlan(
  component: CanonicalComponent,
  override: ComponentOverride | undefined,
  options: ParsedNormalizationPlanOptions,
  collections: PlanCollections,
): void {
  if (component.componentKind !== 'part') return;
  const footprintOverride = override?.footprint;
  const overrideChangesState =
    footprintOverride !== undefined && footprintOverride !== component.rawFootprint;
  const resolvedAvailable = resolvedMetadataAvailable(
    component.rawFootprint,
    component.footprint,
    options,
  );

  if (overrideChangesState || resolvedAvailable) {
    const footprint = footprintOverride ?? component.footprint;
    collections.operations.push(
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
    return;
  }

  if (component.footprint && !unresolvedExpression(component.footprint)) return;
  collections.blockers.push({
    code: 'COMPONENT_FOOTPRINT_REQUIRES_INPUT',
    severity: 'error',
    message: 'The component footprint cannot be normalized without explicit metadata.',
    componentId: component.canonicalComponentId,
    componentRef: component.reference,
    suggestedAction: 'Provide a component override with the intended EasyEDA footprint.',
    confidence: 'high',
  });
}

function addBomClassificationPlan(
  component: CanonicalComponent,
  override: ComponentOverride | undefined,
  collections: PlanCollections,
): void {
  if (!['unknown', 'helper'].includes(component.componentKind)) return;
  if (override?.bomEligible !== undefined) {
    collections.operations.push(
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
    return;
  }
  if (!component.reference && !component.value && !component.footprint) return;
  collections.blockers.push({
    code: 'BOM_CLASSIFICATION_REQUIRES_REVIEW',
    severity: 'error',
    message: 'A part-like helper primitive requires an explicit BOM classification.',
    componentId: component.canonicalComponentId,
    componentRef: component.reference,
    suggestedAction: 'Provide a component override with bomEligible true or false.',
    confidence: 'medium',
  });
}

function addComponentPlans(
  model: SchematicModel,
  options: ParsedNormalizationPlanOptions,
  collections: PlanCollections,
): void {
  const overrides = new Map(
    options.componentOverrides.map((override) => [override.componentId, override]),
  );
  const state = referenceState(model.components);
  const components = [...model.components].sort((a, b) =>
    a.canonicalComponentId.localeCompare(b.canonicalComponentId),
  );
  for (const component of components) {
    const override = overrides.get(component.canonicalComponentId);
    addReferencePlan(component, override, options, state, collections);
    addValuePlan(component, override, options, collections);
    addFootprintPlan(component, override, options, collections);
    addBomClassificationPlan(component, override, collections);
  }
}

function addPowerFlagWarnings(
  model: SchematicModel,
  warnings: NormalizationPlanDiagnostic[],
): void {
  for (const net of model.nets) {
    if (net.kind !== 'power-flag') continue;
    warnings.push({
      code: 'POWER_FLAG_PRESERVED',
      severity: 'warning',
      message: 'Power-flag helper names are intentionally excluded from automatic net renaming.',
      netName: net.canonicalNetName,
      suggestedAction: 'Preserve the helper unless a later runtime-specific operation proves safe.',
      confidence: 'high',
    });
  }
}

function determinePlanStatus(
  blockerCount: number,
  requiresConfirmation: boolean,
  operationCount: number,
): ImportedNormalizationPlan['status'] {
  if (blockerCount > 0) return 'blocked';
  if (requiresConfirmation) return 'review';
  if (operationCount === 0) return 'noop';
  return 'ready';
}

function countOperations(
  operations: NormalizationOperation[],
  kind: NormalizationOperationKind,
): number {
  return operations.filter((operation) => operation.kind === kind).length;
}

function canonicalModelHash(model: SchematicModel): string {
  return sha256({
    ...model,
    components: [...model.components].sort((a, b) =>
      a.canonicalComponentId.localeCompare(b.canonicalComponentId),
    ),
    nets: [...model.nets].sort((a, b) => a.canonicalNetName.localeCompare(b.canonicalNetName)),
    diagnostics: [...model.diagnostics].sort((a, b) => stableJson(a).localeCompare(stableJson(b))),
  });
}

export function previewImportedNormalization(
  model: SchematicModel,
  inputOptions: NormalizationPlanOptions = {},
): ImportedNormalizationPlan {
  const options = parsePlanOptions(inputOptions);
  const collections: PlanCollections = { operations: [], blockers: [], warnings: [] };

  addSourceTruncationBlocker(options, collections.blockers);
  addOverrideTargetBlockers(model, options, collections.blockers);
  addDuplicateReferenceBlockers(model, options, collections.blockers);
  addNetRenameOperations(model, options, collections.operations);
  addComponentPlans(model, options, collections);
  addPowerFlagWarnings(model, collections.warnings);

  collections.operations.sort(operationSort);
  collections.blockers.sort(diagnosticSort);
  collections.warnings.sort(diagnosticSort);

  const confirmationOperationCount = collections.operations.filter(
    (operation) => operation.requiresConfirmation,
  ).length;
  const applicationReady = collections.blockers.length === 0;
  const requiresConfirmation = confirmationOperationCount > 0 || collections.warnings.length > 0;
  const status = determinePlanStatus(
    collections.blockers.length,
    requiresConfirmation,
    collections.operations.length,
  );
  const modelHash = canonicalModelHash(model);
  const planPayload = {
    schemaVersion: 'imported-normalization-plan/v1',
    modelHash,
    options,
    operations: collections.operations,
    blockers: collections.blockers,
    warnings: collections.warnings,
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
      operationCount: collections.operations.length,
      automaticOperationCount: collections.operations.filter((operation) => operation.automatic)
        .length,
      confirmationOperationCount,
      netRenameCount: countOperations(collections.operations, 'normalize-net-name'),
      referenceAnnotationCount: countOperations(collections.operations, 'annotate-reference'),
      valueUpdateCount: countOperations(collections.operations, 'set-component-value'),
      footprintUpdateCount: countOperations(collections.operations, 'set-component-footprint'),
      bomClassificationCount: countOperations(collections.operations, 'classify-bom'),
      blockerCount: collections.blockers.length,
      warningCount: collections.warnings.length,
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
