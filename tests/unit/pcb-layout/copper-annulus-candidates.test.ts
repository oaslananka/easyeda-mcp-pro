import { describe, expect, it } from 'vitest';
import { reviewCopperAnnulusCandidates } from '../../../src/pcb-layout/copper-contact-candidates.js';

const source = {
  pourNet: 'GND',
  pourLayer: 1,
  // Polygon source and native pad positions use different scale.
  pouredRegions: [
    {
      id: 'copper0',
      fill: true,
      lineWidth: 0,
      path: { complexPolygon: [[0, 0, 'L', 100, 0, 100, 100, 0, 100, 0, 0]] },
    },
  ],
  transform: { scale: 0.1, invertY: false, source: 'Independent source contour calibration' },
  pads: [
    {
      primitiveId: 'g1',
      net: 'GND',
      layer: 12,
      x: -20,
      y: 500,
      pad: ['ELLIPSE', 80, 80],
      hole: ['ROUND', 4, 4],
      metallization: true,
      heatWelding: null,
      holeOffsetX: 0,
      holeOffsetY: 0,
      specialPad: null,
    },
  ],
  drills: [
    {
      primitiveId: 'g1',
      diameterMm: 1.016,
      nativeHoleMmPerUnit: 0.254,
      source: 'Independent footprint drill specification and unit calibration',
    },
  ],
};

