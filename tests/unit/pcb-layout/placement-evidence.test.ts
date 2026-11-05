import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  reviewPlacementRelations,
  type NativePlacement,
  type PlacementRelation,
} from '../../../src/pcb-layout/placement-evidence.js';

type Case = {
  id: string;
  components: NativePlacement[];
  relation: PlacementRelation;
  expected: { status: 'WARNING' | 'UNKNOWN'; distanceMm?: number };
};
const cases = JSON.parse(
  readFileSync(
    new URL('../../fixtures/engineering-review/placement-relations-cases.json', import.meta.url),
    'utf8',
  ),
) as Case[];

describe('read-only origin-based placement relationship observations', () => {
  it('maintains distinct deterministic cases covering the requested functional relationships', () => {
    expect(cases.length).toBe(9);
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
  });

  it.each(cases)('$id', ({ components, relation, expected }) => {
    const a = reviewPlacementRelations([relation], components, components.length, true);
    const b = reviewPlacementRelations([relation], components, components.length, true);
    expect(a).toEqual(b);
    expect(a.status).toBe(expected.status);
    expect(a.findings[0]?.status).toBe(expected.status);
    if (expected.distanceMm === undefined) {
      expect(a.findings[0]?.measured_center_distance_mm).toBeUndefined();
    } else {
      expect(a.findings[0]?.measured_center_distance_mm).toBeCloseTo(expected.distanceMm, 4);
    }
    expect(a.findings[0]?.electrical_loop_status).toBe('UNKNOWN');
    expect(a.engineering_sign_off).toBe(false);
    expect(a.distance_unit).toBe('mm');
    expect(a.coordinate_unit).toBe('mil');
  });

  it('compares caller-declared native footprint identities without claiming assembly approval', () => {
    const relation: PlacementRelation = {
      first: 'U1',
      second: 'C1',
      kind: 'decoupling',
      firstFootprintName: 'QFN-32',
      secondFootprintName: 'C_0603',
      constraintSource: 'Hypothetical assembly drawing Rev B',
    };
    const components: NativePlacement[] = [
      { primitiveId: 'u1', designator: 'U1', x: 0, y: 0, layer: 1, footprintName: 'QFN-32' },
      { primitiveId: 'c1', designator: 'C1', x: 15, y: 0, layer: 1, footprintName: 'C_0603' },
    ];
    const aligned = reviewPlacementRelations([relation], components, 2, true);
    expect(aligned.findings[0]).toMatchObject({
      status: 'UNKNOWN',
      evidence: 'native_component_origins',
      first_footprint_name: 'QFN-32',
      second_footprint_name: 'C_0603',
      declared_first_footprint_name: 'QFN-32',
      declared_second_footprint_name: 'C_0603',
      electrical_loop_status: 'UNKNOWN',
    });
    expect(aligned.engineering_sign_off).toBe(false);
    expect(aligned.limitations.join(' ')).toMatch(/package dimensions/);

    const mismatch = reviewPlacementRelations(
      [
        {
          ...relation,
          firstFootprintName: 'QFN-48',
          secondFootprintName: 'c_0603',
        },
      ],
      components,
      2,
      true,
    );
    expect(mismatch.status).toBe('WARNING');
    expect(mismatch.findings[0]?.status).toBe('WARNING');
    expect(mismatch.findings[0]?.reasons.join(' ')).toMatch(/first footprint name differs/);
    expect(mismatch.findings[0]?.reasons.join(' ')).toMatch(/second footprint name differs/);
    expect(mismatch.findings[0]?.first_footprint_name).toBe('QFN-32');
  });

  it('fails closed when native footprint evidence is absent or caller identity is invalid', () => {
    const components: NativePlacement[] = [
      { primitiveId: 'u1', designator: 'U1', x: 0, y: 0, layer: 1 },
      { primitiveId: 'c1', designator: 'C1', x: 15, y: 0, layer: 1, footprintName: ' C_0603' },
    ];
    const base: PlacementRelation = {
      first: 'U1',
      second: 'C1',
      kind: 'sensitive-adjacency',
      firstFootprintName: 'QFN-32',
      secondFootprintName: 'C_0603',
      constraintSource: 'Hypothetical assembly source',
    };
    for (const relation of [base, { ...base, firstFootprintName: ' QFN-32 ' }]) {
      const result = reviewPlacementRelations([relation], components, 2, true);
      expect(result.status).toBe('UNKNOWN');
      expect(result.findings[0]?.first_footprint_name).toBeUndefined();
      expect(result.findings[0]?.second_footprint_name).toBeUndefined();
      expect(result.findings[0]?.reasons.join(' ')).toMatch(/missing or ambiguous|invalid/);
      expect(result.engineering_sign_off).toBe(false);
    }
  });

  it('does not manufacture distance evidence from missing identity or non-finite coordinates', () => {
    const relation: PlacementRelation = {
      first: 'U1',
      second: 'C1',
      kind: 'decoupling',
      maxCenterDistanceMm: 2,
      constraintSource: 'caller datasheet note',
    };
    const components: NativePlacement[] = [
      { primitiveId: 'u1', designator: 'U1', x: 0, y: 0, layer: 1 },
      { primitiveId: 'c1', designator: 'C1', x: Infinity, y: 0, layer: 1 },
    ];
    const result = reviewPlacementRelations([relation], components, components.length, true);
    expect(result.status).toBe('UNKNOWN');
    expect(result.findings[0]?.measured_center_distance_mm).toBeUndefined();
    expect(result.findings[0]?.primitive_ids).toEqual([]);
  });

  it('cannot infer a missing component from truncated or unsupported native readers', () => {
    const { relation, components } = cases[6]!;
    for (const [total, available] of [
      [200, true],
      [1, false],
      [1, true],
    ] as const) {
      const result = reviewPlacementRelations(
        [relation],
        available ? components : [],
        total,
        available,
      );
      if (total === 1 && available) continue;
      expect(result.input_evidence.collection_complete).toBe(false);
      expect(result.status).toBe('UNKNOWN');
      expect(result.findings[0]?.evidence).toBe('caller_declared_unverified');
    }
    const empty = reviewPlacementRelations([relation], [], 0, true);
    expect(empty.input_evidence.collection_complete).toBe(false);
    expect(empty.input_evidence.components).toBe('unavailable');
    expect(empty.status).toBe('UNKNOWN');
  });

  it('does not mistake identical or ambiguous designators for a unique native component', () => {
    const first = cases[0]!;
    const duplicate = [
      first.components[0]!,
      { ...first.components[0], primitiveId: 'u1-copy' },
      first.components[1]!,
    ];
    const result = reviewPlacementRelations([first.relation], duplicate, duplicate.length, true);
    expect(result.status).toBe('UNKNOWN');
    expect(result.findings[0]?.measured_center_distance_mm).toBeUndefined();
  });

  it('does not invent physical side/top-bottom meaning from undocumented layer codes', () => {
    const { relation, components } = cases[4]!;
    const result = reviewPlacementRelations(
      [{ ...relation, requireSameLayer: false }],
      components,
      components.length,
      true,
    );
    expect(result.status).toBe('UNKNOWN');
    expect(result.findings[0]?.native_layers).toEqual([1, 2]);
    expect(result.limitations.join(' ')).toMatch(/top\/bottom/);
  });

  it('reports invalid caller distance limits instead of silently treating them as satisfied', () => {
    const { components, relation } = cases[0]!;
    for (const maxCenterDistanceMm of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const result = reviewPlacementRelations(
        [{ ...relation, maxCenterDistanceMm }],
        components,
        components.length,
        true,
      );
      const finding = result.findings[0];
      expect(finding?.status).toBe('UNKNOWN');
      expect(finding?.reasons.join(' ')).toMatch(/invalid/i);
      expect(finding?.declared_max_center_distance_mm).toBeUndefined();
      expect(result.engineering_sign_off).toBe(false);
    }
  });

  it('reports invalid or incomplete caller rotation targets and tolerances', () => {
    const { components, relation } = cases[3]!;
    for (const firstRotationDeg of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = reviewPlacementRelations(
        [{ ...relation, firstRotationDeg }],
        components,
        components.length,
        true,
      );
      expect(result.findings[0]?.reasons.join(' ')).toMatch(/invalid/i);
      expect(result.findings[0]?.declared_first_rotation_deg).toBeUndefined();
    }
    for (const rotationToleranceDeg of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const result = reviewPlacementRelations(
        [{ ...relation, firstRotationDeg: 270, rotationToleranceDeg }],
        components,
        components.length,
        true,
      );
      expect(result.findings[0]?.status).toBe('UNKNOWN');
      expect(result.findings[0]?.reasons.join(' ')).toMatch(/invalid/i);
    }
    const withoutTarget = reviewPlacementRelations(
      [{ ...relation, firstRotationDeg: undefined, rotationToleranceDeg: 10 }],
      components,
      components.length,
      true,
    );
    expect(withoutTarget.findings[0]?.reasons.join(' ')).toMatch(/without a rotation target/i);
  });

  it('checks independently declared second-component orientation without making an electrical PASS', () => {
    const components: NativePlacement[] = [
      { primitiveId: 'j1', designator: 'J1', x: 0, y: 0, layer: 1, rotation: 0 },
      { primitiveId: 'd1', designator: 'D1', x: 35, y: 0, layer: 1, rotation: -10 },
    ];
    const relation: PlacementRelation = {
      first: 'J1',
      second: 'D1',
      kind: 'esd-entry',
      secondRotationDeg: 350,
      secondRotationToleranceDeg: 0,
      constraintSource: 'Example device assembly drawing, revision B',
    };
    const aligned = reviewPlacementRelations([relation], components, 2, true);
    expect(aligned.findings[0]).toMatchObject({
      status: 'UNKNOWN',
      second_rotation_deg: -10,
      declared_second_rotation_deg: 350,
      electrical_loop_status: 'UNKNOWN',
      constraint_source: 'Example device assembly drawing, revision B',
    });
    expect(aligned.engineering_sign_off).toBe(false);
    const misaligned = reviewPlacementRelations(
      [{ ...relation, secondRotationDeg: 320, secondRotationToleranceDeg: 5 }],
      components,
      2,
      true,
    );
    expect(misaligned.findings[0]).toMatchObject({
      status: 'WARNING',
      declared_second_rotation_deg: 320,
      second_rotation_deg: -10,
    });
    expect(misaligned.findings[0]?.reasons.join(' ')).toContain(
      'Second component rotation exceeds',
    );
  });

  it('keeps missing or invalid second rotation observations explicitly UNKNOWN', () => {
    const components: NativePlacement[] = [
      { primitiveId: 'j1', designator: 'J1', x: 0, y: 0, layer: 1 },
      { primitiveId: 'd1', designator: 'D1', x: 35, y: 0, layer: 1 },
    ];
    const basic: PlacementRelation = {
      first: 'J1',
      second: 'D1',
      kind: 'esd-entry',
      constraintSource: 'Caller-owned layout drawing',
    };
    const cases: PlacementRelation[] = [
      { ...basic, secondRotationDeg: 90 },
      { ...basic, secondRotationDeg: 90, secondRotationToleranceDeg: -1 },
      { ...basic, secondRotationToleranceDeg: 10 },
      { ...basic, secondRotationDeg: Number.POSITIVE_INFINITY },
    ];
    for (const relation of cases) {
      const result = reviewPlacementRelations([relation], components, 2, true);
      expect(result.findings[0]?.status).toBe('UNKNOWN');
      expect(result.findings[0]?.reasons.join(' ')).toMatch(/second component/i);
    }
  });

  it('does not treat two designators with the same primitive ID as two separate native footprints', () => {
    const components: NativePlacement[] = [
      { primitiveId: 'same-id', designator: 'U1', x: 0, y: 0, layer: 1 },
      { primitiveId: 'same-id', designator: 'C1', x: 500, y: 0, layer: 1 },
    ];
    const result = reviewPlacementRelations(
      [
        {
          first: 'U1',
          second: 'C1',
          kind: 'decoupling',
          maxCenterDistanceMm: 1,
          constraintSource: 'Caller-provided layout limit',
        },
      ],
      components,
      components.length,
      true,
    );
    expect(result.findings[0]).toMatchObject({ status: 'UNKNOWN', primitive_ids: [] });
    expect(result.findings[0]?.measured_center_distance_mm).toBeUndefined();
  });

  it('rejects a reused native primitive identity outside the selected assembly pair', () => {
    const relation: PlacementRelation = {
      first: 'U1',
      second: 'C1',
      kind: 'decoupling',
      maxCenterDistanceMm: 1,
      firstFootprintName: 'QFN-32',
      constraintSource: 'Caller-owned assembly drawing',
    };
    const components: NativePlacement[] = [
      { primitiveId: 'u1', designator: 'U1', x: 0, y: 0, layer: 1, footprintName: 'QFN-32' },
      { primitiveId: 'c1', designator: 'C1', x: 500, y: 0, layer: 1 },
      { primitiveId: 'u1', designator: 'R7', x: 800, y: 0, layer: 1 },
    ];
    for (const inventory of [
      components,
      [{ ...components[0], primitiveId: ' u1' }, ...components.slice(1)],
    ]) {
      const result = reviewPlacementRelations([relation], inventory, inventory.length, true);
      expect(result.input_evidence.collection_complete).toBe(false);
      expect(result.status).toBe('UNKNOWN');
      expect(result.findings[0]).toMatchObject({
        status: 'UNKNOWN',
        evidence: 'caller_declared_unverified',
        primitive_ids: [],
        electrical_loop_status: 'UNKNOWN',
      });
      expect(result.findings[0]?.measured_center_distance_mm).toBeUndefined();
      expect(result.findings[0]?.first_footprint_name).toBeUndefined();
      expect(result.engineering_sign_off).toBe(false);
    }
  });

  it('compares rotation modulo 360 but requires explicitly declared limits', () => {
    const data: NativePlacement[] = [
      { primitiveId: 'u1', designator: 'U1', x: 0, y: 0, layer: 1, rotation: -10 },
      { primitiveId: 'c1', designator: 'C1', x: 20, y: 0, layer: 1, rotation: 0 },
    ];
    const base = {
      first: 'U1',
      second: 'C1',
      kind: 'decoupling' as const,
      firstRotationDeg: 350,
      rotationToleranceDeg: 0,
      constraintSource: 'caller mechanical note',
    };
    const r = reviewPlacementRelations([base], data, data.length, true);
    expect(r.status).toBe('UNKNOWN');
    const violated = reviewPlacementRelations(
      [{ ...base, firstRotationDeg: 320 }],
      data,
      data.length,
      true,
    );
    expect(violated.status).toBe('WARNING');
  });
});
