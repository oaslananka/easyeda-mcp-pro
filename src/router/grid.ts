import { movePoint, pointInRect } from './geometry.js';
import type { CardinalDirection, Point, Rect } from './types.js';

export interface GridNeighbor {
  point: Point;
  direction: CardinalDirection;
}

export interface RoutingGrid {
  bounds: Rect;
  spacing: number;
  columns: number;
  rows: number;
  cellCount: number;
}

export class GridLimitError extends Error {
  readonly code = 'GRID_LIMIT_EXCEEDED';

  constructor(message: string) {
    super(message);
    this.name = 'GridLimitError';
  }
}

export function createRoutingGrid(
  bounds: Rect,
  spacing: number,
  maxGridCells: number,
): RoutingGrid {
  if (!Number.isFinite(spacing) || spacing <= 0) {
    throw new GridLimitError('Grid size must be a positive finite number.');
  }
  const columns = Math.floor(bounds.width / spacing) + 1;
  const rows = Math.floor(bounds.height / spacing) + 1;
  const cellCount = columns * rows;
  if (!Number.isSafeInteger(cellCount) || cellCount <= 0 || cellCount > maxGridCells) {
    throw new GridLimitError(
      `Routing grid contains ${cellCount} cells; the configured maximum is ${maxGridCells}.`,
    );
  }
  return { bounds, spacing, columns, rows, cellCount };
}

function snapCoordinate(value: number, origin: number, spacing: number): number {
  return origin + Math.round((value - origin) / spacing) * spacing;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function snapPointToGrid(point: Point, grid: RoutingGrid): Point {
  return {
    x: clamp(
      snapCoordinate(point.x, grid.bounds.x, grid.spacing),
      grid.bounds.x,
      grid.bounds.x + grid.bounds.width,
    ),
    y: clamp(
      snapCoordinate(point.y, grid.bounds.y, grid.spacing),
      grid.bounds.y,
      grid.bounds.y + grid.bounds.height,
    ),
  };
}

export function isGridPointInside(point: Point, grid: RoutingGrid): boolean {
  return pointInRect(point, grid.bounds);
}

/**
 * Fixed neighbor order is part of the deterministic route contract. East/south
 * are preferred only when every score and tie-break field is otherwise equal.
 */
export function gridNeighbors(point: Point, grid: RoutingGrid): readonly GridNeighbor[] {
  const directions: readonly CardinalDirection[] = ['east', 'south', 'west', 'north'];
  const result: GridNeighbor[] = [];
  for (const direction of directions) {
    const candidate = movePoint(point, direction, grid.spacing);
    if (isGridPointInside(candidate, grid)) result.push({ point: candidate, direction });
  }
  return result;
}
