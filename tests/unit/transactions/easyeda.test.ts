import { describe, expect, it } from 'vitest';
import { extractCreatedPrimitiveId } from '../../../src/transactions/easyeda.js';

describe('extractCreatedPrimitiveId', () => {
  it('accepts a direct native UUID string', () => {
    expect(extractCreatedPrimitiveId('primitive-uuid')).toBe('primitive-uuid');
  });

  it('finds IDs in nested normalized bridge results', () => {
    expect(extractCreatedPrimitiveId({ result: { data: { PrimitiveId: 'nested-id' } } })).toBe(
      'nested-id',
    );
  });

  it('finds the first addressable result in arrays', () => {
    expect(extractCreatedPrimitiveId([null, { text: { uuid: 'text-id' } }])).toBe('text-id');
  });

  it('returns undefined for non-addressable create results', () => {
    expect(extractCreatedPrimitiveId({ ok: true })).toBeUndefined();
  });
});
