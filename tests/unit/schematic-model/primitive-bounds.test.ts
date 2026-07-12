import { describe, expect, it } from 'vitest';

import { boundsOverlap } from '../../../src/schematic-engine/geometry.js';
import {
  computePrimitiveBounds,
  computePrimitiveBoundsBatch,
  type PrimitiveBoundsInput,
} from '../../../src/schematic-model/primitive-bounds.js';

function primitive(overrides: Partial<PrimitiveBoundsInput> = {}): PrimitiveBoundsInput {
  return {
    id: 'U1',
    primitiveType: 'component',
    origin: { x: 100, y: 100 },
    rotation: 0,
    units: 'easyeda-coordinate',
    grid: 10,
    coordinateOrigin: { x: 0, y: 0, yAxis: 'down', source: 'live-readback' },
    body: {
      bounds: { x: -10, y: -5, width: 20, height: 10 },
      space: 'local',
      geometrySource: 'runtime',
    },
    ...overrides,
  };
}

describe('primitive rendered bounds', () => {
  it.each([
    [0, { x: 90, y: 95, width: 20, height: 10 }],
    [90, { x: 95, y: 90, width: 10, height: 20 }],
    [180, { x: 90, y: 95, width: 20, height: 10 }],
    [270, { x: 95, y: 90, width: 10, height: 20 }],
  ] as const)('rotates body bounds at %s degrees', (rotation, expected) => {
    expect(computePrimitiveBounds(primitive({ rotation })).body?.bounds).toEqual(expected);
  });

  it('returns body, reference, value, pin text, label and conservative combined bounds', () => {
    const result = computePrimitiveBounds(
      primitive({
        reference: {
          bounds: { x: -8, y: -18, width: 16, height: 8 },
          geometrySource: 'runtime',
        },
        value: { text: 'A very long imported symbol value', anchor: { x: 0, y: 18 }, fontSize: 10 },
        pinTexts: [{ text: 'VISIBLE_PIN_NAME', anchor: { x: 18, y: 0 }, fontSize: 8 }],
        labels: [{ bounds: { x: 25, y: -4, width: 20, height: 8 } }],
        annotations: [{ text: 'note', anchor: { x: -20, y: 25 }, fontSize: 10 }],
      }),
    );

    expect(result.availability).toBe('available');
    expect(result.body).toBeDefined();
    expect(result.reference).toBeDefined();
    expect(result.value).toBeDefined();
    expect(result.pinTexts).toHaveLength(1);
    expect(result.labels).toHaveLength(1);
    expect(result.annotations).toHaveLength(1);
    expect(result.combinedBounds?.width).toBeGreaterThan(200);
    expect(result.geometrySource).toBe('approximate');
    expect(result.confidence).toBe('conservative');
    expect(result.limitations).toContain('One or more text bounds use conservative measurement fallback.');
  });

  it('preserves exact runtime sheet-space geometry without a second rotation', () => {
    const result = computePrimitiveBounds(
      primitive({
        rotation: 90,
        body: {
          bounds: { x: 80, y: 70, width: 40, height: 60 },
          space: 'sheet',
          geometrySource: 'runtime',
        },
      }),
    );
    expect(result.body?.bounds).toEqual({ x: 80, y: 70, width: 40, height: 60 });
    expect(result.confidence).toBe('exact');
  });

  it('reports imported geometry explicitly unavailable instead of inventing an origin box', () => {
    const result = computePrimitiveBounds(
      primitive({ id: 'CUSTOM1', primitiveType: 'imported-symbol', body: undefined }),
    );
    expect(result.availability).toBe('not_available');
    expect(result.combinedBounds).toBeUndefined();
    expect(result.confidence).toBe('not_available');
  });

  it('detects overlap for distinct origins through conservative combined bounds', () => {
    const first = computePrimitiveBounds(primitive({ id: 'U1', origin: { x: 100, y: 100 } }));
    const second = computePrimitiveBounds(primitive({ id: 'U2', origin: { x: 115, y: 100 } }));
    expect(first.origin).not.toEqual(second.origin);
    expect(boundsOverlap(first.combinedBounds!, second.combinedBounds!)).toBe(true);
  });

  it('batches a full-sheet query and exposes mixed units/origins once', () => {
    const batch = computePrimitiveBoundsBatch([
      primitive({ id: 'U1' }),
      primitive({ id: 'U2', units: 'mil', body: undefined }),
    ]);
    expect(batch.items).toHaveLength(2);
    expect(batch.availableCount).toBe(1);
    expect(batch.notAvailableCount).toBe(1);
    expect(batch.units).toBe('mixed');
    expect(batch.coordinateOrigins).toHaveLength(1);
  });
});
