export interface SchematicPoint {
  x: number;
  y: number;
}

export interface SchematicBounds extends SchematicPoint {
  width: number;
  height: number;
}

export type SchematicYAxis = 'up' | 'down';

export interface SchematicCoordinateOrigin extends SchematicPoint {
  yAxis: SchematicYAxis;
  source: 'runtime' | 'live-readback' | 'derived';
}

export type SchematicPageSize = 'A4' | 'A3' | 'custom';

export interface SchematicSheetGeometry {
  bounds: SchematicBounds;
  drawableBounds: SchematicBounds;
  grid: number;
  units: string;
  pageSize: SchematicPageSize;
  coordinateOrigin: SchematicCoordinateOrigin;
  geometrySource: 'runtime' | 'live-readback' | 'derived';
  titleBlockBounds?: SchematicBounds;
}

export function isFiniteBounds(bounds: SchematicBounds): boolean {
  return (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width >= 0 &&
    bounds.height >= 0
  );
}

export function boundsRight(bounds: SchematicBounds): number {
  return bounds.x + bounds.width;
}

export function boundsBottom(bounds: SchematicBounds): number {
  return bounds.y + bounds.height;
}

export function boundsOverlap(a: SchematicBounds, b: SchematicBounds): boolean {
  return (
    a.x < boundsRight(b) && boundsRight(a) > b.x && a.y < boundsBottom(b) && boundsBottom(a) > b.y
  );
}

export function boundsInside(inner: SchematicBounds, outer: SchematicBounds): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    boundsRight(inner) <= boundsRight(outer) &&
    boundsBottom(inner) <= boundsBottom(outer)
  );
}

export function inflateBounds(bounds: SchematicBounds, amount: number): SchematicBounds {
  return {
    x: bounds.x - amount,
    y: bounds.y - amount,
    width: bounds.width + amount * 2,
    height: bounds.height + amount * 2,
  };
}

export function combineBounds(bounds: readonly SchematicBounds[]): SchematicBounds | undefined {
  if (bounds.length === 0) return undefined;
  const left = Math.min(...bounds.map((item) => item.x));
  const top = Math.min(...bounds.map((item) => item.y));
  const right = Math.max(...bounds.map(boundsRight));
  const bottom = Math.max(...bounds.map(boundsBottom));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function snapToGrid(value: number, grid: number): number {
  if (!Number.isFinite(grid) || grid <= 0) return value;
  return Math.round(value / grid) * grid;
}

export function translateBounds(bounds: SchematicBounds, delta: SchematicPoint): SchematicBounds {
  return { ...bounds, x: bounds.x + delta.x, y: bounds.y + delta.y };
}
