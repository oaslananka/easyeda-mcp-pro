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

  it('withholds candidates at centers inside native declared inner contours', () => {
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
      reason: 'CENTER_IN_DECLARED_INNER_CONTOUR',
    });
  });

  it('withholds candidates in overlapping declared contours under unverified nonzero winding', () => {
    // EasyEDA complexPolygon: first contour is outer, EVERY following contour
    // is declared inner. Native nonzero winding may refill overlaps; do not infer copper.
    const result = review({
      pouredRegions: [
        {
          fill: true,
          path: {
            complexPolygon: [
              rectangle[0],
              [30, 30, 'L', 70, 30, 70, 70, 30, 70],
              [40, 40, 'L', 80, 40, 80, 80, 40, 80],
            ],
          },
        },
      ],
      pads: [
        pad('overlap-of-holes', 50, -50),
        pad('in-first-only', 35, -35),
        pad('in-second-only', 75, -75),
        pad('real-copper', 15, -15),
      ],
    });
    expect(result.candidates.map((item) => item.primitiveId)).toEqual(['real-copper']);
    expect(result.pads.slice(0, 3).map((item) => item.reason)).toEqual([
      'CENTER_IN_DECLARED_INNER_CONTOUR',
      'CENTER_IN_DECLARED_INNER_CONTOUR',
      'CENTER_IN_DECLARED_INNER_CONTOUR',
    ]);
    expect(result.engineering_sign_off).toBe(false);
    expect(result.diagnostics).toContain('NONZERO_FILL_RULE_NOT_INDEPENDENTLY_VALIDATED');
  });

  it('returns UNKNOWN within nested native inner contours even if nonzero may fill', () => {
    const result = review({
      pouredRegions: [
        {
          fill: true,
          path: {
            complexPolygon: [
              rectangle[0],
              [20, 20, 'L', 80, 20, 80, 80, 20, 80],
              [35, 35, 'L', 65, 35, 65, 65, 35, 65],
            ],
          },
        },
      ],
      pads: [pad('nested-hole', 50, -50)],
    });
    expect(result.candidates).toEqual([]);
    expect(result.pads[0]).toMatchObject({
      status: 'UNKNOWN',
      reason: 'CENTER_IN_DECLARED_INNER_CONTOUR',
    });
  });

  it('does not claim a center exactly on a native outer or hole boundary is inside copper', () => {
    const result = review({
      pouredRegions: [
        {
          fill: true,
          path: { complexPolygon: [rectangle[0], [40, 40, 'L', 60, 40, 60, 60, 40, 60]] },
        },
      ],
      pads: [
        pad('on-outer-top', 50, 0),
        pad('on-outer-right', 100, -20),
        pad('on-hole-left', 40, -50),
        pad('on-hole-top', 50, -40),
        pad('clear-copper', 20, -20),
      ],
    });
    expect(result.candidates.map((item) => item.primitiveId)).toEqual(['clear-copper']);
    expect(
      result.pads.slice(0, 4).every((item) => item.reason === 'CENTER_ON_NATIVE_COPPER_BOUNDARY'),
    ).toBe(true);
    expect(result.overall_status).toBe('UNKNOWN');
    expect(result.engineering_sign_off).toBe(false);
  });

  it('separates a known inner cutout from a pad center outside the pour boundary', () => {
    const result = review({
      pouredRegions: [
        {
          fill: true,
          path: {
            complexPolygon: [rectangle[0], [40, 40, 'L', 60, 40, 60, 60, 40, 60]],
          },
        },
      ],
      pads: [
        pad('center-in-cutout', 50, -50),
        pad('outside-outer', 120, -20),
        pad('inside-copper', 20, -20),
      ],
    });
    expect(result.pads).toEqual([
      {
        primitiveId: 'center-in-cutout',
        status: 'UNKNOWN',
        reason: 'CENTER_IN_DECLARED_INNER_CONTOUR',
      },
      {
        primitiveId: 'outside-outer',
        status: 'UNKNOWN',
        reason: 'CENTER_NOT_INSIDE_FILLED_POLYGON',
      },
      {
        primitiveId: 'inside-copper',
        status: 'CENTER_OVERLAP_CANDIDATE',
        reason: 'NOT_ELECTRICAL_CONTACT_PROOF',
      },
    ]);
    expect(result.candidates.map((item) => item.primitiveId)).toEqual(['inside-copper']);
    expect(result.overall_status).toBe('UNKNOWN');
    expect(result.engineering_sign_off).toBe(false);
  });

  it('treats a curved native ARC inner contour as a cutout, not an electrical disconnection', () => {
    const circle = [40, 50, 'ARC', 180, 60, 50, 'ARC', 180, 40, 50];
    const result = review({
      pouredRegions: [{ fill: true, path: { complexPolygon: [rectangle[0], circle] } }],
      pads: [pad('arc-hole', 50, -50), pad('filled-area', 20, -20)],
    });
    expect(result.pads).toEqual([
      {
        primitiveId: 'arc-hole',
        status: 'UNKNOWN',
        reason: 'CENTER_IN_DECLARED_INNER_CONTOUR',
      },
      {
        primitiveId: 'filled-area',
        status: 'CENTER_OVERLAP_CANDIDATE',
        reason: 'NOT_ELECTRICAL_CONTACT_PROOF',
      },
    ]);
    expect(result.engineering_sign_off).toBe(false);
    expect(result.overall_status).toBe('UNKNOWN');
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

  it('rejects missing, oversized and malformed native region collections', () => {
    const invalid = [
      null,
      Array.from({ length: 257 }, () => ({ fill: false })),
      [null],
      [{ fill: 'true', path: { complexPolygon: rectangle } }],
      [{ fill: true }],
      [{ fill: true, path: { complexPolygon: [] } }],
      [{ fill: true, path: { complexPolygon: [rectangle[0], null] } }],
      [{ fill: true, path: { complexPolygon: [rectangle[0], '[MaxDepth]'] } }],
    ];
    for (const pouredRegions of invalid) {
      const result = review({ pouredRegions });
      expect(result.diagnostics).toContain('UNSUPPORTED_POLYGON_SOURCE');
      expect(result.candidates).toEqual([]);
      expect(result.engineering_sign_off).toBe(false);
    }
  });

  it('rejects truncated coordinates, nonfinite points and missing line segments', () => {
    const invalidContours = [
      [NaN, 0, 'L', 10, 0, 10, 10],
      [0, 0, 'L', 10, 0, NaN, 10],
      [0, 0, 'L', 10, 0, Infinity, 10],
      [0, 0, 'L', 10],
      [0, 0, 'L', 'ARC', 90, 10, 10],
      [0, 0, 'L', 10, 0],
      [0, 0, 'L', 10, 0, 10, 10, 'ARC', 180],
    ];
    for (const contour of invalidContours) {
      const result = review({
        pouredRegions: [{ fill: true, path: { complexPolygon: [contour] } }],
      });
      expect(result.diagnostics).toContain('UNSUPPORTED_POLYGON_SOURCE');
      expect(result.candidates).toEqual([]);
    }
  });

  it('rejects arc sweeps that cannot define a bounded finite circular segment', () => {
    for (const [sweep, endX, endY] of [
      [Infinity, 20, 0],
      [NaN, 20, 0],
      [0, 20, 0],
      [360, 20, 0],
      [-360, 20, 0],
      [180, 0, 0],
      [180, Infinity, 0],
    ]) {
      const result = review({
        pouredRegions: [
          { fill: true, path: { complexPolygon: [[0, 0, 'ARC', sweep, endX, endY, 'L', 0, 0]] } },
        ],
      });
      expect(result.diagnostics).toContain('UNSUPPORTED_POLYGON_SOURCE');
      expect(result.candidates).toEqual([]);
    }
  });

  it('fails closed if curved contours would exceed the bounded discretization budget', () => {
    const arcs = Array.from({ length: 1200 }, (_, i) => [
      'ARC',
      180,
      i % 2 === 0 ? 20 : 0,
      0,
    ]).flat();
    const result = review({
      pouredRegions: [{ fill: true, path: { complexPolygon: [[0, 0, ...arcs]] } }],
    });
    expect(result.diagnostics).toContain('UNSUPPORTED_POLYGON_SOURCE');
    expect(result.candidates).toEqual([]);
  });

  it('rejects a combined polygon token budget even if individual rings are small enough', () => {
    const line = [0, 0, 'L', ...Array.from({ length: 15_000 }, (_, i) => (i % 2 === 0 ? i : 10))];
    const result = review({
      pouredRegions: [{ fill: true, path: { complexPolygon: [line, line] } }],
    });
    expect(result.diagnostics).toContain('UNSUPPORTED_POLYGON_SOURCE');
    expect(result.candidates).toEqual([]);
  });

  it('returns UNKNOWN for unavailable, malformed and oversized native pad inventories', () => {
    for (const pads of [
      null,
      'bad',
      Array.from({ length: 257 }, (_, i) => pad(String(i), 1, -1)),
    ]) {
      const result = review({ pads });
      expect(result.diagnostics).toContain('INVALID_OR_OVERSIZED_PAD_COLLECTION');
      expect(result.pads).toEqual([]);
      expect(result.candidates).toEqual([]);
    }
  });

  it('rejects missing source net and invalid copper-layer identities', () => {
    for (const pourNet of ['', ' GND', 'GND ']) {
      const result = review({ pourNet });
      expect(result.diagnostics).toContain('UNVERIFIED_POUR_IDENTITY');
      expect(result.candidates).toEqual([]);
    }
    for (const pourLayer of [-1, NaN, 0, 71]) {
      const result = review({ pourLayer });
      expect(result.diagnostics).toContain('UNVERIFIED_POUR_IDENTITY');
      expect(result.candidates).toEqual([]);
    }
  });

  it('rejects malformed coordinate transforms instead of guessing a conversion', () => {
    for (const transform of [
      { scale: 0, invertY: true, source: 'measured' },
      { scale: -1, invertY: true, source: 'measured' },
      { scale: Infinity, invertY: true, source: 'measured' },
      { scale: 1_000_001, invertY: true, source: 'measured' },
      { scale: 1, invertY: true, source: '' },
      { scale: 1, invertY: true, source: '  ' },
      { scale: 1, invertY: true, source: 'x'.repeat(201) },
      { scale: 1, invertY: 'true', source: 'measured' },
    ]) {
      const result = review({
        transform: transform as Parameters<typeof review>[0]['transform'],
      });
      expect(result.diagnostics).toContain('UNVERIFIED_COORDINATE_TRANSFORM');
      expect(result.candidates).toEqual([]);
    }
  });

  it('reports unsupported pad centers and IDs without claiming any contact', () => {
    const result = review({
      pads: [
        pad('', 25, -25),
        pad(' padded ', 25, -25),
        pad('missing-x', 25, -25, { x: undefined }),
        pad('nonfinite-y', 25, -25, { y: Number.NaN }),
        pad('wrong-shape', 25, -25, { pad: ['TRAPEZOID', 10, 10] }),
        pad('invalid-width', 25, -25, { pad: ['ELLIPSE', -1, 10] }),
        pad('unsupported-net', 25, -25, { net: undefined }),
        pad('unsupported-layer', 25, -25, { layer: undefined }),
        pad('unplated', 25, -25, { metallization: false }),
      ],
    });
    expect(result.candidates).toEqual([]);
    expect(result.pads.map((item) => item.reason)).toEqual([
      'INVALID_PAD_ID',
      'INVALID_PAD_ID',
      'INVALID_PAD_CENTER',
      'INVALID_PAD_CENTER',
      'UNVERIFIED_PAD_SHAPE',
      'UNVERIFIED_PAD_SHAPE',
      'NET_DOES_NOT_MATCH_POUR',
      'UNVERIFIED_PAD_COPPER_LAYER',
      'UNVERIFIED_PLATING_OR_THERMAL_CONTACT',
    ]);
  });

  it('preserves existing result distinctions when a filled region is absent or malformed', () => {
    const malformed = review({ pouredRegions: [{ fill: true, path: { complexPolygon: null } }] });
    const empty = review({ pouredRegions: [{ fill: false }] });
    expect(malformed.pads.every((item) => item.reason === 'UNSUPPORTED_POLYGON_SOURCE')).toBe(true);
    expect(empty.pads.every((item) => item.reason === 'NO_NATIVE_FILLED_REGIONS')).toBe(true);
    expect(malformed.overall_status).toBe('UNKNOWN');
    expect(empty.overall_status).toBe('UNKNOWN');
  });
});
