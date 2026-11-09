import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  reviewManufacturerProfile,
  type ManufacturerProfile,
} from '../../../src/pcb-constraints/manufacturing-profile-review.js';
import type { PcbConstraintInput } from '../../../src/pcb-constraints/types.js';

const ref = {
  manufacturer: 'EXAMPLE FACTORY (hypothetical)',
  process: 'Standard two-layer PCB assembly',
  revision: 'example-rev-A',
  source: 'Unverified caller-supplied process notes for testing',
};
type Case = {
  id: string;
  limits: ManufacturerProfile['limits'];
  boardData: PcbConstraintInput;
  expected: { status: 'WARNING' | 'UNKNOWN'; rule: string; comparison: string };
};
const examples = JSON.parse(
  readFileSync(
    new URL('../../fixtures/engineering-review/manufacturer-process-cases.json', import.meta.url),
    'utf8',
  ),
) as Case[];

describe('versioned manufacturer process observations (not fabrication approval)', () => {
  it('covers nine distinct bounded examples', () => {
    expect(examples).toHaveLength(11);
    expect(new Set(examples.map((x) => x.id)).size).toBe(examples.length);
  });

  it.each(examples)('$id', ({ boardData, limits, expected }) => {
    const input = { ...ref, limits };
    const result = reviewManufacturerProfile(input, boardData, 'caller_supplied_unverified');
    expect(result).toEqual(
      reviewManufacturerProfile(input, boardData, 'caller_supplied_unverified'),
    );
    expect(result.status).toBe(expected.status);
    expect(result.findings.find((x) => x.id === expected.rule)).toMatchObject({
      comparison: expected.comparison,
    });
    expect(result.fabrication_approval).toBe(false);
    expect(result.manual_review_required).toBe(true);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profile_reference: ref.source,
          profile_revision: ref.revision,
          measurement_evidence: expect.stringMatching(/^(caller_supplied_unverified|unavailable)$/),
        }),
      ]),
    );
    expect(result.source).toEqual({
      manufacturer: ref.manufacturer,
      process: ref.process,
      revision: ref.revision,
      reference: ref.source,
    });
    expect(result.findings.every((x) => x.status === 'WARNING' || x.status === 'UNKNOWN')).toBe(
      true,
    );
    expect(result.unknown_workflows.join(' ')).toMatch(/mounting-hole semantics/i);
  });

  it('attributes each observed metric to its own data evidence and the declared factory revision', () => {
    const profile = {
      ...ref,
      revision: 'hypothetical-process-rev-B',
      source: 'Manufacturer process limits: hypothetical issue #846 example',
      limits: { maximumBoardWidthMm: 80, minimumAnnularRingMm: 0.15 },
    };
    const review = reviewManufacturerProfile(
      profile,
      { widthMm: 100, hasOutline: true },
      'native_partial_unverified',
    );
    expect(review.status).toBe('WARNING');
    expect(review.findings).toEqual([
      expect.objectContaining({
        id: 'minimumAnnularRingMm',
        status: 'UNKNOWN',
        units: 'mm',
        profile_reference: profile.source,
        profile_revision: profile.revision,
        measurement_evidence: 'unavailable',
      }),
      expect.objectContaining({
        id: 'maximumBoardWidthMm',
        status: 'WARNING',
        units: 'mm',
        source_field: 'widthMm',
        actual: 100,
        profile_reference: profile.source,
        profile_revision: profile.revision,
        measurement_evidence: 'native_partial_unverified',
      }),
    ]);
    expect(review.findings[0]).not.toHaveProperty('actual');
    expect(review.fabrication_approval).toBe(false);
  });

  it('does not compare measurements against corrupt process limits', () => {
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const result = reviewManufacturerProfile(
        { ...ref, limits: { minimumFinishedDrillMm: invalid } },
        { minDrillMm: 0.1 },
        'caller_supplied_unverified',
      );
      const finding = result.findings[0];
      expect(finding?.comparison).toBe('UNKNOWN');
      expect(finding?.status).toBe('UNKNOWN');
      expect(finding?.reason).toContain('invalid');
      expect(result.fabrication_approval).toBe(false);
    }
    for (const invalid of [Number.NaN, 1.1, -0.1]) {
      const result = reviewManufacturerProfile(
        { ...ref, limits: { minimumPolarityMarkRatio: invalid } },
        { polarizedComponentCount: 2, polarityMarkCount: 1 },
        'caller_supplied_unverified',
      );
      expect(result.findings[0]?.comparison).toBe('UNKNOWN');
      expect(result.findings[0]?.reason).toContain('invalid');
      expect(result.fabrication_approval).toBe(false);
    }
  });

  it('does not call zero-sized board dimensions within a declared fabrication maximum', () => {
    const profile = { ...ref, limits: { maximumBoardWidthMm: 80, maximumBoardHeightMm: 60 } };
    for (const source of ['caller_supplied_unverified', 'native_partial_unverified'] as const) {
      const zero = reviewManufacturerProfile(
        profile,
        { widthMm: 0, heightMm: 0, hasOutline: true },
        source,
      );
      expect(zero.findings).toEqual([
        expect.objectContaining({
          id: 'maximumBoardWidthMm',
          comparison: 'UNKNOWN',
          status: 'UNKNOWN',
          measurement_evidence: 'unavailable',
        }),
        expect.objectContaining({
          id: 'maximumBoardHeightMm',
          comparison: 'UNKNOWN',
          status: 'UNKNOWN',
          measurement_evidence: 'unavailable',
        }),
      ]);
      expect(zero.findings.every((finding) => finding.actual === undefined)).toBe(true);
      expect(zero.fabrication_approval).toBe(false);
      expect(zero.manual_review_required).toBe(true);
    }
    const valid = reviewManufacturerProfile(
      profile,
      { widthMm: 50, heightMm: 40, hasOutline: true },
      'caller_supplied_unverified',
    );
    expect(valid.findings.map((finding) => finding.comparison)).toEqual([
      'WITHIN_DECLARED_LIMIT',
      'WITHIN_DECLARED_LIMIT',
    ]);
    expect(valid.fabrication_approval).toBe(false);
  });

  it('does not infer a drilled hole or factory violation from a zero diameter sentinel', () => {
    const profile = { ...ref, limits: { minimumFinishedDrillMm: 0.2 } };
    for (const source of ['native_partial_unverified', 'caller_supplied_unverified'] as const) {
      const report = reviewManufacturerProfile(profile, { minDrillMm: 0 }, source);
      expect(report.findings[0]).toMatchObject({
        id: 'minimumFinishedDrillMm',
        status: 'UNKNOWN',
        comparison: 'UNKNOWN',
        measurement_evidence: 'unavailable',
      });
      expect(report.findings[0]).not.toHaveProperty('actual');
      expect(report.fabrication_approval).toBe(false);
    }
    const measured = reviewManufacturerProfile(
      profile,
      { minDrillMm: 0.1 },
      'native_partial_unverified',
    );
    expect(measured.findings[0]).toMatchObject({
      status: 'WARNING',
      comparison: 'BELOW_DECLARED_LIMIT',
      actual: 0.1,
    });
  });

  it('compares caller-sourced trace width and signed copper gap without a fabricated DFM pass', () => {
    const profile = {
      ...ref,
      limits: { minimumTraceWidthMm: 0.15, minimumTrackGapMm: 0.16 },
    };
    const under = reviewManufacturerProfile(
      profile,
      { minObservedTraceWidthMm: 0.12, minObservedCopperGapMm: -0.08 },
      'caller_supplied_unverified',
    );
    expect(under.status).toBe('WARNING');
    expect(under.findings).toEqual([
      expect.objectContaining({
        id: 'minimumTraceWidthMm',
        source_field: 'minObservedTraceWidthMm',
        status: 'WARNING',
        actual: 0.12,
        comparison: 'BELOW_DECLARED_LIMIT',
        measurement_evidence: 'caller_supplied_unverified',
      }),
      expect.objectContaining({
        id: 'minimumTrackGapMm',
        source_field: 'minObservedCopperGapMm',
        status: 'WARNING',
        actual: -0.08,
        comparison: 'BELOW_DECLARED_LIMIT',
        measurement_evidence: 'caller_supplied_unverified',
      }),
    ]);
    expect(under.limitations.join(' ')).toMatch(/complete native trace inventory/);
    expect(under.fabrication_approval).toBe(false);

    const within = reviewManufacturerProfile(
      profile,
      { minObservedTraceWidthMm: 0.2, minObservedCopperGapMm: 0.25 },
      'caller_supplied_unverified',
    );
    expect(within.status).toBe('UNKNOWN');
    expect(within.findings).toEqual([
      expect.objectContaining({ comparison: 'WITHIN_DECLARED_LIMIT', status: 'UNKNOWN' }),
      expect.objectContaining({ comparison: 'WITHIN_DECLARED_LIMIT', status: 'UNKNOWN' }),
    ]);
    expect(within.fabrication_approval).toBe(false);
  });

  it('fails closed when a track/space minimum is missing, malformed, or not native-sourced', () => {
    const profile = {
      ...ref,
      limits: { minimumTraceWidthMm: 0.15, minimumTrackGapMm: 0.15 },
    };
    const missing = reviewManufacturerProfile(profile, {}, 'native_partial_unverified');
    expect(missing.status).toBe('UNKNOWN');
    expect(missing.findings).toEqual([
      expect.objectContaining({
        id: 'minimumTraceWidthMm',
        comparison: 'UNKNOWN',
        measurement_evidence: 'unavailable',
      }),
      expect.objectContaining({
        id: 'minimumTrackGapMm',
        comparison: 'UNKNOWN',
        measurement_evidence: 'unavailable',
      }),
    ]);
    expect(missing.findings.every((f) => f.actual === undefined)).toBe(true);

    for (const candidate of [Number.NaN, Number.POSITIVE_INFINITY, -10001]) {
      const review = reviewManufacturerProfile(
        profile,
        { minObservedTraceWidthMm: -1, minObservedCopperGapMm: candidate },
        'caller_supplied_unverified',
      );
      expect(review.findings.map((f) => f.comparison)).toEqual(['UNKNOWN', 'UNKNOWN']);
      expect(review.findings.every((f) => f.actual === undefined)).toBe(true);
    }

    const corruptLimit = reviewManufacturerProfile(
      { ...profile, limits: { minimumTrackGapMm: Number.NaN } },
      { minObservedCopperGapMm: -0.1 },
      'caller_supplied_unverified',
    );
    expect(corruptLimit.findings[0]).toMatchObject({
      status: 'UNKNOWN',
      comparison: 'UNKNOWN',
    });
    expect(corruptLimit.findings[0]?.reason).toMatch(/invalid/i);
  });

  it('refuses testpoint coverage from casefold-ambiguous native net names', () => {
    const profile = { ...ref, limits: { minimumCriticalNetTestpointRatio: 0.5 } };
    for (const names of [
      ['IO', 'io'],
      ['VCC', 'vcc', 'GND'],
    ]) {
      const review = reviewManufacturerProfile(
        profile,
        { criticalNetNames: ['IO', 'GND'], testPointNets: names },
        'caller_supplied_unverified',
      );
      expect(review.findings[0]).toMatchObject({
        status: 'UNKNOWN',
        comparison: 'UNKNOWN',
        measurement_evidence: 'unavailable',
      });
      expect(review.findings[0]?.actual).toBeUndefined();
    }
    const repeatedExact = reviewManufacturerProfile(
      profile,
      { criticalNetNames: ['IO', 'GND'], testPointNets: ['IO', 'IO', 'GND'] },
      'caller_supplied_unverified',
    );
    expect(repeatedExact.findings[0]).toMatchObject({
      status: 'UNKNOWN',
      comparison: 'WITHIN_DECLARED_LIMIT',
      actual: 1,
    });
  });

  it('explicitly distinguishes process violations from within-declared bounds', () => {
    const result = reviewManufacturerProfile(
      {
        ...ref,
        limits: { minimumFinishedDrillMm: 0.2, maximumBoardWidthMm: 80, minimumFiducialCount: 2 },
      },
      { minDrillMm: 0.1, widthMm: 50, fiducialCount: 2, hasOutline: true },
      'native_partial_unverified',
    );
    expect(result.status).toBe('WARNING');
    expect(result.input_evidence).toBe('native_partial_unverified');
    expect(result.findings.map((x) => x.comparison)).toEqual([
      'BELOW_DECLARED_LIMIT',
      'WITHIN_DECLARED_LIMIT',
      'WITHIN_DECLARED_LIMIT',
    ]);
    expect(result.findings.map((x) => x.units)).toEqual(['mm', 'mm', 'count']);
  });

  it('never turns absent or nonfinite native measurements into zero values', () => {
    const result = reviewManufacturerProfile(
      {
        ...ref,
        limits: {
          minimumFinishedDrillMm: 0.3,
          minimumToolingHoleCount: 2,
          minimumAnnularRingMm: 0.1,
        },
      },
      { minDrillMm: NaN, toolingHoleCount: undefined },
      'native_partial_unverified',
    );
    expect(result.status).toBe('UNKNOWN');
    expect(result.findings.every((x) => x.comparison === 'UNKNOWN')).toBe(true);
    expect(result.findings.every((x) => x.actual === undefined)).toBe(true);
  });

  it('treats unverified native outline status as unknown even with numeric canvas extents', () => {
    const profile = {
      ...ref,
      limits: {
        maximumBoardWidthMm: 20,
        maximumBoardHeightMm: 20,
        minimumFinishedDrillMm: 0.3,
      },
    };
    const data: PcbConstraintInput = { widthMm: 50, heightMm: 40, minDrillMm: 0.2 };
    const native = reviewManufacturerProfile(profile, data, 'native_partial_unverified');
    expect(native.findings[0]).toMatchObject({
      id: 'minimumFinishedDrillMm',
      status: 'WARNING',
      actual: 0.2,
      measurement_evidence: 'native_partial_unverified',
    });
    for (const finding of native.findings.slice(1)) {
      expect(finding).toMatchObject({
        status: 'UNKNOWN',
        comparison: 'UNKNOWN',
        measurement_evidence: 'unavailable',
      });
      expect(finding).not.toHaveProperty('actual');
      expect(finding.reason).toMatch(/outline.*unverified/i);
    }
    expect(native.fabrication_approval).toBe(false);

    // A caller's own dimensional declaration retains prior comparison behavior,
    // but is still not a confirmed manufacturing approval.
    const supplied = reviewManufacturerProfile(profile, data, 'caller_supplied_unverified');
    expect(supplied.findings.slice(1).map((finding) => finding.comparison)).toEqual([
      'ABOVE_DECLARED_LIMIT',
      'ABOVE_DECLARED_LIMIT',
    ]);
    expect(supplied.fabrication_approval).toBe(false);
  });

  it('does not compare canvas extents as manufactured dimensions without a board outline', () => {
    const profile = {
      ...ref,
      limits: {
        maximumBoardWidthMm: 100,
        maximumBoardHeightMm: 50,
        minimumFinishedDrillMm: 0.3,
      },
    };
    const result = reviewManufacturerProfile(
      profile,
      { hasOutline: false, widthMm: 60, heightMm: 40, minDrillMm: 0.2 },
      'native_partial_unverified',
    );
    const [drill, width, height] = result.findings;
    expect(drill).toMatchObject({
      id: 'minimumFinishedDrillMm',
      status: 'WARNING',
      actual: 0.2,
      measurement_evidence: 'native_partial_unverified',
    });
    for (const measurement of [width, height]) {
      expect(measurement).toMatchObject({
        status: 'UNKNOWN',
        comparison: 'UNKNOWN',
        measurement_evidence: 'unavailable',
      });
      expect(measurement).not.toHaveProperty('actual');
      expect(measurement?.reason).toContain('board outline is explicitly absent');
    }
    expect(result.fabrication_approval).toBe(false);
    expect(result.manual_review_required).toBe(true);

    const withOutline = reviewManufacturerProfile(
      profile,
      { hasOutline: true, widthMm: 60, heightMm: 40, minDrillMm: 0.2 },
      'native_partial_unverified',
    );
    expect(withOutline.findings[1]).toMatchObject({
      comparison: 'WITHIN_DECLARED_LIMIT',
      actual: 60,
    });
    expect(withOutline.findings[2]).toMatchObject({
      comparison: 'WITHIN_DECLARED_LIMIT',
      actual: 40,
    });
    expect(withOutline.fabrication_approval).toBe(false);
  });

  it('does not claim critical-net completeness with duplicates or blank inventories', () => {
    const input = { ...ref, limits: { minimumCriticalNetTestpointRatio: 0.5 } };
    for (const boardData of [
      { criticalNetNames: [], testPointNets: [] },
      { criticalNetNames: ['GND', 'gnd'], testPointNets: ['GND'] },
      { criticalNetNames: ['GND'] },
      { testPointNets: ['GND'] },
    ]) {
      const result = reviewManufacturerProfile(input, boardData, 'caller_supplied_unverified');
      expect(result.status).toBe('UNKNOWN');
      expect(result.findings[0]?.actual).toBeUndefined();
    }
  });

  it('counts only exact critical net identity, never a case-folded test-point match', () => {
    const profile = { ...ref, limits: { minimumCriticalNetTestpointRatio: 0.75 } };
    const mismatch = reviewManufacturerProfile(
      profile,
      { criticalNetNames: ['IO', 'GND'], testPointNets: ['io', 'GND'] },
      'caller_supplied_unverified',
    );
    expect(mismatch.findings[0]).toMatchObject({
      id: 'minimumCriticalNetTestpointRatio',
      actual: 0.5,
      status: 'WARNING',
      comparison: 'BELOW_DECLARED_LIMIT',
      measurement_evidence: 'caller_supplied_unverified',
    });
    expect(mismatch.fabrication_approval).toBe(false);

    const exact = reviewManufacturerProfile(
      profile,
      { criticalNetNames: ['IO', 'GND'], testPointNets: ['IO', 'GND', 'GND'] },
      'caller_supplied_unverified',
    );
    expect(exact.findings[0]).toMatchObject({
      actual: 1,
      status: 'UNKNOWN',
      comparison: 'WITHIN_DECLARED_LIMIT',
    });
  });

  it('fails closed for blank, whitespace-padded and colliding declared net names', () => {
    const profile = { ...ref, limits: { minimumCriticalNetTestpointRatio: 0.8 } };
    const cases: PcbConstraintInput[] = [
      { criticalNetNames: ['IO '], testPointNets: ['IO'] },
      { criticalNetNames: ['IO'], testPointNets: [' IO'] },
      { criticalNetNames: ['IO', ''], testPointNets: ['IO'] },
      { criticalNetNames: ['IO'], testPointNets: [''] },
      { criticalNetNames: ['IO', 'io'], testPointNets: ['IO'] },
    ];
    for (const board of cases) {
      const result = reviewManufacturerProfile(profile, board, 'caller_supplied_unverified');
      expect(result.findings[0]).toMatchObject({
        status: 'UNKNOWN',
        comparison: 'UNKNOWN',
        measurement_evidence: 'unavailable',
      });
      expect(result.findings[0]).not.toHaveProperty('actual');
      expect(result.fabrication_approval).toBe(false);
    }
  });

  it('does not infer good assembly access from merely asserted programming header', () => {
    const result = reviewManufacturerProfile(
      {
        ...ref,
        limits: { requireProgrammingHeader: true },
      },
      { hasProgrammingHeader: true },
      'caller_supplied_unverified',
    );
    expect(result.status).toBe('UNKNOWN');
    expect(result.findings[0]).toMatchObject({
      comparison: 'WITHIN_DECLARED_LIMIT',
      actual: true,
      status: 'UNKNOWN',
    });
    expect(result.unknown_workflows.join(' ')).toContain('programming pin continuity');
  });

  it('reports incomplete ratio evidence instead of impossible percentages', () => {
    const result = reviewManufacturerProfile(
      {
        ...ref,
        limits: { minimumPolarityMarkRatio: 1 },
      },
      { polarizedComponentCount: 1, polarityMarkCount: 2 },
      'caller_supplied_unverified',
    );
    expect(result.status).toBe('UNKNOWN');
    expect(result.findings[0]?.comparison).toBe('UNKNOWN');
    expect(result.findings[0]?.actual).toBeUndefined();
  });

  it('reports full explicit polarity coverage as within-declared but not approved', () => {
    const review = reviewManufacturerProfile(
      {
        ...ref,
        limits: { minimumPolarityMarkRatio: 0.75 },
      },
      { polarizedComponentCount: 4, polarityMarkCount: 4 },
      'caller_supplied_unverified',
    );
    expect(review.status).toBe('UNKNOWN');
    expect(review.findings[0]).toMatchObject({
      status: 'UNKNOWN',
      actual: 1,
      comparison: 'WITHIN_DECLARED_LIMIT',
    });
    expect(review.fabrication_approval).toBe(false);
  });

  it('reports explicit critical-net testpoint coverage within bounds without claiming physical access', () => {
    const review = reviewManufacturerProfile(
      {
        ...ref,
        limits: { minimumCriticalNetTestpointRatio: 0.5 },
      },
      { criticalNetNames: ['GND', '3V3'], testPointNets: ['GND', '3V3'] },
      'caller_supplied_unverified',
    );
    expect(review.findings[0]).toMatchObject({
      status: 'UNKNOWN',
      actual: 1,
      comparison: 'WITHIN_DECLARED_LIMIT',
    });
    expect(review.unknown_workflows.join(' ')).toMatch(/Testpoint accessibility/);
  });
});
