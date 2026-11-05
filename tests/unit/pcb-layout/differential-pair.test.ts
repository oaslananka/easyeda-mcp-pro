import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  reviewDifferentialPair,
  type DifferentialPairDeclaration,
} from '../../../src/pcb-layout/differential-pair.js';
import type { NativeTrack, NativeVia } from '../../../src/pcb-layout/route-review.js';

type Fixture = {
  id: string;
  tracks: NativeTrack[];
  vias: NativeVia[];
  declaration: DifferentialPairDeclaration;
  expected: {
    status: 'WARNING' | 'UNKNOWN';
    skew: string;
    spacing: string;
    positiveCoverage: string;
    negativeCoverage: string;
  };
};

const cases = JSON.parse(
  readFileSync(
    new URL('../../fixtures/engineering-review/differential-pair-cases.json', import.meta.url),
    'utf8',
  ),
) as Fixture[];

const a = (id: string, net: string, x1: number, y1: number, x2: number, y2: number) => ({
  primitiveId: id,
  net,
  layer: 1,
  startX: x1,
  startY: y1,
  endX: x2,
  endY: y2,
  width: 10,
});
const declared: DifferentialPairDeclaration = {
  positiveNet: 'P',
  negativeNet: 'N',
  protocol: 'custom',
};

describe('source-backed native differential-pair evidence', () => {
  it('has distinct deterministic fixture cases', () => {
    expect(cases.length).toBe(10);
    expect(new Set(cases.map((x) => x.id)).size).toBe(cases.length);
  });

  it.each(cases)('$id', ({ tracks, vias, declaration, expected }) => {
    const result = reviewDifferentialPair(declaration, tracks, vias, true);
    expect(result).toEqual(reviewDifferentialPair(declaration, tracks, vias, true));
    expect(result.status).toBe(expected.status);
    expect(result.skew.status).toBe(expected.skew);
    expect(result.spacing.status).toBe(expected.spacing);
    expect(result.paths.positive.coverage).toBe(expected.positiveCoverage);
    expect(result.paths.negative.coverage).toBe(expected.negativeCoverage);
    expect(result.nets).toEqual({
      positive: declaration.positiveNet,
      negative: declaration.negativeNet,
    });
    expect(result.evidence).toBe('native_segments_not_field_solver_or_full_route');
    expect(result.impedance_status).toBe('UNKNOWN');
    expect(result.engineering_sign_off).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: 'pair:return-path',
        status: 'UNKNOWN',
      }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: 'pair:impedance',
        status: 'UNKNOWN',
      }),
    );
    expect(result.findings.map((finding) => finding.status)).not.toContain('PASS');
  });

  it('observed geometric length and edge gap use native mil-to-mm conversion', () => {
    const r = reviewDifferentialPair(cases[0]!.declaration, cases[0]!.tracks, [], true);
    expect(r.paths.positive.observed_length_mm).toBeCloseTo(25.4, 5);
    expect(r.paths.negative.observed_length_mm).toBeCloseTo(25.908, 5);
    expect(r.skew.observed_mm).toBeCloseTo(0.508, 5);
    expect(r.spacing.observed_mm).toBeCloseTo(0.254, 5);
    expect(r.spacing.sample_count).toBe(1);
    expect(r.protocol_guidance?.differential_impedance_reference_ohms).toBe(90);
    expect(r.protocol_guidance?.source).toContain('USB');
  });

  it('protocol does not automatically impose a hard skew or spacing threshold', () => {
    const d: DifferentialPairDeclaration = {
      positiveNet: 'USB_D+',
      negativeNet: 'USB_D-',
      protocol: 'usb2',
    };
    const result = reviewDifferentialPair(d, cases[1]!.tracks, [], true);
    expect(result.skew.status).toBe('UNKNOWN');
    expect(result.spacing.status).toBe('UNKNOWN');
    expect(result.status).toBe('UNKNOWN');
    expect(result.skew.observed_mm).toBeCloseTo(2.54, 5);
    expect(result.target_impedance_ohms).toBeUndefined();
  });

  it('empty native primitive getAll cannot falsely establish a missing net', () => {
    const result = reviewDifferentialPair(declared, [], [], true);
    expect(result.paths.positive.coverage).toBe('UNAVAILABLE');
    expect(result.paths.negative.coverage).toBe('UNAVAILABLE');
    expect(result.status).toBe('UNKNOWN');
    expect(result.skew.status).toBe('UNKNOWN');
  });

  it('declared impedance is carried as provenance but is never calculated or approved', () => {
    const d = { ...declared, targetImpedanceOhms: 105, maxSkewMm: 0.5 };
    const result = reviewDifferentialPair(
      d,
      [a('p', 'P', 0, 0, 100, 0), a('n', 'N', 0, 20, 100, 20)],
      [],
      true,
    );
    expect(result.target_impedance_ohms).toBe(105);
    expect(result.protocol_guidance).toBeNull();
    expect(result.impedance_status).toBe('UNKNOWN');
    expect(result.skew.status).toBe('WITHIN_DECLARED_LIMIT_REFERENCE');
    expect(result.engineering_sign_off).toBe(false);
  });

  it('attributes device limits only to the exact caller-supplied source, never protocol guidance', () => {
    const input = {
      ...declared,
      maxSkewMm: 0.5,
      constraintSource: 'Demo device datasheet Rev C, Section 8.3',
    };
    const tracks = [a('p', 'P', 0, 0, 100, 0), a('n', 'N', 0, 20, 100, 20)];
    const sourced = reviewDifferentialPair(input, tracks, [], true);
    const unsourced = reviewDifferentialPair(
      { ...input, constraintSource: undefined },
      tracks,
      [],
      true,
    );
    expect(sourced.constraint_source).toBe('Demo device datasheet Rev C, Section 8.3');
    expect(unsourced.constraint_source).toBeNull();
    expect(sourced.protocol_guidance).toBeNull();
    expect(sourced.engineering_sign_off).toBe(false);
    expect(sourced.skew.status).toBe('WITHIN_DECLARED_LIMIT_REFERENCE');
    expect(sourced.limitations.join(' ')).toContain('remains unverified');
  });

  it('missing or truncated collections cannot fabricate a missing net or skew warning', () => {
    const input = cases[0]!;
    const result = reviewDifferentialPair(input.declaration, input.tracks.slice(0, 1), [], false);
    expect(result.paths.positive.coverage).toBe('UNAVAILABLE');
    expect(result.paths.negative.coverage).toBe('UNAVAILABLE');
    expect(result.status).toBe('UNKNOWN');
    expect(result.skew.status).toBe('UNKNOWN');
    expect(result.spacing.status).toBe('UNKNOWN');
  });

  it('connected nonbranching two-segment paths allow bounded length comparison', () => {
    const tracks = [
      a('p1', 'P', 0, 0, 100, 0),
      a('p2', 'P', 100, 0, 100, 100),
      a('n1', 'N', 0, 20, 200, 20),
    ];
    const result = reviewDifferentialPair({ ...declared, maxSkewMm: 0.01 }, tracks, [], true);
    expect(result.paths.positive.coverage).toBe('OBSERVED_SINGLE_CHAIN');
    expect(result.skew.status).toBe('WITHIN_DECLARED_LIMIT_REFERENCE');
    expect(result.paths.positive.observed_length_mm).toBeCloseTo(5.08, 5);
    expect(result.paths.negative.observed_length_mm).toBeCloseTo(5.08, 5);
  });

  it('disconnected segments, duplicate primitive identities or inconsistent layers are unknown', () => {
    const badCases = [
      [a('p1', 'P', 0, 0, 100, 0), a('p2', 'P', 200, 0, 300, 0)],
      [a('p1', 'P', 0, 0, 100, 0), a('p1', 'P', 100, 0, 200, 0)],
      [a('p1', 'P', 0, 0, 100, 0), { ...a('p2', 'P', 100, 0, 200, 0), layer: 2 }],
      [a('p1', 'P', 0, 0, 100, 0), { ...a('p2', 'P', 100, 0, 100, 0) }],
    ];
    for (const broken of badCases) {
      const result = reviewDifferentialPair(
        declared,
        [...broken, a('n1', 'N', 0, 20, 100, 20)],
        [],
        true,
      );
      expect(result.paths.positive.coverage).toBe('AMBIGUOUS');
      expect(result.skew.status).toBe('UNKNOWN');
    }
  });

  it('does not compare duplicate native track identities across the two declared nets', () => {
    const tracks = [a('reused', 'P', 0, 0, 100, 0), a('reused', 'N', 0, 20, 100, 20)];
    const result = reviewDifferentialPair(
      { ...declared, maxSkewMm: 0.1, minEdgeGapMm: 0.1 },
      tracks,
      [],
      true,
    );
    expect(result.paths.positive.coverage).toBe('AMBIGUOUS');
    expect(result.paths.negative.coverage).toBe('AMBIGUOUS');
    expect(result.skew.status).toBe('UNKNOWN');
    expect(result.spacing).toMatchObject({ status: 'UNKNOWN', sample_count: 0 });
    expect(result.skew.observed_mm).toBeUndefined();
    expect(result.spacing.observed_mm).toBeUndefined();
    expect(result.engineering_sign_off).toBe(false);
  });

  it('rejects padded native identities and invalid geometry from pair measurements', () => {
    const valid = a('n', 'N', 0, 20, 100, 20);
    for (const broken of [
      { ...a('p', 'P', 0, 0, 100, 0), primitiveId: ' p ' },
      { ...a('p', 'P', 0, 0, 100, 0), net: ' P ' },
      { ...a('p', 'P', 0, 0, 100, 0), endX: 1e308 },
      { ...a('p', 'P', 0, 0, 100, 0), width: 1e308 },
    ]) {
      const declaredNets = {
        ...declared,
        positiveNet: broken.net,
        maxSkewMm: 0.1,
        maxEdgeGapMm: 1,
      };
      const result = reviewDifferentialPair(declaredNets, [broken, valid], [], true);
      expect(result.paths.positive.coverage).not.toBe('OBSERVED_SINGLE_CHAIN');
      expect(result.skew.status).toBe('UNKNOWN');
      expect(result.spacing.status).toBe('UNKNOWN');
      expect(result.engineering_sign_off).toBe(false);
    }
  });

  it('does not trust duplicate via primitive identities when comparing pair paths', () => {
    const tracks = [a('p', 'P', 0, 0, 100, 0), a('n', 'N', 0, 20, 100, 20)];
    const vias: NativeVia[] = [
      { primitiveId: 'via-dup', net: 'OTHER', x: 10, y: 10, diameter: 30, holeDiameter: 10 },
      { primitiveId: 'via-dup', net: 'OTHER2', x: 20, y: 10, diameter: 30, holeDiameter: 10 },
    ];
    const result = reviewDifferentialPair(
      { ...declared, maxSkewMm: 0.1, minEdgeGapMm: 0.1 },
      tracks,
      vias,
      true,
    );
    expect(result.paths.positive.coverage).toBe('AMBIGUOUS');
    expect(result.paths.negative.coverage).toBe('AMBIGUOUS');
    expect(result.skew.status).toBe('UNKNOWN');
    expect(result.spacing.status).toBe('UNKNOWN');
  });

  it('does not treat a repeated or malformed declared net name as a differential pair', () => {
    const tracks = [a('p', 'P', 0, 0, 100, 0), a('n', 'N', 0, 20, 100, 20)];
    for (const names of [
      { positiveNet: 'P', negativeNet: 'P' },
      { positiveNet: ' P ', negativeNet: 'N' },
      { positiveNet: '', negativeNet: 'N' },
    ]) {
      const result = reviewDifferentialPair(
        { ...declared, ...names, maxSkewMm: 0.25, minEdgeGapMm: 0.15 },
        tracks,
        [],
        true,
      );
      expect(result.paths.positive.coverage).toBe('AMBIGUOUS');
      expect(result.paths.negative.coverage).toBe('AMBIGUOUS');
      expect(result.skew.status).toBe('UNKNOWN');
      expect(result.spacing.status).toBe('UNKNOWN');
      expect(result.engineering_sign_off).toBe(false);
    }
  });

  it('rejects invalid numeric skew and spacing declarations instead of a within-limit verdict', () => {
    const tracks = [a('p', 'P', 0, 0, 100, 0), a('n', 'N', 0, 20, 100, 20)];
    for (const maxSkewMm of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = reviewDifferentialPair({ ...declared, maxSkewMm }, tracks, [], true);
      expect(result.skew.status).toBe('UNKNOWN');
      expect(result.skew.declared_limit_mm).toBeUndefined();
      expect(result.skew.note).toMatch(/invalid/i);
    }
    for (const bounds of [
      { minEdgeGapMm: -0.1 },
      { minEdgeGapMm: Number.NaN },
      { maxEdgeGapMm: Number.POSITIVE_INFINITY },
      { minEdgeGapMm: 0.4, maxEdgeGapMm: 0.2 },
    ]) {
      const result = reviewDifferentialPair({ ...declared, ...bounds }, tracks, [], true);
      expect(result.spacing.status).toBe('UNKNOWN');
      expect(result.spacing.sample_count).toBe(0);
      expect(result.spacing.observed_mm).toBeUndefined();
      expect(result.spacing.note).toMatch(/invalid/i);
    }
  });

  it('nonparallel or nonoverlapping segments cannot manufacture spacing evidence', () => {
    const cases = [
      [a('p', 'P', 0, 0, 100, 0), a('n', 'N', 200, 20, 300, 20)],
      [a('p', 'P', 0, 0, 100, 0), a('n', 'N', 50, -50, 50, 50)],
      [a('p', 'P', 0, 0, 100, 0), { ...a('n', 'N', 0, 20, 100, 20), layer: 2 }],
    ];
    for (const tracks of cases) {
      const result = reviewDifferentialPair({ ...declared, minEdgeGapMm: 0.2 }, tracks, [], true);
      expect(result.spacing.status).toBe('UNKNOWN');
      expect(result.spacing.sample_count).toBe(0);
    }
  });

  it('explicit max-edge-spacing violation is a warning, not an impedance verdict', () => {
    const result = reviewDifferentialPair(
      { ...declared, maxEdgeGapMm: 0.1 },
      [a('p', 'P', 0, 0, 100, 0), a('n', 'N', 0, 20, 100, 20)],
      [],
      true,
    );
    expect(result.spacing.status).toBe('WARNING');
    expect(result.spacing.observed_max_mm).toBeCloseTo(0.254, 5);
    expect(result.status).toBe('WARNING');
    expect(result.impedance_status).toBe('UNKNOWN');
  });
});