describe('bounded source-declared round annulus geometry', () => {
  it('finds an interior annular witness despite the center being outside the source outline', () => {
    const result = reviewCopperAnnulusCandidates(source);
    expect(result).toMatchObject({
      overall_status: 'UNKNOWN',
      engineering_sign_off: false,
      pads: [
        {
          primitiveId: 'g1',
          status: 'GEOMETRIC_OVERLAP_CANDIDATE',
          fill_id: 'copper0',
          electrical_continuity_status: 'UNKNOWN',
        },
      ],
    });
    const witness = result.pads[0]?.witness;
    expect(witness).toBeDefined();
    expect(witness?.x_mm).toBeGreaterThan(0);
    expect(witness?.minimum_margin_mm).toBeGreaterThan(0.001);
    expect(Math.hypot(witness!.x_mm - -20 * 0.0254, witness!.y_mm - 500 * 0.0254)).toBeGreaterThan(
      1.016 / 2,
    );
  });

  it('keeps missing or inconsistent independent drill and coordinate evidence unknown', () => {
    for (const patch of [
      { drills: [] },
      { transform: undefined },
      { transform: { ...source.transform, scale: 0 } },
      { drills: [{ ...source.drills[0]!, source: '' }] },
      { drills: [{ ...source.drills[0]!, nativeHoleMmPerUnit: 0.0254 }] },
      { drills: [{ ...source.drills[0]!, diameterMm: 2.032 }] },
      { drills: [{ ...source.drills[0]!, primitiveId: 'unrelated' }] },
      { drills: [source.drills[0]!, source.drills[0]!] },
    ]) {
      const result = reviewCopperAnnulusCandidates({ ...source, ...patch });
      expect(result.pads[0]).toMatchObject({ status: 'UNKNOWN' });
      expect(result.pads[0]?.witness).toBeUndefined();
    }
  });

  it('refuses mismatched native identities, nonround pads and holes, thermal and layer uncertainty', () => {
    for (const patch of [
      { net: 'OTHER' },
      { layer: 2 },
      { metallization: false },
      { heatWelding: 'unknown' },
      { holeOffsetX: 1 },
      { holeOffsetY: -1 },
      { holeOffsetX: undefined },
      { specialPad: [{ layer: 1 }] },
      { specialPad: undefined },
      { pad: ['ELLIPSE', 80, 81] },
      { pad: ['RECT', 80, 80] },
      { hole: ['SLOT', 4, 4] },
      { hole: ['ROUND', 4, 5] },
      { hole: ['ROUND', 0, 0] },
      { x: NaN },
      { primitiveId: 'wrong' },
    ]) {
      const result = reviewCopperAnnulusCandidates({
        ...source,
        pads: [{ ...source.pads[0]!, ...patch }],
      });
      expect(result.pads[0]?.status).toBe('UNKNOWN');
    }
    const duplicate = reviewCopperAnnulusCandidates({
      ...source,
      pads: [source.pads[0]!, source.pads[0]!],
    });
    expect(duplicate.pads.every((p) => p.status === 'UNKNOWN')).toBe(true);
  });

  it('rejects unsupported, ambiguous or oversized contours without inventing a negative connection finding', () => {
    const ring = source.pouredRegions[0]!.path.complexPolygon[0]!;
    for (const regions of [
      [],
      [...source.pouredRegions, ...source.pouredRegions],
      [{ ...source.pouredRegions[0]!, fill: false }],
      [{ ...source.pouredRegions[0]!, path: { complexPolygon: [ring, ring] } }],
      [
        {
          ...source.pouredRegions[0]!,
          path: { complexPolygon: [[0, 0, 'ARC', 90, 100, 100, 'L', 0, 0]] },
        },
      ],
      [{ ...source.pouredRegions[0]!, path: { complexPolygon: [[0, 0, 'L', 100, 0, 100, 100]] } }],
      [
        {
          ...source.pouredRegions[0]!,
          path: { complexPolygon: [[0, 0, 'L', ...Array(30002).fill(1)]] },
        },
      ],
      [
        {
          ...source.pouredRegions[0]!,
          path: { complexPolygon: [[0, 0, 'L', 100, 0, Infinity, 100, 0, 0]] },
        },
      ],
    ]) {
      const result = reviewCopperAnnulusCandidates({ ...source, pouredRegions: regions });
      expect(result.pads[0]?.status).toBe('UNKNOWN');
      expect(result.overall_status).toBe('UNKNOWN');
    }
  });

  it('supports the documented round hole tuple and rejects nonzero winding ambiguity', () => {
    expect(
      reviewCopperAnnulusCandidates({
        ...source,
        pads: [{ ...source.pads[0]!, hole: ['ROUND', 4] }],
      }).pads[0]?.status,
    ).toBe('GEOMETRIC_OVERLAP_CANDIDATE');
    const region = source.pouredRegions[0]!;
    const twice = [0, 0, 'L', 100, 0, 100, 100, 0, 100, 0, 0, 100, 0, 100, 100, 0, 100, 0, 0];
    const result = reviewCopperAnnulusCandidates({
      ...source,
      pads: [{ ...source.pads[0]!, x: 500 }],
      pouredRegions: [{ ...region, path: { complexPolygon: [twice] } }],
    });
    expect(result.pads[0]?.status).toBe('UNKNOWN');
  });

  it('requires bounded source geometry and drill declarations even for malformed inventory', () => {
    for (const patch of [
      { drills: null },
      { drills: Array(9).fill(source.drills[0]) },
      { drills: [null] },
      { pourNet: '' },
      { pourLayer: 15 },
      { pads: [null] },
      { pads: [{ ...source.pads[0], primitiveId: undefined }] },
      { transform: { ...source.transform, scale: 0.000001 } },
      {
        pouredRegions: [
          {
            ...source.pouredRegions[0],
            path: { complexPolygon: [[0, 0, 'L', 100, 0, 0, 100, 1, 1]] },
          },
        ],
      },
    ]) {
      const result = reviewCopperAnnulusCandidates({ ...source, ...patch });
      expect(result.pads[0]).toMatchObject({ status: 'UNKNOWN' });
      expect(result.pads[0]?.witness).toBeUndefined();
    }
    for (const pads of [null, Array(9).fill(source.pads[0])]) {
      expect(reviewCopperAnnulusCandidates({ ...source, pads }).pads).toEqual([]);
    }
  });

  it('supports mirrored source coordinates and repeated contour vertices without false contact', () => {
    const region = source.pouredRegions[0]!;
    const result = reviewCopperAnnulusCandidates({
      ...source,
      transform: { ...source.transform, invertY: true },
      pads: [{ ...source.pads[0]!, y: -500, specialPad: [] }],
      pouredRegions: [
        {
          ...region,
          path: { complexPolygon: [[0, 0, 'L', 100, 0, 100, 0, 100, 100, 0, 100, 0, 0]] },
        },
      ],
    });
    expect(result.pads[0]?.status).toBe('GEOMETRIC_OVERLAP_CANDIDATE');
    expect(result.pads[0]?.witness?.y_mm).toBeLessThan(0);
    expect(result.pads[0]?.electrical_continuity_status).toBe('UNKNOWN');
    const noAnnulus = reviewCopperAnnulusCandidates({
      ...source,
      pads: [{ ...source.pads[0]!, pad: ['ELLIPSE', 40, 40] }],
    });
    expect(noAnnulus.pads[0]).toMatchObject({
      status: 'UNKNOWN',
      reason: 'ROUND_DRILL_SOURCE_MISMATCH',
    });
  });

  it('does not infer disconnection when finite sampling finds no interior witness', () => {
    const result = reviewCopperAnnulusCandidates({
      ...source,
      pads: [{ ...source.pads[0]!, x: -1000 }],
    });
    expect(result.pads[0]).toMatchObject({
      status: 'UNKNOWN',
      reason: 'NO_BOUNDED_INTERIOR_WITNESS',
    });
    expect(result.engineering_sign_off).toBe(false);
  });
});
