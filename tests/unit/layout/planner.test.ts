import { describe, expect, it } from 'vitest';

import {
  planFunctionalLayout,
  type FunctionalLayoutComponent,
} from '../../../src/layout/planner.js';
import { boundsOverlap, type SchematicSheetGeometry } from '../../../src/schematic-engine/geometry.js';

function sheet(pageSize: 'A4' | 'A3'): SchematicSheetGeometry {
  const a3 = pageSize === 'A3';
  return {
    bounds: { x: 0, y: 0, width: a3 ? 1682 : 1189, height: a3 ? 1189 : 841 },
    drawableBounds: { x: 40, y: 40, width: a3 ? 1602 : 1109, height: a3 ? 1109 : 761 },
    grid: 10,
    units: 'easyeda-coordinate',
    pageSize,
    coordinateOrigin: { x: 0, y: 0, yAxis: 'up', source: 'live-readback' },
    geometrySource: 'live-readback',
    titleBlockBounds: a3
      ? { x: 1200, y: 40, width: 442, height: 220 }
      : { x: 800, y: 40, width: 349, height: 180 },
  };
}

const ne555: FunctionalLayoutComponent[] = [
  { id: 'U1', blockId: 'timing', role: 'main', renderedSize: { width: 120, height: 80 } },
  { id: 'R1', blockId: 'timing', role: 'feedback-network', parentId: 'U1', renderedSize: { width: 40, height: 20 } },
  { id: 'R2', blockId: 'timing', role: 'feedback-network', parentId: 'U1', renderedSize: { width: 40, height: 20 } },
  { id: 'C1', blockId: 'timing', role: 'decoupling-capacitor', parentId: 'U1', renderedSize: { width: 30, height: 30 } },
  { id: 'J1', blockId: 'io', role: 'main', renderedSize: { width: 80, height: 60 } },
  { id: 'R3', blockId: 'io', role: 'led-current-limit', parentId: 'J1', renderedSize: { width: 40, height: 20 } },
];

describe('deterministic functional layout planner', () => {
  it('reserves support space before placing NE555 blocks and returns repeatable grid coordinates', () => {
    const input = {
      sheet: sheet('A4'),
      components: ne555,
      existingOccupiedRegions: [
        { id: 'existing-note', kind: 'existing-object' as const, bounds: { x: 40, y: 680, width: 180, height: 80 } },
      ],
      constraints: { maximumSupportDistanceByRole: { 'decoupling-capacitor': 80 } },
    };
    const first = planFunctionalLayout(input);
    const second = planFunctionalLayout(input);

    expect(first).toEqual(second);
    expect(first.feasible).toBe(true);
    expect(first.layoutHash).toBe(second.layoutHash);
    expect(first.blockReservations).toHaveLength(2);
    expect(first.supportReservations.length).toBeGreaterThan(0);
    expect(first.occupancyMap.some((region) => region.id === 'existing-note')).toBe(true);
    expect(first.placements.every((placement) => placement.origin.x % 10 === 0 && placement.origin.y % 10 === 0)).toBe(true);
    expect(first.placements.every((placement) => [0, 90, 180, 270].includes(placement.rotation))).toBe(true);
    const firstSupport = first.placementOrder.findIndex((id) => id !== 'U1' && id !== 'J1');
    expect(first.placementOrder.indexOf('U1')).toBeLessThan(firstSupport);
    expect(first.placementOrder.indexOf('J1')).toBeLessThan(firstSupport);
    const existing = first.occupancyMap.find((region) => region.id === 'existing-note')!;
    expect(first.blockReservations.every((block) => !boundsOverlap(block.bounds, existing.bounds))).toBe(true);
  });

  it('groups a repeatable RP2040-style main device with reserved support roles', () => {
    const rp2040: FunctionalLayoutComponent[] = [
      { id: 'U1', blockId: 'mcu', role: 'main', renderedSize: { width: 180, height: 160 } },
      { id: 'C1', blockId: 'mcu', role: 'decoupling-capacitor', parentId: 'U1', renderedSize: { width: 30, height: 30 } },
      { id: 'C2', blockId: 'mcu', role: 'bulk-capacitor', parentId: 'U1', renderedSize: { width: 30, height: 30 } },
      { id: 'R1', blockId: 'mcu', role: 'boot-strap', parentId: 'U1', renderedSize: { width: 40, height: 20 } },
      { id: 'TP1', blockId: 'mcu', role: 'test-point', parentId: 'U1', renderedSize: { width: 20, height: 20 } },
      { id: 'J1', blockId: 'usb', role: 'main', renderedSize: { width: 100, height: 80 } },
      { id: 'D1', blockId: 'usb', role: 'connector-protection', parentId: 'J1', renderedSize: { width: 50, height: 30 } },
      { id: 'L1', blockId: 'usb', role: 'connector-filter', parentId: 'J1', renderedSize: { width: 50, height: 30 } },
    ];
    const plan = planFunctionalLayout({ sheet: sheet('A4'), components: rp2040 });
    expect(plan.feasible).toBe(true);
    expect(plan.supportReservations.map((reservation) => reservation.role)).toEqual(
      expect.arrayContaining([
        'decoupling-capacitor',
        'bulk-capacitor',
        'boot-strap',
        'test-point',
        'connector-protection',
        'connector-filter',
      ]),
    );
    expect(plan.score.rationale.some((line) => line.includes('units from its parent'))).toBe(true);
  });

  it('recommends A3 only after an exact A4 infeasibility proof', () => {
    const oversized: FunctionalLayoutComponent[] = [
      { id: 'U1', blockId: 'wide', role: 'main', renderedSize: { width: 1150, height: 120 } },
    ];
    const plan = planFunctionalLayout({
      sheet: sheet('A4'),
      a3FallbackSheet: sheet('A3'),
      allowA3Fallback: true,
      components: oversized,
    });

    expect(plan.feasible).toBe(true);
    expect(plan.selectedSheet.pageSize).toBe('A3');
    expect(plan.pageSuitability.attempts).toHaveLength(2);
    expect(plan.pageSuitability.attempts[0]).toMatchObject({ pageSize: 'A4', feasible: false });
    expect(plan.pageSuitability.attempts[0]?.unsatisfiedConstraints.length).toBeGreaterThan(0);
    expect(plan.pageSuitability.a3FallbackRationale).toContain('A4 was proven infeasible');
  });

  it('does not inspect A3 when A4 satisfies readability constraints', () => {
    const plan = planFunctionalLayout({
      sheet: sheet('A4'),
      a3FallbackSheet: sheet('A3'),
      allowA3Fallback: true,
      components: ne555,
    });
    expect(plan.selectedSheet.pageSize).toBe('A4');
    expect(plan.pageSuitability.attempts).toHaveLength(1);
    expect(plan.pageSuitability.a3FallbackRationale).toBeUndefined();
  });

  it('reports exact unsatisfied constraints rather than arbitrary component coordinates', () => {
    const plan = planFunctionalLayout({
      sheet: sheet('A4'),
      components: [{ id: 'U1', blockId: 'impossible', role: 'main', renderedSize: { width: 1500, height: 900 } }],
    });
    expect(plan.feasible).toBe(false);
    expect(plan.placements).toEqual([]);
    expect(plan.conflicts.length).toBeGreaterThan(0);
    expect(plan.pageSuitability.attempts[0]?.unsatisfiedConstraints).toContain('PAGE_BORDER_KEEP_OUT');
  });
});
