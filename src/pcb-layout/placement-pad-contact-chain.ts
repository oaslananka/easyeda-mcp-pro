import { validNativeRouteInventory } from './placement-pad-route-chain.js';
import type { NativeTrack } from './route-review.js';

const MIL_TO_MM = 0.0254;
const MAX_CONTACTS = 128;
type Track = Required<NativeTrack>;

export interface NativePadTrackContact {
  primitiveId: string;
  net: string;
  layer?: number;
  nativeType: string | number;
}

export interface NativePadContactChain {
  evidence: 'observed_associated_endpoint_chain' | 'unavailable';
  selection: 'fewest_segments' | 'unavailable';
  primitive_ids: string[];
  native_layer?: number;
  observed_full_segment_length_mm?: number;
  reasons: string[];
  electrical_continuity_status: 'UNKNOWN';
}

function unavailable(reason: string): NativePadContactChain {
  return {
    evidence: 'unavailable',
    selection: 'unavailable',
    primitive_ids: [],
    reasons: [reason],
    electrical_continuity_status: 'UNKNOWN',
  };
}

function contactIds(
  contacts: NativePadTrackContact[],
  net: string,
  tracks: Map<string, Track>,
): string[] | undefined {
  if (!contacts.length || contacts.length > MAX_CONTACTS) return;
  const ids = contacts.map((contact) => contact.primitiveId);
  if (new Set(ids).size !== ids.length) return;
  for (const contact of contacts) {
    const track = tracks.get(contact.primitiveId);
    // An unresolved ID may be an arc/via or stale observation. Do not infer
    // that an unverified association is a line in the inventoried layer.
    if (
      !track ||
      contact.nativeType !== 'Line' ||
      contact.net !== net ||
      track.net !== net ||
      contact.layer !== track.layer
    )
      return;
  }
  return ids.sort();
}

function endpointKeys(track: Track): string[] {
  return [
    JSON.stringify([track.layer, track.startX, track.startY]),
    JSON.stringify([track.layer, track.endX, track.endY]),
  ].sort();
}

function endpointIndex(tracks: Track[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const track of tracks) {
    for (const key of endpointKeys(track)) {
      const ids = index.get(key) ?? [];
      ids.push(track.primitiveId);
      index.set(key, ids);
    }
  }
  for (const ids of index.values()) ids.sort();
  return index;
}

function reconstruct(last: string, parent: Map<string, string | null>): string[] {
  const path: string[] = [];
  let node: string | null = last;
  while (node !== null) {
    path.push(node);
    node = parent.get(node) ?? null;
  }
  return path.reverse();
}

function findChain(
  first: string[],
  second: string[],
  tracks: Map<string, Track>,
): string[] | undefined {
  const index = endpointIndex([...tracks.values()]);
  const target = new Set(second);
  const queue = [...first];
  const parent = new Map<string, string | null>(first.map((id) => [id, null]));
  const visitedEndpoints = new Set<string>();
  for (const id of queue) {
    if (target.has(id)) return reconstruct(id, parent);
    const track = tracks.get(id);
    if (!track) return;
    for (const endpoint of endpointKeys(track)) {
      if (visitedEndpoints.has(endpoint)) continue;
      visitedEndpoints.add(endpoint);
      for (const neighbor of index.get(endpoint) ?? []) {
        if (parent.has(neighbor)) continue;
        parent.set(neighbor, id);
        queue.push(neighbor);
      }
    }
  }
  return undefined;
}

/**
 * Observe a same-layer, same-net chain of inventoried line segments anchored
 * by native pad associations, not by synthetic pad-center equality.
 * The reported length sums entire segments (including the terminal lines);
 * it is NOT the physical distance along copper between the contact points.
 */
export function observeNativePadContactChain(
  net: string,
  first: NativePadTrackContact[],
  second: NativePadTrackContact[],
  tracks: NativeTrack[],
  complete: boolean,
): NativePadContactChain {
  if (!net || net.trim() !== net || !validNativeRouteInventory(tracks, complete)) {
    return unavailable(
      'A complete, bounded, identity-unique native line inventory and exact net are required.',
    );
  }
  const byId = new Map(
    tracks.filter((track) => track.net === net).map((track) => [track.primitiveId, track]),
  );
  const from = contactIds(first, net, byId);
  const to = contactIds(second, net, byId);
  if (!from || !to) {
    return unavailable(
      'Both native pad association lists must report Line primitives with matching inventoried IDs, nets and layers; other or unverified types are not evaluated.',
    );
  }
  const chain = findChain(from, to, byId);
  if (!chain) {
    return unavailable(
      'No exact same-net/same-layer endpoint chain joins the reported pad-associated lines; missing evidence does not prove disconnection.',
    );
  }
  const segments = chain.map((id) => byId.get(id) as Track);
  return {
    evidence: 'observed_associated_endpoint_chain',
    selection: 'fewest_segments',
    primitive_ids: chain,
    native_layer: segments[0]?.layer,
    observed_full_segment_length_mm:
      segments.reduce(
        (sum, track) => sum + Math.hypot(track.endX - track.startX, track.endY - track.startY),
        0,
      ) * MIL_TO_MM,
    reasons: [
      'Native reported pad associations anchor an exact line-endpoint chain. Full segment length is not pad-to-pad path length; physical pad contact, pours, via continuity, return-current path and engineering sign-off remain unverified.',
    ],
    electrical_continuity_status: 'UNKNOWN',
  };
}
