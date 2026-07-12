import { compareIds } from './geometry.js';
import type {
  DetectedFunctionalBlock,
  FunctionalBlockGraph,
  FunctionalBlockGraphEdge,
  FunctionalBlockGraphNode,
  FunctionalBlockKind,
  LayoutComponentInput,
  LayoutGraphEdge,
  LayoutGraphNode,
  LayoutNetEndpoint,
  LayoutNetInput,
  SchematicLayoutGraph,
} from './types.js';

export const BLOCK_FLOW_BASE_RANK: Readonly<Record<FunctionalBlockKind, number>> = {
  'power-input': 0,
  connector: 0,
  usb: 1,
  regulation: 1,
  crystal: 2,
  mcu: 3,
  memory: 3,
  sensor: 3,
  'analog-front-end': 3,
  debug: 4,
  'motor-driver': 4,
  'led-chain': 5,
  other: 3,
};

function endpointOrder(a: LayoutNetEndpoint, b: LayoutNetEndpoint): number {
  return compareIds(a.componentId, b.componentId) || compareIds(a.pinId ?? '', b.pinId ?? '');
}

function directedPairs(endpoints: readonly LayoutNetEndpoint[]): Array<{
  source: LayoutNetEndpoint;
  target: LayoutNetEndpoint;
  directed: boolean;
}> {
  const uniqueByComponent = new Map<string, LayoutNetEndpoint>();
  for (const endpoint of [...endpoints].sort(endpointOrder)) {
    const existing = uniqueByComponent.get(endpoint.componentId);
    if (!existing || endpoint.direction === 'output' || endpoint.direction === 'power') {
      uniqueByComponent.set(endpoint.componentId, endpoint);
    }
  }
  const unique = [...uniqueByComponent.values()].sort(endpointOrder);
  if (unique.length < 2) return [];

  const sources = unique.filter(
    (endpoint) => endpoint.direction === 'output' || endpoint.direction === 'power',
  );
  if (sources.length > 0) {
    const result: Array<{
      source: LayoutNetEndpoint;
      target: LayoutNetEndpoint;
      directed: boolean;
    }> = [];
    for (const source of sources) {
      for (const target of unique) {
        if (source.componentId !== target.componentId && !sources.includes(target)) {
          result.push({ source, target, directed: true });
        }
      }
    }
    return result;
  }

  const anchor = unique[0];
  if (!anchor) return [];
  return unique.slice(1).map((target) => ({ source: anchor, target, directed: false }));
}

