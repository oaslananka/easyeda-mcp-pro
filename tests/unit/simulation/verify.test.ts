import { describe, expect, it } from 'vitest';
import { verifyRailAgainstSpec } from '../../../src/simulation/verify.js';

describe('verifyRailAgainstSpec', () => {
  it('passes a voltage exactly at the nominal value', () => {
    const verdict = verifyRailAgainstSpec(
      { out: 3.3 },
      { nodeName: 'out', nominalVoltage: 3.3, tolerancePercent: 5 },
    );
    expect(verdict.withinTolerance).toBe(true);
  });

  it('passes a voltage at the tolerance boundary', () => {
    const verdict = verifyRailAgainstSpec(
      { out: 3.135 }, // 3.3 * 0.95
      { nodeName: 'out', nominalVoltage: 3.3, tolerancePercent: 5 },
    );
    expect(verdict.withinTolerance).toBe(true);
    expect(verdict.minAllowedVoltage).toBeCloseTo(3.135, 6);
  });

  it('fails a voltage just outside the tolerance band', () => {
    const verdict = verifyRailAgainstSpec(
      { out: 3.1 },
      { nodeName: 'out', nominalVoltage: 3.3, tolerancePercent: 5 },
    );
    expect(verdict.withinTolerance).toBe(false);
  });

  it('fails when the requested node was not present in the simulation result', () => {
    const verdict = verifyRailAgainstSpec(
      { somethingElse: 3.3 },
      { nodeName: 'out', nominalVoltage: 3.3, tolerancePercent: 5 },
    );
    expect(verdict.withinTolerance).toBe(false);
    expect(Number.isNaN(verdict.observedVoltage)).toBe(true);
  });
});
