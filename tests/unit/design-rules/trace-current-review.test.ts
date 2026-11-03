import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  reviewTraceCurrent,
  type TraceCurrentReviewInput,
} from '../../../src/design-rules/trace-current-review.js';
import { calculateTraceWidth, calculateMaxCurrent } from '../../../src/design-rules/trace-width.js';

type Case = {
  id: string;
  input: TraceCurrentReviewInput;
  status: 'UNKNOWN' | 'WARNING';
  requiredUnknown: string[];
  requiredWarnings: string[];
  hasEstimate: boolean;
};

const cases = JSON.parse(
  readFileSync(
    new URL('../../fixtures/engineering-review/trace-current-cases.json', import.meta.url),
    'utf8',
  ),
) as Case[];

describe('trace-current evidence reference', () => {
  it('has unique fixtures', () => {
    expect(cases.length).toBe(9);
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
  });

  it.each(cases)(
    '$id distinguishes model estimates from verified design evidence',
    ({ input, status, requiredUnknown, requiredWarnings, hasEstimate }) => {
      const report = reviewTraceCurrent(input);
      expect(report).toEqual(reviewTraceCurrent(input));
      expect(report.status).toBe(status);
      expect(report.method).toBe('IPC2221_EMPIRICAL_REFERENCE');
      expect(report.evidence).toBe('caller_supplied_unverified');
      expect(report.source).toContain('IPC-2221');
      expect(report.inputs).toEqual(input);
      expect(report.inputUnits.copperWeightOz).toBe('oz/ft²');
      expect(report.limitations).toEqual(
        expect.arrayContaining([
          expect.stringContaining('IPC-2152'),
          expect.stringContaining('Via'),
        ]),
      );
      expect(report.estimatedMinimumWidthMm === undefined).toBe(!hasEstimate);
      expect(new Set(report.findings.map((item) => item.id)).size).toBe(4);
      for (const name of requiredUnknown) {
        expect(report.findings).toContainEqual(
          expect.objectContaining({ id: name, status: 'UNKNOWN' }),
        );
      }
      for (const name of requiredWarnings) {
        expect(report.findings).toContainEqual(
          expect.objectContaining({ id: name, status: 'WARNING' }),
        );
      }
      expect(report.findings.map((item) => item.status)).not.toContain('PASS');
    },
  );

  it('internal layers need a larger IPC-2221 reference width at the same settings', () => {
    const base = { currentA: 2, temperatureRiseC: 10, copperWeightOz: 1 };
    const outer = reviewTraceCurrent({ ...base, layer: 'external' });
    const inner = reviewTraceCurrent({ ...base, layer: 'internal' });
    expect(inner.estimatedMinimumWidthMm).toBeGreaterThan(outer.estimatedMinimumWidthMm!);
    expect(inner.status).toBe('UNKNOWN');
  });

  it('larger nominal copper and allowed temperature rise reduce the model estimate', () => {
    const base = {
      currentA: 2,
      temperatureRiseC: 10,
      layer: 'external' as const,
      copperWeightOz: 1,
    };
    const oneOz = reviewTraceCurrent(base);
    const twoOz = reviewTraceCurrent({ ...base, copperWeightOz: 2 });
    const hotter = reviewTraceCurrent({ ...base, temperatureRiseC: 30 });
    expect(twoOz.estimatedMinimumWidthMm).toBeLessThan(oneOz.estimatedMinimumWidthMm!);
    expect(hotter.estimatedMinimumWidthMm).toBeLessThan(oneOz.estimatedMinimumWidthMm!);
  });

  it('never reports a pass even for generous caller-supplied route widths', () => {
    const result = reviewTraceCurrent({
      currentA: 1,
      temperatureRiseC: 30,
      copperWeightOz: 2,
      layer: 'external',
      traceWidthMm: 20,
      neckDownWidthMm: 15,
      manufacturerMinWidthMm: 0.1,
    });
    expect(result.status).toBe('UNKNOWN');
    expect(result.findings.every((finding) => finding.status === 'UNKNOWN')).toBe(true);
    expect(result.suppliedNarrowestWidthMm).toBe(15);
  });

  it('rejects invalid numeric inputs and model overflows instead of emitting non-finite estimates', () => {
    for (const input of [
      { currentA: Number.POSITIVE_INFINITY },
      { traceWidthMm: -1 },
      { copperWeightOz: 0 },
      { neckDownWidthMm: Number.NaN },
    ]) {
      expect(() => reviewTraceCurrent(input)).toThrow(/finite positive number/);
    }
    expect(() =>
      calculateTraceWidth({
        currentA: Number.POSITIVE_INFINITY,
        temperatureRiseC: 10,
        copperWeightOz: 1,
        layer: 'external',
      }),
    ).toThrow(/finite positive/);
    expect(() =>
      calculateMaxCurrent({
        traceWidthMils: Number.POSITIVE_INFINITY,
        temperatureRiseC: 10,
        copperWeightOz: 1,
        layer: 'external',
      }),
    ).toThrow(/finite positive/);
  });

  it('retains backward-compatible numerical results while adding auditable input metadata', () => {
    const input = {
      currentA: 1,
      temperatureRiseC: 10,
      layer: 'external' as const,
      copperWeightOz: 1,
    };
    const result = calculateTraceWidth(input);
    expect(result.traceWidthMils).toBeGreaterThan(11.5);
    expect(result.traceWidthMils).toBeLessThan(12.2);
    expect(result.inputs).toEqual(input);
    expect(result.method).toBe('IPC2221_EMPIRICAL_REFERENCE');
    expect(result.units.traceWidthMm).toBe('mm');
    expect(result.limitations).toEqual(
      expect.arrayContaining([expect.stringContaining('not measured')]),
    );
    const max = calculateMaxCurrent({
      traceWidthMils: result.traceWidthMils,
      temperatureRiseC: 10,
      layer: 'external',
      copperWeightOz: 1,
    });
    expect(max.maxCurrentA).toBeCloseTo(1, 1);
    expect(max.inputs.traceWidthMils).toBe(result.traceWidthMils);
    expect(max.units.maxCurrentA).toBe('A');
  });
});