export function buildSchematicLayoutGraph(
  components: readonly LayoutComponentInput[],
  nets: readonly LayoutNetInput[] = [],
): SchematicLayoutGraph {
  const componentById = new Map(
    [...components].sort((a, b) => compareIds(a.id, b.id)).map((component) => [component.id, component]),
  );
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  const adjacency = new Map<string, Set<string>>();
  for (const id of componentById.keys()) {
    incoming.set(id, new Set());
    outgoing.set(id, new Set());
    adjacency.set(id, new Set());
  }

  const edges: LayoutGraphEdge[] = [];
  const edgeKeys = new Set<string>();
  for (const net of [...nets].sort((a, b) => compareIds(a.id, b.id))) {
    const endpoints = net.endpoints.filter((endpoint) => componentById.has(endpoint.componentId));
    for (const pair of directedPairs(endpoints)) {
      const sourceComponentId = pair.source.componentId;
      const targetComponentId = pair.target.componentId;
      const key = `${net.id}\u0000${sourceComponentId}\u0000${targetComponentId}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({
        id: `${net.id}:${sourceComponentId}:${targetComponentId}`,
        netId: net.id,
        sourceComponentId,
        targetComponentId,
        directed: pair.directed,
      });
      outgoing.get(sourceComponentId)?.add(net.id);
      incoming.get(targetComponentId)?.add(net.id);
      if (!pair.directed) {
        outgoing.get(targetComponentId)?.add(net.id);
        incoming.get(sourceComponentId)?.add(net.id);
      }
      adjacency.get(sourceComponentId)?.add(targetComponentId);
      adjacency.get(targetComponentId)?.add(sourceComponentId);
    }
  }

  edges.sort((a, b) => compareIds(a.id, b.id));
  const nodes: LayoutGraphNode[] = [...componentById.values()].map((component) => ({
    id: component.id,
    component,
    incomingNetIds: [...(incoming.get(component.id) ?? [])].sort(compareIds),
    outgoingNetIds: [...(outgoing.get(component.id) ?? [])].sort(compareIds),
  }));
  const adjacencyRecord: Record<string, readonly string[]> = {};
  for (const id of [...adjacency.keys()].sort(compareIds)) {
    adjacencyRecord[id] = [...(adjacency.get(id) ?? [])].sort(compareIds);
  }

  return { nodes, edges, adjacency: adjacencyRecord };
}

export function buildFunctionalBlockGraph(
  blocks: readonly DetectedFunctionalBlock[],
  componentGraph: SchematicLayoutGraph,
): FunctionalBlockGraph {
  const blockById = new Map(blocks.map((block) => [block.id, block]));
  const blockForComponent = new Map<string, string>();
  for (const block of blocks) {
    for (const componentId of block.componentIds) blockForComponent.set(componentId, block.id);
  }

  const edges: FunctionalBlockGraphEdge[] = [];
  const edgeKeys = new Set<string>();
  for (const edge of componentGraph.edges) {
    let sourceBlockId = blockForComponent.get(edge.sourceComponentId);
    let targetBlockId = blockForComponent.get(edge.targetComponentId);
    if (!sourceBlockId || !targetBlockId || sourceBlockId === targetBlockId) continue;
    if (!edge.directed) {
      const source = blockById.get(sourceBlockId);
      const target = blockById.get(targetBlockId);
      if (
        source &&
        target &&
        (BLOCK_FLOW_BASE_RANK[source.kind] > BLOCK_FLOW_BASE_RANK[target.kind] ||
          (BLOCK_FLOW_BASE_RANK[source.kind] === BLOCK_FLOW_BASE_RANK[target.kind] &&
            compareIds(sourceBlockId, targetBlockId) > 0))
      ) {
        [sourceBlockId, targetBlockId] = [targetBlockId, sourceBlockId];
      }
    }
    const key = `${edge.netId}\u0000${sourceBlockId}\u0000${targetBlockId}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({
      id: `${edge.netId}:${sourceBlockId}:${targetBlockId}`,
      netId: edge.netId,
      sourceBlockId,
      targetBlockId,
      directed: edge.directed,
    });
  }
  edges.sort((a, b) => compareIds(a.id, b.id));

  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  const ranks = new Map<string, number>();
  for (const block of blocks) {
    incoming.set(block.id, new Set());
    outgoing.set(block.id, new Set());
    ranks.set(block.id, BLOCK_FLOW_BASE_RANK[block.kind]);
  }
  for (const edge of edges) {
    incoming.get(edge.targetBlockId)?.add(edge.sourceBlockId);
    outgoing.get(edge.sourceBlockId)?.add(edge.targetBlockId);
  }

  // Bounded relaxation preserves deterministic ranks even when the schematic graph has cycles.
  for (let pass = 0; pass < blocks.length; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      if (!edge.directed) continue;
      const sourceRank = ranks.get(edge.sourceBlockId) ?? 0;
      const target = blockById.get(edge.targetBlockId);
      if (!target) continue;
      const next = Math.max(
        ranks.get(edge.targetBlockId) ?? 0,
        Math.min(9, sourceRank + 1),
        BLOCK_FLOW_BASE_RANK[target.kind],
      );
      if (next !== ranks.get(edge.targetBlockId)) {
        ranks.set(edge.targetBlockId, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const nodes: FunctionalBlockGraphNode[] = [...blocks]
    .sort((a, b) => compareIds(a.id, b.id))
    .map((block) => ({
      blockId: block.id,
      kind: block.kind,
      componentIds: [...block.componentIds].sort(compareIds),
      incomingBlockIds: [...(incoming.get(block.id) ?? [])].sort(compareIds),
      outgoingBlockIds: [...(outgoing.get(block.id) ?? [])].sort(compareIds),
      flowRank: ranks.get(block.id) ?? BLOCK_FLOW_BASE_RANK[block.kind],
    }));
  return { nodes, edges };
}

export function orderBlocksForPlacement(graph: FunctionalBlockGraph): FunctionalBlockGraphNode[] {
  return [...graph.nodes].sort(
    (a, b) => a.flowRank - b.flowRank || compareIds(a.blockId, b.blockId),
  );
}
