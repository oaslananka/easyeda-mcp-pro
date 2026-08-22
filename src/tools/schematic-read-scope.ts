import { z } from 'zod';

export const schematicReadScopeValues = ['focused', 'page', 'all_pages'] as const;
export type SchematicReadScope = (typeof schematicReadScopeValues)[number];

const scopeEnum = z.enum(schematicReadScopeValues);
const pageUuidSchema = z.string().trim().min(1, 'pageUuid must not be empty');
const schematicReadScopeShape = {
  pageUuid: pageUuidSchema.optional(),
  scope: scopeEnum.optional(),
};

type SchematicReadScopeInput = {
  pageUuid?: string;
  scope?: SchematicReadScope;
};

function validateSchematicReadScope(value: SchematicReadScopeInput, ctx: z.core.$RefinementCtx) {
  if (value.scope === 'page' && !value.pageUuid) {
    ctx.addIssue({
      code: 'custom',
      path: ['pageUuid'],
      message: "scope 'page' requires pageUuid",
      input: value,
    });
  }
  if (value.pageUuid && value.scope === 'focused') {
    ctx.addIssue({
      code: 'custom',
      path: ['scope'],
      message: "scope 'focused' cannot be combined with pageUuid",
      input: value,
    });
  }
  if (value.pageUuid && value.scope === 'all_pages') {
    ctx.addIssue({
      code: 'custom',
      path: ['scope'],
      message: "scope 'all_pages' cannot be combined with pageUuid",
      input: value,
    });
  }
}

export const schematicReadScopeInputSchema = z
  .object(schematicReadScopeShape)
  .superRefine(validateSchematicReadScope)
  .transform((value) =>
    value.pageUuid && !value.scope ? { ...value, scope: 'page' as const } : value,
  );

export function withSchematicReadScope<T extends z.ZodObject>(schema: T) {
  return schema.safeExtend(schematicReadScopeShape).superRefine(validateSchematicReadScope);
}

export const readScopeOutputSchema = z.object({
  requested: scopeEnum,
  resolved: scopeEnum,
  page_uuid: z.string().optional(),
  focused_page_uuid: z.string().optional(),
  focus_changed: z.literal(false),
  source: z.string(),
});

const safeScopeErrorKeys = [
  'requestedScope',
  'pageUuid',
  'focusedPageUuid',
  'operation',
  'missingCapability',
] as const;

type ScopeErrorFields = {
  error_code?: string;
  error_data?: Record<string, string | number | boolean>;
};

function safeScopeErrorData(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const data = value as Record<string, unknown>;
  return Object.fromEntries(
    safeScopeErrorKeys.flatMap((key) => {
      const item = data[key];
      return typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
        ? [[key, item]]
        : [];
    }),
  );
}

export function scopeErrorFields(error: unknown): ScopeErrorFields {
  if (!error || typeof error !== 'object') return {};
  const record = error as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : undefined;
  if (!code?.startsWith('PAGE_')) return code ? { error_code: code } : {};
  const errorData = safeScopeErrorData(record.data);
  return {
    error_code: code,
    ...(Object.keys(errorData).length ? { error_data: errorData } : {}),
  };
}

export function scopeErrorDiagnostics(error: unknown): unknown {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  const fields = scopeErrorFields(error);
  return fields.error_code?.startsWith('PAGE_') ? fields.error_data : record.data;
}

export const scopeErrorDataSchema = z
  .object({
    requestedScope: scopeEnum.optional(),
    pageUuid: z.string().optional(),
    focusedPageUuid: z.string().optional(),
    operation: z.string().optional(),
    missingCapability: z.string().optional(),
  })
  .partial();

export function assertSchematicReadScopeSupported(
  scope: SchematicReadScope | undefined,
  pageUuid: string | undefined,
  supported: readonly SchematicReadScope[],
  operation: string,
  missingCapability: string,
): void {
  if (!scope || supported.includes(scope)) return;
  throw Object.assign(new Error(`Schematic ${scope} scope is not supported for ${operation}.`), {
    code: 'PAGE_SCOPE_UNSUPPORTED',
    data: {
      requestedScope: scope,
      ...(pageUuid ? { pageUuid } : {}),
      operation,
      missingCapability,
    },
  });
}

