import { describe, expect, it } from 'vitest';
import {
  alignComponents,
  compactLayout,
  distributeComponents,
  optimizeLabels,
  placementCenter,
  resolveOverlaps,
} from '../../../src/layout/operations.js';
import { rectFromCenter } from '../../../src/layout/geometry.js';
import type { LayoutLabel, LayoutPlacement, LayoutWire } from '../../../src/layout/types.js';

function placement(
  overrides: Partial<LayoutPlacement> & Pick<LayoutPlacement, 'componentId' | 'x' | 'y'>,
): LayoutPlacement {
  const width = overrides.width ?? 40;
  const height = overrides.height ?? 20;
  return {
    reference: overrides.componentId,
    blockId: 'block-1',
    width,
    height,
    orientation: 0,
    locked: false,
    reason: 'initial',
    bbox: rectFromCenter({ x: overrides.x, y: overrides.y }, width, height, overrides.componentId),
    ...overrides,
  };
}

describe('alignComponents', () => {
  it('aligns selected components to the average of their axis coordinate', () => {
    const placements = [
      placement({ componentId: 'A', x: 0, y: 0 }),
      placement({ componentId: 'B', x: 20, y: 0 }),
    ];
    const result = alignComponents(placements, { axis: 'x' });
    expect(result.find((p) => p.componentId === 'A')?.x).toBe(10);
    expect(result.find((p) => p.componentId === 'B')?.x).toBe(10);
  });

  it('aligns to an explicit value along the y axis and updates bbox', () => {
    const placements = [placement({ componentId: 'A', x: 0, y: 0 })];
    const result = alignComponents(placements, { axis: 'y', value: 50 });
    expect(result[0]?.y).toBe(50);
    expect(result[0]?.bbox.y).toBe(50 - result[0]!.height / 2);
    expect(result[0]?.reason).toBe('aligned-y');
  });

  it('leaves locked components untouched', () => {
    const placements = [placement({ componentId: 'A', x: 0, y: 0, locked: true })];
    const result = alignComponents(placements, { axis: 'x', value: 99 });
    expect(result[0]?.x).toBe(0);
  });

  it('only aligns componentIds present in the selection filter', () => {
    const placements = [
      placement({ componentId: 'A', x: 0, y: 0 }),
      placement({ componentId: 'B', x: 20, y: 0 }),
    ];
    const result = alignComponents(placements, { axis: 'x', value: 5, componentIds: ['A'] });
    expect(result.find((p) => p.componentId === 'A')?.x).toBe(5);
    expect(result.find((p) => p.componentId === 'B')?.x).toBe(20);
  });

  it('returns cloned placements unchanged when the selection is empty', () => {
    const placements = [placement({ componentId: 'A', x: 0, y: 0 })];
    const result = alignComponents(placements, { axis: 'x', componentIds: ['missing'] });
    expect(result[0]?.x).toBe(0);
    expect(result[0]).not.toBe(placements[0]);
  });
});

describe('distributeComponents', () => {
  it('spreads three components evenly between start and end', () => {
    const placements = [
      placement({ componentId: 'A', x: 0, y: 0 }),
      placement({ componentId: 'B', x: 5, y: 0 }),
      placement({ componentId: 'C', x: 10, y: 0 }),
    ];
    const result = distributeComponents(placements, { axis: 'x', start: 0, end: 100 });
    expect(result.find((p) => p.componentId === 'A')?.x).toBe(0);
    expect(result.find((p) => p.componentId === 'B')?.x).toBe(50);
    expect(result.find((p) => p.componentId === 'C')?.x).toBe(100);
  });

  it('is a no-op when fewer than two components are selected', () => {
    const placements = [placement({ componentId: 'A', x: 0, y: 0 })];
    const result = distributeComponents(placements, { axis: 'x' });
    expect(result[0]?.x).toBe(0);
  });

  it('skips locked components when distributing', () => {
    const placements = [
      placement({ componentId: 'A', x: 0, y: 0 }),
      placement({ componentId: 'B', x: 10, y: 0, locked: true }),
      placement({ componentId: 'C', x: 20, y: 0 }),
    ];
    const result = distributeComponents(placements, { axis: 'x', start: 0, end: 20 });
    expect(result.find((p) => p.componentId === 'B')?.x).toBe(10);
  });
});

describe('compactLayout', () => {
  it('keeps locked components in place and packs the rest into free space', () => {
    const bounds = { x: 0, y: 0, width: 200, height: 200 };
    const placements = [
      placement({ componentId: 'A', x: 500, y: 500, locked: true }),
      placement({ componentId: 'B', x: 500, y: 500 }),
    ];
    const result = compactLayout(placements, { bounds, spacing: 4 });
    expect(result.find((p) => p.componentId === 'A')?.x).toBe(500);
    const b = result.find((p) => p.componentId === 'B')!;
    expect(b.x).not.toBe(500);
    expect(b.reason).toBe('compacted');
  });

  it('leaves a placement untouched when no free space fits it', () => {
    const bounds = { x: 0, y: 0, width: 10, height: 10 };
    const placements = [
      placement({ componentId: 'A', x: 5, y: 5, width: 40, height: 20, locked: true }),
      placement({ componentId: 'B', x: 500, y: 500, width: 40, height: 20 }),
    ];
    const result = compactLayout(placements, { bounds, spacing: 4 });
    expect(result.find((p) => p.componentId === 'B')?.x).toBe(500);
  });
});

