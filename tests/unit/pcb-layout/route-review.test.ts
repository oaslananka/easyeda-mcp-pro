import { describe, expect, it } from 'vitest';
import {
  reviewRouteGeometry,
  type NativeTrack,
  type RouteGeometryInput,
} from '../../../src/pcb-layout/route-review.js';

const track = (
  primitiveId: string,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  width = 12,
): NativeTrack => ({
  primitiveId,
  net: 'DATA+',
  layer: 1,
  startX,
  startY,
  endX,
  endY,
  width,
});

function review(patch: Partial<RouteGeometryInput> = {}) {
  const tracks = patch.tracks ?? [track('a', 0, 0, 100, 0), track('b', 100, 0, 100, 100)];
  const vias = patch.vias ?? [];
  return reviewRouteGeometry({
    tracks,
    vias,
    trackCount: tracks.length,
    viaCount: vias.length,
    tracksAvailable: true,
    viasAvailable: true,
    intent: 'general',
    ...patch,
  });
}

describe('bounded native route geometry evidence', () => {
  it('does not ban a 90-degree bend on general nets', () => {
    const result = review();
    expect(result.overall_status).toBe('UNKNOWN');
    expect(result.findings).not.toContainEqual(
      expect.objectContaining({
        rule_id: 'RIGHT_ANGLE_STYLE_REVIEW',
      }),
    );
    expect(result.coordinate_unit).toBe('mil');
    expect(result.width_unit).toBe('mm');
    expect(result.input_evidence.collection_complete).toBe(true);
    expect(result.engineering_sign_off).toBe(false);
    expect(result.findings.map((f) => f.status)).not.toContain('PASS');
  });

  it('reports 90 degrees only as a style advisory for high-speed routing', () => {
    const result = review({ intent: 'high-speed' });
    expect(result.overall_status).toBe('UNKNOWN');
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'RIGHT_ANGLE_STYLE_REVIEW',
        status: 'ADVISORY',
        net: 'DATA+',
        layer: 1,
        primitive_ids: ['a', 'b'],
        position_mil: { x: 100, y: 0 },
        deflection_degrees: 90,
      }),
    );
    expect(result.findings.some((f) => f.status === 'WARNING')).toBe(false);
  });

  it('does not manufacture corners from intersections, other nets/layers, or T-junctions', () => {
    const otherNet = { ...track('b', 100, 0, 100, 100), net: 'GND' };
    for (const tracks of [
      [track('a', 0, 0, 100, 0), track('b', 50, -50, 50, 50)],
      [track('a', 0, 0, 100, 0), otherNet],
      [track('a', 0, 0, 100, 0), { ...track('b', 100, 0, 100, 100), layer: 2 }],
      [track('a', 0, 0, 100, 0), track('b', 100, 0, 100, 100), track('c', 100, 0, 130, 80)],
    ]) {
      expect(review({ tracks, intent: 'high-speed' }).findings).not.toContainEqual(
        expect.objectContaining({ rule_id: 'RIGHT_ANGLE_STYLE_REVIEW' }),
      );
    }
  });

  it('warns only for measured same-layer, different-net copper contact', () => {
    const base = track('h', 0, 0, 100, 0, 10);
    const crossing = { ...track('v', 50, -50, 50, 50, 10), net: 'GND' };
    const result = review({ tracks: [base, crossing] });
    const warning = result.findings.find((f) => f.rule_id === 'OBSERVED_TRACK_COPPER_OVERLAP');
    expect(warning).toMatchObject({
      status: 'WARNING',
      net: 'DATA+',
      other_net: 'GND',
      layer: 1,
      primitive_ids: ['h', 'v'],
      observed_edge_gap_mm: -0.254,
    });
    expect(result.overall_status).toBe('WARNING');
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'COPPER_CLEARANCE_UNVERIFIED',
        status: 'UNKNOWN',
      }),
    );
    expect(result.engineering_sign_off).toBe(false);
  });

  it('detects parallel and end-cap overlap but not far or separate-layer segments', () => {
    const a = track('a', 0, 0, 100, 0, 10);
    const b = { ...track('b', 30, 8, 90, 8, 10), net: 'GND' };
    const cap = { ...track('cap', 107, 0, 180, 0, 10), net: 'VCC' };
    const far = { ...track('far', 30, 11, 90, 11, 10), net: 'SENSE' };
    const otherLayer = { ...track('layer', 20, 0, 80, 0, 10), net: 'LAYER', layer: 2 };
    const result = review({ tracks: [a, b, cap, far, otherLayer] });
    const warnings = result.findings.filter((f) => f.rule_id === 'OBSERVED_TRACK_COPPER_OVERLAP');
    expect(warnings.map((w) => w.primitive_ids)).toEqual([
      ['a', 'b'],
      ['a', 'cap'],
      ['b', 'far'],
    ]);
    expect(warnings[0]!.observed_edge_gap_mm).toBeCloseTo(-0.0508, 7);
    expect(warnings[1]!.observed_edge_gap_mm).toBeCloseTo(-0.0762, 7);
    expect(result.findings.some((f) => f.other_net === 'LAYER')).toBe(false);
  });

  it('rejects invalid native layer codes before measured width, overlap and complete inventory claims', () => {
    const valid = track('valid', 0, 0, 100, 0, 10);
    for (const layer of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 1e308]) {
      const invalid = {
        ...track('bad-layer', 50, -50, 50, 50, 2),
        layer,
        net: 'GND',
      };
      const result = review({ tracks: [valid, invalid], minWidthMm: 0.2, intent: 'high-speed' });
      expect(result.input_evidence.collection_complete).toBe(false);
      expect(result.findings).toContainEqual(
        expect.objectContaining({
          id: 'track:bad-layer:missing-geometry',
          rule_id: 'TRACK_GEOMETRY_UNAVAILABLE',
          status: 'UNKNOWN',
          primitive_ids: ['bad-layer'],
        }),
      );
      expect(result.findings).toContainEqual(
        expect.objectContaining({ rule_id: 'NATIVE_COLLECTION_INCOMPLETE', status: 'UNKNOWN' }),
      );
      expect(
        result.findings.some(
          (item) =>
            item.primitive_ids.includes('bad-layer') &&
            (item.status === 'WARNING' || item.status === 'ADVISORY'),
        ),
      ).toBe(false);
      expect(result.engineering_sign_off).toBe(false);
    }
  });

  it('treats implausible and overflowing native coordinates as missing geometry', () => {
    const valid = track('valid', 0, 0, 100, 0);
    const invalid = { ...track('far-out', 0, 0, 10, 10), net: 'GND', startX: 1e308 };
    const result = review({ tracks: [valid, invalid] });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: 'track:far-out:missing-geometry',
        status: 'UNKNOWN',
      }),
    );
    expect(result.findings.some((f) => f.rule_id === 'OBSERVED_TRACK_COPPER_OVERLAP')).toBe(false);
  });

  it('ignores same-net connections, malformed geometry and disconnected/untrusted track snapshots', () => {
    const a = track('a', 0, 0, 100, 0);
    const b = track('b', 50, -50, 50, 50);
    const malformed = { ...b, primitiveId: 'bad', net: 'GND', width: undefined };
    const stale = { ...b, net: 'GND' };
    expect(
      review({ tracks: [a, b, malformed] }).findings.some(
        (f) => f.rule_id === 'OBSERVED_TRACK_COPPER_OVERLAP',
      ),
    ).toBe(false);
    expect(
      review({ tracks: [a, stale], tracksAvailable: false }).findings.some(
        (f) => f.rule_id === 'OBSERVED_TRACK_COPPER_OVERLAP',
      ),
    ).toBe(false);
    expect(
      review({ tracks: [a, { ...stale, layer: 2 }] }).findings.some(
        (f) => f.rule_id === 'OBSERVED_TRACK_COPPER_OVERLAP',
      ),
    ).toBe(false);
  });

  it('does not infer a high-speed corner from a native segment with missing copper width', () => {
    const valid = track('valid', 0, 0, 100, 0);
    const incomplete = { ...track('incomplete', 100, 0, 100, 100), width: undefined };
    const result = review({ tracks: [valid, incomplete], intent: 'high-speed' });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: 'track:incomplete:missing-geometry',
        rule_id: 'TRACK_GEOMETRY_UNAVAILABLE',
        status: 'UNKNOWN',
      }),
    );
    expect(result.findings.some((item) => item.rule_id === 'RIGHT_ANGLE_STYLE_REVIEW')).toBe(false);
    expect(result.engineering_sign_off).toBe(false);
  });

  it('excludes padded or blank native net labels from measured track and via claims', () => {
    const valid = track('valid', 0, 0, 100, 0, 10);
    const invalidNet = { ...track('bad-net', 50, -40, 50, 40, 2), net: ' GND ' };
    const via = {
      primitiveId: 'via',
      net: ' DATA+ ',
      x: 100,
      y: 0,
      holeDiameter: 10,
      diameter: 30,
    };
    const otherLayer = { ...track('layer', 100, 0, 100, 80), layer: 2 };
    const result = review({
      tracks: [valid, invalidNet, otherLayer],
      vias: [via],
      intent: 'high-speed',
      minWidthMm: 0.2,
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: 'track:bad-net:missing-geometry',
        rule_id: 'TRACK_GEOMETRY_UNAVAILABLE',
        status: 'UNKNOWN',
      }),
    );
    expect(result.findings.some((item) => item.rule_id === 'OBSERVED_TRACK_COPPER_OVERLAP')).toBe(
      false,
    );
    expect(
      result.findings.some((item) => item.rule_id === 'TRACE_WIDTH_BELOW_CONTEXT_MINIMUM'),
    ).toBe(false);
    expect(result.findings.some((item) => item.rule_id === 'VIA_LAYER_TRANSITION_CANDIDATE')).toBe(
      false,
    );

    const padded = review({
      tracks: [
        { ...track('top', 0, 0, 100, 0), net: ' DATA+ ' },
        { ...track('bottom', 100, 0, 100, 100), net: ' DATA+ ', layer: 12 },
      ],
      vias: [via],
    });
    expect(padded.findings.some((item) => item.rule_id === 'VIA_LAYER_TRANSITION_CANDIDATE')).toBe(
      false,
    );
    expect(
      padded.findings.filter((item) => item.rule_id === 'TRACK_GEOMETRY_UNAVAILABLE'),
    ).toHaveLength(2);
  });

  it('never emits measured geometry warnings from explicitly unavailable native collections', () => {
    const narrow = track('narrow', 0, 0, 100, 0, 2);
    const colliding = { ...track('collision', 50, -30, 50, 30, 10), net: 'GND' };
    const impossibleVia = {
      primitiveId: 'via-bad',
      net: 'DATA+',
      x: 100,
      y: 0,
      holeDiameter: 40,
      diameter: 20,
    };
    const stale = review({
      tracks: [narrow, colliding],
      vias: [impossibleVia],
      tracksAvailable: false,
      viasAvailable: false,
      minWidthMm: 0.2,
      intent: 'high-speed',
    });
    expect(stale.overall_status).toBe('UNKNOWN');
    expect(stale.input_evidence).toMatchObject({
      tracks: 'unavailable',
      vias: 'unavailable',
      collection_complete: false,
    });
    expect(stale.findings.some((f) => f.status === 'WARNING' || f.status === 'ADVISORY')).toBe(
      false,
    );
    expect(stale.findings.map((f) => f.rule_id)).toEqual(
      expect.arrayContaining([
        'TRACK_GEOMETRY_UNAVAILABLE',
        'NATIVE_COLLECTION_INCOMPLETE',
        'VIA_CURRENT_CAPACITY_UNKNOWN',
        'REFERENCE_PLANE_UNVERIFIED',
        'COPPER_CLEARANCE_UNVERIFIED',
      ]),
    );
    expect(stale.findings.some((f) => f.rule_id === 'VIA_ANNULAR_GEOMETRY')).toBe(false);
    expect(stale.findings.some((f) => f.rule_id === 'TRACE_WIDTH_BELOW_CONTEXT_MINIMUM')).toBe(
      false,
    );
    expect(stale.findings.some((f) => f.rule_id === 'OBSERVED_TRACK_COPPER_OVERLAP')).toBe(false);
    expect(stale.findings.some((f) => f.rule_id === 'VIA_LAYER_TRANSITION_CANDIDATE')).toBe(false);
    expect(stale.engineering_sign_off).toBe(false);
  });

  it('uses only a source-available collection, never stale rows in the other collection', () => {
    const narrow = track('narrow', 0, 0, 100, 0, 2);
    const badVia = {
      primitiveId: 'via-bad',
      net: 'DATA+',
      x: 100,
      y: 0,
      holeDiameter: 40,
      diameter: 20,
    };
    const withTracksOnly = review({
      tracks: [narrow],
      vias: [badVia],
      viasAvailable: false,
      minWidthMm: 0.2,
    });
    expect(
      withTracksOnly.findings.some((f) => f.rule_id === 'TRACE_WIDTH_BELOW_CONTEXT_MINIMUM'),
    ).toBe(true);
    expect(withTracksOnly.findings.some((f) => f.rule_id === 'VIA_ANNULAR_GEOMETRY')).toBe(false);
    expect(withTracksOnly.input_evidence.collection_complete).toBe(false);

    const withViasOnly = review({
      tracks: [narrow],
      tracksAvailable: false,
      vias: [badVia],
      minWidthMm: 0.2,
    });
    expect(
      withViasOnly.findings.some((f) => f.rule_id === 'TRACE_WIDTH_BELOW_CONTEXT_MINIMUM'),
    ).toBe(false);
    expect(withViasOnly.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'VIA_ANNULAR_GEOMETRY',
        status: 'WARNING',
        primitive_ids: ['via-bad'],
      }),
    );
    expect(withViasOnly.input_evidence.collection_complete).toBe(false);
  });

  it('fails closed on duplicated track IDs without inventing source-attributed geometry warnings', () => {
    const a = track('duplicate', 0, 0, 100, 0, 2);
    const b = { ...track('duplicate', 50, -40, 50, 40), net: 'GND' };
    const result = review({
      tracks: [a, b],
      minWidthMm: 0.2,
      intent: 'high-speed',
    });
    expect(result.overall_status).toBe('UNKNOWN');
    expect(result.input_evidence.collection_complete).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: 'track:duplicate:ambiguous-identity',
        status: 'UNKNOWN',
        rule_id: 'TRACK_GEOMETRY_UNAVAILABLE',
      }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'NATIVE_COLLECTION_INCOMPLETE',
        status: 'UNKNOWN',
      }),
    );
    expect(result.findings.some((f) => f.status === 'WARNING' || f.status === 'ADVISORY')).toBe(
      false,
    );
    expect(result.engineering_sign_off).toBe(false);

    const withUnique = review({
      tracks: [a, b, track('unique', 0, 200, 100, 200, 2)],
      minWidthMm: 0.2,
    });
    expect(
      withUnique.findings
        .filter((f) => f.rule_id === 'TRACE_WIDTH_BELOW_CONTEXT_MINIMUM')
        .map((f) => f.primitive_ids),
    ).toEqual([['unique']]);
    expect(withUnique.input_evidence.collection_complete).toBe(false);
  });

  it('does not trust duplicate or absent via identities for annular geometry', () => {
    const bad = {
      primitiveId: 'via-duplicate',
      net: 'DATA+',
      x: 100,
      y: 0,
      holeDiameter: 35,
      diameter: 30,
    };
    const ambiguous = review({ tracks: [], vias: [bad, { ...bad, net: 'GND' }] });
    expect(ambiguous.input_evidence.collection_complete).toBe(false);
    expect(ambiguous.overall_status).toBe('UNKNOWN');
    expect(ambiguous.findings.some((f) => f.rule_id === 'VIA_ANNULAR_GEOMETRY')).toBe(false);
    expect(ambiguous.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'NATIVE_COLLECTION_INCOMPLETE',
        status: 'UNKNOWN',
      }),
    );
    const mixed = review({
      tracks: [],
      vias: [bad, { ...bad }, { ...bad, primitiveId: 'real-unique' }],
    });
    expect(
      mixed.findings
        .filter((f) => f.rule_id === 'VIA_ANNULAR_GEOMETRY')
        .map((f) => f.primitive_ids),
    ).toEqual([['real-unique']]);

    const missing = review({ tracks: [], vias: [{ ...bad, primitiveId: undefined }] });
    expect(missing.input_evidence.collection_complete).toBe(false);
    expect(missing.findings.some((f) => f.rule_id === 'VIA_ANNULAR_GEOMETRY')).toBe(false);
  });

  it('does not infer a via transition when a track ID collides away from the candidate', () => {
    const front = track('same', 0, 0, 100, 0);
    const back = { ...track('back', 100, 0, 100, 80), layer: 12 };
    const duplicateAway = { ...track('same', 300, 300, 400, 300), net: 'OTHER' };
    const via = { primitiveId: 'via', net: 'DATA+', x: 100, y: 0, holeDiameter: 10, diameter: 30 };
    const ambiguous = review({ tracks: [front, back, duplicateAway], vias: [via] });
    expect(ambiguous.input_evidence.collection_complete).toBe(false);
    expect(ambiguous.findings.some((f) => f.rule_id === 'VIA_LAYER_TRANSITION_CANDIDATE')).toBe(
      false,
    );
    const exact = review({ tracks: [front, back], vias: [via] });
    expect(exact.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'VIA_LAYER_TRANSITION_CANDIDATE',
        status: 'UNKNOWN',
        native_layers: [1, 12],
      }),
    );
  });

  it('reports an actual native segment narrower than the caller-supplied minimum', () => {
    const result = review({
      tracks: [track('narrow-1', 0, 0, 100, 0, 4)],
      minWidthMm: 0.2,
    });
    expect(result.overall_status).toBe('WARNING');
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: 'track:narrow-1:width',
        rule_id: 'TRACE_WIDTH_BELOW_CONTEXT_MINIMUM',
        status: 'WARNING',
        net: 'DATA+',
        layer: 1,
        primitive_ids: ['narrow-1'],
        width_mm: 0.1016,
        threshold_mm: 0.2,
      }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'COPPER_CLEARANCE_UNVERIFIED',
        status: 'UNKNOWN',
      }),
    );
  });

  it('retains UNKNOWN when no actual fab width limit is supplied', () => {
    const result = review({ tracks: [track('wide', 0, 0, 100, 0, 1)] });
    expect(result.overall_status).toBe('UNKNOWN');
    expect(result.findings.some((f) => f.rule_id === 'TRACE_WIDTH_BELOW_CONTEXT_MINIMUM')).toBe(
      false,
    );
    expect(result.limitations).toContainEqual(expect.stringContaining('caller-supplied width'));
  });

  it('observes coincident same-net via endpoints across two raw native layer codes without a connectivity PASS', () => {
    const a = track('front', 0, 0, 100, 0);
    const b = { ...track('other-code', 100, 0, 100, 120), layer: 12 };
    const result = review({
      tracks: [a, b],
      vias: [{ primitiveId: 'v1', net: 'DATA+', x: 100, y: 0, holeDiameter: 10, diameter: 30 }],
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: 'via-transition:v1',
        rule_id: 'VIA_LAYER_TRANSITION_CANDIDATE',
        status: 'UNKNOWN',
        primitive_ids: ['front', 'other-code', 'v1'],
        net: 'DATA+',
        position_mil: { x: 100, y: 0 },
        native_layers: [1, 12],
      }),
    );
    expect(result.overall_status).toBe('UNKNOWN');
    expect(result.engineering_sign_off).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'REFERENCE_PLANE_UNVERIFIED',
        status: 'UNKNOWN',
      }),
    );
  });

  it('does not infer a via transition from unrelated or incomplete native identities', () => {
    const front = track('front', 0, 0, 100, 0);
    const back = { ...track('back', 100, 0, 100, 120), layer: 2 };
    const via = { primitiveId: 'v', net: 'DATA+', x: 100, y: 0, holeDiameter: 10, diameter: 30 };
    const variants: Array<Partial<RouteGeometryInput>> = [
      { tracks: [front, { ...back, net: 'GND' }], vias: [via] },
      { tracks: [front, { ...back, startX: 100.001 }], vias: [via] },
      { tracks: [front, { ...back, layer: 1 }], vias: [via] },
      { tracks: [front, { ...back, width: undefined }], vias: [via] },
      { tracks: [front, { ...back, primitiveId: 'front' }], vias: [via] },
      { tracks: [front, back], vias: [{ ...via, holeDiameter: 35 }] },
      { tracks: [front, back], vias: [{ ...via, x: Number.NaN }] },
      { tracks: [front, back], vias: [via, { ...via }] },
      { tracks: [front, back], vias: [via], tracksAvailable: false },
      { tracks: [front, back], vias: [via], viasAvailable: false },
    ];
    for (const variant of variants) {
      const finding = review(variant).findings.find(
        (item) => item.rule_id === 'VIA_LAYER_TRANSITION_CANDIDATE',
      );
      expect(finding).toBeUndefined();
    }
  });

  it('withholds native via geometry claims for unbounded positive drill or land dimensions', () => {
    const front = track('front', 0, 0, 100, 0);
    const back = { ...track('back', 100, 0, 100, 100), layer: 12 };
    const via = {
      primitiveId: 'via',
      net: 'DATA+',
      x: 100,
      y: 0,
      holeDiameter: 10,
      diameter: 30,
    };
    const invalid = [
      { ...via, diameter: 1e308 },
      { ...via, holeDiameter: 1e308, diameter: 1e308 },
      { ...via, holeDiameter: 1e308, diameter: 1e307 },
    ];
    for (const bad of invalid) {
      const observed = review({ tracks: [front, back], vias: [bad] });
      expect(
        observed.findings.some((item) => item.rule_id === 'VIA_LAYER_TRANSITION_CANDIDATE'),
      ).toBe(false);
      expect(observed.findings.some((item) => item.rule_id === 'VIA_ANNULAR_GEOMETRY')).toBe(false);
      expect(observed.engineering_sign_off).toBe(false);
    }
    const valid = review({ tracks: [front, back], vias: [via] });
    expect(valid.findings.some((item) => item.rule_id === 'VIA_LAYER_TRANSITION_CANDIDATE')).toBe(
      true,
    );
    const physicallyContradictory = review({
      tracks: [],
      vias: [{ ...via, holeDiameter: 35 }],
    });
    expect(
      physicallyContradictory.findings.some((item) => item.rule_id === 'VIA_ANNULAR_GEOMETRY'),
    ).toBe(true);
  });

  it('withholds measured via findings and complete inventory on untrustworthy net, center or dimensions', () => {
    const front = track('front', 0, 0, 100, 0);
    const back = { ...track('back', 100, 0, 100, 100), layer: 12 };
    const via = {
      primitiveId: 'v-bad',
      net: 'DATA+',
      x: 100,
      y: 0,
      holeDiameter: 40,
      diameter: 30,
    };
    const invalid = [
      { ...via, net: ' DATA+ ' },
      { ...via, net: undefined },
      { ...via, x: Number.POSITIVE_INFINITY },
      { ...via, y: 1e308 },
      { ...via, holeDiameter: undefined },
      { ...via, diameter: 1e308 },
    ];
    for (const candidate of invalid) {
      const result = review({ tracks: [front, back], vias: [candidate] });
      expect(result.input_evidence.collection_complete).toBe(false);
      expect(result.overall_status).toBe('UNKNOWN');
      expect(result.findings).toContainEqual(
        expect.objectContaining({
          id: 'via:v-bad:missing-geometry',
          rule_id: 'VIA_GEOMETRY_UNAVAILABLE',
          status: 'UNKNOWN',
          primitive_ids: ['v-bad'],
        }),
      );
      expect(result.findings.map((f) => f.rule_id)).toContain('NATIVE_COLLECTION_INCOMPLETE');
      expect(result.findings.some((f) => f.rule_id === 'VIA_ANNULAR_GEOMETRY')).toBe(false);
      expect(result.findings.some((f) => f.rule_id === 'VIA_LAYER_TRANSITION_CANDIDATE')).toBe(
        false,
      );
      expect(result.engineering_sign_off).toBe(false);
    }
  });

  it('flags physically contradictory via land/drill diameter without claiming current rating', () => {
    const result = review({
      tracks: [],
      vias: [{ primitiveId: 'via-1', net: 'GND', x: 12, y: 20, holeDiameter: 35, diameter: 30 }],
    });
    expect(result.overall_status).toBe('WARNING');
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: 'via:via-1:geometry',
        rule_id: 'VIA_ANNULAR_GEOMETRY',
        status: 'WARNING',
        primitive_ids: ['via-1'],
        position_mil: { x: 12, y: 20 },
      }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'VIA_CURRENT_CAPACITY_UNKNOWN',
        status: 'UNKNOWN',
      }),
    );
  });

  it('treats missing primitive fields and empty native readers as unknown', () => {
    const result = review({
      tracks: [{ primitiveId: 'broken', net: 'GND', startX: 0 }],
      viasAvailable: false,
    });
    expect(result.input_evidence.vias).toBe('unavailable');
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: 'track:broken:missing-geometry',
        status: 'UNKNOWN',
      }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: 'coverage:pagination',
        status: 'UNKNOWN',
      }),
    );
    const empty = review({ tracks: [], vias: [] });
    expect(empty.input_evidence.collection_complete).toBe(true);
    expect(empty.overall_status).toBe('UNKNOWN');
    expect(empty.findings).toContainEqual(
      expect.objectContaining({
        id: 'coverage:tracks',
        status: 'UNKNOWN',
      }),
    );
  });

  it('reports incomplete paginated native reads instead of inferring a clean board', () => {
    const result = review({ trackCount: 201, viaCount: 10 });
    expect(result.input_evidence.collection_complete).toBe(false);
    expect(result.coverage.requested_track_count).toBe(201);
    expect(result.coverage.returned_track_count).toBe(2);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'NATIVE_COLLECTION_INCOMPLETE',
        status: 'UNKNOWN',
      }),
    );
    expect(result.engineering_sign_off).toBe(false);
  });

  it('caps findings deterministically and retains warnings in bounded output', () => {
    const tracks = Array.from({ length: 80 }, (_, i) =>
      track('very-narrow-' + i, i * 100, 0, i * 100 + 50, 0, 1),
    );
    const first = review({ tracks, minWidthMm: 0.2 });
    const second = review({ tracks, minWidthMm: 0.2 });
    expect(first).toEqual(second);
    expect(first.coverage.findings_truncated).toBe(true);
    expect(first.findings.length).toBe(60);
    expect(first.findings.filter((f) => f.status === 'WARNING').length).toBe(57);
    expect(first.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'REFERENCE_PLANE_UNVERIFIED',
        status: 'UNKNOWN',
      }),
    );
    expect(first.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'COPPER_CLEARANCE_UNVERIFIED',
        status: 'UNKNOWN',
      }),
    );
    expect(first.findings).toContainEqual(
      expect.objectContaining({
        rule_id: 'VIA_CURRENT_CAPACITY_UNKNOWN',
        status: 'UNKNOWN',
      }),
    );
  });
});
