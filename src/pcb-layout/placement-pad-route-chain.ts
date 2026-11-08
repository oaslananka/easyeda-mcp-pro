import { nativeCopperLayerCode, type NativeTrack } from './route-review.js';

/**
 * Opt-in, bounded, same-net native *centerline endpoint* chain evidence.
 * A matching 2D chain never proves physical pad contact, plated barrels,
 * pours/planes, return-current continuity or electrical sign-off.
 */
const MIL_TO_MM = 0.0254;
const MAX_TRACKS = 1200;
const MAX_COORDINATE_MIL = 1_000_000;

export interface NativePadRoutePoint {
  x: number;
  y: number;
  layer: number;
  net: string;
}

export interface NativePadRouteChain {
  evidence: 'observed_exact_endpoint_chain' | 'unavailable';
  selection: 'fewest_segments' | 'unavailable';
  primitive_ids: string[];
  native_layer?: number;
  observed_centerline_length_mm?: number;
  reasons: string[];
  electrical_continuity_status: 'UNKNOWN';
}

interface Edge {
  primitiveId: string;
  other: string;
  lengthMil: number;
}

interface Candidate {
  primitiveIds: string[];
  lengthMil: number;
  layer: number;
}

function unavailable(reason: string): NativePadRouteChain {
  return {
    evidence: 'unavailable',
    selection: 'unavailable',
    primitive_ids: [],
    reasons: [reason],
    electrical_continuity_status: 'UNKNOWN',
  };
}

function exactText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function coordinate(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE_MIL
  );
}

function padRoutePoint(point: NativePadRoutePoint): boolean {
  return (
    coordinate(point.x) &&
    coordinate(point.y) &&
    exactText(point.net) &&
    (point.layer === 12 || nativeCopperLayerCode(point.layer))
  );
}

function validTrack(track: NativeTrack): boolean {
  return (
    exactText(track.primitiveId) &&
    exactText(track.net) &&
    nativeCopperLayerCode(track.layer) &&
    coordinate(track.startX) &&
    coordinate(track.startY) &&
    coordinate(track.endX) &&
    coordinate(track.endY) &&
    typeof track.width === 'number' &&
    Number.isFinite(track.width) &&
    track.width > 0 &&
    track.width <= MAX_COORDINATE_MIL &&
    (track.startX !== track.endX || track.startY !== track.endY)
  );
}

function padSupportsObservedLayer(padLayer: number, copperLayer: number): boolean {
  // MULTI (12) may coincide geometrically with a copper layer; it does not
  // establish metallization or a real electrical connection to that layer.
  return padLayer === 12 || padLayer === copperLayer;
}

function key(x: number, y: number): string {
  return JSON.stringify([x, y]);
}

function addEdge(graph: Map<string, Edge[]>, source: string, edge: Edge): void {
  const current = graph.get(source) ?? [];
  current.push(edge);
  graph.set(source, current);
}

function layerGraph(tracks: NativeTrack[]): Map<string, Edge[]> {
  const graph = new Map<string, Edge[]>();
  for (const track of tracks) {
    const first = key(track.startX as number, track.startY as number);
    const second = key(track.endX as number, track.endY as number);
    const lengthMil = Math.hypot(
      (track.endX as number) - (track.startX as number),
      (track.endY as number) - (track.startY as number),
    );
    addEdge(graph, first, { primitiveId: track.primitiveId as string, other: second, lengthMil });
    addEdge(graph, second, { primitiveId: track.primitiveId as string, other: first, lengthMil });
  }
  for (const edges of graph.values()) {
    edges.sort((a, b) =>
      a.primitiveId < b.primitiveId ? -1 : a.primitiveId > b.primitiveId ? 1 : 0,
    );
  }
  return graph;
}

function findEndpointChain(
  graph: Map<string, Edge[]>,
  start: string,
  end: string,
): Omit<Candidate, 'layer'> | undefined {
  if (!graph.has(start) || !graph.has(end) || start === end) return undefined;
  const queue = [start];
  const previous = new Map<string, { from: string; edge: Edge }>();
  const visited = new Set([start]);
  // Iterate values directly rather than indexing with a dynamic key.
  // Appended, unvisited neighbors are visited in FIFO order by for-of.
  for (const node of queue) {
    if (node === end) break;
    for (const edge of graph.get(node) ?? []) {
      if (visited.has(edge.other)) continue;
      visited.add(edge.other);
      previous.set(edge.other, { from: node, edge });
      queue.push(edge.other);
    }
  }
  if (!visited.has(end)) return undefined;
  const primitiveIds: string[] = [];
  let lengthMil = 0;
  let node = end;
  while (node !== start) {
    const step = previous.get(node);
    if (!step) return undefined;
    primitiveIds.push(step.edge.primitiveId);
    lengthMil += step.edge.lengthMil;
    node = step.from;
  }
  primitiveIds.reverse();
  return { primitiveIds, lengthMil };
}

function candidateOrder(a: Candidate, b: Candidate): number {
  return (
    a.primitiveIds.length - b.primitiveIds.length || a.lengthMil - b.lengthMil || a.layer - b.layer
  );
}

export function observeNativePadRouteChain(
  first: NativePadRoutePoint | undefined,
  second: NativePadRoutePoint | undefined,
  tracks: NativeTrack[],
  collectionComplete: boolean,
): NativePadRouteChain {
  if (!collectionComplete || tracks.length > MAX_TRACKS) {
    return unavailable('A complete, bounded native track/via inventory is required.');
  }
  if (
    !first ||
    !second ||
    !padRoutePoint(first) ||
    !padRoutePoint(second) ||
    first.net !== second.net
  ) {
    return unavailable('Both pad centers must have trustworthy native geometry and one exact net.');
  }
  if (
    !tracks.every(validTrack) ||
    new Set(tracks.map((track) => track.primitiveId)).size !== tracks.length
  ) {
    return unavailable('At least one native track primitive is malformed or duplicated.');
  }
  const source = key(first.x, first.y);
  const target = key(second.x, second.y);
  const layers = [...new Set(tracks.filter((t) => t.net === first.net).map((t) => t.layer))]
    .filter(
      (layer): layer is number =>
        nativeCopperLayerCode(layer) &&
        padSupportsObservedLayer(first.layer, layer) &&
        padSupportsObservedLayer(second.layer, layer),
    )
    .sort((a, b) => a - b);
  const candidates = layers.flatMap((layer) => {
    const graph = layerGraph(tracks.filter((t) => t.net === first.net && t.layer === layer));
    const chain = findEndpointChain(graph, source, target);
    return chain ? [{ ...chain, layer }] : [];
  });
  candidates.sort(candidateOrder);
  if (candidates.length === 0) {
    return unavailable(
      'No exact same-layer, same-net native track endpoint chain joins both pad centers; absent evidence does not prove disconnection.',
    );
  }
  const candidate = candidates[0] as Candidate;
  return {
    evidence: 'observed_exact_endpoint_chain',
    selection: 'fewest_segments',
    primitive_ids: candidate.primitiveIds,
    native_layer: candidate.layer,
    observed_centerline_length_mm: candidate.lengthMil * MIL_TO_MM,
    reasons: [
      'A geometric same-net/same-layer endpoint chain was observed. Physical pad contact, copper pours, vias, other paths, return-current continuity and electrical sign-off remain unverified.',
    ],
    electrical_continuity_status: 'UNKNOWN',
  };
}
