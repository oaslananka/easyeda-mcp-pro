import { describe, expect, it } from 'vitest';
import { reviewSelectedLineWidth } from '../../../src/pcb-layout/placement-selected-line-width.js';
import type { NativePadPairFinding } from '../../../src/pcb-layout/placement-pad-evidence.js';
import type { NativeTrack } from '../../../src/pcb-layout/route-review.js';

const chain = {
  evidence: 'observed_exact_endpoint_chain',
  selection: 'fewest_segments',
  primitive_ids: ['a', 'b'],
  native_layer: 1,
  observed_centerline_length_mm: 2.54,
  reasons: [],
  electrical_continuity_status: 'UNKNOWN',
} as const;
const pad: NativePadPairFinding = {
  first_pin: '1',
  second_pin: '2',
  expected_net: 'VIN',
  evidence: 'native_component_pads',
  native_first_net: 'VIN',
  native_second_net: 'VIN',
  status: 'UNKNOWN',
  electrical_loop_status: 'UNKNOWN',
  reasons: [],
  route_chain: { ...chain, primitive_ids: [...chain.primitive_ids] },
};
const tracks: NativeTrack[] = [
  { primitiveId: 'a', net: 'VIN', layer: 1, startX: 0, startY: 0, endX: 50, endY: 0, width: 10 },
  { primitiveId: 'b', net: 'VIN', layer: 1, startX: 50, startY: 0, endX: 100, endY: 0, width: 10 },
  {
    primitiveId: 'elsewhere',
    net: 'VIN',
    layer: 1,
    startX: 0,
    startY: 100,
    endX: 50,
    endY: 100,
    width: 1,
  },
];
const association: NonNullable<NativePadPairFinding['native_pad_associations']> = {
  evidence: 'native_reported',
  first_primitive_ids: ['a'],
  second_primitive_ids: ['b'],
  shared_primitive_ids: [],
  reasons: [],
  electrical_continuity_status: 'UNKNOWN',
  associated_route_chain: {
    evidence: 'observed_associated_endpoint_chain',
    selection: 'fewest_segments',
    primitive_ids: ['a', 'b'],
    native_layer: 1,
    observed_full_segment_length_mm: 2.54,
    reasons: [],
    electrical_continuity_status: 'UNKNOWN',
  },
};

describe('selected native line width evidence', () => {
  it('reports all tied narrowest segments and excludes unrelated same-net traces', () => {
    for (const [minimum, status] of [
      [0.2, 'UNKNOWN'],
      [0.254, 'UNKNOWN'],
      [0.3, 'WARNING'],
    ] as const) {
      expect(reviewSelectedLineWidth(pad, minimum, tracks, true)).toMatchObject({
        evidence: 'observed_exact_endpoint_chain',
        native_layer: 1,
        observed_min_line_width_mm: 0.254,
        narrowest_line_ids: ['a', 'b'],
        status,
        electrical_continuity_status: 'UNKNOWN',
      });
    }
  });

  it('preserves association mode and prefers an observed exact endpoint chain', () => {
    for (const evidence of ['native_reported', 'native_reported_centre'] as const) {
      const native = { ...association, evidence };
      expect(
        reviewSelectedLineWidth(
          { ...pad, route_chain: undefined, native_pad_associations: native },
          0.3,
          tracks,
          true,
        ).evidence,
      ).toBe(evidence);
      expect(
        reviewSelectedLineWidth({ ...pad, native_pad_associations: native }, 0.3, tracks, true)
          .evidence,
      ).toBe('observed_exact_endpoint_chain');
    }
  });

  it('withholds measurements for incomplete or inconsistent selected chain evidence', () => {
    const missing = {
      evidence: 'unavailable',
      status: 'UNKNOWN',
      narrowest_line_ids: [],
      electrical_continuity_status: 'UNKNOWN',
    };
    for (const changed of [
      { ...pad, evidence: 'unavailable' as const },
      { ...pad, native_first_net: 'OTHER' },
      { ...pad, native_second_net: 'OTHER' },
      { ...pad, route_chain: undefined },
      {
        ...pad,
        route_chain: undefined,
        native_pad_associations: { ...association, evidence: 'unavailable' as const },
      },
      {
        ...pad,
        route_chain: undefined,
        native_pad_associations: { ...association, associated_route_chain: undefined },
      },
      { ...pad, route_chain: { ...pad.route_chain!, primitive_ids: [] } },
      { ...pad, route_chain: { ...pad.route_chain!, primitive_ids: ['a', 'a'] } },
      { ...pad, route_chain: { ...pad.route_chain!, native_layer: undefined } },
      {
        ...pad,
        route_chain: { ...pad.route_chain!, primitive_ids: ['missing'] },
        native_pad_associations: association,
      },
    ]) {
      const result = reviewSelectedLineWidth(changed, 0.3, tracks, true);
      expect(result).toMatchObject(missing);
      expect(result.observed_min_line_width_mm).toBeUndefined();
    }
    expect(reviewSelectedLineWidth(pad, 0.3, tracks, false)).toMatchObject(missing);
    for (const invalid of [
      tracks.slice(1),
      [...tracks, tracks[0]!],
      [{ ...tracks[0]!, net: 'OTHER' }, ...tracks.slice(1)],
      [{ ...tracks[0]!, layer: 2 }, ...tracks.slice(1)],
      [{ ...tracks[0]!, width: 0 }, ...tracks.slice(1)],
    ])
      expect(reviewSelectedLineWidth(pad, 0.3, invalid, true)).toMatchObject(missing);
  });
});
