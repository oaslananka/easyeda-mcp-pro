import { describe, expect, it } from 'vitest';
import { rankPlacementReview } from '../../../src/pcb-layout/placement-priorities.js';
import type { NativePadPairFinding } from '../../../src/pcb-layout/placement-pad-evidence.js';
import type { PlacementFinding } from '../../../src/pcb-layout/placement-evidence.js';

const finding = (id: string, overrides: Partial<PlacementFinding> = {}): PlacementFinding => ({
  id,
  relation: 'switching-loop',
  components: ['U1', 'C1'],
  primitive_ids: ['u', 'c'],
  status: 'UNKNOWN',
  evidence: 'native_component_origins',
  electrical_loop_status: 'UNKNOWN',
  reasons: [],
  ...overrides,
});
const pad: NativePadPairFinding = {
  first_pin: '1',
  second_pin: '1',
  expected_net: 'VIN',
  native_first_net: 'VIN',
  native_second_net: 'VIN',
  evidence: 'native_component_pads',
  status: 'UNKNOWN',
  electrical_loop_status: 'UNKNOWN',
  reasons: [],
};
const issue = {
  code: 'POWER_REGULATOR_OVERLOAD',
  severity: 'error',
  componentRef: 'U1',
  railName: 'VIN',
} as const;

describe('placement review priorities (not electrical risk or sign-off)', () => {
  it('prioritizes a native net mismatch over a declared distance warning, independent of input order', () => {
    const a = finding('mismatch', {
      status: 'WARNING',
      pad_pairs: [{ ...pad, status: 'WARNING', native_second_net: 'OTHER' }],
    });
    const b = finding('requirement', { status: 'WARNING', constraint_source: 'Device drawing' });
    const provenance = new Map([['requirement', 'datasheet-requirement' as const]]);
    for (const findings of [
      [a, b],
      [b, a],
    ]) {
      const before = [...findings];
      const result = rankPlacementReview(findings, provenance, []);
      expect(result.map((x) => [x.finding_id, x.action])).toEqual([
        ['mismatch', 'verify-net-mismatch'],
        ['requirement', 'review-declared-requirement'],
      ]);
      expect(findings).toEqual(before);
    }
  });

  it('correlates caller-supplied power analysis only with exact native net and component identities', () => {
    const observed = finding('observed', { pad_pairs: [{ ...pad }] });
    const missing = finding('missing', { pad_pairs: [{ ...pad, evidence: 'unavailable' }] });
    const unrelated = finding('unrelated', { components: ['U2', 'C2'], pad_pairs: [{ ...pad }] });
    const result = rankPlacementReview([missing, unrelated, observed], new Map(), [issue]);
    expect(result[0]).toMatchObject({
      finding_id: 'observed',
      action: 'review-power-context',
      power_context: [issue],
      electrical_loop_status: 'UNKNOWN',
    });
    expect(result.slice(1).every((x) => x.power_context.length === 0)).toBe(true);
    expect(
      rankPlacementReview([observed], new Map(), [{ ...issue, railName: 'vin' }])[0]?.power_context,
    ).toEqual([]);
  });

  it('prioritizes observed selected-line deviations over generic advice but below matched power context and requirements', () => {
    const width = {
      evidence: 'native_reported_centre',
      status: 'WARNING',
      declared_min_line_width_mm: 0.5,
      observed_min_line_width_mm: 0.254,
      narrowest_line_ids: ['narrow'],
      electrical_continuity_status: 'UNKNOWN',
      reasons: [],
    } as const;
    const w = finding('width', {
      status: 'WARNING',
      pad_pairs: [
        {
          ...pad,
          selected_line_width_review: {
            ...width,
            narrowest_line_ids: [...width.narrowest_line_ids],
          },
        },
      ],
    });
    const advice = finding('advice', { status: 'WARNING' });
    const requirement = finding('requirement', { ...w, id: 'requirement' });
    const power = finding('power', { components: ['U2', 'C2'], pad_pairs: [{ ...pad }] });
    const result = rankPlacementReview(
      [advice, w, power, requirement],
      new Map([['requirement', 'datasheet-requirement']]),
      [{ ...issue, componentRef: 'U2' }],
    );
    expect(result.map((x) => x.action)).toEqual([
      'review-declared-requirement',
      'review-power-context',
      'review-selected-line-width',
      'review-observed-warning',
    ]);
    expect(result[0]?.width_deviations).toEqual(result[2]?.width_deviations);
    expect(result[2]?.width_deviations).toEqual([
      {
        first_pin: '1',
        second_pin: '1',
        expected_net: 'VIN',
        narrowest_line_ids: ['narrow'],
        observed_min_line_width_mm: 0.254,
        declared_min_line_width_mm: 0.5,
      },
    ]);
    expect(result[3]?.width_deviations).toBeUndefined();
  });

  it('keeps advisory, unknown provenance and missing evidence distinct without physical risk scores', () => {
    const a = finding('advice', { status: 'WARNING', constraint_source: 'Layout example' });
    const b = finding('unknown');
    const result = rankPlacementReview([b, a], new Map([['advice', 'advisory']]), []);
    expect(
      result.map((x) => [x.action, x.constraint_source_kind, x.electrical_loop_status]),
    ).toEqual([
      ['review-observed-warning', 'advisory', 'UNKNOWN'],
      ['collect-topology-evidence', 'unspecified', 'UNKNOWN'],
    ]);
    expect(a.status).toBe('WARNING');
    expect(b.status).toBe('UNKNOWN');
  });
});
