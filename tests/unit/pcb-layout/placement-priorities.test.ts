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

  const sourcedPad = { ...pad, native_pad_primitive_ids: ['pad-a', 'pad-b'] };
  const exact = {
    evidence: 'observed_exact_endpoint_chain' as const,
    selection: 'fewest_segments' as const,
    primitive_ids: ['exact-line'],
    native_layer: 1,
    observed_centerline_length_mm: 1,
    reasons: [],
    electrical_continuity_status: 'UNKNOWN' as const,
  };
  const associated = {
    evidence: 'native_reported_centre' as const,
    first_primitive_ids: ['start'],
    second_primitive_ids: ['end'],
    shared_primitive_ids: [],
    reasons: [],
    electrical_continuity_status: 'UNKNOWN' as const,
    associated_route_chain: {
      evidence: 'observed_associated_endpoint_chain' as const,
      selection: 'fewest_segments' as const,
      primitive_ids: ['start', 'end'],
      native_layer: 1,
      observed_full_segment_length_mm: 2,
      reasons: [],
      electrical_continuity_status: 'UNKNOWN' as const,
    },
  };
  it('distinguishes existing native line-chain evidence from a missing pair without electrical PASS', () => {
    const first = finding('observed', {
      pad_pairs: [
        { ...sourcedPad, route_chain: exact },
        {
          ...sourcedPad,
          first_pin: '2',
          second_pin: '2',
          expected_net: 'GND',
          native_first_net: 'GND',
          native_second_net: 'GND',
          native_pad_primitive_ids: ['pad-c', 'pad-d'],
          native_pad_associations: associated,
        },
      ],
    });
    const mixed = finding('mixed', {
      pad_pairs: [
        { ...sourcedPad, native_pad_associations: associated },
        {
          ...sourcedPad,
          first_pin: '2',
          second_pin: '2',
          expected_net: 'GND',
          native_first_net: 'GND',
          native_second_net: 'GND',
          native_pad_primitive_ids: ['pad-c', 'pad-d'],
        },
      ],
    });
    const result = rankPlacementReview([first, mixed], new Map(), []);
    expect(result[0]?.line_path_evidence).toEqual([
      {
        first_pin: '1',
        second_pin: '1',
        expected_net: 'VIN',
        native_pad_primitive_ids: ['pad-a', 'pad-b'],
        evidence: 'observed_exact_endpoint_chain',
        primitive_ids: ['exact-line'],
        native_layer: 1,
        electrical_continuity_status: 'UNKNOWN',
      },
      {
        first_pin: '2',
        second_pin: '2',
        expected_net: 'GND',
        native_pad_primitive_ids: ['pad-c', 'pad-d'],
        evidence: 'native_reported_centre',
        primitive_ids: ['start', 'end'],
        native_layer: 1,
        electrical_continuity_status: 'UNKNOWN',
      },
    ]);
    expect(result[0]?.next_step).toContain('Review the observed line chains');
    expect(result[1]?.line_path_evidence?.map((p) => p.evidence)).toEqual([
      'native_reported_centre',
      'unavailable',
    ]);
    expect(result[1]?.next_step).toContain('Collect the missing line-chain evidence');
    expect(
      result.every(
        (p) => p.action === 'collect-topology-evidence' && p.electrical_loop_status === 'UNKNOWN',
      ),
    ).toBe(true);
  });

  it('prefers exact chains and refuses to attribute incomplete or contradictory pad identities', () => {
    const observed = { ...sourcedPad, route_chain: exact, native_pad_associations: associated };
    const result = rankPlacementReview(
      [
        finding('exact', { pad_pairs: [observed] }),
        finding('broad', {
          pad_pairs: [
            {
              ...sourcedPad,
              native_pad_associations: { ...associated, evidence: 'native_reported' },
            },
          ],
        }),
        finding('mismatch', { pad_pairs: [{ ...observed, native_second_net: 'OTHER' }] }),
        finding('duplicate', {
          pad_pairs: [{ ...observed, native_pad_primitive_ids: ['pad-a', 'pad-a'] }],
        }),
        finding('empty', {
          pad_pairs: [{ ...observed, route_chain: { ...exact, primitive_ids: [] } }],
        }),
      ],
      new Map(),
      [],
    );
    const byId = new Map(result.map((r) => [r.finding_id, r]));
    expect(byId.get('exact')?.line_path_evidence?.[0]?.evidence).toBe(
      'observed_exact_endpoint_chain',
    );
    expect(byId.get('broad')?.line_path_evidence?.[0]?.evidence).toBe('native_reported');
    for (const id of ['mismatch', 'duplicate', 'empty']) {
      const p = byId.get(id)?.line_path_evidence?.[0];
      expect(p).toMatchObject({
        evidence: 'unavailable',
        primitive_ids: [],
        electrical_continuity_status: 'UNKNOWN',
      });
      expect(p?.native_layer).toBeUndefined();
    }
    expect(result[0]?.action).toBe('verify-net-mismatch');
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
