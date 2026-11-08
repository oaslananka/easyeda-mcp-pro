import { describe, expect, it } from 'vitest';
import { reviewNativePlacementPadPair } from '../../../src/pcb-layout/placement-pad-evidence.js';

const ids = { first: 'component-u', second: 'component-c' };
const declaration = { firstPin: '8', secondPin: '1', expectedNet: 'VCC' };
const first = [
  {
    primitiveId: 'component-u/pad8',
    parentComponentPrimitiveId: ids.first,
    padNumber: '8',
    net: 'VCC',
    x: 100,
    y: 0,
    layer: 12,
  },
];
const second = [
  {
    primitiveId: 'component-c/pad1',
    parentComponentPrimitiveId: ids.second,
    padNumber: '1',
    net: 'VCC',
    x: 0,
    y: 0,
    layer: 12,
  },
];
const evaluate = (a: unknown = first, b: unknown = second) =>
  reviewNativePlacementPadPair(declaration, ids, { first: a, second: b });

describe('native placement pad evidence is bounded and never a copper-loop pass', () => {
  it('reports native same-net pad-center distance but never an electrical success', () => {
    const result = evaluate();
    expect(result).toMatchObject({
      first_pin: '8',
      second_pin: '1',
      expected_net: 'VCC',
      native_first_net: 'VCC',
      native_second_net: 'VCC',
      native_pad_layer_codes: [12, 12],
      measured_pad_center_distance_mm: 2.54,
      evidence: 'native_component_pads',
      status: 'UNKNOWN',
      electrical_loop_status: 'UNKNOWN',
    });
    expect(result.reasons.join(' ')).toContain('not routed copper length');
  });

  it('only warns for a source-declared limit or a native net mismatch', () => {
    expect(
      reviewNativePlacementPadPair({ ...declaration, maxCenterDistanceMm: 2 }, ids, {
        first,
        second,
      }),
    ).toMatchObject({
      status: 'WARNING',
      declared_max_pad_center_distance_mm: 2,
      measured_pad_center_distance_mm: 2.54,
      electrical_loop_status: 'UNKNOWN',
    });
    expect(
      reviewNativePlacementPadPair({ ...declaration, maxCenterDistanceMm: 2.54 }, ids, {
        first,
        second,
      }).status,
    ).toBe('UNKNOWN');
    expect(evaluate(first, [{ ...second[0], net: 'GND' }])).toMatchObject({
      status: 'WARNING',
      native_second_net: 'GND',
      electrical_loop_status: 'UNKNOWN',
    });
    expect(
      reviewNativePlacementPadPair({ ...declaration, expectedNet: 'GND' }, ids, {
        first,
        second,
      }).status,
    ).toBe('WARNING');
  });

  it('withholds all measured claims for wrong parent, malformed, missing or duplicate pads', () => {
    for (const data of [
      [],
      null,
      [{ ...first[0], parentComponentPrimitiveId: 'other' }],
      [{ ...first[0], x: Number.NaN }],
      [{ ...first[0], x: 2_000_000 }],
      [{ ...first[0], net: ' VCC' }],
      [{ ...first[0], padNumber: '8 ' }],
      [first[0], first[0]],
      [first[0], { ...first[0], primitiveId: 'other' }],
      Array.from({ length: 129 }, (_, index) => ({
        ...first[0],
        primitiveId: 'pad-' + index,
        padNumber: String(index),
      })),
    ]) {
      const result = evaluate(data, second);
      expect(result).toMatchObject({
        evidence: 'unavailable',
        status: 'UNKNOWN',
        electrical_loop_status: 'UNKNOWN',
      });
      expect(result.measured_pad_center_distance_mm).toBeUndefined();
    }
    expect(
      reviewNativePlacementPadPair(declaration, ids, { first: undefined, second }),
    ).toMatchObject({ evidence: 'unavailable', status: 'UNKNOWN' });
    expect(evaluate([{ ...first[0], net: '' }]).measured_pad_center_distance_mm).toBeUndefined();
    expect(
      reviewNativePlacementPadPair(declaration, ids, {
        first: [{ ...first[0], padNumber: '7' }],
        second,
      }).evidence,
    ).toBe('unavailable');
  });

  it('never combines unrelated components or an absent native source', () => {
    for (const [componentIds, observations] of [
      [undefined, { first, second }],
      [ids, undefined],
      [
        { first: 'same', second: 'same' },
        { first, second },
      ],
    ] as const) {
      expect(reviewNativePlacementPadPair(declaration, componentIds, observations)).toMatchObject({
        status: 'UNKNOWN',
        evidence: 'unavailable',
        electrical_loop_status: 'UNKNOWN',
      });
    }
  });
});
