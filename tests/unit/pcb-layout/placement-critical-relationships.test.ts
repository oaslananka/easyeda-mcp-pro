import { describe, expect, it } from 'vitest';
import {
  reviewNativePlacementPadPair,
  type NativePadPairDeclaration,
} from '../../../src/pcb-layout/placement-pad-evidence.js';
import {
  reviewPlacementRelations,
  type NativePlacement,
  type PlacementRelation,
} from '../../../src/pcb-layout/placement-evidence.js';
import type { NativeTrack } from '../../../src/pcb-layout/route-review.js';

// Synthetic data exercises documented acceptance boundaries. It is NOT a
// replacement for a real, version-matched disposable EasyEDA PCB observation.
type Net = 'VCC' | 'GND' | 'VIN' | 'PGND' | 'SW' | 'XTAL_IN' | 'XTAL_OUT' | 'ESD';
const ids = { first: 'part-1', second: 'part-2' };
const pad = (parent: string, pin: string, net: Net, x: number, y: number, layer: number) => ({
  primitiveId: parent + ':' + pin,
  parentComponentPrimitiveId: parent,
  padNumber: pin,
  net,
  x,
  y,
  layer,
});
const trace = (
  primitiveId: string,
  net: Net,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  layer = 1,
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
const reviewPads = (
  declaration: NativePadPairDeclaration,
  first: ReturnType<typeof pad>[],
  second: ReturnType<typeof pad>[],
  tracks: NativeTrack[],
  complete = true,
) => reviewNativePlacementPadPair(declaration, ids, { first, second }, { tracks, complete });

describe('#842 synthetic source-specific placement acceptance matrix (not native PCB acceptance)', () => {
  it('distinguishes nearby vs distant decoupling VIN/GND paths without false loop PASS', () => {
    const declarations = [
      { firstPin: '8', secondPin: '1', expectedNet: 'VCC', maxCenterDistanceMm: 2 },
      { firstPin: '4', secondPin: '2', expectedNet: 'GND', maxCenterDistanceMm: 2 },
    ];
    const u = [pad(ids.first, '8', 'VCC', 0, 0, 12), pad(ids.first, '4', 'GND', 0, 30, 12)];
    const close = [pad(ids.second, '1', 'VCC', 40, 0, 12), pad(ids.second, '2', 'GND', 40, 30, 12)];
    const far = [pad(ids.second, '1', 'VCC', 360, 0, 12), pad(ids.second, '2', 'GND', 360, 30, 12)];
    const tracks = [trace('vcc1', 'VCC', 0, 0, 40, 0), trace('gnd1', 'GND', 0, 30, 40, 30)];
    const nearFindings = declarations.map((d) => reviewPads(d, u, close, tracks));
    const farFindings = declarations.map((d) => reviewPads(d, u, far, tracks));
    expect(nearFindings.map((p) => p.status)).toEqual(['UNKNOWN', 'UNKNOWN']);
    expect(nearFindings.map((p) => p.route_chain?.evidence)).toEqual([
      'observed_exact_endpoint_chain',
      'observed_exact_endpoint_chain',
    ]);
    expect(nearFindings.map((p) => p.measured_pad_center_distance_mm)).toEqual([1.016, 1.016]);
    expect(farFindings.map((p) => p.status)).toEqual(['WARNING', 'WARNING']);
    expect(farFindings.map((p) => p.route_chain?.evidence)).toEqual(['unavailable', 'unavailable']);
    expect(farFindings.map((p) => p.measured_pad_center_distance_mm)).toEqual([9.144, 9.144]);
    for (const p of [...nearFindings, ...farFindings]) {
      expect(p.electrical_loop_status).toBe('UNKNOWN');
      expect(p.route_chain?.electrical_continuity_status).toBe('UNKNOWN');
    }
  });

  it('does not invent a closed buck power/return loop when VIN is routed but PGND and SW are not', () => {
    const a = [
      pad(ids.first, '1', 'VIN', 0, 0, 12),
      pad(ids.first, '2', 'PGND', 0, 80, 12),
      pad(ids.first, '3', 'SW', 0, 120, 1),
    ];
    const b = [
      pad(ids.second, '1', 'VIN', 100, 0, 12),
      pad(ids.second, '2', 'PGND', 100, 80, 12),
      pad(ids.second, '3', 'SW', 100, 120, 2),
    ];
    const segments = [
      trace('vin', 'VIN', 0, 0, 100, 0),
      trace('ground-top', 'PGND', 0, 80, 50, 80),
      trace('ground-bottom', 'PGND', 50, 80, 100, 80, 2),
      trace('sw', 'SW', 0, 120, 100, 120),
    ];
    const findings = [
      reviewPads(
        { firstPin: '1', secondPin: '1', expectedNet: 'VIN', maxCenterDistanceMm: 3 },
        a,
        b,
        segments,
      ),
      reviewPads({ firstPin: '2', secondPin: '2', expectedNet: 'PGND' }, a, b, segments),
      reviewPads({ firstPin: '3', secondPin: '3', expectedNet: 'SW' }, a, b, segments),
    ];
    expect(findings.map((p) => p.route_chain?.evidence)).toEqual([
      'observed_exact_endpoint_chain',
      'unavailable',
      'unavailable',
    ]);
    expect(findings.every((p) => p.electrical_loop_status === 'UNKNOWN')).toBe(true);
    expect(findings.every((p) => p.status === 'UNKNOWN')).toBe(true);
  });

  it('keeps crystal IN/OUT paths separate and enforces only explicitly declared rotation', () => {
    const components: NativePlacement[] = [
      { primitiveId: 'osc', designator: 'Y1', x: 0, y: 0, layer: 1, rotation: -90 },
      { primitiveId: 'mcu', designator: 'U1', x: 60, y: 0, layer: 1, rotation: 0 },
    ];
    const relation: PlacementRelation = {
      kind: 'crystal',
      first: 'Y1',
      second: 'U1',
      firstRotationDeg: 270,
      rotationToleranceDeg: 2,
      constraintSource: 'Synthetic caller-owned drawing',
    };
    expect(reviewPlacementRelations([relation], components, 2, true).findings[0]?.status).toBe(
      'UNKNOWN',
    );
    expect(
      reviewPlacementRelations([{ ...relation, firstRotationDeg: 180 }], components, 2, true)
        .findings[0]?.status,
    ).toBe('WARNING');
    const a = [pad(ids.first, '1', 'XTAL_IN', 0, 0, 1), pad(ids.first, '2', 'XTAL_OUT', 0, 20, 1)];
    const b = [
      pad(ids.second, '8', 'XTAL_IN', 60, 0, 1),
      pad(ids.second, '9', 'XTAL_OUT', 60, 20, 1),
    ];
    const segments = [
      trace('xin', 'XTAL_IN', 0, 0, 60, 0),
      trace('xout', 'XTAL_OUT', 0, 20, 60, 20),
    ];
    const input = reviewPads(
      { firstPin: '1', secondPin: '8', expectedNet: 'XTAL_IN' },
      a,
      b,
      segments,
    );
    const output = reviewPads(
      { firstPin: '2', secondPin: '9', expectedNet: 'XTAL_OUT' },
      a,
      b,
      segments,
    );
    expect(input.route_chain?.primitive_ids).toEqual(['xin']);
    expect(output.route_chain?.primitive_ids).toEqual(['xout']);
    expect([input, output].every((p) => p.electrical_loop_status === 'UNKNOWN')).toBe(true);
  });

  it('warns on caller-sourced ESD same-side mismatch without universal side/angle rules', () => {
    const components: NativePlacement[] = [
      { primitiveId: 'j1', designator: 'J1', x: 0, y: 0, layer: 1, rotation: 90 },
      { primitiveId: 'd1', designator: 'D1', x: 20, y: 0, layer: 2, rotation: 270 },
    ];
    const relation: PlacementRelation = {
      kind: 'esd-entry',
      first: 'J1',
      second: 'D1',
      requireSameLayer: true,
      secondRotationDeg: 270,
      secondRotationToleranceDeg: 1,
      constraintSource: 'Synthetic source-specific assembly requirement',
    };
    const warned = reviewPlacementRelations([relation], components, 2, true);
    expect(warned.findings[0]).toMatchObject({
      status: 'WARNING',
      native_layers: [1, 2],
      electrical_loop_status: 'UNKNOWN',
    });
    const advisory = reviewPlacementRelations(
      [
        {
          ...relation,
          requireSameLayer: false,
          secondRotationDeg: undefined,
          secondRotationToleranceDeg: undefined,
        },
      ],
      components,
      2,
      true,
    );
    expect(advisory.findings[0]?.status).toBe('UNKNOWN');
    expect(advisory.engineering_sign_off).toBe(false);
    const physical = reviewPads(
      { firstPin: '1', secondPin: '1', expectedNet: 'ESD' },
      [pad(ids.first, '1', 'ESD', 0, 0, 1)],
      [pad(ids.second, '1', 'ESD', 20, 0, 2)],
      [trace('top-only', 'ESD', 0, 0, 20, 0, 1)],
    );
    expect(physical.route_chain?.evidence).toBe('unavailable');
    expect(physical.electrical_loop_status).toBe('UNKNOWN');
  });

  it('never accepts a truncated route inventory, even with perfect endpoint matches', () => {
    const finding = reviewPads(
      { firstPin: '8', secondPin: '1', expectedNet: 'VCC' },
      [pad(ids.first, '8', 'VCC', 0, 0, 1)],
      [pad(ids.second, '1', 'VCC', 100, 0, 1)],
      [trace('a', 'VCC', 0, 0, 100, 0)],
      false,
    );
    expect(finding).toMatchObject({
      status: 'UNKNOWN',
      route_chain: {
        evidence: 'unavailable',
        primitive_ids: [],
        electrical_continuity_status: 'UNKNOWN',
      },
      electrical_loop_status: 'UNKNOWN',
    });
  });
});
