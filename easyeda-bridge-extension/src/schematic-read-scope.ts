export const schematicReadScopeValues = ['focused', 'page', 'all_pages'] as const;
export type SchematicReadScope = (typeof schematicReadScopeValues)[number];

export interface SchematicReadSelector {
  scope?: SchematicReadScope;
  pageUuid?: string;
}

function scopeError(
  code: 'PAGE_UUID_REQUIRED' | 'PAGE_SCOPE_CONFLICT' | 'PAGE_SCOPE_UNSUPPORTED',
  message: string,
  suggestion: string,
  data: Record<string, unknown>,
): Error {
  return Object.assign(new Error(message), { code, suggestion, data });
}

function normalizedPageUuid(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function describeInvalidScope(value: unknown): string {
  return typeof value === 'string' ? value : typeof value;
}

export function resolveSchematicReadSelector(
  params: Record<string, unknown> = {},
  operation = 'schematic.read',
): SchematicReadSelector {
  const rawScope = params.scope;
  const rawPageUuid = params.pageUuid;
  const pageUuid = normalizedPageUuid(rawPageUuid);

  if (
    rawScope !== undefined &&
    !schematicReadScopeValues.includes(rawScope as SchematicReadScope)
  ) {
    const requestedScope = describeInvalidScope(rawScope);
    throw scopeError(
      'PAGE_SCOPE_CONFLICT',
      `Invalid schematic read scope for ${operation}.`,
      `Use one of: ${schematicReadScopeValues.join(', ')}.`,
      { operation, requestedScope },
    );
  }

  const explicitScope = rawScope as SchematicReadScope | undefined;
  const scope = explicitScope ?? (pageUuid ? 'page' : undefined);

  if (rawPageUuid !== undefined && !pageUuid) {
    throw scopeError(
      'PAGE_UUID_REQUIRED',
      `pageUuid must be a non-empty string for ${operation}.`,
      'Provide a valid schematic page UUID or omit pageUuid.',
      { operation, ...(scope ? { requestedScope: scope } : {}) },
    );
  }
  if (scope === 'page' && !pageUuid) {
    throw scopeError(
      'PAGE_UUID_REQUIRED',
      `scope 'page' requires pageUuid for ${operation}.`,
      'Provide the target schematic page UUID.',
      { operation, requestedScope: scope },
    );
  }
  if (pageUuid && (scope === 'focused' || scope === 'all_pages')) {
    throw scopeError(
      'PAGE_SCOPE_CONFLICT',
      `pageUuid cannot be combined with scope '${scope}' for ${operation}.`,
      "Use scope 'page' with pageUuid, or omit pageUuid for focused/all_pages.",
      { operation, requestedScope: scope, pageUuid },
    );
  }

  return { scope, pageUuid };
}

export function assertSchematicReadScopeSupported(
  params: Record<string, unknown> | undefined,
  supported: readonly SchematicReadScope[],
  operation: string,
  missingCapability: string,
): SchematicReadSelector {
  const selector = resolveSchematicReadSelector(params ?? {}, operation);
  if (!selector.scope || supported.includes(selector.scope)) return selector;
  throw scopeError(
    'PAGE_SCOPE_UNSUPPORTED',
    `Schematic ${selector.scope} scope is not supported for ${operation}.`,
    'Use the focused scope or a tool/runtime capability that explicitly supports the requested scope.',
    {
      requestedScope: selector.scope,
      ...(selector.pageUuid ? { pageUuid: selector.pageUuid } : {}),
      operation,
      missingCapability,
    },
  );
}

const focusedScope = ['focused'] as const;
const focusedAndAllPagesScopes = ['focused', 'all_pages'] as const;
const allMetadataScopes = ['focused', 'page', 'all_pages'] as const;

const focusedOnlyCapabilityByOperation = new Map<string, string>([
  ['design.erc', 'page-aware-erc'],
  ['schematic.getNetDetail', 'page-aware-net-detail-read'],
  ['schematic.listNets', 'page-aware-net-read'],
  ['schematic.validateNetlist', 'project-wide-complete-netlist-validation'],
  ['system.inspectWires', 'page-aware-wire-read'],
]);

export function assertSchematicReadOperationScope(
  params: Record<string, unknown> | undefined,
  operation: string,
): void {
  if (operation === 'schematic.getSheetInfo') {
    assertSchematicReadScopeSupported(
      params,
      allMetadataScopes,
      operation,
      'schematic-page-metadata',
    );
    return;
  }
  if (operation === 'schematic.listComponents') {
    assertSchematicReadScopeSupported(
      params,
      focusedAndAllPagesScopes,
      operation,
      'page-attributed-component-read',
    );
    return;
  }
  const missingCapability = focusedOnlyCapabilityByOperation.get(operation);
  if (!missingCapability) return;
  assertSchematicReadScopeSupported(params, focusedScope, operation, missingCapability);
}
