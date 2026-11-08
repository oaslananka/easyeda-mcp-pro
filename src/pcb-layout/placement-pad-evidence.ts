import {
  observeNativePadRouteChain,
  type NativePadRouteChain,
} from './placement-pad-route-chain.js';
import type { NativeTrack } from './route-review.js';

/**
 * Opt-in native component-pad distance screening.
 * A straight-line pad-center distance is not copper routing, plane contact,
 * loop area, impedance or an electrical/DFM acceptance decision.
 */

const MIL_TO_MM = 0.0254;
const MAX_PADS_PER_COMPONENT = 128;

export interface NativePadPairDeclaration {
  firstPin: string;
  secondPin: string;
  expectedNet: string;
  maxCenterDistanceMm?: number;
}

export interface NativePadPairFinding {
  first_pin: string;
  second_pin: string;
  expected_net: string;
  status: 'WARNING' | 'UNKNOWN';
  evidence: 'native_component_pads' | 'unavailable';
  native_first_net?: string;
  native_second_net?: string;
  native_pad_layer_codes?: number[];
  measured_pad_center_distance_mm?: number;
  declared_max_pad_center_distance_mm?: number;
  reasons: string[];
  electrical_loop_status: 'UNKNOWN';
  route_chain?: NativePadRouteChain;
}

interface ComponentPad {
  primitiveId: string;
  parentComponentPrimitiveId: string;
  padNumber: string;
  net: string;
  x: number;
  y: number;
  layer: number;
}

function nativePadIdentity(v: Record<string, unknown>, parentId: string): boolean {
  return (
    typeof v.primitiveId === 'string' &&
    v.primitiveId.length > 0 &&
    v.parentComponentPrimitiveId === parentId &&
    typeof v.padNumber === 'string' &&
    v.padNumber.length > 0 &&
    v.padNumber === v.padNumber.trim() &&
    typeof v.net === 'string' &&
    v.net === v.net.trim()
  );
}

function nativePadGeometry(v: Record<string, unknown>): boolean {
  return (
    Number.isFinite(v.x) &&
    Number.isFinite(v.y) &&
    Math.abs(v.x as number) <= 1_000_000 &&
    Math.abs(v.y as number) <= 1_000_000 &&
    typeof v.layer === 'number' &&
    Number.isSafeInteger(v.layer)
  );
}

function validPad(value: unknown, parentId: string): value is ComponentPad {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return nativePadIdentity(v, parentId) && nativePadGeometry(v);
}

function uniquePads(raw: unknown, parentId: string): ComponentPad[] | undefined {
  if (
    !Array.isArray(raw) ||
    raw.length < 1 ||
    raw.length > MAX_PADS_PER_COMPONENT ||
    !raw.every((pad) => validPad(pad, parentId))
  )
    return undefined;
  const pads = raw as ComponentPad[];
  if (
    new Set(pads.map((p) => p.primitiveId)).size !== pads.length ||
    new Set(pads.map((p) => p.padNumber)).size !== pads.length
  )
    return undefined;
  return pads;
}

function optionalRouteChain(
  first: ComponentPad | undefined,
  second: ComponentPad | undefined,
  source: { tracks: NativeTrack[]; complete: boolean } | undefined,
): NativePadRouteChain | undefined {
  return source
    ? observeNativePadRouteChain(first, second, source.tracks, source.complete)
    : undefined;
}

export function reviewNativePlacementPadPair(
  declaration: NativePadPairDeclaration,
  componentIds: { first: string; second: string } | undefined,
  observations: { first: unknown; second: unknown } | undefined,
  routeSource?: { tracks: NativeTrack[]; complete: boolean },
): NativePadPairFinding {
  const base: NativePadPairFinding = {
    first_pin: declaration.firstPin,
    second_pin: declaration.secondPin,
    expected_net: declaration.expectedNet,
    status: 'UNKNOWN',
    evidence: 'unavailable',
    reasons: [],
    electrical_loop_status: 'UNKNOWN',
    route_chain: optionalRouteChain(undefined, undefined, routeSource),
  };
  if (!componentIds || !observations || componentIds.first === componentIds.second) {
    base.reasons.push('Matched native component and pad evidence is unavailable.');
    return base;
  }
  const first = uniquePads(observations.first, componentIds.first);
  const second = uniquePads(observations.second, componentIds.second);
  if (!first || !second) {
    base.reasons.push(
      'Native component pads are incomplete, duplicated, or have invalid parent/geometry identity.',
    );
    return base;
  }
  const a = first.find((p) => p.padNumber === declaration.firstPin);
  const b = second.find((p) => p.padNumber === declaration.secondPin);
  if (!a || !b || !a.net || !b.net) {
    base.reasons.push('Requested pad number or populated native net is unavailable.');
    return base;
  }
  base.route_chain = optionalRouteChain(a, b, routeSource);
  base.evidence = 'native_component_pads';
  base.native_first_net = a.net;
  base.native_second_net = b.net;
  base.native_pad_layer_codes = [a.layer, b.layer];
  base.measured_pad_center_distance_mm = Math.hypot(a.x - b.x, a.y - b.y) * MIL_TO_MM;
  if (declaration.maxCenterDistanceMm !== undefined) {
    base.declared_max_pad_center_distance_mm = declaration.maxCenterDistanceMm;
  }
  if (a.net !== b.net || a.net !== declaration.expectedNet) {
    base.status = 'WARNING';
    base.reasons.push(
      'Observed native pad nets differ from each other or the caller-declared net.',
    );
  } else if (
    declaration.maxCenterDistanceMm !== undefined &&
    base.measured_pad_center_distance_mm > declaration.maxCenterDistanceMm + 1e-9
  ) {
    base.status = 'WARNING';
    base.reasons.push(
      'Observed pad-center distance exceeds the caller-declared source-specific limit.',
    );
  }
  base.reasons.push(
    'Pad-center distance is straight-line geometry, not routed copper length, return-current loop or electrical sign-off.',
  );
  return base;
}
