import type { CardinalDirection, Point, Rect } from './types.js';

export const GEOMETRY_EPSILON = 1e-7;

export interface Segment {
  start: Point;
  end: Point;
}

export type SegmentIntersection =
  | { kind: 'none' }
  | { kind: 'point'; point: Point }
  | { kind: 'overlap'; start: Point; end: Point };

export function isFinitePoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

export function isFiniteRect(rect: Rect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width >= 0 &&
    rect.height >= 0
  );
}

export function pointsEqual(a: Point, b: Point, tolerance = GEOMETRY_EPSILON): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
}

function normalizedNumber(value: number): number {
  const rounded = Number(value.toFixed(7));
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function pointKey(point: Point): string {
  return `${normalizedNumber(point.x)},${normalizedNumber(point.y)}`;
}

export function rectRight(rect: Rect): number {
  return rect.x + rect.width;
}

export function rectBottom(rect: Rect): number {
  return rect.y + rect.height;
}

export function expandRect(rect: Rect, amount: number): Rect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  };
}

export function pointInRect(point: Point, rect: Rect, inclusive = true): boolean {
  if (inclusive) {
    return (
      point.x >= rect.x - GEOMETRY_EPSILON &&
      point.x <= rectRight(rect) + GEOMETRY_EPSILON &&
      point.y >= rect.y - GEOMETRY_EPSILON &&
      point.y <= rectBottom(rect) + GEOMETRY_EPSILON
    );
  }
  return (
    point.x > rect.x + GEOMETRY_EPSILON &&
    point.x < rectRight(rect) - GEOMETRY_EPSILON &&
    point.y > rect.y + GEOMETRY_EPSILON &&
    point.y < rectBottom(rect) - GEOMETRY_EPSILON
  );
}

