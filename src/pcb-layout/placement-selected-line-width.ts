import type { NativePadPairFinding } from './placement-pad-evidence.js';
import { validNativeRouteInventory } from './placement-pad-route-chain.js';
import type { NativeTrack } from './route-review.js';

export interface SelectedLineWidthReview {
  evidence:
    'observed_exact_endpoint_chain' | 'native_reported' | 'native_reported_centre' | 'unavailable';
  status: 'WARNING' | 'UNKNOWN';
  declared_min_line_width_mm: number;
  observed_min_line_width_mm?: number;
  native_layer?: number;
  narrowest_line_ids: string[];
  electrical_continuity_status: 'UNKNOWN';
  reasons: string[];
}

interface SelectedChain {
  evidence: Exclude<SelectedLineWidthReview['evidence'], 'unavailable'>;
  ids: string[];
  layer: number | undefined;
}

function selectChain(pad: NativePadPairFinding): SelectedChain | undefined {
  const exact = pad.route_chain;
  if (exact?.evidence === 'observed_exact_endpoint_chain') {
    return { evidence: exact.evidence, ids: exact.primitive_ids, layer: exact.native_layer };
  }
  const association = pad.native_pad_associations;
  const chain = association?.associated_route_chain;
  if (
    association &&
    association.evidence !== 'unavailable' &&
    chain?.evidence === 'observed_associated_endpoint_chain'
  ) {
    return { evidence: association.evidence, ids: chain.primitive_ids, layer: chain.native_layer };
  }
  return undefined;
}

function selectedTracks(
  pad: NativePadPairFinding,
  tracks: Required<NativeTrack>[],
  chain: SelectedChain,
): Required<NativeTrack>[] | undefined {
  if (
    !chain.ids.length ||
    new Set(chain.ids).size !== chain.ids.length ||
    chain.layer === undefined
  )
    return undefined;
  const byId = new Map(tracks.map((t) => [t.primitiveId, t]));
  const selected: Required<NativeTrack>[] = [];
  for (const id of chain.ids) {
    const t = byId.get(id);
    if (!t || t.net !== pad.expected_net || t.layer !== chain.layer) return undefined;
    selected.push(t);
  }
  return selected;
}

export function reviewSelectedLineWidth(
  pad: NativePadPairFinding,
  minimum: number,
  tracks: NativeTrack[],
  complete: boolean,
): SelectedLineWidthReview {
  const base: SelectedLineWidthReview = {
    evidence: 'unavailable',
    status: 'UNKNOWN',
    declared_min_line_width_mm: minimum,
    narrowest_line_ids: [],
    electrical_continuity_status: 'UNKNOWN',
    reasons: [
      'Complete matched source, exact pad nets and a selected native line chain are required. Missing evidence does not establish a width violation.',
    ],
  };
  if (
    pad.evidence !== 'native_component_pads' ||
    pad.native_first_net !== pad.expected_net ||
    pad.native_second_net !== pad.expected_net ||
    !validNativeRouteInventory(tracks, complete)
  )
    return base;
  const chain = selectChain(pad);
  if (!chain) return base;
  const selected = selectedTracks(pad, tracks, chain);
  if (!selected) return base;
  const width = Math.min(...selected.map((t) => t.width)) * 0.0254;
  return {
    ...base,
    evidence: chain.evidence,
    status: width + 1e-9 < minimum ? 'WARNING' : 'UNKNOWN',
    observed_min_line_width_mm: width,
    native_layer: chain.layer,
    narrowest_line_ids: selected
      .filter((t) => t.width * 0.0254 === width)
      .map((t) => t.primitiveId),
    reasons: [
      'Compares the minimum width of the selected observed line chain with a caller-declared source-specific criterion.',
      'Not an all-path bottleneck, current-capacity, physical pad contact, return-plane or electrical adequacy assessment.',
    ],
  };
}
