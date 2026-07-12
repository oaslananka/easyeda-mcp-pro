import { describe, expect, it } from 'vitest';
import {
  buildFunctionalBlockGraph,
  buildSchematicLayoutGraph,
  orderBlocksForPlacement,
} from '../../../src/layout/graph.js';
import type {
  DetectedFunctionalBlock,
  LayoutComponentInput,
  LayoutNetInput,
} from '../../../src/layout/types.js';

function component(id: string): LayoutComponentInput {
  return { id, reference: id, width: 40, height: 20 };
}

function block(
  overrides: Partial<DetectedFunctionalBlock> &
    Pick<DetectedFunctionalBlock, 'id' | 'kind' | 'componentIds'>,
): DetectedFunctionalBlock {
  return {
    title: overrides.id,
    source: 'inferred',
    confidence: 0.9,
    locked: false,
    preferredOrientation: 'horizontal',
    ...overrides,
  };
}

describe('buildSchematicLayoutGraph', () => {
  it('returns an empty graph for no components or nets', () => {
    const graph = buildSchematicLayoutGraph([]);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.adjacency).toEqual({});
  });

  it('ignores net endpoints that reference unknown components', () => {
    const graph = buildSchematicLayoutGraph(
      [component('U1')],
      [
        {
          id: 'NET1',
          name: 'NET1',
          endpoints: [{ componentId: 'U1' }, { componentId: 'missing' }],
        },
      ],
    );
    expect(graph.edges).toEqual([]);
  });

  it('creates a single undirected edge for a 2-pin net with no direction info', () => {
    const nets: LayoutNetInput[] = [
      { id: 'NET1', name: 'NET1', endpoints: [{ componentId: 'U1' }, { componentId: 'R1' }] },
    ];
    const graph = buildSchematicLayoutGraph([component('U1'), component('R1')], nets);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.directed).toBe(false);
    expect(graph.adjacency.U1).toEqual(['R1']);
    expect(graph.adjacency.R1).toEqual(['U1']);
  });

  it('directs edges away from output/power pins toward every other endpoint', () => {
    const nets: LayoutNetInput[] = [
      {
        id: 'NET1',
        name: 'NET1',
        endpoints: [
          { componentId: 'U1', direction: 'output' },
          { componentId: 'R1', direction: 'input' },
          { componentId: 'R2', direction: 'input' },
        ],
      },
    ];
    const graph = buildSchematicLayoutGraph(
      [component('U1'), component('R1'), component('R2')],
      nets,
    );
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.every((edge) => edge.directed && edge.sourceComponentId === 'U1')).toBe(
      true,
    );
    expect(graph.nodes.find((node) => node.id === 'U1')?.outgoingNetIds).toEqual(['NET1']);
    expect(graph.nodes.find((node) => node.id === 'R1')?.incomingNetIds).toEqual(['NET1']);
  });

  it('deduplicates repeated endpoints for the same component, preferring output/power', () => {
    const nets: LayoutNetInput[] = [
      {
        id: 'NET1',
        name: 'NET1',
        endpoints: [
          { componentId: 'U1', pinId: '1', direction: 'input' },
          { componentId: 'U1', pinId: '2', direction: 'output' },
          { componentId: 'R1' },
        ],
      },
    ];
    const graph = buildSchematicLayoutGraph([component('U1'), component('R1')], nets);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.sourceComponentId).toBe('U1');
  });

  it('produces no edges for a net with fewer than two distinct components', () => {
    const nets: LayoutNetInput[] = [
      {
        id: 'NET1',
        name: 'NET1',
        endpoints: [
          { componentId: 'U1', pinId: '1' },
          { componentId: 'U1', pinId: '2' },
        ],
      },
    ];
    const graph = buildSchematicLayoutGraph([component('U1')], nets);
    expect(graph.edges).toEqual([]);
  });
});

