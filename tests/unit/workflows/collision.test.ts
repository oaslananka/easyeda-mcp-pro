import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  scanSheetForPinCollisions,
  reconcilePlacementCollisions,
} from '../../../src/workflows/collision.js';
import { type ToolContext } from '../../../src/tools/types.js';

/* ─── helpers ─────────────────────────────────────────────────────────── */

function makeCtx(bridgeCall: ReturnType<typeof vi.fn>): ToolContext {
  return {
    profile: 'pro',
    bridge: {
      connected: true,
      call: bridgeCall,
    },
    config: {
      bridgeTimeoutMs: 1000,
      artifactDir: '.easyeda-mcp-pro/artifacts',
      bridgeHost: 'localhost',
      bridgePort: 3000,
    },
    vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
  };
}

/** Build a mock pin object in the flat format returned by the bridge. */
function pin(pinNumber: string, pinName: string, x: number, y: number) {
  return { pinNumber, pinName, x, y, rotation: 0, pinLength: 10 };
}

/* ─── scanSheetForPinCollisions ───────────────────────────────────────── */

describe('scanSheetForPinCollisions', () => {
  let bridgeCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bridgeCall = vi.fn();
  });

  it('returns collisions when two components share the same pin coordinate', async () => {
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listComponents') {
        return {
          total: 2,
          items: [{ primitiveId: 'comp-A' }, { primitiveId: 'comp-B' }],
        };
      }
      if (method === 'api.call') {
        const id = params.args[0];
        if (id === 'comp-A') {
          return { result: [pin('1', 'VCC', 100, 200), pin('2', 'GND', 100, 300)] };
        }
        if (id === 'comp-B') {
          // pin 1 of comp-B overlaps with pin 1 of comp-A at (100, 200)
          return { result: [pin('1', 'OUT', 100, 200), pin('2', 'IN', 200, 200)] };
        }
      }
      return undefined;
    });

    const ctx = makeCtx(bridgeCall);
    const collisions = await scanSheetForPinCollisions(ctx, 'proj-1');

    expect(collisions).toHaveLength(1);
    expect(collisions[0].x).toBe(100);
    expect(collisions[0].y).toBe(200);
    expect(collisions[0].pins).toHaveLength(2);

    const primitiveIds = collisions[0].pins.map((p) => p.primitiveId);
    expect(primitiveIds).toContain('comp-A');
    expect(primitiveIds).toContain('comp-B');
  });

  it('returns no collisions when pins do not overlap', async () => {
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listComponents') {
        return {
          total: 2,
          items: [{ primitiveId: 'comp-A' }, { primitiveId: 'comp-B' }],
        };
      }
      if (method === 'api.call') {
        const id = params.args[0];
        if (id === 'comp-A') {
          return { result: [pin('1', 'VCC', 100, 200)] };
        }
        if (id === 'comp-B') {
          return { result: [pin('1', 'OUT', 300, 400)] };
        }
      }
      return undefined;
    });

    const ctx = makeCtx(bridgeCall);
    const collisions = await scanSheetForPinCollisions(ctx, 'proj-1');
    expect(collisions).toHaveLength(0);
  });

  it('returns no collisions when the component list is empty', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.listComponents') {
        return { total: 0, items: [] };
      }
      return undefined;
    });

    const ctx = makeCtx(bridgeCall);
    const collisions = await scanSheetForPinCollisions(ctx, 'proj-1');
    expect(collisions).toHaveLength(0);
  });

  it('ignores pins of the same component at the same coordinate (single-component bucket)', async () => {
    // Two pins of the *same* component share a coordinate — this is NOT a collision
    // because collisionsFromMap requires >= 2 distinct primitiveIds in the bucket.
    bridgeCall.mockImplementation(async (method: string, _params: any) => {
      if (method === 'schematic.listComponents') {
        return { total: 1, items: [{ primitiveId: 'comp-A' }] };
      }
      if (method === 'api.call') {
        return { result: [pin('1', 'P1', 50, 50), pin('2', 'P2', 50, 50)] };
      }
      return undefined;
    });

    const ctx = makeCtx(bridgeCall);
    const collisions = await scanSheetForPinCollisions(ctx, 'proj-1');
    expect(collisions).toHaveLength(0);
  });

  it('groups coordinates with sub-millis precision via rounding (pointKey behavior)', async () => {
    // pointKey rounds to 3 decimal places: 100.00049 and 100.0005 should
    // round to 100 and 100.001 respectively — they should NOT collide.
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listComponents') {
        return {
          total: 2,
          items: [{ primitiveId: 'comp-A' }, { primitiveId: 'comp-B' }],
        };
      }
      if (method === 'api.call') {
        const id = params.args[0];
        if (id === 'comp-A') {
          return { result: [pin('1', 'P1', 100.00049, 200)] };
        }
        if (id === 'comp-B') {
          return { result: [pin('1', 'P1', 100.0005, 200)] };
        }
      }
      return undefined;
    });

    const ctx = makeCtx(bridgeCall);
    const collisions = await scanSheetForPinCollisions(ctx, 'proj-1');
    // 100.00049 rounds to 100.000 and 100.0005 rounds to 100.001 — no collision
    expect(collisions).toHaveLength(0);
  });

  it('detects collision for coordinates that round to the same pointKey', async () => {
    // Both 100.0001 and 100.0004 round to 100.000 → same key → collision
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listComponents') {
        return {
          total: 2,
          items: [{ primitiveId: 'comp-A' }, { primitiveId: 'comp-B' }],
        };
      }
      if (method === 'api.call') {
        const id = params.args[0];
        if (id === 'comp-A') {
          return { result: [pin('1', 'P1', 100.0001, 200)] };
        }
        if (id === 'comp-B') {
          return { result: [pin('1', 'P1', 100.0004, 200)] };
        }
      }
      return undefined;
    });

    const ctx = makeCtx(bridgeCall);
    const collisions = await scanSheetForPinCollisions(ctx, 'proj-1');
    expect(collisions).toHaveLength(1);
  });

  it('paginates through multiple pages of components', async () => {
    // Simulate 2 pages: first returns 1 item (total=2), second returns 1 item
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listComponents') {
        if (params.offset === 0) {
          return { total: 2, items: [{ primitiveId: 'comp-A' }] };
        }
        return { total: 2, items: [{ primitiveId: 'comp-B' }] };
      }
      if (method === 'api.call') {
        const id = params.args[0];
        if (id === 'comp-A') {
          return { result: [pin('1', 'P1', 50, 50)] };
        }
        if (id === 'comp-B') {
          // Collision with comp-A
          return { result: [pin('1', 'P1', 50, 50)] };
        }
      }
      return undefined;
    });

    const ctx = makeCtx(bridgeCall);
    const collisions = await scanSheetForPinCollisions(ctx, 'proj-1');
    expect(collisions).toHaveLength(1);

    // Should have called listComponents at least twice for pagination
    const listCalls = bridgeCall.mock.calls.filter(
      ([m]: [string]) => m === 'schematic.listComponents',
    );
    expect(listCalls.length).toBeGreaterThanOrEqual(2);
  });
});

