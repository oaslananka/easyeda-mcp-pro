import { describe, expect, it } from 'vitest';
import {
  observeNativePadRouteChain,
  type NativePadRoutePoint,
} from '../../../src/pcb-layout/placement-pad-route-chain.js';
import type { NativeTrack } from '../../../src/pcb-layout/route-review.js';

const first: NativePadRoutePoint = { x: 0, y: 0, layer: 12, net: 'VCC' };
const second: NativePadRoutePoint = { x: 100, y: 0, layer: 12, net: 'VCC' };
const track = (
  primitiveId: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  layer = 1,
  net = 'VCC',
): NativeTrack => ({
  primitiveId,
  net,
  layer,
  startX: x1,
  startY: y1,
  endX: x2,
  endY: y2,
  width: 10,
});

const observed = (tracks: NativeTrack[], complete = true) =>
  observeNativePadRouteChain(first, second, tracks, complete);

describe('bounded same-net native pad endpoint chain observations', () => {
  it('reports exact same-layer two-segment geometry, not electrical continuity', () => {
    expect(observed([track('a', 0, 0, 50, 50), track('b', 50, 50, 100, 0)])).toMatchObject({
      evidence: 'observed_exact_endpoint_chain',
      selection: 'fewest_segments',
      primitive_ids: ['a', 'b'],
      native_layer: 1,
      observed_centerline_length_mm: Math.hypot(50, 50) * 2 * 0.0254,
      electrical_continuity_status: 'UNKNOWN',
    });
  });

  it('distinguishes short vs meandering native centerlines without generic limits', () => {
    const short = observed([track('short', 0, 0, 100, 0)]);
    const long = observed([
      track('up', 0, 0, 0, 100),
      track('across', 0, 100, 100, 100),
      track('down', 100, 100, 100, 0),
    ]);
    expect(short).toMatchObject({
      evidence: 'observed_exact_endpoint_chain',
      primitive_ids: ['short'],
      observed_centerline_length_mm: 2.54,
      electrical_continuity_status: 'UNKNOWN',
    });
    expect(long).toMatchObject({
      evidence: 'observed_exact_endpoint_chain',
      primitive_ids: ['up', 'across', 'down'],
      observed_centerline_length_mm: 7.62,
      electrical_continuity_status: 'UNKNOWN',
    });
    expect(long.reasons.join(' ')).toContain('return-current continuity');
  });

  it('deterministically prefers the fewest exact native segments without a copper PASS', () => {
    const result = observed([
      track('z-short', 0, 0, 100, 0),
      track('b', 50, 0, 100, 0),
      track('a', 0, 0, 50, 0),
    ]);
    expect(result.primitive_ids).toEqual(['z-short']);
    expect(result.selection).toBe('fewest_segments');
    expect(result.electrical_continuity_status).toBe('UNKNOWN');
  });

  it('never bridges other net, different layers, unsupported layers or via-only transitions', () => {
    for (const tracks of [
      [track('first', 0, 0, 50, 0), track('second', 50, 0, 100, 0, 1, 'GND')],
      [track('top', 0, 0, 50, 0), track('bottom', 50, 0, 100, 0, 2)],
      [track('silk', 0, 0, 100, 0, 3)],
      [track('multi', 0, 0, 100, 0, 12)],
      [track('unconnected', 0, 0, 90, 0)],
    ]) {
      expect(observed(tracks)).toMatchObject({
        evidence: 'unavailable',
        selection: 'unavailable',
        primitive_ids: [],
        electrical_continuity_status: 'UNKNOWN',
      });
    }
  });

  it('does not join interior geometric crossings or a pad center on a segment interior', () => {
    for (const tracks of [
      [track('horizontal', 0, 0, 100, 0), track('vertical', 50, -50, 50, 50)],
      [track('left', 0, 0, 50, 0), track('crossing', 75, -25, 75, 25)],
    ]) {
      const end = { ...second, x: 50, y: 50 };
      expect(observeNativePadRouteChain(first, end, tracks, true).evidence).toBe('unavailable');
    }
    expect(
      observeNativePadRouteChain({ ...first, x: 50 }, second, [track('full', 0, 0, 100, 0)], true)
        .evidence,
    ).toBe('unavailable');
  });

  it('rejects mixed component sides even if copper ends meet in XY', () => {
    const top = { ...first, layer: 1 };
    const bottom = { ...second, layer: 2 };
    expect(
      observeNativePadRouteChain(top, bottom, [track('top', 0, 0, 100, 0)], true),
    ).toMatchObject({ evidence: 'unavailable', electrical_continuity_status: 'UNKNOWN' });
    expect(
      observeNativePadRouteChain(top, { ...second, layer: 1 }, [track('top', 0, 0, 100, 0)], true),
    ).toMatchObject({
      evidence: 'observed_exact_endpoint_chain',
      native_layer: 1,
    });
    expect(
      observeNativePadRouteChain({ ...top, layer: 12 }, bottom, [track('top', 0, 0, 100, 0)], true)
        .evidence,
    ).toBe('unavailable');
  });

  it('requires a fully enumerated, bounded, identity-unique native snapshot', () => {
    expect(observed([track('a', 0, 0, 100, 0)], false).evidence).toBe('unavailable');
    expect(
      observed(Array.from({ length: 1201 }, (_, i) => track('track-' + i, 0, i, 100, i))).evidence,
    ).toBe('unavailable');
    expect(observed([track('dup', 0, 0, 100, 0), track('dup', 10, 0, 20, 0)]).evidence).toBe(
      'unavailable',
    );
    for (const malformed of [
      { ...track('a', 0, 0, 100, 0), net: ' VCC' },
      { ...track('a', 0, 0, 100, 0), layer: 99 },
      { ...track('a', 0, 0, 100, 0), width: 0 },
      { ...track('a', 0, 0, 100, 0), startX: Number.NaN },
      { ...track('a', 0, 0, 100, 0), startY: 1_000_001 },
      { ...track('a', 0, 0, 100, 0), primitiveId: 'a ' },
      { ...track('a', 0, 0, 100, 0), endX: 0 },
    ]) {
      expect(observed([malformed])).toMatchObject({
        evidence: 'unavailable',
        electrical_continuity_status: 'UNKNOWN',
      });
    }
  });

  it('keeps unsupported pad layers, wrong nets and missing pad identity unknown', () => {
    for (const [a, b] of [
      [{ ...first, layer: 99 }, second],
      [first, { ...second, net: 'GND' }],
      [first, { ...second, x: Number.NaN }],
      [{ ...first, net: 'VCC ' }, second],
      [first, { ...second, x: 0, y: 0 }],
    ] as const) {
      expect(observeNativePadRouteChain(a, b, [track('a', 0, 0, 100, 0)], true)).toMatchObject({
        evidence: 'unavailable',
        electrical_continuity_status: 'UNKNOWN',
      });
    }
    expect(observeNativePadRouteChain(undefined, second, [], true).evidence).toBe('unavailable');
    expect(observeNativePadRouteChain(first, undefined, [], true).evidence).toBe('unavailable');
  });

  it('reports one selected layer only and never assumes MULTI pad plating/plane contact', () => {
    const result = observed([track('bottom', 0, 0, 100, 0, 2), track('top', 0, 0, 100, 0, 1)]);
    expect(result).toMatchObject({
      evidence: 'observed_exact_endpoint_chain',
      native_layer: 1,
      primitive_ids: ['top'],
      electrical_continuity_status: 'UNKNOWN',
    });
    expect(result.reasons.join(' ')).toContain('Physical pad contact');
  });
});
