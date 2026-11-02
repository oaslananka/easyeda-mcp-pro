import { describe, it, expect } from 'vitest';
import { planComponentGroupPlacement, planRoutePath } from '../../../src/pcb-layout/index.js';

const mmToPcbMil = (millimetres: number): number => millimetres / 0.0254;

describe('pcb layout planner', () => {
  it('creates a previewable component group plan without errors', () => {
    const plan = planComponentGroupPlacement({
      board: { widthMm: 60, heightMm: 40 },
      anchor: { x: 10, y: 10 },
      columns: 2,
      spacingMm: 4,
      components: [
        { ref: 'U1', primitiveId: 'p-u1', widthMm: 6, heightMm: 6 },
        { ref: 'C1', primitiveId: 'p-c1', widthMm: 2, heightMm: 1.2 },
      ],
    });

    expect(plan.blocked).toBe(false);
    expect(plan.applied).toBe(false);
    expect(plan.placements).toHaveLength(2);
    expect(plan.operations[0]).toMatchObject({ method: 'pcb.modifyComponent' });
    expect(plan.summary).toContain('ready');
  });

  it('blocks new component placement when no existing PCB primitive ID is supplied', () => {
    const plan = planComponentGroupPlacement({
      board: { widthMm: 60, heightMm: 40 },
      anchor: { x: 10, y: 10 },
      components: [{ ref: 'U1', footprint: 'SOIC-8', widthMm: 6, heightMm: 6 }],
    });

    expect(plan.blocked).toBe(true);
    expect(plan.operations).toEqual([]);
    expect(plan.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'LAYOUT_COMPONENT_NOT_ON_BOARD', severity: 'error' }),
      ]),
    );
  });

  it('blocks component placements outside board or inside keepouts', () => {
    const plan = planComponentGroupPlacement({
      board: { widthMm: 20, heightMm: 20 },
      anchor: { x: 19, y: 19 },
      keepouts: [{ x: 0, y: 0, widthMm: 20, heightMm: 20, name: 'all' }],
      components: [{ ref: 'U1', primitiveId: 'p-u1', widthMm: 6, heightMm: 6 }],
    });

    expect(plan.blocked).toBe(true);
    expect(plan.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['LAYOUT_COMPONENT_OUTSIDE_BOARD', 'LAYOUT_COMPONENT_IN_KEEPOUT']),
    );
  });

  it('detects placement collision when spacing is insufficient', () => {
    const plan = planComponentGroupPlacement({
      board: { widthMm: 50, heightMm: 50 },
      anchor: { x: 10, y: 10 },
      columns: 2,
      spacingMm: 0,
      minSpacingMm: 2,
      components: [
        { ref: 'U1', primitiveId: 'p-u1', widthMm: 10, heightMm: 10 },
        { ref: 'U2', primitiveId: 'p-u2', widthMm: 10, heightMm: 10 },
      ],
    });

    expect(plan.blocked).toBe(true);
    expect(plan.issues.some((issue) => issue.code === 'LAYOUT_COMPONENT_COLLISION')).toBe(true);
  });

  it('uses rotation-aware footprint bounds for a quarter-turn within the board', () => {
    const plan = planComponentGroupPlacement({
      board: { widthMm: 10, heightMm: 10 },
      anchor: { x: 2, y: 5 },
      components: [{ ref: 'U1', primitiveId: 'p-u1', widthMm: 8, heightMm: 2, rotation: 90 }],
    });

    expect(plan.blocked).toBe(false);
    expect(plan.placements[0]?.bbox).toEqual({
      x: 1,
      y: 1,
      widthMm: 2,
      heightMm: 8,
      name: 'U1',
    });
    expect(plan.operations[0]?.params.property).toMatchObject({ rotation: 90 });
  });

  it('detects an off-board rotated footprint that would appear to fit unrotated', () => {
    const plan = planComponentGroupPlacement({
      board: { widthMm: 10, heightMm: 10 },
      anchor: { x: 5, y: 2 },
      components: [{ ref: 'U1', primitiveId: 'p-u1', widthMm: 8, heightMm: 2, rotation: 90 }],
    });
    expect(plan.issues.some((entry) => entry.code === 'LAYOUT_COMPONENT_OUTSIDE_BOARD')).toBe(true);
  });

  it('applies rotated bounds to component keepouts, including arbitrary angles', () => {
    const plan = planComponentGroupPlacement({
      board: { widthMm: 20, heightMm: 20 },
      anchor: { x: 10, y: 10 },
      keepouts: [{ x: 11, y: 12, widthMm: 1, heightMm: 1 }],
      components: [{ ref: 'U1', primitiveId: 'p-u1', widthMm: 6, heightMm: 2, rotation: 45 }],
    });
    expect(plan.issues.some((entry) => entry.code === 'LAYOUT_COMPONENT_IN_KEEPOUT')).toBe(true);
    expect(plan.placements[0]?.bbox.widthMm).toBeCloseTo(4 * Math.SQRT2);
  });

  it('detects a collision that exists only after rotating a component', () => {
    const plan = planComponentGroupPlacement({
      board: { widthMm: 30, heightMm: 30 },
      anchor: { x: 10, y: 10 },
      columns: 2,
      spacingMm: 0,
      minSpacingMm: 0,
      components: [
        { ref: 'U1', primitiveId: 'p-u1', widthMm: 2, heightMm: 8, rotation: 90 },
        { ref: 'U2', primitiveId: 'p-u2', widthMm: 2, heightMm: 2 },
      ],
    });
    expect(plan.issues.some((entry) => entry.code === 'LAYOUT_COMPONENT_COLLISION')).toBe(true);
  });

  it('blocks an extremely thin keepout intersecting a long segment between sample points', () => {
    const plan = planRoutePath({
      netName: 'TEST',
      layer: 1,
      widthMm: 0.254,
      waypoints: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      keepouts: [{ x: 53, y: -2.5, width: 5, height: 5 }],
    });
    expect(plan.issues.some((entry) => entry.code === 'LAYOUT_PATH_IN_KEEPOUT')).toBe(true);
    expect(plan.blocked).toBe(true);
  });

  it('rejects a diagonal segment crossing a keepout without touching its corners', () => {
    const plan = planRoutePath({
      netName: 'TEST',
      layer: 1,
      widthMm: 0.254,
      waypoints: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      keepouts: [{ x: 40, y: 49, width: 20, height: 2 }],
    });
    expect(plan.blocked).toBe(true);
  });

  it('checks the copper width against keepout boundaries, not only the centreline', () => {
    const near = planRoutePath({
      netName: 'TEST',
      layer: 1,
      widthMm: 0.254,
      waypoints: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      keepouts: [{ x: 45, y: 4, width: 10, height: 3 }],
    });
    const far = planRoutePath({
      netName: 'TEST',
      layer: 1,
      widthMm: 0.254,
      waypoints: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      keepouts: [{ x: 45, y: 6, width: 10, height: 3 }],
    });
    expect(near.blocked).toBe(true);
    expect(far.blocked).toBe(false);
  });

  it('does not flag a keepout when the segment misses it', () => {
    const plan = planRoutePath({
      netName: 'TEST',
      layer: 1,
      widthMm: 0.254,
      waypoints: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      keepouts: [{ x: 0, y: 90, width: 5, height: 5 }],
    });
    expect(plan.blocked).toBe(false);
  });

  it('creates a constrained path plan with length metadata', () => {
    const plan = planRoutePath({
      netName: 'GND',
      layer: 1,
      widthMm: 0.4,
      board: { minX: 0, maxX: mmToPcbMil(60), minY: 0, maxY: mmToPcbMil(40) },
      waypoints: [
        { x: mmToPcbMil(5), y: mmToPcbMil(5) },
        { x: mmToPcbMil(15), y: mmToPcbMil(5) },
        { x: mmToPcbMil(15), y: mmToPcbMil(15) },
      ],
    });

    expect(plan.blocked).toBe(false);
    expect(plan.pathLengthMm).toBe(20);
    expect(plan.operations[0]).toMatchObject({ method: 'pcb.addTrack' });
  });

  it('plans native PCB mil waypoints while reporting physical route length and width in mm', () => {
    const waypoints = [
      { x: 4822.8, y: -2057.1 },
      { x: 4908.2, y: -2059.1 },
    ];
    const plan = planRoutePath({
      netName: 'U4-VSET2',
      layer: 1,
      widthMm: 0.2,
      board: {
        minX: 4448.8189,
        maxX: 7600.7493,
        minY: -2086.6141,
        maxY: -118.1102,
      },
      waypoints,
    });

    expect(plan.blocked).toBe(false);
    expect(plan.pathLengthMm).toBe(2.1698);
    expect(plan.operations[0]).toEqual({
      method: 'pcb.addTrack',
      params: {
        points: waypoints,
        layer: 1,
        width: mmToPcbMil(0.2),
        netName: 'U4-VSET2',
      },
    });
  });

  it('blocks route path that crosses keepout or leaves board', () => {
    const plan = planRoutePath({
      netName: '3V3',
      layer: 1,
      widthMm: 0.2,
      minWidthMm: 0.3,
      board: { minX: 0, maxX: mmToPcbMil(20), minY: 0, maxY: mmToPcbMil(20) },
      keepouts: [
        {
          x: mmToPcbMil(8),
          y: mmToPcbMil(8),
          width: mmToPcbMil(4),
          height: mmToPcbMil(4),
          name: 'center',
        },
      ],
      waypoints: [
        { x: 0, y: mmToPcbMil(10) },
        { x: mmToPcbMil(25), y: mmToPcbMil(10) },
      ],
    });

    expect(plan.blocked).toBe(true);
    expect(plan.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'LAYOUT_TRACE_WIDTH_TOO_SMALL',
        'LAYOUT_PATH_OUTSIDE_BOARD',
        'LAYOUT_PATH_IN_KEEPOUT',
      ]),
    );
  });
});
