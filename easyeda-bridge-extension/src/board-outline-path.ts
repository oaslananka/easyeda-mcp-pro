import { readFiniteNumber } from './pcb-primitive-state.js';

type Point = [number, number];
const FULL_TURN = 2 * Math.PI;
const CARDINALS = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];

function readPoint(source: readonly unknown[], index: number): Point | undefined {
  const x = readFiniteNumber(source[index]);
  const y = readFiniteNumber(source[index + 1]);
  return x === undefined || y === undefined ? undefined : [x, y];
}

function isWithinSweep(angle: number, start: number, sweep: number): boolean {
  const delta = (angle - start) * Math.sign(sweep);
  const normalized = ((delta % FULL_TURN) + FULL_TURN) % FULL_TURN;
  return normalized <= Math.abs(sweep) + 1e-10;
}

/** The documented ARC angle is a signed sweep in degrees, not a central angle coordinate. */
function arcExtrema(start: Point, end: Point, degrees: number): Point[] | undefined {
  if (degrees === 0 || Math.abs(degrees) >= 360) return undefined;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) return undefined;
  const sweep = (degrees * Math.PI) / 180;
  const offset = 0.5 / Math.tan(sweep / 2);
  const cx = start[0] + dx / 2 - dy * offset;
  const cy = start[1] + dy / 2 + dx * offset;
  const radius = Math.hypot(start[0] - cx, start[1] - cy);
  if (![cx, cy, radius].every(Number.isFinite)) return undefined;
  const startAngle = Math.atan2(start[1] - cy, start[0] - cx);
  return CARDINALS.filter((angle) => isWithinSweep(angle, startAngle, sweep)).map((angle) => [
    cx + radius * Math.cos(angle),
    cy + radius * Math.sin(angle),
  ]);
}

function appendLines(
  source: readonly unknown[],
  index: number,
  points: Point[],
): number | undefined {
  const first = index;
  while (index < source.length && typeof source[index] !== 'string') {
    const point = readPoint(source, index);
    if (!point) return undefined;
    points.push(point);
    index += 2;
  }
  return index > first ? index : undefined;
}

function appendArc(source: readonly unknown[], index: number, points: Point[]): number | undefined {
  const degrees = readFiniteNumber(source[index]);
  const end = readPoint(source, index + 1);
  if (degrees === undefined || !end) return undefined;
  const extrema = arcExtrema(points[points.length - 1], end, degrees);
  if (!extrema || !extrema.every((point) => point.every(Number.isFinite))) return undefined;
  points.push(...extrema, end);
  return index + 3;
}

/** Parse an entire native L/ARC path before exposing any bounds; unsupported commands remain unknown. */
export function readOutlinePathPoints(source: readonly unknown[]): Point[] | undefined {
  const start = readPoint(source, 0);
  if (!start || source.length <= 2) return undefined;
  const points = [start];
  let index = 2;
  while (index < source.length) {
    const mode = source[index++];
    const next =
      mode === 'L'
        ? appendLines(source, index, points)
        : mode === 'ARC'
          ? appendArc(source, index, points)
          : undefined;
    if (next === undefined) return undefined;
    index = next;
  }
  return points;
}