/* ─── reconcilePlacementCollisions ────────────────────────────────────── */

describe('reconcilePlacementCollisions', () => {
  let bridgeCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bridgeCall = vi.fn();
  });

  it('returns immediately with empty result when candidatePrimitiveIds is empty', async () => {
    const ctx = makeCtx(bridgeCall);
    const result = await reconcilePlacementCollisions(ctx, 'proj-1', [], new Map());
    expect(result.unresolvedCollisions).toHaveLength(0);
    expect(result.movedComponents.size).toBe(0);
    // Bridge should not be called at all
    expect(bridgeCall).not.toHaveBeenCalled();
  });

  it('returns no collisions when candidate pins do not overlap with existing components', async () => {
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listComponents') {
        return {
          total: 2,
          items: [{ primitiveId: 'existing-1' }, { primitiveId: 'candidate-1' }],
        };
      }
      if (method === 'api.call') {
        const id = params.args[0];
        if (id === 'existing-1') {
          return { result: [pin('1', 'VCC', 100, 100)] };
        }
        if (id === 'candidate-1') {
          return { result: [pin('1', 'OUT', 500, 500)] };
        }
      }
      return undefined;
    });

    const ctx = makeCtx(bridgeCall);
    const positions = new Map([['candidate-1', { x: 500, y: 500 }]]);
    const result = await reconcilePlacementCollisions(ctx, 'proj-1', ['candidate-1'], positions);

    expect(result.unresolvedCollisions).toHaveLength(0);
    expect(result.movedComponents.size).toBe(0);
  });

  it('nudges a colliding candidate and resolves the collision', async () => {
    let nudgeCount = 0;
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listComponents') {
        return {
          total: 2,
          items: [{ primitiveId: 'existing-1' }, { primitiveId: 'candidate-1' }],
        };
      }
      if (method === 'api.call') {
        const id = params.args[0];
        if (id === 'existing-1') {
          return { result: [pin('1', 'VCC', 100, 100)] };
        }
        if (id === 'candidate-1') {
          // After the first nudge, the candidate's pin moves away
          if (nudgeCount > 0) {
            return { result: [pin('1', 'OUT', 130, 130)] };
          }
          // Initially collides at (100, 100)
          return { result: [pin('1', 'OUT', 100, 100)] };
        }
      }
      if (method === 'schematic.modifyPrimitive') {
        nudgeCount += 1;
        return { success: true };
      }
      return undefined;
    });

    const ctx = makeCtx(bridgeCall);
    const positions = new Map([['candidate-1', { x: 100, y: 100 }]]);
    const result = await reconcilePlacementCollisions(ctx, 'proj-1', ['candidate-1'], positions);

    expect(result.unresolvedCollisions).toHaveLength(0);
    expect(result.movedComponents.has('candidate-1')).toBe(true);
    const moved = result.movedComponents.get('candidate-1')!;
    // First nudge: x + 30*(0+1) = 130, y + 30*(0+1) = 130
    expect(moved.x).toBe(130);
    expect(moved.y).toBe(130);
  });

  it('reports unresolved collisions when all nudge attempts fail', async () => {
    // The collision persists after every nudge — candidate and existing always overlap
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listComponents') {
        return {
          total: 2,
          items: [{ primitiveId: 'existing-1' }, { primitiveId: 'candidate-1' }],
        };
      }
      if (method === 'api.call') {
        const id = params.args[0];
        if (id === 'existing-1') {
          // Existing component has pins everywhere along the nudge trajectory
          return {
            result: [
              pin('1', 'P1', 100, 100),
              pin('2', 'P2', 130, 130),
              pin('3', 'P3', 160, 160),
              pin('4', 'P4', 190, 190),
            ],
          };
        }
        if (id === 'candidate-1') {
          // Always returns a pin at the candidate's current position
          // which matches one of existing-1's pins.
          // The candidate will be nudged to (130,130), (160,160), (190,190)
          // and all of those collide with existing-1
          return { result: [pin('1', 'OUT', 100, 100)] };
        }
      }
      if (method === 'schematic.modifyPrimitive') {
        return { success: true };
      }
      return undefined;
    });

    // We need to be smarter about the mock: after each nudge the candidate position
    // is updated in candidatePositions, but buildPinCoordinateMap re-fetches pins
    // from the bridge. We need the bridge to always return a colliding coordinate.

    // Simplest approach: existing component has a pin at every nudge destination.
    let currentCandidatePos = { x: 100, y: 100 };
    bridgeCall.mockReset();
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listComponents') {
        return {
          total: 2,
          items: [{ primitiveId: 'existing-1' }, { primitiveId: 'candidate-1' }],
        };
      }
      if (method === 'api.call') {
        const id = params.args[0];
        if (id === 'existing-1') {
          // Existing component has pins at (100,100), (130,130), (190,190), (280,280), (400,400)
          // covering the initial position and all 3 nudge destinations:
          // nudge 1: +30 → (130,130), nudge 2: +60 → (190,190), nudge 3: +90 → (280,280), nudge 4: +120 -> (400,400)
          return {
            result: [
              pin('1', 'P1', 100, 100),
              pin('2', 'P2', 130, 130),
              pin('3', 'P3', 190, 190),
              pin('4', 'P4', 280, 280),
              pin('5', 'P5', 400, 400),
            ],
          };
        }
        if (id === 'candidate-1') {
          return { result: [pin('1', 'OUT', currentCandidatePos.x, currentCandidatePos.y)] };
        }
      }
      if (method === 'schematic.modifyPrimitive') {
        // Track the nudge position
        currentCandidatePos = { x: params.property.x, y: params.property.y };
        return { success: true };
      }
      return undefined;
    });

    const ctx = makeCtx(bridgeCall);
    const positions = new Map([['candidate-1', { x: 100, y: 100 }]]);
    const result = await reconcilePlacementCollisions(ctx, 'proj-1', ['candidate-1'], positions);

    expect(result.unresolvedCollisions.length).toBeGreaterThan(0);
    // Verify the modify call was made 3 times (NUDGE_ATTEMPTS = 3)
    const modifyCalls = bridgeCall.mock.calls.filter(
      ([m]: [string]) => m === 'schematic.modifyPrimitive',
    );
    expect(modifyCalls).toHaveLength(3);
  });

  it('nudges only candidates involved in collisions, not all candidates', async () => {
    let candANudged = false;
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listComponents') {
        return {
          total: 3,
          items: [
            { primitiveId: 'existing-1' },
            { primitiveId: 'candidate-A' },
            { primitiveId: 'candidate-B' },
          ],
        };
      }
      if (method === 'api.call') {
        const id = params.args[0];
        if (id === 'existing-1') {
          return { result: [pin('1', 'VCC', 100, 100)] };
        }
        if (id === 'candidate-A') {
          // candidate-A collides with existing-1 on first check, then is nudged away
          if (candANudged) return { result: [pin('1', 'P1', 200, 200)] };
          return { result: [pin('1', 'P1', 100, 100)] };
        }
        if (id === 'candidate-B') {
          // candidate-B never collides
          return { result: [pin('1', 'P2', 999, 999)] };
        }
      }
      if (method === 'schematic.modifyPrimitive') {
        if (params.primitiveId === 'candidate-A') {
          candANudged = true;
        }
        return { success: true };
      }
      return undefined;
    });

    const ctx = makeCtx(bridgeCall);
    const positions = new Map([
      ['candidate-A', { x: 100, y: 100 }],
      ['candidate-B', { x: 999, y: 999 }],
    ]);
    const result = await reconcilePlacementCollisions(
      ctx,
      'proj-1',
      ['candidate-A', 'candidate-B'],
      positions,
    );

    expect(result.unresolvedCollisions).toHaveLength(0);
    expect(result.movedComponents.has('candidate-A')).toBe(true);
    // candidate-B should NOT have been nudged
    expect(candANudged).toBe(true);
    expect(result.movedComponents.has('candidate-B')).toBe(false);
  });
});

