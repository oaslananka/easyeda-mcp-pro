import { describe, expect, it } from 'vitest';
import { calculateTraceWidth, calculateMaxCurrent } from '../../../src/design-rules/trace-width.js';

describe('calculateTraceWidth', () => {
  it('matches the hand-computed reference point (1A, 10C rise, external, 1oz)', () => {
    // I = k * dT^0.44 * A^0.725  =>  A = (I / (k * dT^0.44)) ^ (1/0.725)
    // 0.048 * 10^0.44 ≈ 0.048 * 2.7566 ≈ 0.13232
    // A = (1 / 0.13232) ^ (1/0.725) ≈ 7.558 ^ 1.379 ≈ 16.33 mils^2
    // width = area / thickness(1.378 mils) ≈ 11.85 mils
    const result = calculateTraceWidth({
      currentA: 1,
      temperatureRiseC: 10,
      layer: 'external',
      copperWeightOz: 1,
    });
    expect(result.traceWidthMils).toBeGreaterThan(11.5);
    expect(result.traceWidthMils).toBeLessThan(12.2);
  });

  it('internal-layer width for current I equals external-layer width for current 2I', () => {
    // k_internal = k_external / 2, and area = (I / (k * dT^0.44))^(1/0.725), so halving k
    // is equivalent to doubling I for the internal case — an exact structural identity
    // independent of any specific numeric constants.
    const internal = calculateTraceWidth({
      currentA: 1.5,
      temperatureRiseC: 20,
      layer: 'internal',
      copperWeightOz: 2,
    });
    const external = calculateTraceWidth({
      currentA: 3,
      temperatureRiseC: 20,
      layer: 'external',
      copperWeightOz: 2,
    });
    expect(internal.traceWidthMils).toBeCloseTo(external.traceWidthMils, 6);
    expect(internal.requiredAreaMils2).toBeCloseTo(external.requiredAreaMils2, 6);
  });

  it('is monotonically increasing in current and decreasing in allowed temperature rise', () => {
    const base = calculateTraceWidth({
      currentA: 2,
      temperatureRiseC: 10,
      layer: 'external',
      copperWeightOz: 1,
    });
    const moreCurrent = calculateTraceWidth({
      currentA: 4,
      temperatureRiseC: 10,
      layer: 'external',
      copperWeightOz: 1,
    });
    const moreRise = calculateTraceWidth({
      currentA: 2,
      temperatureRiseC: 30,
      layer: 'external',
      copperWeightOz: 1,
    });
    expect(moreCurrent.traceWidthMils).toBeGreaterThan(base.traceWidthMils);
    expect(moreRise.traceWidthMils).toBeLessThan(base.traceWidthMils);
  });

  it('doubling copper weight halves the required width for the same area', () => {
    const oneOz = calculateTraceWidth({
      currentA: 1,
      temperatureRiseC: 10,
      layer: 'external',
      copperWeightOz: 1,
    });
    const twoOz = calculateTraceWidth({
      currentA: 1,
      temperatureRiseC: 10,
      layer: 'external',
      copperWeightOz: 2,
    });
    expect(oneOz.requiredAreaMils2).toBeCloseTo(twoOz.requiredAreaMils2, 6);
    expect(twoOz.traceWidthMils).toBeCloseTo(oneOz.traceWidthMils / 2, 1);
  });

  it('rejects non-positive inputs', () => {
    expect(() =>
      calculateTraceWidth({
        currentA: 0,
        temperatureRiseC: 10,
        layer: 'external',
        copperWeightOz: 1,
      }),
    ).toThrow();
    expect(() =>
      calculateTraceWidth({
        currentA: 1,
        temperatureRiseC: -5,
        layer: 'external',
        copperWeightOz: 1,
      }),
    ).toThrow();
    expect(() =>
      calculateTraceWidth({
        currentA: 1,
        temperatureRiseC: 10,
        layer: 'external',
        copperWeightOz: 0,
      }),
    ).toThrow();
  });

  it('includes source and caveat text', () => {
    const result = calculateTraceWidth({
      currentA: 1,
      temperatureRiseC: 10,
      layer: 'external',
      copperWeightOz: 1,
    });
    expect(result.source).toMatch(/IPC-2221/);
    expect(result.caveat).toMatch(/Estimate only/);
  });
});

describe('calculateMaxCurrent', () => {
  it('round-trips with calculateTraceWidth', () => {
    const forward = calculateTraceWidth({
      currentA: 2.5,
      temperatureRiseC: 15,
      layer: 'external',
      copperWeightOz: 1,
    });
    const reverse = calculateMaxCurrent({
      traceWidthMils: forward.traceWidthMils,
      temperatureRiseC: 15,
      layer: 'external',
      copperWeightOz: 1,
    });
    // rounding in the forward pass introduces a small amount of slop
    expect(reverse.maxCurrentA).toBeCloseTo(2.5, 1);
  });

  it('rejects non-positive inputs', () => {
    expect(() =>
      calculateMaxCurrent({
        traceWidthMils: 0,
        temperatureRiseC: 10,
        layer: 'external',
        copperWeightOz: 1,
      }),
    ).toThrow();
  });
});