describe('buildFunctionalBlockGraph', () => {
  it('produces no edges when every net stays inside one block', () => {
    const blocks = [block({ id: 'b1', kind: 'mcu', componentIds: ['U1', 'R1'] })];
    const componentGraph = buildSchematicLayoutGraph(
      [component('U1'), component('R1')],
      [{ id: 'NET1', name: 'NET1', endpoints: [{ componentId: 'U1' }, { componentId: 'R1' }] }],
    );
    const graph = buildFunctionalBlockGraph(blocks, componentGraph);
    expect(graph.edges).toEqual([]);
  });

  it('creates a directed inter-block edge and increases the downstream flowRank', () => {
    const blocks = [
      block({ id: 'usb', kind: 'usb', componentIds: ['J1'] }),
      block({ id: 'mcu', kind: 'mcu', componentIds: ['U1'] }),
    ];
    const componentGraph = buildSchematicLayoutGraph(
      [component('J1'), component('U1')],
      [
        {
          id: 'NET1',
          name: 'NET1',
          endpoints: [
            { componentId: 'J1', direction: 'output' },
            { componentId: 'U1', direction: 'input' },
          ],
        },
      ],
    );
    const graph = buildFunctionalBlockGraph(blocks, componentGraph);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.sourceBlockId).toBe('usb');
    expect(graph.edges[0]?.targetBlockId).toBe('mcu');
    const mcuNode = graph.nodes.find((node) => node.blockId === 'mcu');
    expect(mcuNode?.flowRank).toBeGreaterThan(0);
    expect(mcuNode?.incomingBlockIds).toEqual(['usb']);
  });

  it('normalizes an undirected inter-block edge toward the lower flow-rank block', () => {
    const blocks = [
      block({ id: 'mcu', kind: 'mcu', componentIds: ['U1'] }),
      block({ id: 'usb', kind: 'usb', componentIds: ['J1'] }),
    ];
    const componentGraph = buildSchematicLayoutGraph(
      [component('U1'), component('J1')],
      [{ id: 'NET1', name: 'NET1', endpoints: [{ componentId: 'U1' }, { componentId: 'J1' }] }],
    );
    const graph = buildFunctionalBlockGraph(blocks, componentGraph);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.sourceBlockId).toBe('usb');
    expect(graph.edges[0]?.targetBlockId).toBe('mcu');
    expect(graph.edges[0]?.directed).toBe(false);
  });

  it('deduplicates edges that collapse to the same net/source/target key', () => {
    const blocks = [
      block({ id: 'usb', kind: 'usb', componentIds: ['J1', 'J2'] }),
      block({ id: 'mcu', kind: 'mcu', componentIds: ['U1'] }),
    ];
    const componentGraph = buildSchematicLayoutGraph(
      [component('J1'), component('J2'), component('U1')],
      [
        {
          id: 'NET1',
          name: 'NET1',
          endpoints: [
            { componentId: 'J1', direction: 'output' },
            { componentId: 'J2', direction: 'output' },
            { componentId: 'U1', direction: 'input' },
          ],
        },
      ],
    );
    const graph = buildFunctionalBlockGraph(blocks, componentGraph);
    expect(graph.edges).toHaveLength(1);
  });

  it('remains stable when the underlying component graph has a rank cycle', () => {
    const blocks = [
      block({ id: 'a', kind: 'mcu', componentIds: ['U1'] }),
      block({ id: 'b', kind: 'mcu', componentIds: ['U2'] }),
    ];
    const componentGraph = buildSchematicLayoutGraph(
      [component('U1'), component('U2')],
      [
        {
          id: 'NET1',
          name: 'NET1',
          endpoints: [
            { componentId: 'U1', direction: 'output' },
            { componentId: 'U2', direction: 'input' },
          ],
        },
        {
          id: 'NET2',
          name: 'NET2',
          endpoints: [
            { componentId: 'U2', direction: 'output' },
            { componentId: 'U1', direction: 'input' },
          ],
        },
      ],
    );
    const graph = buildFunctionalBlockGraph(blocks, componentGraph);
    expect(graph.edges).toHaveLength(2);
    expect(graph.nodes.every((node) => Number.isFinite(node.flowRank))).toBe(true);
  });
});

describe('orderBlocksForPlacement', () => {
  it('orders nodes by ascending flowRank, then by blockId', () => {
    const graph = {
      nodes: [
        {
          blockId: 'b',
          kind: 'mcu' as const,
          componentIds: [],
          incomingBlockIds: [],
          outgoingBlockIds: [],
          flowRank: 2,
        },
        {
          blockId: 'a',
          kind: 'mcu' as const,
          componentIds: [],
          incomingBlockIds: [],
          outgoingBlockIds: [],
          flowRank: 1,
        },
        {
          blockId: 'c',
          kind: 'mcu' as const,
          componentIds: [],
          incomingBlockIds: [],
          outgoingBlockIds: [],
          flowRank: 1,
        },
      ],
      edges: [],
    };
    const ordered = orderBlocksForPlacement(graph).map((node) => node.blockId);
    expect(ordered).toEqual(['a', 'c', 'b']);
  });
});
