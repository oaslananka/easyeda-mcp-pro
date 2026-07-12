import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gatherLivePrimitiveBounds } from '../../../src/schematic-model/live-primitive-bounds.js';
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

function component(primitiveId: string, x: number, y: number, rotation: number) {
  return { primitiveId, reference: primitiveId, component_kind: 'part', x, y, rotation };
}

describe('gatherLivePrimitiveBounds', () => {
  let bridgeCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bridgeCall = vi.fn();
  });

  it('returns a runtime/exact body bound for a rotated component', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.listComponents') {
        return { total: 1, items: [component('c1', 935, -290, 90)] };
      }
      if (method === 'schematic.primitiveBounds') {
        return {
          items: [
            { primitiveId: 'c1', bounds: { minX: 924.5, maxX: 945.5, minY: -294.5, maxY: -285.5 } },
          ],
          combined: { minX: 924.5, maxX: 945.5, minY: -294.5, maxY: -285.5 },
        };
      }
      return undefined;
    });

    const result = await gatherLivePrimitiveBounds(makeCtx(bridgeCall), 'proj-1');

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.rotation).toBe(90);
    expect(item.availability).toBe('available');
    expect(item.geometrySource).toBe('runtime');
    expect(item.confidence).toBe('exact');
    expect(item.body).toMatchObject({
      bounds: { x: 924.5, y: -294.5, width: 21, height: 9 },
      geometrySource: 'runtime',
      confidence: 'exact',
    });
    expect(item.combinedBounds).toEqual({ x: 924.5, y: -294.5, width: 21, height: 9 });
    expect(result.availableCount).toBe(1);
    expect(result.notAvailableCount).toBe(0);
  });

  it('swaps width/height correctly between a 90 and a 180 rotation', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.listComponents') {
        return {
          total: 2,
          items: [component('r90', 935, -290, 90), component('r180', 840, -360, 180)],
        };
      }
      if (method === 'schematic.primitiveBounds') {
        return {
          items: [
            {
              primitiveId: 'r90',
              bounds: { minX: 924.5, maxX: 945.5, minY: -294.5, maxY: -285.5 },
            },
            {
              primitiveId: 'r180',
              bounds: { minX: 835.5, maxX: 844.5, minY: -370.5, maxY: -349.5 },
            },
          ],
          combined: null,
        };
      }
      return undefined;
    });

    const result = await gatherLivePrimitiveBounds(makeCtx(bridgeCall), 'proj-1');
    const r90 = result.items.find((i) => i.id === 'r90')!;
    const r180 = result.items.find((i) => i.id === 'r180')!;

    expect(r90.body?.bounds).toEqual({ x: 924.5, y: -294.5, width: 21, height: 9 });
    expect(r180.body?.bounds).toEqual({ x: 835.5, y: -370.5, width: 9, height: 21 });
  });

  it('marks a primitive not_available when the bridge returns no bbox for it', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.listComponents') {
        return { total: 1, items: [component('ghost', 0, 0, 0)] };
      }
      if (method === 'schematic.primitiveBounds') {
        return { items: [{ primitiveId: 'ghost', bounds: null }], combined: null };
      }
      return undefined;
    });

    const result = await gatherLivePrimitiveBounds(makeCtx(bridgeCall), 'proj-1');
    expect(result.items[0].availability).toBe('not_available');
    expect(result.items[0].body).toBeUndefined();
    expect(result.notAvailableCount).toBe(1);
  });

  it('filters to only the requested primitiveIds', async () => {
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listComponents') {
        return {
          total: 3,
          items: [component('a', 0, 0, 0), component('b', 1, 1, 0), component('c', 2, 2, 0)],
        };
      }
      if (method === 'schematic.primitiveBounds') {
        expect(params.primitiveIds).toEqual(['b']);
        return {
          items: [{ primitiveId: 'b', bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 } }],
          combined: null,
        };
      }
      return undefined;
    });

    const result = await gatherLivePrimitiveBounds(makeCtx(bridgeCall), 'proj-1', {
      primitiveIds: ['b'],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('b');
  });

  it('normalizes an out-of-range or negative rotation to a canonical quarter-turn', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.listComponents') {
        return { total: 1, items: [component('c1', 0, 0, -90)] };
      }
      if (method === 'schematic.primitiveBounds') {
        return {
          items: [{ primitiveId: 'c1', bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 } }],
          combined: null,
        };
      }
      return undefined;
    });

    const result = await gatherLivePrimitiveBounds(makeCtx(bridgeCall), 'proj-1');
    expect(result.items[0].rotation).toBe(270);
  });

  it('pages through listComponents past a single page', async () => {
    const page1 = Array.from({ length: 3 }, (_, i) => component(`c${i}`, i, i, 0));
    const page2 = [component('c3', 3, 3, 0)];

    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listComponents') {
        if (params.offset === 0) return { total: 4, items: page1 };
        return { total: 4, items: page2 };
      }
      if (method === 'schematic.primitiveBounds') {
        return { items: [], combined: null };
      }
      return undefined;
    });

    const result = await gatherLivePrimitiveBounds(makeCtx(bridgeCall), 'proj-1');
    expect(result.items).toHaveLength(4);
  });

  it('falls back to a generic primitiveType when component_kind is missing', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.listComponents') {
        return { total: 1, items: [{ primitiveId: 'c1', x: 0, y: 0, rotation: 0 }] };
      }
      if (method === 'schematic.primitiveBounds') {
        return {
          items: [{ primitiveId: 'c1', bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 } }],
          combined: null,
        };
      }
      return undefined;
    });

    const result = await gatherLivePrimitiveBounds(makeCtx(bridgeCall), 'proj-1');
    expect(result.items[0].primitiveType).toBe('component');
  });

  it('returns no items for an explicitly empty primitiveIds filter', async () => {
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listComponents') {
        return { total: 1, items: [component('a', 0, 0, 0)] };
      }
      if (method === 'schematic.primitiveBounds') {
        expect(params.primitiveIds).toEqual([]);
        return { items: [], combined: null };
      }
      return undefined;
    });

    const result = await gatherLivePrimitiveBounds(makeCtx(bridgeCall), 'proj-1', {
      primitiveIds: [],
    });
    expect(result.items).toHaveLength(0);
  });

  it('drops selected components with no primitiveId before requesting bounds', async () => {
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listComponents') {
        return { total: 2, items: [{ x: 0, y: 0, rotation: 0 }, component('b', 1, 1, 0)] };
      }
      if (method === 'schematic.primitiveBounds') {
        expect(params.primitiveIds).toEqual(['b']);
        return {
          items: [{ primitiveId: 'b', bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 } }],
          combined: null,
        };
      }
      return undefined;
    });

    const result = await gatherLivePrimitiveBounds(makeCtx(bridgeCall), 'proj-1');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('b');
  });
});
