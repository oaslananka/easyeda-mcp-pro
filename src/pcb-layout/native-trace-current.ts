import { calculateTraceWidth, type ConductorLayer } from '../design-rules/trace-width.js';
import type { NativeTrack } from './route-review.js';

const MIL_TO_MM = 0.0254;
const INVALID_VERSIONS = new Set([
  '',
  'undefined',
  'null',
  'unknown',
  'nan',
  '[object object]',
  '[object promise]',
]);

export interface NativeTraceCurrentDeclaration {
  net: string;
  currentA: number;
  temperatureRiseC: number;
  layer: ConductorLayer;
  copperWeightOz: number;
  environment?: 'still-air' | 'forced-air' | 'vacuum' | 'unspecified';
  manufacturerMinWidthMm?: number;
}

export interface NativeTraceCurrentInput {
  declaration: NativeTraceCurrentDeclaration;
  tracks: NativeTrack[];
  trackCount: number;
  collectionComplete: boolean;
  easyedaVersion?: string | null;
  extensionVersion?: string | null;
}

export interface NativeTraceCurrentResult {
  net: string;
  status: 'WARNING' | 'UNKNOWN';
  method: 'IPC2221_EMPIRICAL_REFERENCE';
  geometry_source: 'pcb.listTracks';
  geometry_evidence: 'observed_bounded_segments' | 'unavailable';
  source_versions: { easyeda: string | null; extension: string | null };
  width_unit: 'mm';
  declaration: NativeTraceCurrentDeclaration;
  model_source: string;
  empirical_reference_width_mm: number;
  observed_narrowest_segment_width_mm?: number;
  observed_primitive_ids: string[];
  findings: Array<{
    id:
      | 'NATIVE_GEOMETRY_UNKNOWN'
      | 'THERMAL_REFERENCE_SHORTFALL'
      | 'FABRICATION_DECLARATION_SHORTFALL'
      | 'FABRICATION_DECLARATION_INVALID'
      | 'THERMAL_ADEQUACY_UNKNOWN'
      | 'VIA_CURRENT_UNKNOWN';
    status: 'WARNING' | 'UNKNOWN';
    message: string;
  }>;
  limitations: string[];
  engineering_sign_off: false;
}

function sourceVersion(value: string | null | undefined): string | null {
  const version = value?.trim();
  return version && !INVALID_VERSIONS.has(version.toLowerCase()) ? version : null;
}

function exactIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function boundedCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}

function trustedNativeIdentity(tracks: NativeTrack[]): boolean {
  const ids = tracks.map((track) => track.primitiveId);
  return (
    ids.every(exactIdentity) &&
    tracks.every((track) => exactIdentity(track.net)) &&
    new Set(ids).size === ids.length
  );
}

function validManufacturerMinimum(width: number | undefined): boolean {
  return width === undefined || (Number.isFinite(width) && width > 0);
}

function validSegment(track: NativeTrack): boolean {
  return (
    exactIdentity(track.primitiveId) &&
    exactIdentity(track.net) &&
    Number.isInteger(track.layer) &&
    typeof track.width === 'number' &&
    Number.isFinite(track.width) &&
    track.width > 0 &&
    track.width <= 1_000_000 &&
    boundedCoordinate(track.startX) &&
    boundedCoordinate(track.startY) &&
    boundedCoordinate(track.endX) &&
    boundedCoordinate(track.endY) &&
    (track.startX !== track.endX || track.startY !== track.endY)
  );
}

function nativeNetGeometryComplete(
  input: NativeTraceCurrentInput,
  matching: NativeTrack[],
  ids: Array<string | undefined>,
  easyeda: string | null,
  extension: string | null,
): boolean {
  return (
    input.collectionComplete &&
    input.trackCount === input.tracks.length &&
    easyeda !== null &&
    extension !== null &&
    exactIdentity(input.declaration.net) &&
    trustedNativeIdentity(input.tracks) &&
    matching.length > 0 &&
    matching.every(validSegment) &&
    // One declared external/internal thermal class cannot be applied to
    // copper segments observed on multiple native layer codes.
    new Set(matching.map((track) => track.layer)).size === 1 &&
    ids.every(exactIdentity) &&
    new Set(ids).size === ids.length
  );
}

/**
 * Compare an actual bounded native net-segment minimum with an *unverified*
 * caller-declared thermal reference. This never proves current-path topology,
 * copper thickness, via ampacity, heat transfer or fabrication readiness.
 */
