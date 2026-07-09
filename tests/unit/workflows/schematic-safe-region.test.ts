import { describe, expect, it } from 'vitest';
import {
  defaultTitleBlockKeepout,
  inferSchematicSheetGeometry,
  planSafeSchematicRegion,
  rectsOverlap,
} from '../../../src/workflows/schematic-safe-region.js';

describe('schematic safe-region planner', () => {
  it('defaults to bottom-left EasyEDA coordinates on A4 landscape when sheet info is missing', () => {
    const sheet = inferSchematicSheetGeometry(undefined);
    expect(sheet).toEqual({
      width: 1189,
      height: 841,
      unit: 'easyeda-coordinate',
      origin: 'bottom-left',
      source: 'default-a4-landscape',
    });
  });

  it('reads runtime sheet-info page size when available', () => {
    const sheet = inferSchematicSheetGeometry({
      currentPage: { Width: '1600', Height: 1000, unit: 'coord' },
    });
    expect(sheet).toMatchObject({ width: 1600, height: 1000, unit: 'coord', source: 'sheet-info' });
  });

  it('places upper-left content at high Y, not near the lower title block', () => {
    const plan = planSafeSchematicRegion({
      contentWidth: 360,
      contentHeight: 180,
      preferredRegion: 'upper-left',
    });
    expect(plan.blocked).toBe(false);
    expect(plan.bounds.x).toBe(80);
    expect(plan.bounds.y).toBeGreaterThan(500);
    expect(plan.anchor).toEqual({ x: plan.bounds.x, y: plan.bounds.y + plan.bounds.height });
    expect(rectsOverlap(plan.bounds, plan.keepouts[0])).toBe(false);
  });

  it('keeps the default title-block keep-out on the lower-right of the sheet', () => {
    const sheet = inferSchematicSheetGeometry(undefined);
    const keepout = defaultTitleBlockKeepout(sheet);
    expect(keepout.x).toBeGreaterThan(sheet.width / 2);
    expect(keepout.y).toBe(0);
    expect(keepout.height).toBeGreaterThan(200);
  });

  it('moves a lower-right request away from the title-block keep-out', () => {
    const plan = planSafeSchematicRegion({
      contentWidth: 360,
      contentHeight: 180,
      preferredRegion: 'lower-right',
    });
    expect(plan.blocked).toBe(false);
    expect(plan.warnings).toContain(
      'Preferred region lower-right intersects the title-block keep-out; searching fallback safe regions.',
    );
    expect(rectsOverlap(plan.requestedBounds, plan.keepouts[0])).toBe(true);
    expect(rectsOverlap(plan.bounds, plan.keepouts[0])).toBe(false);
  });

  it('blocks content that cannot fit outside the usable bounds', () => {
    const plan = planSafeSchematicRegion({
      contentWidth: 2000,
      contentHeight: 2000,
      preferredRegion: 'center',
    });
    expect(plan.blocked).toBe(true);
    expect(plan.issues.some((issue) => issue.code === 'CONTENT_DOES_NOT_FIT_USABLE_BOUNDS')).toBe(
      true,
    );
  });
});
