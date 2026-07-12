import type { LayoutPoint, LayoutRect, LayoutSheet } from './types.js';

const EPSILON = 1e-9;

export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function rectFromCenter(
  center: LayoutPoint,
  width: number,
  height: number,
  id?: string,
): LayoutRect {
  return {
    id,
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
  };
}

export function rectCenter(rect: LayoutRect): LayoutPoint {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function rectArea(rect: LayoutRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

export function rectsOverlap(a: LayoutRect, b: LayoutRect, clearance = 0): boolean {
  return !(
    a.x + a.width + clearance <= b.x ||
    b.x + b.width + clearance <= a.x ||
    a.y + a.height + clearance <= b.y ||
    b.y + b.height + clearance <= a.y
  );
}

export function inflateRect(rect: LayoutRect, amount: number): LayoutRect {
  return {
    ...rect,
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  };
}

export function rectInsideRect(inner: LayoutRect, outer: LayoutRect): boolean {
  return (
    inner.x >= outer.x - EPSILON &&
    inner.y >= outer.y - EPSILON &&
    inner.x + inner.width <= outer.x + outer.width + EPSILON &&
    inner.y + inner.height <= outer.y + outer.height + EPSILON
  );
}

export function sheetRect(sheet: LayoutSheet): LayoutRect {
  const origin = sheet.origin ?? { x: 0, y: 0 };
  return { x: origin.x, y: origin.y, width: sheet.width, height: sheet.height };
}

export function intersectionArea(a: LayoutRect, b: LayoutRect): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

export function boundingRect(rects: readonly LayoutRect[]): LayoutRect | undefined {
  if (rects.length === 0) return undefined;
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function translateRect(rect: LayoutRect, dx: number, dy: number): LayoutRect {
  return { ...rect, x: rect.x + dx, y: rect.y + dy };
}

export function clampRect(rect: LayoutRect, bounds: LayoutRect): LayoutRect {
  return {
    ...rect,
    x: Math.min(Math.max(rect.x, bounds.x), bounds.x + Math.max(0, bounds.width - rect.width)),
    y: Math.min(Math.max(rect.y, bounds.y), bounds.y + Math.max(0, bounds.height - rect.height)),
  };
}

export function pointInsideRect(point: LayoutPoint, rect: LayoutRect): boolean {
  return (
    point.x >= rect.x - EPSILON &&
    point.x <= rect.x + rect.width + EPSILON &&
    point.y >= rect.y - EPSILON &&
    point.y <= rect.y + rect.height + EPSILON
  );
}

function cross(a: LayoutPoint, b: LayoutPoint, c: LayoutPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegment(point: LayoutPoint, a: LayoutPoint, b: LayoutPoint): boolean {
  return (
    Math.abs(cross(a, b, point)) <= EPSILON &&
    point.x >= Math.min(a.x, b.x) - EPSILON &&
    point.x <= Math.max(a.x, b.x) + EPSILON &&
    point.y >= Math.min(a.y, b.y) - EPSILON &&
    point.y <= Math.max(a.y, b.y) + EPSILON
  );
}

export function pointsEqual(a: LayoutPoint, b: LayoutPoint): boolean {
  return Math.abs(a.x - b.x) <= EPSILON && Math.abs(a.y - b.y) <= EPSILON;
}

export function segmentsIntersect(
  a1: LayoutPoint,
  a2: LayoutPoint,
  b1: LayoutPoint,
  b2: LayoutPoint,
): boolean {
  const d1 = cross(a1, a2, b1);
  const d2 = cross(a1, a2, b2);
  const d3 = cross(b1, b2, a1);
  const d4 = cross(b1, b2, a2);
  if (((d1 > EPSILON && d2 < -EPSILON) || (d1 < -EPSILON && d2 > EPSILON)) &&
      ((d3 > EPSILON && d4 < -EPSILON) || (d3 < -EPSILON && d4 > EPSILON))) {
    return true;
  }
  return (
    (Math.abs(d1) <= EPSILON && pointOnSegment(b1, a1, a2)) ||
    (Math.abs(d2) <= EPSILON && pointOnSegment(b2, a1, a2)) ||
    (Math.abs(d3) <= EPSILON && pointOnSegment(a1, b1, b2)) ||
    (Math.abs(d4) <= EPSILON && pointOnSegment(a2, b1, b2))
  );
}

export function segmentIntersectsRect(
  a: LayoutPoint,
  b: LayoutPoint,
  rect: LayoutRect,
): boolean {
  if (pointInsideRect(a, rect) || pointInsideRect(b, rect)) return true;
  const topLeft = { x: rect.x, y: rect.y + rect.height };
  const topRight = { x: rect.x + rect.width, y: rect.y + rect.height };
  const bottomLeft = { x: rect.x, y: rect.y };
  const bottomRight = { x: rect.x + rect.width, y: rect.y };
  return (
    segmentsIntersect(a, b, bottomLeft, bottomRight) ||
    segmentsIntersect(a, b, bottomRight, topRight) ||
    segmentsIntersect(a, b, topRight, topLeft) ||
    segmentsIntersect(a, b, topLeft, bottomLeft)
  );
}

export function polylineLength(points: readonly LayoutPoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const current = points[index];
    const previous = points[index - 1];
    if (!current || !previous) continue;
    total += Math.hypot(current.x - previous.x, current.y - previous.y);
  }
  return total;
}

export function polylineBends(points: readonly LayoutPoint[]): number {
  let bends = 0;
  for (let index = 2; index < points.length; index += 1) {
    const previous = points[index - 2];
    const current = points[index - 1];
    const next = points[index];
    if (!previous || !current || !next) continue;
    const first = { x: current.x - previous.x, y: current.y - previous.y };
    const second = { x: next.x - current.x, y: next.y - current.y };
    if (Math.abs(first.x * second.y - first.y * second.x) > EPSILON) bends += 1;
  }
  return bends;
}

export function candidateGrid(bounds: LayoutRect, step: number): LayoutPoint[] {
  const safeStep = Math.max(step, EPSILON);
  const points: LayoutPoint[] = [];
  for (let y = bounds.y; y <= bounds.y + bounds.height + EPSILON; y += safeStep) {
    for (let x = bounds.x; x <= bounds.x + bounds.width + EPSILON; x += safeStep) {
      points.push({ x, y });
    }
  }
  return points;
}
