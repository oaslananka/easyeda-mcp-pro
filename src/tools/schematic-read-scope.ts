import { z } from 'zod';

export const schematicReadScopeValues = ['focused', 'page', 'all_pages'] as const;
export type SchematicReadScope = (typeof schematicReadScopeValues)[number];

const scopeEnum = z.enum(schematicReadScopeValues);
const pageUuidSchema = z.string().trim().min(1, 'pageUuid must not be empty');

export const schematicReadScopeInputSchema = z
  .object({
    pageUuid: pageUuidSchema.optional(),
    scope: scopeEnum.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.scope === 'page' && !value.pageUuid) {
      ctx.addIssue({
        code: 'custom',
        path: ['pageUuid'],
        message: "scope 'page' requires pageUuid",
      });
    }
    if (value.pageUuid && value.scope === 'focused') {
      ctx.addIssue({
        code: 'custom',
        path: ['scope'],
        message: "scope 'focused' cannot be combined with pageUuid",
      });
    }
    if (value.pageUuid && value.scope === 'all_pages') {
      ctx.addIssue({
        code: 'custom',
        path: ['scope'],
        message: "scope 'all_pages' cannot be combined with pageUuid",
      });
    }
  })
  .transform((value) => ({
    ...value,
    scope: value.scope ?? (value.pageUuid ? ('page' as const) : ('focused' as const)),
  }));

export function withSchematicReadScope<T extends z.ZodType>(schema: T) {
  return schema.and(schematicReadScopeInputSchema);
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

export function scopeErrorFields(error: unknown): ScopeErrorFields {
  if (!error || typeof error !== 'object') return {};
  const record = error as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : undefined;
  if (!code?.startsWith('PAGE_')) return code ? { error_code: code } : {};

  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : undefined;
  const errorData: Record<string, string | number | boolean> = {};
  if (data) {
    for (const key of safeScopeErrorKeys) {
      const value = data[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        errorData[key] = value;
      }
    }
  }

  return {
    error_code: code,
    ...(Object.keys(errorData).length > 0 ? { error_data: errorData } : {}),
  };
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
