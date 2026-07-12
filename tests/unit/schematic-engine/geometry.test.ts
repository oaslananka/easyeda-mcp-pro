import { describe, expect, it } from 'vitest';
import {
  boundsBottom,
  boundsInside,
  boundsOverlap,
  boundsRight,
  combineBounds,
  inflateBounds,
  isFiniteBounds,
  snapToGrid,
  translateBounds,
} from '../../../src/schematic-engine/geometry.js';
import type { SchematicBounds } from '../../../src/schematic-engine/geometry.js';

const rect = (x: number, y: number, width: number, height: number): SchematicBounds => ({
  x,
  y,
  width,
  height,
});

describe('isFiniteBounds', () => {
  it('accepts a well-formed bounds object', () => {
    expect(isFiniteBounds(rect(0, 0, 10, 10))).toBe(true);
  });

  it('rejects non-finite coordinates', () => {
    expect(isFiniteBounds(rect(Number.NaN, 0, 10, 10))).toBe(false);
    expect(isFiniteBounds(rect(0, Number.POSITIVE_INFINITY, 10, 10))).toBe(false);
  });

  it('rejects negative width or height', () => {
    expect(isFiniteBounds(rect(0, 0, -1, 10))).toBe(false);
    expect(isFiniteBounds(rect(0, 0, 10, -1))).toBe(false);
  });
});

describe('boundsRight / boundsBottom', () => {
  it('computes the right and bottom edges', () => {
    expect(boundsRight(rect(10, 20, 30, 40))).toBe(40);
    expect(boundsBottom(rect(10, 20, 30, 40))).toBe(60);
  });
});

describe('boundsOverlap', () => {
  it('detects overlapping rectangles', () => {
    expect(boundsOverlap(rect(0, 0, 10, 10), rect(5, 5, 10, 10))).toBe(true);
  });

  it('returns false for rectangles that only touch at an edge', () => {
    expect(boundsOverlap(rect(0, 0, 10, 10), rect(10, 0, 10, 10))).toBe(false);
  });

  it('returns false for fully separated rectangles', () => {
    expect(boundsOverlap(rect(0, 0, 10, 10), rect(100, 100, 10, 10))).toBe(false);
  });
});

describe('boundsInside', () => {
  it('returns true when the inner rect is fully contained', () => {
    expect(boundsInside(rect(1, 1, 5, 5), rect(0, 0, 10, 10))).toBe(true);
  });

  it('returns false when the inner rect extends past any edge', () => {
    expect(boundsInside(rect(-1, 1, 5, 5), rect(0, 0, 10, 10))).toBe(false);
    expect(boundsInside(rect(1, 1, 15, 5), rect(0, 0, 10, 10))).toBe(false);
  });
});

describe('inflateBounds', () => {
  it('expands a rect symmetrically by the given amount', () => {
    expect(inflateBounds(rect(10, 10, 20, 20), 5)).toEqual(rect(5, 5, 30, 30));
  });

  it('shrinks a rect with a negative amount', () => {
    expect(inflateBounds(rect(10, 10, 20, 20), -5)).toEqual(rect(15, 15, 10, 10));
  });
});

describe('combineBounds', () => {
  it('returns undefined for an empty list', () => {
    expect(combineBounds([])).toBeUndefined();
  });

  it('returns the same rect for a single-element list', () => {
    expect(combineBounds([rect(1, 2, 3, 4)])).toEqual(rect(1, 2, 3, 4));
  });

  it('computes the union bounding box of multiple rects', () => {
    const result = combineBounds([rect(0, 0, 10, 10), rect(20, 20, 10, 10)]);
    expect(result).toEqual({ x: 0, y: 0, width: 30, height: 30 });
  });
});

describe('snapToGrid', () => {
  it('rounds to the nearest grid multiple', () => {
    expect(snapToGrid(12, 10)).toBe(10);
    expect(snapToGrid(16, 10)).toBe(20);
  });

  it('returns the original value when the grid is non-finite or non-positive', () => {
    expect(snapToGrid(12.3, 0)).toBe(12.3);
    expect(snapToGrid(12.3, -5)).toBe(12.3);
    expect(snapToGrid(12.3, Number.NaN)).toBe(12.3);
  });
});

describe('translateBounds', () => {
  it('shifts x/y by the given delta while preserving size', () => {
    expect(translateBounds(rect(10, 10, 5, 5), { x: 3, y: -2 })).toEqual(rect(13, 8, 5, 5));
  });
});