export function reviewNativeTraceCurrent(input: NativeTraceCurrentInput): NativeTraceCurrentResult {
  const { declaration } = input;
  const easyeda = sourceVersion(input.easyedaVersion);
  const extension = sourceVersion(input.extensionVersion);
  const reference = calculateTraceWidth({
    currentA: declaration.currentA,
    temperatureRiseC: declaration.temperatureRiseC,
    layer: declaration.layer,
    copperWeightOz: declaration.copperWeightOz,
  });
  const matching = input.tracks.filter((track) => track.net === declaration.net);
  const ids = matching.map((track) => track.primitiveId);
  const minWidth = nativeNetGeometryComplete(input, matching, ids, easyeda, extension)
    ? Math.min(...matching.map((track) => (track.width as number) * MIL_TO_MM))
    : undefined;
  const findings: NativeTraceCurrentResult['findings'] = [];

  if (minWidth === undefined) {
    findings.push({
      id: 'NATIVE_GEOMETRY_UNKNOWN',
      status: 'UNKNOWN',
      message:
        'Selected-net native geometry is absent, malformed, spans multiple native layers, incomplete or not version-bound; no trace-width verdict is available.',
    });
  } else {
    if (minWidth < reference.traceWidthMm) {
      findings.push({
        id: 'THERMAL_REFERENCE_SHORTFALL',
        status: 'WARNING',
        message:
          'A native segment is narrower than the IPC-2221 empirical estimate under caller-declared assumptions; investigate the current path and thermal design.',
      });
    } else {
      findings.push({
        id: 'THERMAL_ADEQUACY_UNKNOWN',
        status: 'UNKNOWN',
        message:
          'Measured segment width is not below this empirical reference; that does not establish thermal adequacy.',
      });
    }
    if (
      declaration.manufacturerMinWidthMm !== undefined &&
      validManufacturerMinimum(declaration.manufacturerMinWidthMm) &&
      minWidth < declaration.manufacturerMinWidthMm
    ) {
      findings.push({
        id: 'FABRICATION_DECLARATION_SHORTFALL',
        status: 'WARNING',
        message:
          'Observed segment width is below the caller-declared manufacturer minimum; the fabricator process itself is unverified.',
      });
    }
  }

  if (!validManufacturerMinimum(declaration.manufacturerMinWidthMm)) {
    findings.push({
      id: 'FABRICATION_DECLARATION_INVALID',
      status: 'UNKNOWN',
      message:
        'Caller-declared manufacturer minimum must be finite and positive; process capability remains unverified.',
    });
  }

  findings.push({
    id: 'VIA_CURRENT_UNKNOWN',
    status: 'UNKNOWN',
    message:
      'Native segment widths cannot prove via ampacity, neck-down topology, plane paths or current sharing.',
  });

  return {
    net: declaration.net,
    status: findings.some((finding) => finding.status === 'WARNING') ? 'WARNING' : 'UNKNOWN',
    method: 'IPC2221_EMPIRICAL_REFERENCE',
    geometry_source: 'pcb.listTracks',
    geometry_evidence: minWidth === undefined ? 'unavailable' : 'observed_bounded_segments',
    source_versions: { easyeda, extension },
    width_unit: 'mm',
    declaration,
    model_source: reference.source,
    empirical_reference_width_mm: reference.traceWidthMm,
    ...(minWidth === undefined ? {} : { observed_narrowest_segment_width_mm: minWidth }),
    observed_primitive_ids: minWidth === undefined ? [] : (ids as string[]).sort(),
    findings,
    limitations: [
      'IPC-2221 is an empirical reference, NOT an IPC-2152 thermal model or guaranteed limit.',
      'Current, layer class, copper weight, temperature rise, environment and manufacturer minimum remain caller declarations; native stackup/finished copper thickness was not verified.',
      'A single caller-declared thermal layer class cannot be mapped to multiple native copper layer codes; mixed-layer net reviews require separate source-bound layer assumptions.',
      "Native primitive reads are bounded and non-atomic; only the selected net's returned segments were compared, not a verified end-to-end current path.",
      'Via plating, bottlenecks, pours, copper return paths, dissipation and environmental heat transfer remain UNKNOWN.',
      'This read-only review does not run DRC or certify fabrication, electrical safety or thermal adequacy.',
    ],
    engineering_sign_off: false,
  };
}
