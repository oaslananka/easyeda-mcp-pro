import { describe, expect, it } from 'vitest';

import { checkPlacement, selectSafeRegion } from '../../../src/layout/placement.js';
import type { SchematicSheetGeometry } from '../../../src/schematic-engine/geometry.js';

function a4Sheet(yAxis: 'up' | 'down' = 'up'): SchematicSheetGeometry {
  return {
    bounds: { x: 0, y: 0, width: 1189, height: 841 },
    drawableBounds: { x: 40, y: 40, width: 1109, height: 761 },
    grid: 10,
    units: 'easyeda-coordinate',
    pageSize: 'A4',
    coordinateOrigin: { x: 0, y: 0, yAxis, source: 'live-readback' },
    geometrySource: 'live-readback',
    titleBlockBounds: { x: 800, y: 40, width: 349, height: 180 },
  };
}

describe('placement constraints and safe regions', () => {
  it('maps upper-left from live bottom-left coordinates without viewport assumptions', () => {
    const result = selectSafeRegion({
      sheet: a4Sheet('up'),
      size: { width: 120, height: 80 },
      preference: 'upper-left',
    });
    expect(result.feasible).toBe(true);
    expect(result.candidate?.origin.x).toBeLessThan(100);
    expect(result.candidate?.origin.y).toBeGreaterThan(650);
    expect(result.check.conflicts).toHaveLength(1);
    expect(result.rationale[0]).toContain('Y-axis up');
  });

  it('rejects a rendered body entering title block even when its origin remains outside', () => {
    const result = checkPlacement({
      sheet: a4Sheet(),
      candidate: {
        origin: { x: 780, y: 230 },
        rotation: 0,
        combinedBounds: { x: 790, y: 200, width: 30, height: 50 },
      },
      minimumClearance: 0,
    });
    expect(result.accepted).toBe(false);
    expect(result.conflicts.map((conflict) => conflict.code)).toContain('TITLE_BLOCK_KEEP_OUT');
    expect(result.suggestedAlternatives.length).toBeGreaterThan(0);
  });

  it('treats caller reservations and existing unrelated primitives as occupied', () => {
    const input = {
      sheet: a4Sheet(),
      candidate: {
        origin: { x: 100, y: 700 },
        rotation: 0 as const,
        combinedBounds: { x: 100, y: 700, width: 80, height: 40 },
      },
      reservedRegions: [
        {
          id: 'reserved-power',
          kind: 'caller-reserved' as const,
          bounds: { x: 90, y: 690, width: 120, height: 70 },
        },
      ],
      occupiedRegions: [
        {
          id: 'existing-R1',
          kind: 'existing-object' as const,
          primitiveId: 'R1',
          bounds: { x: 220, y: 690, width: 60, height: 40 },
        },
      ],
      minimumClearance: 10,
    };
    const first = checkPlacement(input);
    const second = checkPlacement(input);
    expect(first.accepted).toBe(false);
    expect(first.conflicts.map((conflict) => conflict.code)).toContain('CALLER_RESERVED_REGION');
    expect(first.suggestedAlternatives).toEqual(second.suggestedAlternatives);
    expect(first.suggestedAlternatives[0]?.combinedBounds.x).not.toBe(100);
  });

  it('returns structured no-feasible-position instead of arbitrary fallback coordinates', () => {
    const result = checkPlacement({
      sheet: a4Sheet(),
      candidate: {
        origin: { x: 40, y: 40 },
        rotation: 0,
        combinedBounds: { x: 40, y: 40, width: 1200, height: 900 },
      },
      minimumClearance: 10,
    });
    expect(result.suggestedAlternatives).toEqual([]);
    expect(result.failure?.code).toBe('NO_FEASIBLE_POSITION');
    expect(result.failure?.unsatisfiedConstraints).toContain('PAGE_BORDER_KEEP_OUT');
  });

  it('uses visual upper-left for a top-left coordinate system too', () => {
    const result = selectSafeRegion({
      sheet: a4Sheet('down'),
      size: { width: 100, height: 60 },
      preference: 'upper-left',
    });
    expect(result.candidate?.origin.y).toBeLessThan(100);
  });
});
