// Bounded, deterministic geometry for a *single*, explicitly closed EasyEDA L polyline.
// No arcs, curves, holes, multiple contours, or inferred closure; fail closed otherwise.
import type { ZoneRectangle } from './zone-outline-evidence.js';

type Point = readonly [number, number];
const MAX_VERTICES = 512;
const EPSILON = 1e-8;

function vertex(points: readonly Point[], index: number): Point {
  const point = points[index];
  if (!point) throw new Error('Invalid polygon vertex');
  return point;
}

function orientation(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  return (
    Math.abs(orientation(a, b, p)) <= EPSILON &&
    p[0] >= Math.min(a[0], b[0]) - EPSILON &&
    p[0] <= Math.max(a[0], b[0]) + EPSILON &&
    p[1] >= Math.min(a[1], b[1]) - EPSILON &&
    p[1] <= Math.max(a[1], b[1]) + EPSILON
  );
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (
    ((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON)) &&
    ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON))
  )
    return true;
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

function equal(a: Point, b: Point): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function parseClosedPoints(source: unknown): Point[] | undefined {
  if (!Array.isArray(source) || source[2] !== 'L' || source.length < 11) return undefined;
  if ((source.length - 3) % 2 !== 0 || source.length > 3 + 2 * (MAX_VERTICES + 1)) return undefined;
  const values = [source[0], source[1], ...source.slice(3)];
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value)))
    return undefined;
  const points: Point[] = [];
  for (let index = 0; index < values.length; index += 2) {
    points.push([values[index] as number, values[index + 1] as number]);
  }
  if (points.length < 4 || !equal(vertex(points, 0), vertex(points, points.length - 1)))
    return undefined;
  points.pop();
  return points;
}

function hasValidAreaAndEdges(points: readonly Point[]): boolean {
  let doubleArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = vertex(points, i);
    const b = vertex(points, (i + 1) % points.length);
    if (equal(a, b)) return false;
    doubleArea += a[0] * b[1] - b[0] * a[1];
  }
  return Number.isFinite(doubleArea) && Math.abs(doubleArea) > EPSILON;
}

function hasCrossingEdges(points: readonly Point[]): boolean {
  // Reject self-crossings, touching non-adjacent edges, and ambiguous internal rings.
  for (let i = 0; i < points.length; i++) {
    const a = vertex(points, i);
    const b = vertex(points, (i + 1) % points.length);
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      if (segmentsIntersect(a, b, vertex(points, j), vertex(points, (j + 1) % points.length)))
        return true;
    }
  }
  return false;
}

export function nativeClosedPolyline(source: unknown): Point[] | undefined {
  const points = parseClosedPoints(source);
  if (!points || !hasValidAreaAndEdges(points) || hasCrossingEdges(points)) return undefined;
  return points;
}

function pointInPolygon(
  point: Point,
  polygon: readonly Point[],
): 'inside' | 'outside' | 'boundary' {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = vertex(polygon, j),
      b = vertex(polygon, i);
    if (onSegment(a, b, point)) return 'boundary';
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside ? 'inside' : 'outside';
}

export function polygonRectangleRelation(
  polygon: readonly Point[],
  rectangle: ZoneRectangle,
): 'inside' | 'partial' | 'outside' {
  const x0 = rectangle.x,
    x1 = rectangle.x + rectangle.width;
  const y0 = rectangle.y - rectangle.height,
    y1 = rectangle.y;
  const corners: Point[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const cornerStates = corners.map((point) => pointInPolygon(point, polygon));
  let boundaryContact = false;
  for (let i = 0; i < polygon.length; i++) {
    const a = vertex(polygon, i),
      b = vertex(polygon, (i + 1) % polygon.length);
    for (let j = 0; j < 4; j++) {
      if (segmentsIntersect(a, b, vertex(corners, j), vertex(corners, (j + 1) % 4)))
        boundaryContact = true;
    }
  }
  const polygonVertexInRectangle = polygon.some(
    ([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1,
  );
  if (
    cornerStates.every((state) => state === 'inside') &&
    !boundaryContact &&
    !polygonVertexInRectangle
  )
    return 'inside';
  if (
    cornerStates.some((state) => state !== 'outside') ||
    boundaryContact ||
    polygonVertexInRectangle
  )
    return 'partial';
  return 'outside';
}
