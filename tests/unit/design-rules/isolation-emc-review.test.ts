import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  reviewIsolationEmc,
  type IsolationEmcInput,
} from '../../../src/design-rules/isolation-emc-review.js';

type Fixture = {
  id: string;
  review: IsolationEmcInput;
  expected: {
    status: 'WARNING' | 'UNKNOWN';
    qualified: boolean;
    clearance: 'WARNING' | 'UNKNOWN';
    creepage: 'WARNING' | 'UNKNOWN';
    missing: string | null;
  };
};
const fixtures = JSON.parse(
  readFileSync(
    new URL('../../fixtures/engineering-review/isolation-emc-cases.json', import.meta.url),
    'utf8',
  ),
) as Fixture[];

describe('contextual isolation, creepage and ESD/EMC observations', () => {
  it('maintains independent explicit source scenarios without numeric standard tables', () => {
    expect(fixtures).toHaveLength(10);
    expect(new Set(fixtures.map((entry) => entry.id)).size).toBe(fixtures.length);
  });

  it.each(fixtures)('$id', ({ review, expected }) => {
    const result = reviewIsolationEmc(review);
    expect(result).toEqual(reviewIsolationEmc(review));
    expect(result.status).toBe(expected.status);
    expect(result.qualified_review_required).toBe(expected.qualified);
    expect(result.findings.find((f) => f.id === 'AIR_CLEARANCE')?.status).toBe(expected.clearance);
    expect(result.findings.find((f) => f.id === 'SURFACE_CREEPAGE')?.status).toBe(
      expected.creepage,
    );
    if (expected.missing) expect(result.context_missing.join(' ')).toContain(expected.missing);
    else expect(result.context_missing).toEqual([]);
    expect(result.safety_certification).toBe(false);
    expect(result.engineering_sign_off).toBe(false);
    expect(result.evidence).toBe('caller_supplied_unverified');
    expect(result.findings.every((f) => f.status === 'UNKNOWN' || f.status === 'WARNING')).toBe(
      true,
    );
  });

  it('fails closed on corrupt measurement and declared spacing limits', () => {
    const source = fixtures[1]!.review;
    const badMeasurements = [Number.NaN, Number.POSITIVE_INFINITY, -0.1];
    for (const distanceMm of badMeasurements) {
      const result = reviewIsolationEmc({
        ...source,
        airClearance: {
          distanceMm,
          evidenceRef: 'invalid native measurement',
          evidenceKind: 'measured_air_gap',
        },
      });
      const finding = result.findings.find((entry) => entry.id === 'AIR_CLEARANCE');
      expect(finding?.status).toBe('UNKNOWN');
      expect(finding?.missing).toContain('finite nonnegative geometry measurement');
      expect(finding?.message).not.toContain('meets its declared minimum');
      expect(finding?.reported_mm).toBeUndefined();
      expect(result.safety_certification).toBe(false);
    }
    for (const minimumMm of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const result = reviewIsolationEmc({
        ...source,
        clearanceRequirement: { ...source.clearanceRequirement!, minimumMm },
      });
      const finding = result.findings.find((entry) => entry.id === 'AIR_CLEARANCE');
      expect(finding?.status).toBe('UNKNOWN');
      expect(finding?.missing).toContain('finite nonnegative source-declared minimum');
      expect(finding?.message).not.toContain('meets its declared minimum');
      expect(finding?.declared_min_mm).toBeUndefined();
      expect(result.engineering_sign_off).toBe(false);
    }
  });

  it('never derives a creepage measurement from a through-air observation', () => {
    const review: IsolationEmcInput = {
      airClearance: {
        distanceMm: 1,
        evidenceRef: 'claimed air gap',
        evidenceKind: 'measured_air_gap',
      },
      creepageRequirement: {
        minimumMm: 2,
        reference: {
          identifier: 'IEC 60664-1',
          edition: '2020+AMD1:2025',
          clause: 'example requirement',
          source: 'caller declaration',
        },
      },
      surfaceCreepage: {
        distanceMm: 1,
        evidenceRef: 'same air path',
        evidenceKind: 'measured_air_gap',
      },
    };
    const result = reviewIsolationEmc(review);
    const surface = result.findings.find((f) => f.id === 'SURFACE_CREEPAGE');
    expect(surface?.status).toBe('UNKNOWN');
    expect(surface?.missing).toContain(
      'measured along-surface creepage path accounting for geometry and slots',
    );
    expect(result.findings.find((f) => f.id === 'AIR_CLEARANCE')?.status).toBe('UNKNOWN');
  });

  it('requires separate geometry evidence and source-declared minima for warnings', () => {
    const example = fixtures[1]!;
    const withoutRequirement = reviewIsolationEmc({
      ...example.review,
      clearanceRequirement: undefined,
    });
    expect(withoutRequirement.status).toBe('UNKNOWN');
    expect(withoutRequirement.findings[0]?.missing).toContain('source-declared minimum distance');
    const withoutGeometry = reviewIsolationEmc({
      ...example.review,
      airClearance: undefined,
    });
    expect(withoutGeometry.status).toBe('UNKNOWN');
    expect(withoutGeometry.findings[0]?.missing).toContain('geometry measurement');
    expect(withoutGeometry.qualified_review_required).toBe(true);
  });

  it('preserves ESD connector and return evidence limits, without asserting immunity test success', () => {
    const input = fixtures[4]!.review;
    const result = reviewIsolationEmc(input);
    const esd = result.findings.find((f) => f.id === 'ESD_ENTRY');
    expect(esd?.status).toBe('UNKNOWN');
    expect(esd?.missing).toContain('verified short ESD return path and actual copper geometry');
    expect(esd?.reference?.identifier).toBe('IEC 61000-4-2');
    expect(result.source_references).toContainEqual(
      expect.objectContaining({
        edition: '2025',
        identifier: 'IEC 61000-4-2',
      }),
    );
    expect(result.limitations.join(' ')).toContain('ESD advice does not establish');
  });

  it('does not treat an ESD return-path reference as IEC immunity measurement', () => {
    const input: IsolationEmcInput = {
      esdEntry: {
        connectorRef: 'J1',
        protectorRef: 'D1',
        entryNet: 'USB_D+',
        returnPathEvidence: 'Unverified hand-authored PCB description',
      },
    };
    const result = reviewIsolationEmc(input);
    expect(result.findings.find((f) => f.id === 'ESD_ENTRY')).toMatchObject({
      status: 'UNKNOWN',
      missing: [],
      evidence_refs: ['Unverified hand-authored PCB description'],
    });
    expect(result.safety_certification).toBe(false);
  });

  it('does not invent fast-loop or return-plane facts when description is missing', () => {
    const result = reviewIsolationEmc({ emcReturn: {} });
    expect(result.findings.find((f) => f.id === 'EMC_RETURN')).toMatchObject({
      status: 'UNKNOWN',
      evidence_refs: [],
    });
    expect(result.findings.find((f) => f.id === 'EMC_RETURN')?.missing).toHaveLength(3);
  });

  it('deduplicates identical source references but retains distinct clauses', () => {
    const source = {
      identifier: 'IEC 60664-1',
      edition: '2020+AMD1:2025',
      clause: 'hypothetical manufacturer check',
      source: 'Caller supplied edition reference',
    };
    const result = reviewIsolationEmc({
      safetyStandard: source,
      clearanceRequirement: { minimumMm: 1, reference: source },
      creepageRequirement: { minimumMm: 2, reference: { ...source, clause: 'another clause' } },
    });
    expect(result.source_references).toHaveLength(2);
    expect(result.source_references[0]).toEqual(source);
    expect(result.source_references[1]?.clause).toBe('another clause');
  });

  it('a non-safety functional board with complete context does not claim certified spacing', () => {
    const result = reviewIsolationEmc(fixtures[6]!.review);
    expect(result.status).toBe('UNKNOWN');
    expect(result.qualified_review_required).toBe(false);
    expect(result.findings.map((f) => f.id)).toEqual([
      'AIR_CLEARANCE',
      'SURFACE_CREEPAGE',
      'INSULATION_CONTEXT',
    ]);
    expect(result.findings.find((f) => f.id === 'AIR_CLEARANCE')?.reported_mm).toBe(0.4);
    expect(result.findings.find((f) => f.id === 'SURFACE_CREEPAGE')?.reported_mm).toBe(0.6);
    expect(result.safety_certification).toBe(false);
  });

  it('does not promote a PCB XY air-clearance estimate into measured safety evidence', () => {
    const standard = {
      identifier: 'IEC 60664-1',
      edition: '2020+AMD1:2025',
      clause: 'hypothetical sample',
      source: 'caller-declared requirement',
    };
    const result = reviewIsolationEmc({
      clearanceRequirement: { minimumMm: 2, reference: standard },
      airClearance: {
        distanceMm: 0.5,
        evidenceRef: 'PCB XY projection only',
        evidenceKind: 'estimated',
      },
    });
    expect(result.status).toBe('UNKNOWN');
    expect(result.findings.find((f) => f.id === 'AIR_CLEARANCE')?.missing).toContain(
      'measured through-air clearance between actual conductors',
    );
  });

  it('reports ESD connector without a protector or identified entry net as unverified', () => {
    const result = reviewIsolationEmc({ esdEntry: { connectorRef: 'J1' } });
    const finding = result.findings.find((f) => f.id === 'ESD_ENTRY');
    expect(finding?.status).toBe('UNKNOWN');
    expect(finding?.missing).toEqual([
      'declared ESD protection component',
      'connector entry net',
      'verified short ESD return path and actual copper geometry',
    ]);
    expect(result.safety_certification).toBe(false);
  });
});