export function manhattanDistance(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function euclideanDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function isAxisAligned(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= GEOMETRY_EPSILON || Math.abs(a.y - b.y) <= GEOMETRY_EPSILON;
}

export function directionBetween(a: Point, b: Point): CardinalDirection | null {
  if (pointsEqual(a, b)) return null;
  if (Math.abs(a.x - b.x) <= GEOMETRY_EPSILON) {
    return b.y < a.y ? 'north' : 'south';
  }
  if (Math.abs(a.y - b.y) <= GEOMETRY_EPSILON) {
    return b.x < a.x ? 'west' : 'east';
  }
  return null;
}

export function oppositeDirection(direction: CardinalDirection): CardinalDirection {
  switch (direction) {
    case 'north':
      return 'south';
    case 'east':
      return 'west';
    case 'south':
      return 'north';
    case 'west':
      return 'east';
  }
}

export function movePoint(point: Point, direction: CardinalDirection, distance: number): Point {
  switch (direction) {
    case 'north':
      return { x: point.x, y: point.y - distance };
    case 'east':
      return { x: point.x + distance, y: point.y };
    case 'south':
      return { x: point.x, y: point.y + distance };
    case 'west':
      return { x: point.x - distance, y: point.y };
  }
}

export function pointOnSegment(point: Point, a: Point, b: Point): boolean {
  if (!isAxisAligned(a, b)) return false;
  if (Math.abs(a.x - b.x) <= GEOMETRY_EPSILON) {
    return (
      Math.abs(point.x - a.x) <= GEOMETRY_EPSILON &&
      point.y >= Math.min(a.y, b.y) - GEOMETRY_EPSILON &&
      point.y <= Math.max(a.y, b.y) + GEOMETRY_EPSILON
    );
  }
  return (
    Math.abs(point.y - a.y) <= GEOMETRY_EPSILON &&
    point.x >= Math.min(a.x, b.x) - GEOMETRY_EPSILON &&
    point.x <= Math.max(a.x, b.x) + GEOMETRY_EPSILON
  );
}

function intervalIntersection(
  a1: number,
  a2: number,
  b1: number,
  b2: number,
): [number, number] | null {
  const start = Math.max(Math.min(a1, a2), Math.min(b1, b2));
  const end = Math.min(Math.max(a1, a2), Math.max(b1, b2));
  return start <= end + GEOMETRY_EPSILON ? [start, end] : null;
}

export function intersectAxisAlignedSegments(
  a1: Point,
  a2: Point,
  b1: Point,
  b2: Point,
): SegmentIntersection {
  if (!isAxisAligned(a1, a2) || !isAxisAligned(b1, b2)) return { kind: 'none' };
  const aHorizontal = Math.abs(a1.y - a2.y) <= GEOMETRY_EPSILON;
  const bHorizontal = Math.abs(b1.y - b2.y) <= GEOMETRY_EPSILON;

  if (aHorizontal && bHorizontal) {
    if (Math.abs(a1.y - b1.y) > GEOMETRY_EPSILON) return { kind: 'none' };
    const overlap = intervalIntersection(a1.x, a2.x, b1.x, b2.x);
    if (!overlap) return { kind: 'none' };
    const [start, end] = overlap;
    if (Math.abs(start - end) <= GEOMETRY_EPSILON) {
      return { kind: 'point', point: { x: normalizedNumber(start), y: normalizedNumber(a1.y) } };
    }
    return {
      kind: 'overlap',
      start: { x: normalizedNumber(start), y: normalizedNumber(a1.y) },
      end: { x: normalizedNumber(end), y: normalizedNumber(a1.y) },
    };
  }

  if (!aHorizontal && !bHorizontal) {
    if (Math.abs(a1.x - b1.x) > GEOMETRY_EPSILON) return { kind: 'none' };
    const overlap = intervalIntersection(a1.y, a2.y, b1.y, b2.y);
    if (!overlap) return { kind: 'none' };
    const [start, end] = overlap;
    if (Math.abs(start - end) <= GEOMETRY_EPSILON) {
      return { kind: 'point', point: { x: normalizedNumber(a1.x), y: normalizedNumber(start) } };
    }
    return {
      kind: 'overlap',
      start: { x: normalizedNumber(a1.x), y: normalizedNumber(start) },
      end: { x: normalizedNumber(a1.x), y: normalizedNumber(end) },
    };
  }

  const horizontalStart = aHorizontal ? a1 : b1;
  const horizontalEnd = aHorizontal ? a2 : b2;
  const verticalStart = aHorizontal ? b1 : a1;
  const verticalEnd = aHorizontal ? b2 : a2;
  const point = { x: verticalStart.x, y: horizontalStart.y };
  return pointOnSegment(point, horizontalStart, horizontalEnd) &&
    pointOnSegment(point, verticalStart, verticalEnd)
    ? { kind: 'point', point }
    : { kind: 'none' };
}

export function segmentIntersectsRect(a: Point, b: Point, rect: Rect): boolean {
  if (pointInRect(a, rect) || pointInRect(b, rect)) return true;
  const topLeft = { x: rect.x, y: rect.y };
  const topRight = { x: rectRight(rect), y: rect.y };
  const bottomRight = { x: rectRight(rect), y: rectBottom(rect) };
  const bottomLeft = { x: rect.x, y: rectBottom(rect) };
  const edges: readonly [Point, Point][] = [
    [topLeft, topRight],
    [topRight, bottomRight],
    [bottomRight, bottomLeft],
    [bottomLeft, topLeft],
  ];
  return edges.some(
    ([start, end]) => intersectAxisAlignedSegments(a, b, start, end).kind !== 'none',
  );
}

export function distancePointToRect(point: Point, rect: Rect): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - rectRight(rect));
  const dy = Math.max(rect.y - point.y, 0, point.y - rectBottom(rect));
  return Math.hypot(dx, dy);
}

export function distancePointToSegment(point: Point, start: Point, end: Point): number {
  if (pointsEqual(start, end)) return euclideanDistance(point, start);
  if (Math.abs(start.x - end.x) <= GEOMETRY_EPSILON) {
    const y = Math.min(Math.max(point.y, Math.min(start.y, end.y)), Math.max(start.y, end.y));
    return euclideanDistance(point, { x: start.x, y });
  }
  if (Math.abs(start.y - end.y) <= GEOMETRY_EPSILON) {
    const x = Math.min(Math.max(point.x, Math.min(start.x, end.x)), Math.max(start.x, end.x));
    return euclideanDistance(point, { x, y: start.y });
  }
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const t = Math.min(
    1,
    Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)),
  );
  return euclideanDistance(point, { x: start.x + t * dx, y: start.y + t * dy });
}

export function pathLength(points: readonly Point[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous && current) length += manhattanDistance(previous, current);
  }
  return length;
}

export function countBends(points: readonly Point[]): number {
  let bends = 0;
  let previousDirection: CardinalDirection | null = null;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current) continue;
    const direction = directionBetween(previous, current);
    if (!direction) continue;
    if (previousDirection && direction !== previousDirection) bends += 1;
    previousDirection = direction;
  }
  return bends;
}

export function canonicalSegmentKey(a: Point, b: Point): string {
  const first = pointKey(a);
  const second = pointKey(b);
  return first.localeCompare(second) <= 0 ? `${first}|${second}` : `${second}|${first}`;
}

export function boundingRect(points: readonly Point[]): Rect {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
