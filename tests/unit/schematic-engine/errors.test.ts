import { describe, expect, it } from 'vitest';
import {
  SchematicEngineError,
  normalizeRuntimeError,
  schematicError,
  toStructuredSchematicError,
} from '../../../src/schematic-engine/errors.js';

describe('schematicError', () => {
  it('applies default recoverable/details/suggestion when omitted', () => {
    const error = schematicError('VALIDATION_FAILED', 'writePrimitive', 'bad input');
    expect(error).toBeInstanceOf(SchematicEngineError);
    expect(error.message).toBe('bad input');
    expect(error.error).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'bad input',
      operation: 'writePrimitive',
      recoverable: true,
      details: {},
      suggestion: 'Review the operation input and retry from a fresh preview.',
    });
  });

  it('honors explicit recoverable/details/suggestion/cause', () => {
    const cause = new Error('root cause');
    const error = schematicError('MODEL_INCONSISTENT', 'sync', 'inconsistent model', {
      recoverable: false,
      details: { primitiveId: 'p1' },
      suggestion: 'Re-run audit.',
      cause,
    });
    expect(error.error.recoverable).toBe(false);
    expect(error.error.details).toEqual({ primitiveId: 'p1' });
    expect(error.error.suggestion).toBe('Re-run audit.');
    expect(error.cause).toBe(cause);
  });
});

describe('normalizeRuntimeError', () => {
  it('passes an existing SchematicEngineError through unchanged', () => {
    const original = schematicError('PIN_NOT_FOUND', 'op', 'no pin');
    expect(normalizeRuntimeError(original, 'op')).toBe(original);
  });

  it('classifies a disconnected-socket message as CONNECTION_LOST', () => {
    const result = normalizeRuntimeError(new Error('socket closed unexpectedly'), 'writeWire');
    expect(result.error.code).toBe('CONNECTION_LOST');
    expect(result.error.suggestion).toMatch(/Reconnect the EasyEDA bridge/);
  });

  it('classifies a timeout message as TIMEOUT', () => {
    const result = normalizeRuntimeError(new Error('request timed out'), 'writeWire');
    expect(result.error.code).toBe('TIMEOUT');
    expect(result.error.suggestion).toMatch(/Inspect transaction status/);
  });

  it('falls back to NATIVE_API_ERROR for an unrecognized message', () => {
    const result = normalizeRuntimeError(new Error('unexpected native failure'), 'writeWire');
    expect(result.error.code).toBe('NATIVE_API_ERROR');
    expect(result.error.recoverable).toBe(true);
    expect(result.error.message).toBe('unexpected native failure');
  });

  it('marks a NATIVE_API_ERROR unrecoverable only when the native code is FATAL', () => {
    const fatal = Object.assign(new Error('boom'), { code: 'fatal' });
    const result = normalizeRuntimeError(fatal, 'writeWire');
    expect(result.error.code).toBe('NATIVE_API_ERROR');
    expect(result.error.recoverable).toBe(false);
    expect(result.error.details.nativeCode).toBe('fatal');
  });

  it('ignores a non-string error.code property', () => {
    const withNumericCode = Object.assign(new Error('boom'), { code: 42 });
    const result = normalizeRuntimeError(withNumericCode, 'writeWire');
    expect(result.error.details.nativeCode).toBeUndefined();
  });

  it('replaces a localized (non-Latin) runtime message with a generic one', () => {
    const result = normalizeRuntimeError(new Error('未知错误'), 'writeWire');
    expect(result.error.message).toBe('EasyEDA runtime failed while executing writeWire.');
  });

  it('falls back to a generic message when the raw message is empty', () => {
    const result = normalizeRuntimeError(new Error(''), 'writeWire');
    expect(result.error.message).toBe('EasyEDA runtime failed while executing writeWire.');
  });

  it('stringifies a non-Error thrown value', () => {
    const result = normalizeRuntimeError('plain string failure', 'writeWire');
    expect(result.error.message).toBe('plain string failure');
    expect(result.error.code).toBe('NATIVE_API_ERROR');
  });
});

describe('toStructuredSchematicError', () => {
  it('returns the plain structured error payload', () => {
    const structured = toStructuredSchematicError(new Error('request timed out'), 'op');
    expect(structured.code).toBe('TIMEOUT');
    expect(structured.operation).toBe('op');
  });
});
