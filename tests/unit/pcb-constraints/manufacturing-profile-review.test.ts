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
      { widthMm: 100 },
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

  it('explicitly distinguishes process violations from within-declared bounds', () => {
    const result = reviewManufacturerProfile(
      {
        ...ref,
        limits: { minimumFinishedDrillMm: 0.2, maximumBoardWidthMm: 80, minimumFiducialCount: 2 },
      },
      { minDrillMm: 0.1, widthMm: 50, fiducialCount: 2 },
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
