export const SCHEMATIC_ERROR_CODES = [
  'INVALID_ARGUMENT',
  'VALIDATION_FAILED',
  'TRANSACTION_ACTIVE',
  'TRANSACTION_NOT_FOUND',
  'TRANSACTION_ROLLBACK_FAILED',
  'CONTEXT_UNAVAILABLE',
  'CAPABILITY_UNAVAILABLE',
  'UNSUPPORTED_RUNTIME',
  'ROUTE_NOT_FOUND',
  'ROUTE_COLLISION',
  'VISUAL_COLLISION',
  'NET_CONFLICT',
  'PIN_NOT_FOUND',
  'COMPONENT_NOT_FOUND',
  'MODEL_INCONSISTENT',
  'IMPORT_NORMALIZATION_REQUIRED',
  'NATIVE_API_ERROR',
  'CONNECTION_LOST',
  'TIMEOUT',
] as const;

export type SchematicErrorCode = (typeof SCHEMATIC_ERROR_CODES)[number];

export interface StructuredSchematicError {
  code: SchematicErrorCode;
  message: string;
  operation: string;
  recoverable: boolean;
  details: Record<string, unknown>;
  suggestion: string;
}

export class SchematicEngineError extends Error {
  readonly error: StructuredSchematicError;

  constructor(error: StructuredSchematicError, options?: ErrorOptions) {
    super(error.message, options);
    this.name = 'SchematicEngineError';
    this.error = error;
  }
}

const LOCALIZED_RUNTIME_TEXT = /[\u3400-\u9fff]/u;

function runtimeCause(error: unknown): { message: string; code?: string } {
  if (error instanceof Error) {
    const code = Reflect.get(error, 'code');
    return {
      message: error.message,
      code: typeof code === 'string' ? code : undefined,
    };
  }
  return { message: String(error) };
}

export function schematicError(
  code: SchematicErrorCode,
  operation: string,
  message: string,
  options: {
    recoverable?: boolean;
    details?: Record<string, unknown>;
    suggestion?: string;
    cause?: unknown;
  } = {},
): SchematicEngineError {
  return new SchematicEngineError(
    {
      code,
      message,
      operation,
      recoverable: options.recoverable ?? true,
      details: options.details ?? {},
      suggestion:
        options.suggestion ?? 'Review the operation input and retry from a fresh preview.',
    },
    options.cause === undefined ? undefined : { cause: options.cause },
  );
}

export function normalizeRuntimeError(error: unknown, operation: string): SchematicEngineError {
  if (error instanceof SchematicEngineError) return error;

  const raw = runtimeCause(error);
  const normalizedCode = raw.code?.toUpperCase();
  const disconnected = /disconnect|closed|socket|not connected/i.test(raw.message);
  const timedOut = /timed?\s*out|timeout/i.test(raw.message);
  const code: SchematicErrorCode = disconnected
    ? 'CONNECTION_LOST'
    : timedOut
      ? 'TIMEOUT'
      : 'NATIVE_API_ERROR';
  const primaryMessage = LOCALIZED_RUNTIME_TEXT.test(raw.message)
    ? `EasyEDA runtime failed while executing ${operation}.`
    : raw.message || `EasyEDA runtime failed while executing ${operation}.`;

  return schematicError(code, operation, primaryMessage, {
    recoverable: code !== 'NATIVE_API_ERROR' || normalizedCode !== 'FATAL',
    details: {
      nativeCode: raw.code,
      rawCause: raw.message,
    },
    suggestion:
      code === 'CONNECTION_LOST'
        ? 'Reconnect the EasyEDA bridge, inspect transaction status, and roll back before retrying.'
        : code === 'TIMEOUT'
          ? 'Inspect transaction status before retrying; the runtime may have applied part of the request.'
          : 'Inspect EasyEDA runtime capabilities and retry from a preview or transaction snapshot.',
    cause: error,
  });
}

export function toStructuredSchematicError(
  error: unknown,
  operation: string,
): StructuredSchematicError {
  return normalizeRuntimeError(error, operation).error;
}