/* ─── collisionsFromMap — onlyInvolving filter ────────────────────────── */

describe('collisionsFromMap onlyInvolving filter (tested via reconcilePlacementCollisions)', () => {
  let bridgeCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bridgeCall = vi.fn();
  });

  it('ignores collisions between two non-candidate components', async () => {
    // Two existing components collide at (50,50) but neither is a candidate
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.listComponents') {
        return {
          total: 3,
          items: [
            { primitiveId: 'existing-1' },
            { primitiveId: 'existing-2' },
            { primitiveId: 'candidate-1' },
          ],
        };
      }
      if (method === 'api.call') {
        const id = params.args[0];
        if (id === 'existing-1') {
          return { result: [pin('1', 'P1', 50, 50)] };
        }
        if (id === 'existing-2') {
          // Collides with existing-1 at (50, 50) but no candidate is involved
          return { result: [pin('1', 'P2', 50, 50)] };
        }
        if (id === 'candidate-1') {
          // No collision
          return { result: [pin('1', 'P3', 800, 800)] };
        }
      }
      return undefined;
    });

    const ctx = makeCtx(bridgeCall);
    const positions = new Map([['candidate-1', { x: 800, y: 800 }]]);
    const result = await reconcilePlacementCollisions(ctx, 'proj-1', ['candidate-1'], positions);

    // The collision between existing-1 and existing-2 is NOT reported
    expect(result.unresolvedCollisions).toHaveLength(0);
    expect(result.movedComponents.size).toBe(0);
  });
});
