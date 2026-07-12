import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gatherLivePlacementCheck } from '../../../src/schematic-model/live-placement-check.js';
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

describe('gatherLivePlacementCheck', () => {
  let bridgeCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bridgeCall = vi.fn();
  });

  it('accepts a candidate placement with x/y in empty space', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.getSheetInfo') return RAW_SHEET_INFO;
      if (method === 'schematic.listComponents') return { total: 0, items: [] };
      if (method === 'schematic.primitiveBounds') return { items: [], combined: null };
      return undefined;
    });

    const result = await gatherLivePlacementCheck(makeCtx(bridgeCall), 'proj-1', {
      width: 50,
      height: 30,
      x: 100,
      y: -200,
    });

    expect(result.mode).toBe('check-placement');
    if (result.mode !== 'check-placement') throw new Error('unreachable');
    expect(result.accepted).toBe(true);
    expect(result.conflicts).toEqual([]);
  });

  it('rejects a candidate that overlaps a real existing component', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.getSheetInfo') return RAW_SHEET_INFO;
      if (method === 'schematic.listComponents') {
        return { total: 1, items: [component('blocker', 924, -294)] };
      }
      if (method === 'schematic.primitiveBounds') {
        return {
          items: [
            { primitiveId: 'blocker', bounds: { minX: 924, maxX: 945, minY: -294, maxY: -285 } },
          ],
          combined: null,
        };
      }
      return undefined;
    });

    const result = await gatherLivePlacementCheck(makeCtx(bridgeCall), 'proj-1', {
      width: 21,
      height: 9,
      x: 924,
      y: -294,
    });

    expect(result.mode).toBe('check-placement');
    if (result.mode !== 'check-placement') throw new Error('unreachable');
    expect(result.accepted).toBe(false);
    expect(result.conflicts.some((c) => c.code === 'EXISTING_OBJECT_OCCUPIED')).toBe(true);
    expect(result.conflicts.some((c) => c.regionId === 'existing:blocker')).toBe(true);
  });

  it('excludes a primitiveId from the occupied-region set', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.getSheetInfo') return RAW_SHEET_INFO;
      if (method === 'schematic.listComponents') {
        return { total: 1, items: [component('moving', 100, -100)] };
      }
      if (method === 'schematic.primitiveBounds') {
        return {
          items: [
            { primitiveId: 'moving', bounds: { minX: 100, maxX: 121, minY: -100, maxY: -91 } },
          ],
          combined: null,
        };
      }
      return undefined;
    });

    const result = await gatherLivePlacementCheck(
      makeCtx(bridgeCall),
      'proj-1',
      { width: 21, height: 9, x: 100, y: -100 },
      { excludePrimitiveIds: ['moving'] },
    );

    expect(result.mode).toBe('check-placement');
    if (result.mode !== 'check-placement') throw new Error('unreachable');
    expect(result.accepted).toBe(true);
  });

  it('searches for a safe region when x/y are omitted', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.getSheetInfo') return RAW_SHEET_INFO;
      if (method === 'schematic.listComponents') return { total: 0, items: [] };
      if (method === 'schematic.primitiveBounds') return { items: [], combined: null };
      return undefined;
    });

    const result = await gatherLivePlacementCheck(makeCtx(bridgeCall), 'proj-1', {
      width: 50,
      height: 30,
      preference: 'upper-left',
    });

    expect(result.mode).toBe('select-safe-region');
    if (result.mode !== 'select-safe-region') throw new Error('unreachable');
    expect(result.feasible).toBe(true);
    expect(result.candidate).toBeDefined();
  });

  it('returns a structured no-feasible-position failure when the sheet is fully occupied', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.getSheetInfo') return RAW_SHEET_INFO;
      if (method === 'schematic.listComponents') {
        return { total: 1, items: [component('everything', 0, 0)] };
      }
      if (method === 'schematic.primitiveBounds') {
        return {
          items: [
            {
              primitiveId: 'everything',
              bounds: { minX: -10000, maxX: 10000, minY: -10000, maxY: 10000 },
            },
          ],
          combined: null,
        };
      }
      return undefined;
    });

    const result = await gatherLivePlacementCheck(makeCtx(bridgeCall), 'proj-1', {
      width: 50,
      height: 30,
      x: 100,
      y: -200,
    });

    expect(result.mode).toBe('check-placement');
    if (result.mode !== 'check-placement') throw new Error('unreachable');
    expect(result.accepted).toBe(false);
    expect(result.failure?.code).toBe('NO_FEASIBLE_POSITION');
  });

  it('passes caller-supplied reservedRegions and minimumClearance through', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.getSheetInfo') return RAW_SHEET_INFO;
      if (method === 'schematic.listComponents') return { total: 0, items: [] };
      if (method === 'schematic.primitiveBounds') return { items: [], combined: null };
      return undefined;
    });

    const result = await gatherLivePlacementCheck(
      makeCtx(bridgeCall),
      'proj-1',
      { width: 50, height: 30, x: 500, y: -500 },
      {
        reservedRegions: [
          {
            id: 'reserved',
            kind: 'caller-reserved',
            bounds: { x: 500, y: -500, width: 50, height: 30 },
          },
        ],
        minimumClearance: 5,
      },
    );

    expect(result.mode).toBe('check-placement');
    if (result.mode !== 'check-placement') throw new Error('unreachable');
    expect(result.conflicts.some((c) => c.code === 'CALLER_RESERVED_REGION')).toBe(true);
  });
});
