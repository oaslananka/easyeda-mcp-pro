import { describe, expect, it } from 'vitest';
import {
  lookupDecouplingGuidance,
  listDecouplingCategories,
  recommendBulkCapacitance,
  type DecouplingCategory,
} from '../../../src/design-rules/decoupling.js';
import { requiredBulkCapacitance, DEFAULT_LIMITS } from '../../../src/power-tree/index.js';

describe('lookupDecouplingGuidance', () => {
  it('returns guidance for every listed category', () => {
    for (const category of listDecouplingCategories()) {
      const guidance = lookupDecouplingGuidance(category);
      expect(guidance.category).toBe(category);
      expect(guidance.perPinCapacitorsNf.length).toBeGreaterThan(0);
      expect(guidance.placement.length).toBeGreaterThan(0);
      expect(guidance.notes.length).toBeGreaterThan(0);
      expect(guidance.caveat).toMatch(/Rule-of-thumb guidance/);
    }
  });

  it('lists the expected categories', () => {
    expect(listDecouplingCategories()).toEqual(
      expect.arrayContaining([
        'digital-logic',
        'mcu',
        'analog',
        'rf',
        'crystal-oscillator',
        'power-regulator',
      ]),
    );
  });

  it('rejects an unknown category', () => {
    expect(() => lookupDecouplingGuidance('bogus' as DecouplingCategory)).toThrow();
  });
});

describe('recommendBulkCapacitance', () => {
  it("matches the power-tree analyzer's requiredBulkCapacitance exactly for the same inputs", () => {
    const loadA = 1.5;
    const expected = requiredBulkCapacitance(loadA, DEFAULT_LIMITS);
    const result = recommendBulkCapacitance(loadA);
    expect(result.requiredBulkCapacitanceUf).toBeCloseTo(expected, 6);
  });

  it('applies the minimum floor for very small loads', () => {
    const result = recommendBulkCapacitance(0.01);
    expect(result.requiredBulkCapacitanceUf).toBe(DEFAULT_LIMITS.minBulkCapacitanceUf);
  });

  it('rejects non-positive load current', () => {
    expect(() => recommendBulkCapacitance(0)).toThrow();
    expect(() => recommendBulkCapacitance(-1)).toThrow();
  });

  it('honors custom limits overrides', () => {
    const result = recommendBulkCapacitance(2, {
      minBulkCapacitanceUfPerA: 100,
      minBulkCapacitanceUf: 5,
    });
    expect(result.requiredBulkCapacitanceUf).toBe(200);
  });

  it('ignores explicit undefined fields in limits rather than overriding the defaults with NaN', () => {
    // A caller (e.g. a tool handler passing through optional input fields) may build a
    // limits object with explicit `undefined` values instead of omitting the keys entirely.
    const result = recommendBulkCapacitance(2, {
      minBulkCapacitanceUfPerA: undefined,
      minBulkCapacitanceUf: undefined,
    });
    expect(result.requiredBulkCapacitanceUf).toBe(DEFAULT_LIMITS.minBulkCapacitanceUfPerA * 2);
  });
});
