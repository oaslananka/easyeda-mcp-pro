import { directionBetween, pointKey, pointsEqual } from './geometry.js';
import type { Point } from './types.js';

/**
 * Removes zero-length and collinear interior vertices while preserving explicit
 * terminals and controlled merge points. It never changes segment geometry.
 */
export function simplifyOrthogonalPath(
  points: readonly Point[],
  preservePoints: readonly Point[] = [],
): Point[] {
  const preserved = new Set(preservePoints.map(pointKey));
  const deduplicated: Point[] = [];
  for (const point of points) {
    const previous = deduplicated[deduplicated.length - 1];
    if (!previous || !pointsEqual(previous, point)) deduplicated.push(point);
  }
  if (deduplicated.length <= 2) return deduplicated;

  const simplified: Point[] = [deduplicated[0] as Point];
  for (let index = 1; index < deduplicated.length - 1; index += 1) {
    const previous = simplified[simplified.length - 1];
    const current = deduplicated[index];
    const next = deduplicated[index + 1];
    if (!previous || !current || !next) continue;
    const incoming = directionBetween(previous, current);
    const outgoing = directionBetween(current, next);
    if (incoming && outgoing && incoming === outgoing && !preserved.has(pointKey(current))) {
      continue;
    }
    simplified.push(current);
  }
  const last = deduplicated[deduplicated.length - 1];
  if (last) simplified.push(last);
  return simplified;
}

