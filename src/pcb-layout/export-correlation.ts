import { createHash } from 'node:crypto';
import {
  parseCopperExport,
  parseIpcExport,
  type Layer,
  type Point,
  type Stroke,
} from './export-correlation-parsers.js';

const TOLERANCE = 100; // 0.001 mm, one observed IPC metric coordinate unit.
const MAX_COMPARISONS = 2_000_000;
const distance = (a: Point, b: Point) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

function strokeError(a: Stroke, b: Stroke): number {
  return Math.min(
    Math.max(distance(a.start, b.start), distance(a.end, b.end)),
    Math.max(distance(a.start, b.end), distance(a.end, b.start)),
  );
}

function matches<T extends { net: string; line: number }, U extends { line: number }>(
  records: T[],
  features: U[],
  error: (record: T, feature: U) => number,
) {
  if (records.length * features.length > MAX_COMPARISONS)
    throw new Error('Correlation exceeds comparison budget');
  const claims = new Map<number, number>();
  const candidates = records.map((record) => {
    let count = 0;
    let first: { line: number; errorTicks: number } | undefined;
    for (const feature of features) {
      const e = error(record, feature);
      if (e > TOLERANCE) continue;
      count++;
      first ??= { line: feature.line, errorTicks: e };
      claims.set(feature.line, (claims.get(feature.line) ?? 0) + 1);
    }
    return { count, first };
  });
  return records.map((record, index) => {
    const hits = candidates[index];
    if (!hits) throw new Error('Internal correlation inventory mismatch');
    const hit = hits.first;
    const unique = hits.count === 1 && hit && claims.get(hit.line) === 1;
    return {
      ...record,
      status: unique
        ? ('MATCHED' as const)
        : hits.count
          ? ('AMBIGUOUS' as const)
          : ('UNMATCHED' as const),
      ...(unique ? { gerberLine: hit.line, coordinateErrorMm: hit.errorTicks / 100_000 } : {}),
    };
  });
}

/** Correlates observed artwork objects, never physical or topological connectivity. */
export function correlateExportGeometry(gerber: string, ipc: string, layer: Layer, net: string) {
  if (layer !== 'top' && layer !== 'bottom') throw new Error('Select top or bottom layer');
  if (!net || net !== net.trim() || net.length > 14)
    throw new Error('Specify an exact IPC net name (up to 14 characters)');
  const copper = parseCopperExport(gerber, layer);
  const design = parseIpcExport(ipc);
  const conductors = design.conductors.filter((record) => record.layer === layer);
  const padMatches = matches(design.pads, copper.flashes, (a, b) =>
    distance(a.point, b.point),
  ).filter((x) => x.net === net);
  const conductorMatches = matches(conductors, copper.strokes, (a, b) =>
    a.width === b.width ? strokeError(a, b) : Infinity,
  ).filter((x) => x.net === net);
  const selected = [...padMatches, ...conductorMatches];
  const matched = selected.filter((x) => x.status === 'MATCHED').length;
  return {
    correlationStatus:
      selected.length === 0
        ? 'NO_RECORDS'
        : matched === selected.length
          ? 'MATCHED_OBSERVED_RECORDS'
          : 'PARTIAL_OR_AMBIGUOUS',
    summary: {
      matched,
      unmatched: selected.filter((x) => x.status === 'UNMATCHED').length,
      ambiguous: selected.filter((x) => x.status === 'AMBIGUOUS').length,
    },
    evidence: 'OFFLINE_EXPORT_GEOMETRY_CORRELATION' as const,
    layer,
    net,
    sourceHashes: { gerber: hash(gerber), ipc: hash(ipc) },
    coordinateUnit: '0.00001 mm' as const,
    matchingToleranceMm: TOLERANCE / 100_000,
    inventory: {
      ipcPads: design.pads.length,
      ipcLayerSegments: conductors.length,
      gerberFlashes: copper.flashes.length,
      gerberLinearCircularStrokes: copper.strokes.length,
      omitted: copper.omitted,
    },
    padMatches,
    conductorMatches,
    electricalContinuity: 'UNKNOWN' as const,
    engineeringSignOff: false as const,
    limitations: [
      'Only the observed EasyEDA Pro metric all-dark export dialect is supported. Pad matches use flash centers, not complete pad geometry.',
      'Line matches compare nominal width and both endpoints; curves, regions and noncircular strokes are excluded. Matches do not prove connected copper or net isolation.',
      'No drill, plating, board outline, return current, impedance or manufacturing sign-off. Unmatched or ambiguous records do not prove disconnection.',
    ],
  };
}
