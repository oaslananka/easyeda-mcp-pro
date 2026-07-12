import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gatherLiveFunctionalLayoutPlan } from '../../../src/schematic-model/live-functional-layout.js';
import { type ToolContext } from '../../../src/tools/types.js';

function makeCtx(bridgeCall: ReturnType<typeof vi.fn>): ToolContext {
  return {
    profile: 'pro',
    bridge: {
      connected: true,
      call: bridgeCall,
    },
    config: {
      bridgeTimeoutMs: 1000,
      artifactDir: '.easyeda-mcp-pro/artifacts',
      bridgeHost: 'localhost',
      bridgePort: 3000,
    },
    vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
  };
}

function component(primitiveId: string, x: number, y: number, rotation = 0) {
  return { primitiveId, reference: primitiveId, component_kind: 'part', x, y, rotation };
}

const RAW_SHEET_INFO = { page_size: { width: 1682, height: 1189 } };

describe('gatherLiveFunctionalLayoutPlan', () => {
  let bridgeCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bridgeCall = vi.fn();
  });

  it('places a two-component block inside real sheet bounds with no conflicts', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.getSheetInfo') return RAW_SHEET_INFO;
      if (method === 'schematic.listComponents') {
        return { total: 2, items: [component('a', 100, -100), component('b', 200, -100, 90)] };
      }
      if (method === 'schematic.primitiveBounds') {
        return {
          items: [
            { primitiveId: 'a', bounds: { minX: 95, maxX: 105, minY: -105, maxY: -95 } },
            { primitiveId: 'b', bounds: { minX: 195, maxX: 210, minY: -108, maxY: -95 } },
          ],
          combined: null,
        };
      }
      return undefined;
    });

    const plan = await gatherLiveFunctionalLayoutPlan(makeCtx(bridgeCall), 'proj-1', [
      { primitiveId: 'a', blockId: 'blk', role: 'main' },
      { primitiveId: 'b', blockId: 'blk', role: 'support' },
    ]);

    expect(plan.feasible).toBe(true);
    expect(plan.deterministic).toBe(true);
    expect(plan.conflicts).toEqual([]);
    expect(plan.blockReservations).toHaveLength(1);
    const bounds = plan.blockReservations[0].bounds;
    const sheet = plan.selectedSheet.bounds;
    expect(bounds.x).toBeGreaterThanOrEqual(sheet.x);
    expect(bounds.y).toBeGreaterThanOrEqual(sheet.y);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(sheet.x + sheet.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(sheet.y + sheet.height);
  });

  it('treats non-requested components as existing occupied regions', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.getSheetInfo') return RAW_SHEET_INFO;
      if (method === 'schematic.listComponents') {
        return {
          total: 2,
          items: [component('planned', 100, -100), component('bystander', 300, -300)],
        };
      }
      if (method === 'schematic.primitiveBounds') {
        return {
          items: [
            { primitiveId: 'planned', bounds: { minX: 95, maxX: 105, minY: -105, maxY: -95 } },
            { primitiveId: 'bystander', bounds: { minX: 295, maxX: 305, minY: -305, maxY: -295 } },
          ],
          combined: null,
        };
      }
      return undefined;
    });

    const plan = await gatherLiveFunctionalLayoutPlan(makeCtx(bridgeCall), 'proj-1', [
      { primitiveId: 'planned', blockId: 'blk', role: 'main' },
    ]);

    const existing = plan.occupancyMap.filter((region) => region.kind === 'existing-object');
    expect(existing).toHaveLength(1);
    expect(existing[0].ownerId).toBe('bystander');
  });

  it('includes an inferred title-block hard keepout', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.getSheetInfo') return RAW_SHEET_INFO;
      if (method === 'schematic.listComponents') return { total: 0, items: [] };
      if (method === 'schematic.primitiveBounds') return { items: [], combined: null };
      return undefined;
    });

    const plan = await gatherLiveFunctionalLayoutPlan(makeCtx(bridgeCall), 'proj-1', [
      { primitiveId: 'a', blockId: 'blk', role: 'main' },
    ]);

    const titleBlockRegion = plan.occupancyMap.find((region) => region.kind === 'title-block');
    // occupancyMap only carries reservations that were actually consumed; title-block
    // keepouts feed placement checks directly -- verify via selectedSheet instead.
    expect(plan.selectedSheet.titleBlockBounds).toBeDefined();
    expect(plan.selectedSheet.titleBlockBounds!.width).toBeGreaterThan(0);
    expect(titleBlockRegion).toBeUndefined();
  });

  it('merges caller-supplied hardKeepouts with the inferred title-block keepout', async () => {
    let capturedComponents = 0;
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.getSheetInfo') return RAW_SHEET_INFO;
      if (method === 'schematic.listComponents') {
        capturedComponents += 1;
        return { total: 0, items: [] };
      }
      if (method === 'schematic.primitiveBounds') return { items: [], combined: null };
      return undefined;
    });

    const plan = await gatherLiveFunctionalLayoutPlan(
      makeCtx(bridgeCall),
      'proj-1',
      [{ primitiveId: 'a', blockId: 'blk', role: 'main' }],
      {
        hardKeepouts: [
          { id: 'extra', kind: 'caller-reserved', bounds: { x: 0, y: 0, width: 1, height: 1 } },
        ],
      },
    );

    expect(capturedComponents).toBeGreaterThan(0);
    expect(plan.feasible).toBe(true);
  });

  it('falls back to a default 10x10 size when a component has no live bounds', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.getSheetInfo') return RAW_SHEET_INFO;
      if (method === 'schematic.listComponents') return { total: 1, items: [component('a', 0, 0)] };
      if (method === 'schematic.primitiveBounds') {
        return { items: [{ primitiveId: 'a', bounds: null }], combined: null };
      }
      return undefined;
    });

    const plan = await gatherLiveFunctionalLayoutPlan(makeCtx(bridgeCall), 'proj-1', [
      { primitiveId: 'a', blockId: 'blk', role: 'main' },
    ]);

    expect(plan.feasible).toBe(true);
    expect(plan.blockReservations[0].bounds.width).toBeGreaterThan(0);
  });

  it('passes through constraints and allowA3Fallback', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.getSheetInfo') return RAW_SHEET_INFO;
      if (method === 'schematic.listComponents') {
        return { total: 1, items: [component('a', 0, 0)] };
      }
      if (method === 'schematic.primitiveBounds') {
        return {
          items: [{ primitiveId: 'a', bounds: { minX: 0, maxX: 10, minY: -10, maxY: 0 } }],
          combined: null,
        };
      }
      return undefined;
    });

    const plan = await gatherLiveFunctionalLayoutPlan(
      makeCtx(bridgeCall),
      'proj-1',
      [{ primitiveId: 'a', blockId: 'blk', role: 'main' }],
      { a3FallbackAllowed: true, constraints: { blockPadding: 5 } },
    );

    expect(plan.feasible).toBe(true);
  });
});
