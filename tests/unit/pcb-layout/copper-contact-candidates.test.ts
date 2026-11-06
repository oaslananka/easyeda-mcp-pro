import { describe, expect, it } from 'vitest';
import { reviewCopperPadCenterCandidates } from '../../../src/pcb-layout/copper-contact-candidates.js';

const rectangle = [[0, 0, 'L', 100, 0, 100, 100, 0, 100]] as const;
const pad = (id: string, x: number, y: number, patch: Record<string, unknown> = {}) => ({
  primitiveId: id,
  x,
  y,
  layer: 12,
  net: 'GND',
  pad: ['ELLIPSE', 10, 10],
  metallization: true,
  heatWelding: null,
  ...patch,
});

function review(patch: Partial<Parameters<typeof reviewCopperPadCenterCandidates>[0]> = {}) {
  return reviewCopperPadCenterCandidates({
    pourNet: 'GND',
    pourLayer: 1,
    pouredRegions: [{ fill: true, path: { complexPolygon: rectangle } }],
    pads: [pad('g1', 25, -25), pad('g2', 75, -75)],
    transform: { scale: 1, invertY: true, source: 'native-fixture-calibrated' },
    ...patch,
  });
}

describe('read-only native copper pad center candidates', () => {
  it('requires explicit sourced coordinate conversion; never guesses X or Y units', () => {
    const result = review({ transform: undefined });
    expect(result.candidates).toEqual([]);
    expect(result.pads.every((item) => item.status === 'UNKNOWN')).toBe(true);
    expect(result.diagnostics).toContain('UNVERIFIED_COORDINATE_TRANSFORM');
    expect(result.engineering_sign_off).toBe(false);
  });

  it('detects center candidates only after supplied SVG/native coordinate mapping', () => {
    const result = review();
    expect(result.candidates.map((candidate) => candidate.primitiveId)).toEqual(['g1', 'g2']);
    expect(result.overall_status).toBe('UNKNOWN');
    expect(result.engineering_sign_off).toBe(false);
    expect(result.candidates.every((c) => c.status === 'CENTER_OVERLAP_CANDIDATE')).toBe(true);
  });

  it('supports source-versus-pad scale mismatches without inventing a default conversion', () => {
    const result = review({
      transform: { scale: 0.1, invertY: false, source: 'calibrated-native-PRO-api' },
      pads: [pad('scaled', 500, 500)],
    });
    expect(result.candidates.map((c) => c.primitiveId)).toEqual(['scaled']);
  });

  it('respects inner copper holes via even-odd parity', () => {
    const result = review({
      pouredRegions: [
        {
          fill: true,
          path: {
            complexPolygon: [rectangle[0], [40, 40, 'L', 60, 40, 60, 60, 40, 60]],
          },
        },
      ],
      pads: [pad('in-hole', 50, -50), pad('surrounding', 20, -50)],
    });
    expect(result.candidates.map((item) => item.primitiveId)).toEqual(['surrounding']);
    expect(result.pads.find((item) => item.primitiveId === 'in-hole')).toMatchObject({
      status: 'UNKNOWN',
      reason: 'CENTER_NOT_INSIDE_FILLED_POLYGON',
    });
  });

  it('discretizes supported ARC sweeps as geometry candidates without electrical sign-off', () => {
    const semicircle = [[0, 0, 'ARC', 180, 20, 0, 'L', 0, 0]];
    const result = review({
      pouredRegions: [{ fill: true, path: { complexPolygon: semicircle } }],
      pads: [pad('arc-region', 10, 5), pad('far', 70, -70)],
      transform: { scale: 1, invertY: true, source: 'verified-arc-coordinate-system' },
    });
    expect(result.diagnostics).not.toContain('UNSUPPORTED_POLYGON_SOURCE');
    expect(result.candidates.map((candidate) => candidate.primitiveId)).toEqual(['arc-region']);
    expect(result.pads).toHaveLength(2);
    expect(result.engineering_sign_off).toBe(false);
  });

  it('does not confuse multiple filled copper regions with a single even-odd cutout graph', () => {
    const result = review({
      pouredRegions: [
        { fill: true, path: { complexPolygon: rectangle } },
        { fill: true, path: { complexPolygon: rectangle } },
      ],
    });
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics).toContain('UNSUPPORTED_POLYGON_SOURCE');
  });

  it('rejects duplicate native pad IDs and impossible copper layer identities', () => {
    const duplicates = review({ pads: [pad('same', 20, -20), pad('same', 30, -30)] });
    expect(duplicates.candidates).toEqual([]);
    expect(duplicates.pads.every((p) => p.reason === 'DUPLICATE_PAD_ID')).toBe(true);

    const layer = review({ pourLayer: 71 });
    expect(layer.candidates).toEqual([]);
    expect(layer.diagnostics).toContain('UNVERIFIED_POUR_IDENTITY');
  });

  it('never counts fill=false subdivisions as conductive copper', () => {
    const result = review({
      pouredRegions: [
        { fill: false, path: { complexPolygon: rectangle } },
        { fill: false, path: { complexPolygon: rectangle } },
      ],
    });
    expect(result.filledRegionCount).toBe(0);
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics).toContain('NO_NATIVE_FILLED_REGIONS');
  });

  it('fails closed on unsupported curve commands, truncated data and malformed contours', () => {
    for (const source of [
      [[0, 0, 'C', 10, 10, 20, 20, 30, 30]],
      [['[MaxDepth]']],
      [[0, 0, 'ARC', 0, 30, 30]],
      Array.from({ length: 260 }, () => [0, 0, 'L', 10, 10, 0, 10]),
    ]) {
      const result = review({ pouredRegions: [{ fill: true, path: { complexPolygon: source } }] });
      expect(result.candidates).toEqual([]);
      expect(result.diagnostics).toContain('UNSUPPORTED_POLYGON_SOURCE');
      expect(result.overall_status).toBe('UNKNOWN');
    }
  });

  it('withholds candidates for missing native pad shape, other nets and unknown layers', () => {
    const result = review({
      pads: [
        pad('shape-unknown', 25, -25, { pad: undefined }),
        pad('other-net', 25, -25, { net: 'VCC' }),
        pad('other-layer', 25, -25, { layer: 71 }),
        pad('unplated', 25, -25, { metallization: false }),
        pad('thermal-unverified', 25, -25, { heatWelding: { spokes: 4 } }),
        pad('good', 25, -25),
      ],
    });
    expect(result.candidates.map((item) => item.primitiveId)).toEqual(['good']);
    expect(
      result.pads.every(
        (item) => item.status === 'UNKNOWN' || item.status === 'CENTER_OVERLAP_CANDIDATE',
      ),
    ).toBe(true);
  });
});
