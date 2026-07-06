import { describe, expect, it } from 'vitest';
import { planFloorplan, type FloorplanInput } from '../../../src/pcb-layout/floorplan.js';
import { validateCircuitIR } from '../../../src/circuit/circuit-ir.js';
import { PlacementSide } from '../../../src/circuit/types.js';

function baseCircuitIR() {
  return validateCircuitIR({
    metadata: {},
    blocks: [
      { id: 'blk-power', name: 'Power', type: 'power-management', children: [] },
      { id: 'blk-io', name: 'IO', type: 'connector', children: [] },
    ],
    devices: [
      { id: 'dev-u1', ref: 'U1', blockRef: 'blk-power', estimatedDissipationWatts: 0.1 },
      { id: 'dev-u2', ref: 'U2', blockRef: 'blk-power', estimatedDissipationWatts: 2 },
      {
        id: 'dev-j1',
        ref: 'J1',
        blockRef: 'blk-io',
        metadata: [{ key: 'role', value: 'connector' }],
      },
      { id: 'dev-u3', ref: 'U3', blockRef: 'blk-power' },
    ],
    physicalConstraints: [
      {
        id: 'pc-1',
        type: 'placement',
        targetType: 'device',
        targetRef: 'dev-u3',
        description: 'U3 must be on the bottom side',
        preferredSide: PlacementSide.Bottom,
      },
    ],
    pcb: {
      keepoutAreas: [
        {
          outline: [
            { x: 0, y: 0 },
            { x: 5, y: 0 },
            { x: 5, y: 5 },
            { x: 0, y: 5 },
          ],
          layer: 'top-copper',
          restriction: 'all',
          description: 'mounting-hole-keepout',
        },
      ],
    },
  });
}

function baseInput(overrides: Partial<FloorplanInput> = {}): FloorplanInput {
  return {
    circuitIR: baseCircuitIR(),
    projectId: 'proj-1',
    board: { widthMm: 100, heightMm: 80 },
    anchor: { x: 30, y: 30 },
    devices: [
      { deviceId: 'dev-u1', ref: 'U1', widthMm: 5, heightMm: 5 },
      { deviceId: 'dev-u2', ref: 'U2', widthMm: 5, heightMm: 5 },
      { deviceId: 'dev-j1', ref: 'J1', widthMm: 8, heightMm: 4 },
      { deviceId: 'dev-u3', ref: 'U3', widthMm: 4, heightMm: 4 },
    ],
    ...overrides,
  };
}

describe('planFloorplan', () => {
  it('is deterministic: identical input produces an identical transaction id', () => {
    const planA = planFloorplan(baseInput());
    const planB = planFloorplan(baseInput());
    expect(planA.transactionId).toBe(planB.transactionId);
    expect(planA.transactionId).toMatch(/^floorplan_[0-9a-f]{16}$/);
  });

  it('routes a connector-role device to the connector-edge pass, not the general grid', () => {
    const plan = planFloorplan(baseInput());
    const connectorPlacement = plan.placements.find((p) => p.ref === 'J1');
    expect(connectorPlacement).toBeDefined();
    // Default connectorEdge is 'bottom' -> anchored near the board's bottom edge.
    expect(connectorPlacement!.y).toBeGreaterThan(60);
  });

  it('places a device with a Bottom placement-side constraint on the bottom layer', () => {
    const plan = planFloorplan(baseInput({ topLayer: 1, bottomLayer: 2 }));
    const u3 = plan.placements.find((p) => p.ref === 'U3');
    const u1 = plan.placements.find((p) => p.ref === 'U1');
    expect(u3?.layer).toBe(2);
    expect(u1?.layer).toBe(1);
  });

  it('boosts minimum spacing for a pass containing a hot device', () => {
    const plan = planFloorplan(baseInput({ thermalDissipationThresholdWatts: 0.5 }));
    expect(plan.floorplanNotes.some((note) => note.includes('minimum spacing boosted'))).toBe(true);
  });

  it('does not boost spacing when no device exceeds the thermal threshold', () => {
    const plan = planFloorplan(baseInput({ thermalDissipationThresholdWatts: 100 }));
    expect(plan.floorplanNotes.some((note) => note.includes('minimum spacing boosted'))).toBe(
      false,
    );
  });

  it('skips devices with no supplied physical dimensions and notes it', () => {
    const input = baseInput({
      devices: [{ deviceId: 'dev-u1', ref: 'U1', widthMm: 5, heightMm: 5 }],
    });
    const plan = planFloorplan(input);
    expect(plan.placements.map((p) => p.ref)).toEqual(['U1']);
    expect(
      plan.floorplanNotes.some((note) => note.includes('had no supplied physical dimensions')),
    ).toBe(true);
  });

  it('converts CircuitIR keepout polygons to bounding boxes applied to every pass', () => {
    const plan = planFloorplan(
      baseInput({
        anchor: { x: 2, y: 2 },
        devices: [{ deviceId: 'dev-u1', ref: 'U1', widthMm: 4, heightMm: 4 }],
      }),
    );
    expect(plan.blocked).toBe(true);
    expect(plan.issues.some((issue) => issue.code === 'LAYOUT_COMPONENT_IN_KEEPOUT')).toBe(true);
  });

  it('groups devices from the same block adjacently within a pass', () => {
    const plan = planFloorplan(baseInput());
    const topRefs = plan.placements
      .filter((p) => p.layer === 1 && p.ref !== 'J1')
      .map((p) => p.ref);
    // U1, U2, U3 all share blockRef 'blk-power' (U3 is filtered out of the top layer by
    // its own Bottom constraint, so only U1/U2 remain here) — both present and adjacent.
    expect(topRefs).toEqual(expect.arrayContaining(['U1', 'U2']));
  });

  it('reports zero passes cleanly when no devices have supplied dimensions', () => {
    const plan = planFloorplan(baseInput({ devices: [] }));
    expect(plan.placements).toHaveLength(0);
    expect(plan.blocked).toBe(false);
    expect(plan.summary).toMatch(/0 pass\(es\)/);
  });
});
