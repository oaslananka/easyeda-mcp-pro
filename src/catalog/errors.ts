/**
 * Catalog-specific validation and lookup errors.
 *
 * Follows the same pattern as src/circuit/errors.ts and src/schemas/common.ts.
 *
 * @module
 */

// ── Error codes ───────────────────────────────────────────────────────────

export const CatalogErrorCode = {
  // Schema validation
  CATALOG_INVALID: 'CATALOG_INVALID',
  CATALOG_SCHEMA_VERSION_MISMATCH: 'CATALOG_SCHEMA_VERSION_MISMATCH',

  // Device validation
  DEVICE_DUPLICATE_ID: 'DEVICE_DUPLICATE_ID',
  DEVICE_MISSING_SYMBOL: 'DEVICE_MISSING_SYMBOL',
  DEVICE_MISSING_FOOTPRINT: 'DEVICE_MISSING_FOOTPRINT',
  DEVICE_MISSING_PIN_MAP: 'DEVICE_MISSING_PIN_MAP',
  DEVICE_INCOMPATIBLE_PACKAGE: 'DEVICE_INCOMPATIBLE_PACKAGE',
  DEVICE_MISSING_MPN: 'DEVICE_MISSING_MPN',
  DEVICE_MISSING_ASSEMBLY_DATA: 'DEVICE_MISSING_ASSEMBLY_DATA',
  DEVICE_DUPLICATE_SUPPLIER_ID: 'DEVICE_DUPLICATE_SUPPLIER_ID',
  DEVICE_UNRESOLVED_SYMBOL: 'DEVICE_UNRESOLVED_SYMBOL',
  DEVICE_UNRESOLVED_FOOTPRINT: 'DEVICE_UNRESOLVED_FOOTPRINT',

  // Lookup
  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
  DEVICE_RESOLUTION_FAILED: 'DEVICE_RESOLUTION_FAILED',
} as const;

export type CatalogErrorCode = (typeof CatalogErrorCode)[keyof typeof CatalogErrorCode];

// ── Structured error ──────────────────────────────────────────────────────

export interface CatalogValidationError {
  code: CatalogErrorCode;
  message: string;
  /** Path to the field that caused the error (dot-notation) */
  path?: string;
  /** Specific details for programmatic handling */
  details?: Record<string, unknown>;
}

export class CatalogError extends Error {
  public readonly code: CatalogErrorCode;
  public readonly errors: CatalogValidationError[];
  public readonly retryable: boolean;

  constructor(opts: {
    code: CatalogErrorCode;
    message: string;
    errors?: CatalogValidationError[];
    retryable?: boolean;
  }) {
    super(opts.message);
    this.name = 'CatalogError';
    this.code = opts.code;
    this.errors = opts.errors ?? [];
    this.retryable = opts.retryable ?? false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Create a single validation error.
 */
export function catalogValidationError(
  code: CatalogErrorCode,
  message: string,
  details?: Record<string, unknown>,
): CatalogValidationError {
  return { code, message, details };
}

/**
 * Build a list of CatalogValidationErrors from a Zod error.
 */
export function fromZodError(
  zodError: import('zod').ZodError,
  prefix?: string,
): CatalogValidationError[] {
  return zodError.issues.map((issue) => ({
    code: 'CATALOG_INVALID' as CatalogErrorCode,
    message: issue.message,
    path: prefix ? `${prefix}.${issue.path.join('.')}` : issue.path.join('.'),
    details: {
      code: issue.code,
      expected: issue.message,
      received: (issue as { received?: unknown }).received,
    },
  }));
}
