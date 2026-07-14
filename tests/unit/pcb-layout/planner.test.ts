import { describe, it, expect } from 'vitest';
import { planComponentGroupPlacement, planRoutePath } from '../../../src/pcb-layout/index.js';

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

  it('creates a constrained path plan with length metadata', () => {
    const plan = planRoutePath({
      netName: 'GND',
      layer: 1,
      widthMm: 0.4,
      board: { widthMm: 60, heightMm: 40 },
      waypoints: [
        { x: 5, y: 5 },
        { x: 15, y: 5 },
        { x: 15, y: 15 },
      ],
    });

    expect(plan.blocked).toBe(false);
    expect(plan.pathLengthMm).toBe(20);
    expect(plan.operations[0]).toMatchObject({ method: 'pcb.addTrack' });
  });

  it('blocks route path that crosses keepout or leaves board', () => {
    const plan = planRoutePath({
      netName: '3V3',
      layer: 1,
      widthMm: 0.2,
      minWidthMm: 0.3,
      board: { widthMm: 20, heightMm: 20 },
      keepouts: [{ x: 8, y: 8, widthMm: 4, heightMm: 4, name: 'center' }],
      waypoints: [
        { x: 0, y: 10 },
        { x: 25, y: 10 },
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
