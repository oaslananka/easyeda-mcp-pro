import { describe, expect, it } from 'vitest';
import { reviewNativePadAssociations } from '../../../src/pcb-layout/placement-pad-connectivity.js';

const expected = {
  firstComponentId: 'native-u3',
  secondComponentId: 'native-c5',
  firstPin: '8',
  secondPin: '1',
  net: 'VCC',
};
const report = (id: string, pad: string, ids: string[]) => ({
  evidence: 'native_reported' as const,
  componentPrimitiveId: id,
  padPrimitiveId: id + '/' + pad,
  padNumber: pad,
  net: 'VCC',
  connected: ids.map((primitiveId) => ({
    primitiveId,
    nativeType: 3,
    net: 'VCC',
    layer: 1,
  })),
});
const first = report('native-u3', '8', ['track1', 'track2']);
const second = report('native-c5', '1', ['track2', 'track3']);

describe('native pad associations remain evidence-only', () => {
  it('lists distinct source-bound pads and shared primitive IDs without physical sign-off', () => {
    expect(reviewNativePadAssociations(first, second, expected)).toMatchObject({
      evidence: 'native_reported',
      first_primitive_ids: ['track1', 'track2'],
      second_primitive_ids: ['track2', 'track3'],
      shared_primitive_ids: ['track2'],
      electrical_continuity_status: 'UNKNOWN',
    });
  });

  it('preserves UNKNOWN when the native reader sees no touching primitives', () => {
    const result = reviewNativePadAssociations(
      report('native-u3', '8', []),
      report('native-c5', '1', []),
      expected,
    );
    expect(result).toMatchObject({
      evidence: 'native_reported',
      shared_primitive_ids: [],
      electrical_continuity_status: 'UNKNOWN',
    });
    expect(result.reasons.join(' ')).toContain('do not prove disconnection');
  });

  it('never accepts spoofed identity, net, missing, too-large or duplicate primitive reads', () => {
    const bad = [
      null,
      {},
      { ...first, componentPrimitiveId: 'other' },
      { ...first, padNumber: '7' },
      { ...first, net: 'GND' },
      { ...first, connected: [{ ...first.connected[0], net: 'GND' }] },
      { ...first, connected: [{ ...first.connected[0], nativeType: null }] },
      { ...first, connected: [{ ...first.connected[0], layer: 1.2 }] },
      { ...first, connected: [first.connected[0], first.connected[0]] },
      { ...first, connected: new Array(129).fill(first.connected[0]) },
      { evidence: 'unavailable', reason: 'beta-getter-not-available' },
    ];
    for (const input of bad) {
      expect(reviewNativePadAssociations(input, second, expected)).toMatchObject({
        evidence: 'unavailable',
        first_primitive_ids: [],
        second_primitive_ids: [],
        shared_primitive_ids: [],
        electrical_continuity_status: 'UNKNOWN',
      });
    }
  });
});