export function componentReadScope(scope: SchematicReadScope | undefined) {
  if (!scope) return { bridgeParams: {} };
  return {
    bridgeParams: { allPages: scope === 'all_pages' },
    readScope: readScope(scope, 'SCH_PrimitiveComponent.getAll'),
  };
}

export function readScopeResult(scope: SchematicReadScope | undefined, source: string) {
  return scope ? { read_scope: readScope(scope, source) } : {};
}

type SheetScopeResolution = {
  current?: Record<string, unknown>;
  pages: Array<Record<string, unknown>>;
  metadataSource?: string;
  readScope?: z.infer<typeof readScopeOutputSchema>;
  allPages: boolean;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pageRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const page = record(item);
    return page ? [page] : [];
  });
}

function pageScopeError(
  code: 'PAGE_NOT_FOUND' | 'PAGE_SCOPE_UNAVAILABLE',
  message: string,
  data: Record<string, unknown>,
): Error {
  return Object.assign(new Error(message), { code, data });
}

function focusedPageUuid(
  root: Record<string, unknown>,
  current: Record<string, unknown> | undefined,
): string | undefined {
  const focused = record(root.focusedDocument);
  if (typeof focused?.uuid === 'string') return focused.uuid;
  return typeof current?.uuid === 'string' ? current.uuid : undefined;
}

function readScope(
  scope: SchematicReadScope,
  source: string,
  focusedUuid?: string,
  pageUuid?: string,
): z.infer<typeof readScopeOutputSchema> {
  return {
    requested: scope,
    resolved: scope,
    ...(pageUuid ? { page_uuid: pageUuid } : {}),
    ...(focusedUuid ? { focused_page_uuid: focusedUuid } : {}),
    focus_changed: false,
    source,
  };
}

function pageErrorData(scope: SchematicReadScope, pageUuid?: string, focusedUuid?: string) {
  return {
    requestedScope: scope,
    ...(pageUuid ? { pageUuid } : {}),
    ...(focusedUuid ? { focusedPageUuid: focusedUuid } : {}),
    operation: 'schematic.getSheetInfo',
  };
}

function resolveNonFocusedSheetScope(
  pages: Array<Record<string, unknown>>,
  scope: 'page' | 'all_pages',
  pageUuid: string | undefined,
  focusedUuid: string | undefined,
): SheetScopeResolution {
  const data = pageErrorData(scope, pageUuid, focusedUuid);
  if (!pages.length) {
    throw pageScopeError(
      'PAGE_SCOPE_UNAVAILABLE',
      'EasyEDA did not expose a schematic page list for the requested scope.',
      data,
    );
  }
  if (scope === 'all_pages') {
    return {
      pages,
      metadataSource: 'page_list',
      allPages: true,
      readScope: readScope(scope, 'page_list', focusedUuid),
    };
  }
  const current = pages.find((page) => page.uuid === pageUuid);
  if (!current)
    throw pageScopeError('PAGE_NOT_FOUND', 'Requested schematic page was not found.', data);
  return {
    current,
    pages,
    metadataSource: 'page_list',
    allPages: false,
    readScope: readScope(scope, 'page_list', focusedUuid, pageUuid),
  };
}

export function resolveSheetInfoScope(
  result: unknown,
  scope?: SchematicReadScope,
  pageUuid?: string,
): SheetScopeResolution {
  const root = record(result) ?? {};
  const current = record(root.currentPage) ?? (typeof root.uuid === 'string' ? root : undefined);
  const pages = pageRecords(root.pages);
  if (!scope) return { current, pages, allPages: false };
  const focusedUuid = focusedPageUuid(root, current);
  if (scope !== 'focused') return resolveNonFocusedSheetScope(pages, scope, pageUuid, focusedUuid);
  const source = typeof root.source === 'string' ? root.source : 'focused';
  return {
    current,
    pages,
    metadataSource: source,
    allPages: false,
    readScope: readScope(scope, source, focusedUuid),
  };
}
