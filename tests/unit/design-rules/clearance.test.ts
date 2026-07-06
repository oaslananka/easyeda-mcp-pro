import { describe, expect, it } from 'vitest';
import { lookupClearance } from '../../../src/design-rules/clearance.js';

describe('lookupClearance', () => {
  it('returns a positive clearance for a low-voltage external case', () => {
    const result = lookupClearance({ voltageV: 5, location: 'external' });
    expect(result.minClearanceMm).toBeGreaterThan(0);
    expect(result.minClearanceMils).toBeGreaterThan(0);
  });

  it('is monotonically non-decreasing in voltage', () => {
    const low = lookupClearance({ voltageV: 5, location: 'external' });
    const mid = lookupClearance({ voltageV: 50, location: 'external' });
    const high = lookupClearance({ voltageV: 250, location: 'external' });
    expect(mid.minClearanceMm).toBeGreaterThanOrEqual(low.minClearanceMm);
    expect(high.minClearanceMm).toBeGreaterThanOrEqual(mid.minClearanceMm);
  });

  it('never recommends a smaller clearance for internal vs external at the same voltage', () => {
    for (const voltageV of [5, 50, 150, 400]) {
      const external = lookupClearance({ voltageV, location: 'external' });
      const internal = lookupClearance({ voltageV, location: 'internal' });
      expect(internal.minClearanceMm).toBeGreaterThanOrEqual(external.minClearanceMm);
    }
  });

  it('flags voltages above the covered range instead of silently extrapolating', () => {
    const result = lookupClearance({ voltageV: 1000, location: 'external' });
    expect(result.outOfRange).toBe(true);
    expect(result.caveat).toMatch(/exceeds this module's covered range/);
  });

  it('rejects negative voltage', () => {
    expect(() => lookupClearance({ voltageV: -1, location: 'external' })).toThrow();
  });

  it('includes source and caveat text directing to the real standard', () => {
    const result = lookupClearance({ voltageV: 12, location: 'external' });
    expect(result.source).toMatch(/IPC-2221/);
    expect(result.caveat).toMatch(/IPC-2221/);
  });
});
