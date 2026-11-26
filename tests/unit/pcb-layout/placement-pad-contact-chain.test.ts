import { describe, expect, it } from 'vitest';
import { observeNativePadContactChain } from '../../../src/pcb-layout/placement-pad-contact-chain.js';
import type { NativeTrack } from '../../../src/pcb-layout/route-review.js';

const line = (id: string, startX: number, endX: number, layer = 1, net = 'VCC'): NativeTrack => ({
  primitiveId: id,
  startX,
  endX,
  startY: 0,
  endY: 0,
  width: 10,
  layer,
  net,
});
const contact = (primitiveId: string, layer = 1, net = 'VCC') => ({
  primitiveId,
  layer,
  net,
  nativeType: 'Line',
});
const observe = (
  tracks: NativeTrack[],
  first = [contact('a')],
  second = [contact('b')],
  complete = true,
) => observeNativePadContactChain('VCC', first, second, tracks, complete);

describe('native pad-associated track chains (not electrical continuity)', () => {
  it('joins two native pad-associated lines at exact endpoints, without requiring pad centers', () => {
    expect(observe([line('a', 10, 40), line('middle', 40, 60), line('b', 60, 90)])).toMatchObject({
      evidence: 'observed_associated_endpoint_chain',
      primitive_ids: ['a', 'middle', 'b'],
      native_layer: 1,
      observed_full_segment_length_mm: 80 * 0.0254,
      electrical_continuity_status: 'UNKNOWN',
    });
  });

  it('reports one shared inventoried line only once', () => {
    expect(observe([line('a', 10, 90)], [contact('a')], [contact('a')])).toMatchObject({
      evidence: 'observed_associated_endpoint_chain',
      primitive_ids: ['a'],
      observed_full_segment_length_mm: 80 * 0.0254,
      electrical_continuity_status: 'UNKNOWN',
    });
  });

  it('does not invent connectivity across layers, different nets, near endpoints or missing tracks', () => {
    for (const tracks of [
      [line('a', 10, 50), line('b', 50, 90, 2)],
      [line('a', 10, 50), line('b', 50, 90, 1, 'GND')],
      [line('a', 10, 50), line('b', 50.0001, 90)],
      [line('a', 10, 90)],
    ]) {
      expect(observe(tracks)).toMatchObject({
        evidence: 'unavailable',
        primitive_ids: [],
        electrical_continuity_status: 'UNKNOWN',
      });
    }
  });

  it('rejects contradictory association layer and net, duplicate identities and truncated inventory', () => {
    const tracks = [line('a', 10, 50), line('b', 50, 90)];
    for (const result of [
      observe(tracks, [{ ...contact('a'), nativeType: 'Via' }]),
      observe(tracks, [{ ...contact('a'), nativeType: '3' }]),
      observe(tracks, [contact('a', 2)]),
      observe(tracks, [contact('a', 1, 'GND')]),
      observe(tracks, [contact('a'), contact('a')]),
      observe([...tracks, line('a', 100, 110)]),
      observe(tracks, undefined, undefined, false),
      observe([{ ...tracks[0]!, width: 0 }, tracks[1]!]),
    ])
      expect(result.evidence).toBe('unavailable');
  });

  it('chooses a deterministic fewest-segment chain even when several native anchors are present', () => {
    const tracks = [line('a', 0, 10), line('b', 20, 30), line('z', 10, 20), line('c', 10, 20)];
    const first = observe(tracks);
    const reversed = observe([...tracks].reverse());
    expect(first).toEqual(reversed);
    expect(first.primitive_ids).toEqual(['a', 'c', 'b']);
    expect(first.electrical_continuity_status).toBe('UNKNOWN');
  });
});
