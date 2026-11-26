import {
  observeNativePadContactChain,
  type NativePadContactChain,
} from './placement-pad-contact-chain.js';
import type { NativeTrack } from './route-review.js';

/**
 * Bounded, source-attributed beta EasyEDA pad associations.
 * API associations are evidence of what EasyEDA reported, never a copper,
 * reference-plane, filled-zone or electrical-current-loop sign-off.
 */
const MAX_CONNECTED = 128;

export interface NativePadAssociationFinding {
  evidence: 'native_reported' | 'native_reported_centre' | 'unavailable';
  first_primitive_ids: string[];
  second_primitive_ids: string[];
  shared_primitive_ids: string[];
  reasons: string[];
  electrical_continuity_status: 'UNKNOWN';
  associated_route_chain?: NativePadContactChain;
}

type NativePadAssociation = {
  evidence: 'native_reported' | 'native_reported_centre';
  componentPrimitiveId: string;
  padPrimitiveId: string;
  padNumber: string;
  net: string;
  connected: Array<{
    primitiveId: string;
    net: string;
    nativeType: string | number;
    layer?: number;
  }>;
};

function unavailable(reason: string): NativePadAssociationFinding {
  return {
    evidence: 'unavailable',
    first_primitive_ids: [],
    second_primitive_ids: [],
    shared_primitive_ids: [],
    reasons: [reason],
    electrical_continuity_status: 'UNKNOWN',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validIds(value: unknown): value is NativePadAssociation['connected'] {
  if (!Array.isArray(value) || value.length > MAX_CONNECTED) return false;
  return value.every(
    (item) =>
      isRecord(item) &&
      typeof item.primitiveId === 'string' &&
      item.primitiveId.length > 0 &&
      item.primitiveId === item.primitiveId.trim() &&
      typeof item.net === 'string' &&
      (typeof item.nativeType === 'string' ||
        (typeof item.nativeType === 'number' && Number.isFinite(item.nativeType))) &&
      (item.layer === undefined ||
        (typeof item.layer === 'number' && Number.isSafeInteger(item.layer))),
  );
}

function decode(
  raw: unknown,
  expectedComponent: string,
  expectedPin: string,
  expectedNet: string,
  centreOnly: boolean,
): NativePadAssociation | undefined {
  if (
    !isRecord(raw) ||
    raw.evidence !== (centreOnly ? 'native_reported_centre' : 'native_reported')
  )
    return undefined;
  if (
    raw.componentPrimitiveId !== expectedComponent ||
    raw.padNumber !== expectedPin ||
    raw.net !== expectedNet ||
    typeof raw.padPrimitiveId !== 'string' ||
    !raw.padPrimitiveId ||
    raw.padPrimitiveId !== raw.padPrimitiveId.trim() ||
    !validIds(raw.connected)
  )
    return undefined;
  const ids = raw.connected.map((item) => item.primitiveId);
  if (new Set(ids).size !== ids.length || raw.connected.some((item) => item.net !== expectedNet))
    return undefined;
  return raw as NativePadAssociation;
}

export function reviewNativePadAssociations(
  firstRaw: unknown,
  secondRaw: unknown,
  expected: {
    firstComponentId: string;
    secondComponentId: string;
    firstPin: string;
    secondPin: string;
    net: string;
    firstPadId?: string;
    secondPadId?: string;
  },
  routeSource?: { tracks: NativeTrack[]; complete: boolean; padLayers: number[] },
  centreOnly = false,
): NativePadAssociationFinding {
  const first = decode(
    firstRaw,
    expected.firstComponentId,
    expected.firstPin,
    expected.net,
    centreOnly,
  );
  const second = decode(
    secondRaw,
    expected.secondComponentId,
    expected.secondPin,
    expected.net,
    centreOnly,
  );
  if (
    !first ||
    !second ||
    first.padPrimitiveId === second.padPrimitiveId ||
    (expected.firstPadId !== undefined && first.padPrimitiveId !== expected.firstPadId) ||
    (expected.secondPadId !== undefined && second.padPrimitiveId !== expected.secondPadId)
  ) {
    return unavailable('Native focused pad association source is unavailable or inconsistent.');
  }
  const firstIds = first.connected.map((x) => x.primitiveId);
  const secondIds = second.connected.map((x) => x.primitiveId);
  const secondSet = new Set(secondIds);
  const layerCompatible = (
    contacts: NativePadAssociation['connected'],
    layer: number | undefined,
  ) => layer === 12 || contacts.every((contact) => contact.layer === layer);
  const chain = routeSource
    ? observeNativePadContactChain(
        expected.net,
        first.connected,
        second.connected,
        routeSource.tracks,
        routeSource.complete &&
          routeSource.padLayers.length === 2 &&
          layerCompatible(first.connected, routeSource.padLayers[0]) &&
          layerCompatible(second.connected, routeSource.padLayers[1]),
      )
    : undefined;
  return {
    evidence: first.evidence,
    first_primitive_ids: firstIds,
    second_primitive_ids: secondIds,
    shared_primitive_ids: firstIds.filter((id) => secondSet.has(id)),
    ...(chain ? { associated_route_chain: chain } : {}),
    reasons: [
      'Native beta getConnectedPrimitives(' +
        String(centreOnly) +
        ') reports direct pad associations only. Missing associations do not prove disconnection; reported overlap does not prove a closed copper or reference-plane current path.',
    ],
    electrical_continuity_status: 'UNKNOWN',
  };
}

export const unknownNativePadAssociations = unavailable;