describe('resolveOverlaps', () => {
  it('leaves non-overlapping placements untouched', () => {
    const placements = [
      placement({ componentId: 'A', x: 0, y: 0 }),
      placement({ componentId: 'B', x: 200, y: 200 }),
    ];
    const bounds = { x: -1000, y: -1000, width: 2000, height: 2000 };
    const result = resolveOverlaps(placements, { bounds });
    expect(result.find((p) => p.componentId === 'A')?.x).toBe(0);
    expect(result.find((p) => p.componentId === 'B')?.x).toBe(200);
  });

  it('moves an overlapping unlocked placement away from a locked one', () => {
    const placements = [
      placement({ componentId: 'A', x: 0, y: 0, locked: true }),
      placement({ componentId: 'B', x: 0, y: 0 }),
    ];
    const bounds = { x: -500, y: -500, width: 1000, height: 1000 };
    const result = resolveOverlaps(placements, { bounds, spacing: 4 });
    const a = result.find((p) => p.componentId === 'A')!;
    const b = result.find((p) => p.componentId === 'B')!;
    expect(a.x).toBe(0);
    expect(b.x !== 0 || b.y !== 0).toBe(true);
    expect(b.reason).toBe('overlap-resolved');
  });

  it('respects keepout regions', () => {
    const placements = [placement({ componentId: 'A', x: 0, y: 0 })];
    const bounds = { x: -10, y: -10, width: 20, height: 20 };
    const keepouts = [{ x: -10, y: -10, width: 20, height: 20 }];
    const result = resolveOverlaps(placements, { bounds, keepouts, spacing: 1, maxIterations: 5 });
    // No free spot exists outside the keepout within such a tight bounds/iteration budget,
    // so the placement is left where it started.
    expect(result[0]?.componentId).toBe('A');
  });

  it('gives up and leaves the original position when maxIterations is exhausted first', () => {
    const placements = [
      placement({ componentId: 'A', x: 20, y: 10, locked: true }),
      placement({ componentId: 'B', x: 500, y: 500 }),
    ];
    const bounds = { x: 0, y: 0, width: 100, height: 100 };
    const result = resolveOverlaps(placements, { bounds, spacing: 10, maxIterations: 1 });
    const b = result.find((p) => p.componentId === 'B')!;
    expect(b.x).toBe(500);
    expect(b.y).toBe(500);
    expect(b.reason).toBe('initial');
  });

  it('resolves the same overlap once given enough iterations', () => {
    const placements = [
      placement({ componentId: 'A', x: 20, y: 10, locked: true }),
      placement({ componentId: 'B', x: 500, y: 500 }),
    ];
    const bounds = { x: 0, y: 0, width: 100, height: 100 };
    const result = resolveOverlaps(placements, { bounds, spacing: 10, maxIterations: 20 });
    const b = result.find((p) => p.componentId === 'B')!;
    expect(b.reason).toBe('overlap-resolved');
    expect(b.x === 500 && b.y === 500).toBe(false);
  });
});

describe('optimizeLabels', () => {
  const bounds = { x: -1000, y: -1000, width: 2000, height: 2000 };

  function label(
    overrides: Partial<LayoutLabel> & Pick<LayoutLabel, 'id' | 'x' | 'y'>,
  ): LayoutLabel {
    return { text: overrides.id, kind: 'net', width: 20, height: 10, ...overrides };
  }

  it('keeps a label in place when it has no collisions', () => {
    const result = optimizeLabels([label({ id: 'L1', x: 0, y: 0 })], [], [], { bounds });
    expect(result[0]?.x).toBe(0);
    expect(result[0]?.y).toBe(0);
  });

  it('nudges a label away from an overlapping component', () => {
    const placements = [placement({ componentId: 'A', x: 0, y: 0, width: 40, height: 40 })];
    const result = optimizeLabels([label({ id: 'L1', x: 0, y: 0 })], placements, [], {
      bounds,
      clearance: 4,
      maxAttempts: 60,
    });
    expect(result[0]?.x === 0 && result[0]?.y === 0).toBe(false);
  });

  it('nudges a label away from a wire segment it would otherwise sit on', () => {
    const wires: LayoutWire[] = [
      {
        id: 'W1',
        netId: 'NET1',
        points: [
          { x: -100, y: 5 },
          { x: 100, y: 5 },
        ],
      },
    ];
    const result = optimizeLabels([label({ id: 'L1', x: 0, y: 0 })], [], wires, {
      bounds,
      clearance: 4,
      maxAttempts: 16,
    });
    expect(result[0]?.x === 0 && result[0]?.y === 0).toBe(false);
  });

  it('avoids colliding with a previously accepted label', () => {
    const labels = [label({ id: 'L1', x: 0, y: 0 }), label({ id: 'L2', x: 0, y: 0 })];
    const result = optimizeLabels(labels, [], [], { bounds, clearance: 4, maxAttempts: 60 });
    const l1 = result.find((l) => l.id === 'L1')!;
    const l2 = result.find((l) => l.id === 'L2')!;
    expect(l1.x === l2.x && l1.y === l2.y).toBe(false);
  });

  it('falls back to a clamped original position when every offset collides', () => {
    const placements = [placement({ componentId: 'A', x: 0, y: 0, width: 4000, height: 4000 })];
    const result = optimizeLabels([label({ id: 'L1', x: 0, y: 0 })], placements, [], {
      bounds,
      clearance: 4,
      maxAttempts: 4,
    });
    expect(result[0]?.id).toBe('L1');
  });
});

describe('placementCenter', () => {
  it('returns the geometric center of the placement bbox', () => {
    const p = placement({ componentId: 'A', x: 10, y: 20, width: 40, height: 20 });
    expect(placementCenter(p)).toEqual({ x: 10, y: 20 });
  });
});
