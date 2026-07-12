import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gatherLiveSchematicSnapshot } from '../../../src/schematic-model/live-snapshot.js';
import { buildSchematicModel } from '../../../src/schematic-model/model-builder.js';
import { createConnectivityFingerprint } from '../../../src/schematic-model/connectivity-fingerprint.js';
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

function pin(pinNumber: string, pinName: string, x: number, y: number, pinType?: string) {
  return { pinNumber, pinName, x, y, rotation: 0, pinLength: 10, pinType };
}

describe('gatherLiveSchematicSnapshot', () => {
  let bridgeCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bridgeCall = vi.fn();
  });

  it('assembles a snapshot from components, pins, nets, and wires', async () => {
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listComponents') {
        return {
          total: 2,
          items: [
            { primitiveId: 'comp-R1', reference: 'R1', x: 10, y: 20, rotation: 0 },
            { primitiveId: 'comp-C1', reference: 'C1', x: 30, y: 40, rotation: 90 },
          ],
        };
      }
      if (method === 'api.call') {
        const id = params.args[0];
        if (id === 'comp-R1') {
          return { result: [pin('1', 'A', 10, 20, 'IN'), pin('2', 'B', 10, 30, 'OUT')] };
        }
        if (id === 'comp-C1') {
          return { result: [pin('1', 'P', 30, 40), pin('2', 'N', 30, 50)] };
        }
        return { result: [] };
      }
      if (method === 'schematic.listNets') {
        return [
          {
            netName: 'NET1',
            nodes: [
              { component: 'R1', pin: '2' },
              { component: 'C1', pin: '1' },
            ],
          },
        ];
      }
      if (method === 'system.inspectWires') {
        return {
          total: 1,
          samples: [{ primitiveId: 'wire-1', line: [10, 30, 30, 40], net: 'NET1' }],
        };
      }
      return undefined;
    });

    const snapshot = await gatherLiveSchematicSnapshot(makeCtx(bridgeCall), 'proj-1');

    expect(snapshot.document?.projectId).toBe('proj-1');
    expect(snapshot.components).toHaveLength(2);
    expect(snapshot.components?.[0]).toMatchObject({
      runtimePrimitiveId: 'comp-R1',
      reference: 'R1',
      position: { x: 10, y: 20 },
    });
    expect(snapshot.components?.[0].pins).toHaveLength(2);
    expect(snapshot.components?.[0].pins?.[0]).toMatchObject({
      number: '1',
      name: 'A',
      electricalType: 'IN',
      position: { x: 10, y: 20 },
    });

    expect(snapshot.nets).toHaveLength(1);
    expect(snapshot.nets?.[0]).toMatchObject({
      name: 'NET1',
      nodes: [
        { componentReference: 'R1', pinNumber: '2' },
        { componentReference: 'C1', pinNumber: '1' },
      ],
    });

    expect(snapshot.wires).toHaveLength(1);
    expect(snapshot.wires?.[0]).toMatchObject({
      runtimePrimitiveId: 'wire-1',
      netName: 'NET1',
      points: [
        { x: 10, y: 30 },
        { x: 30, y: 40 },
      ],
    });
  });

  it('feeds cleanly into buildSchematicModel and createConnectivityFingerprint', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.listComponents') {
        return { total: 1, items: [{ primitiveId: 'comp-R1', reference: 'R1', x: 0, y: 0 }] };
      }
      if (method === 'api.call') {
        return { result: [pin('1', 'A', 0, 0), pin('2', 'B', 0, 10)] };
      }
      if (method === 'schematic.listNets') {
        return [{ netName: 'GND', nodes: [{ component: 'R1', pin: '2' }] }];
      }
      if (method === 'system.inspectWires') {
        return { total: 0, samples: [] };
      }
      return undefined;
    });

    const snapshot = await gatherLiveSchematicSnapshot(makeCtx(bridgeCall), 'proj-1');
    const model = buildSchematicModel(snapshot);
    const fingerprint = createConnectivityFingerprint(model);

    expect(model.components).toHaveLength(1);
    expect(fingerprint.schemaVersion).toBe(1);
    expect(fingerprint.hash).toEqual(expect.any(String));
    expect(fingerprint.normalized.pinNetMembership).toHaveLength(2);
  });

  it('pages through listComponents past a single page', async () => {
    const page1 = Array.from({ length: 3 }, (_, i) => ({
      primitiveId: `c${i}`,
      reference: `R${i}`,
      x: i,
      y: i,
    }));
    const page2 = [{ primitiveId: 'c3', reference: 'R3', x: 3, y: 3 }];

    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listComponents') {
        if (params.offset === 0) return { total: 4, items: page1 };
        return { total: 4, items: page2 };
      }
      if (method === 'api.call') return { result: [] };
      if (method === 'schematic.listNets') return [];
      if (method === 'system.inspectWires') return { total: 0, samples: [] };
      return undefined;
    });

    const snapshot = await gatherLiveSchematicSnapshot(makeCtx(bridgeCall), 'proj-1', {
      pageSize: 3,
    });

    expect(snapshot.components).toHaveLength(4);
    expect(snapshot.components?.map((c) => c.runtimePrimitiveId)).toEqual(['c0', 'c1', 'c2', 'c3']);
  });

  it('pages through system.inspectWires past the 50-wire cap', async () => {
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listComponents') return { total: 0, items: [] };
      if (method === 'schematic.listNets') return [];
      if (method === 'system.inspectWires') {
        if (params.offset === 0) {
          return {
            total: 51,
            samples: Array.from({ length: 50 }, (_, i) => ({
              primitiveId: `w${i}`,
              line: [0, 0, 1, 1],
            })),
          };
        }
        return { total: 51, samples: [{ primitiveId: 'w50', line: [0, 0, 1, 1] }] };
      }
      return undefined;
    });

    const snapshot = await gatherLiveSchematicSnapshot(makeCtx(bridgeCall), 'proj-1');
    expect(snapshot.wires).toHaveLength(51);
  });

  it('skips components with no primitiveId and does not fetch their pins', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.listComponents') {
        return { total: 1, items: [{ reference: 'GHOST', x: 0, y: 0 }] };
      }
      if (method === 'api.call') throw new Error('should not be called for a ghost component');
      if (method === 'schematic.listNets') return [];
      if (method === 'system.inspectWires') return { total: 0, samples: [] };
      return undefined;
    });

    const snapshot = await gatherLiveSchematicSnapshot(makeCtx(bridgeCall), 'proj-1');
    expect(snapshot.components).toHaveLength(0);
  });

  it('drops a trailing unpaired coordinate from an odd-length wire line', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.listComponents') return { total: 0, items: [] };
      if (method === 'schematic.listNets') return [];
      if (method === 'system.inspectWires') {
        return { total: 1, samples: [{ primitiveId: 'w1', line: [0, 0, 5, 5, 9] }] };
      }
      return undefined;
    });

    const snapshot = await gatherLiveSchematicSnapshot(makeCtx(bridgeCall), 'proj-1');
    expect(snapshot.wires?.[0].points).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 5 },
    ]);
  });

  it('treats an empty wire net name as unset rather than an empty string', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.listComponents') return { total: 0, items: [] };
      if (method === 'schematic.listNets') return [];
      if (method === 'system.inspectWires') {
        return { total: 1, samples: [{ primitiveId: 'w1', line: [0, 0, 1, 1], net: '' }] };
      }
      return undefined;
    });

    const snapshot = await gatherLiveSchematicSnapshot(makeCtx(bridgeCall), 'proj-1');
    expect(snapshot.wires?.[0].netName).toBeUndefined();
  });

  it('leaves position undefined when a component has no x/y', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.listComponents') {
        return { total: 1, items: [{ primitiveId: 'comp-1', reference: 'U1' }] };
      }
      if (method === 'api.call') return { result: [] };
      if (method === 'schematic.listNets') return [];
      if (method === 'system.inspectWires') return { total: 0, samples: [] };
      return undefined;
    });

    const snapshot = await gatherLiveSchematicSnapshot(makeCtx(bridgeCall), 'proj-1');
    expect(snapshot.components?.[0].position).toBeUndefined();
  });

  it('treats a net with no nodes array as having zero nodes', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.listComponents') return { total: 0, items: [] };
      if (method === 'schematic.listNets') return [{ netName: 'FLOAT' }];
      if (method === 'system.inspectWires') return { total: 0, samples: [] };
      return undefined;
    });

    const snapshot = await gatherLiveSchematicSnapshot(makeCtx(bridgeCall), 'proj-1');
    expect(snapshot.nets?.[0]).toMatchObject({ name: 'FLOAT', nodes: [] });
  });

  it('handles missing nets/wires responses without throwing', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.listComponents') return { total: 0, items: [] };
      if (method === 'schematic.listNets') return undefined;
      if (method === 'system.inspectWires') return undefined;
      return undefined;
    });

    const snapshot = await gatherLiveSchematicSnapshot(makeCtx(bridgeCall), 'proj-1');
    expect(snapshot.components).toEqual([]);
    expect(snapshot.nets).toEqual([]);
    expect(snapshot.wires).toEqual([]);
  });
});
