import { describe, expect, it } from 'vitest';
import { extractPinsPayload } from '../../../scripts/e2e/payloads.mjs';

describe('extractPinsPayload', () => {
  it('accepts direct pin arrays', () => {
    const pins = [{ pinNumber: '1' }];
    expect(extractPinsPayload(pins)).toBe(pins);
  });

  it('accepts wrapped pin arrays', () => {
    const pins = [{ pinNumber: '2' }];
    expect(extractPinsPayload({ pins })).toBe(pins);
  });

  it.each([null, undefined, {}, { pins: null }, 'invalid', 42])(
    'returns an empty array for unsupported payload %j',
    (payload) => {
      expect(extractPinsPayload(payload)).toEqual([]);
    },
  );
});
