import { describe, expect, it, vi } from 'vitest';
import { evaluateZoneOutlineEvidence } from '../src/zone-outline-evidence.js';
import {
  nativeClosedPolyline,
  polygonRectangleRelation,
} from '../src/zone-polygon-intersection.js';

const board = {
  getState_Layer: () => 11,
  getState_Polygon: () => ({ getSource: () => ['R', 0, 0, 3149.6063, 2362.2047, 0, 0] }),
};
const inside = { x: 2420, y: -1800, width: 520, height: 420 };
const outside = { x: 2400, y: 1700, width: 300, height: 250 };
const state = (obj: unknown, key: string): unknown =>
  (obj as Record<string, () => unknown>)['getState_' + key]?.();

function fixture(overrides: Record<string, unknown> = {}) {
  const runtime: Record<string, unknown> = {
    DMT_Project: { getCurrentProjectInfo: vi.fn(async () => ({ uuid: 'project' })) },
    DMT_SelectControl: {
      getCurrentDocumentInfo: vi.fn(async () => ({
        documentType: 3,
        uuid: 'pcb',
        parentProjectUuid: 'project',
      })),
    },
    PCB_PrimitivePolyline: { getAll: vi.fn(async () => [board]) },
    PCB_PrimitiveLine: { getAll: vi.fn(async () => []) },
    PCB_PrimitiveArc: { getAll: vi.fn(async () => []) },
    PCB_PrimitiveRegion: { getAll: vi.fn(async () => []) },
    ...overrides,
  };
  const reader = <T>(paths: readonly string[]): T | undefined =>
    paths.map((path) => runtime[path]).find(Boolean) as T | undefined;
  return { reader };
}

describe('read-only native board rectangle intersection', () => {
  const lOutline = [0, 0, 'L', 100, 0, 100, -20, 40, -20, 40, -80, 0, -80, 0, 0];
  const lShape = {
    getState_Layer: () => 11,
    getState_Polygon: () => ({ polygon: lOutline }),
  };
  it.each([
    ['inside', { x: 60, y: -2, width: 20, height: 10 }],
    ['outside', { x: 60, y: -40, width: 20, height: 20 }],
    ['partial', { x: 20, y: -10, width: 30, height: 30 }],
    ['partial', { x: -10, y: 10, width: 130, height: 110 }],
  ] as const)(
    'reads a closed non-rectangular board with %s intersection',
    async (relation, rect) => {
      const { reader } = fixture({ PCB_PrimitivePolyline: { getAll: async () => [lShape] } });
      await expect(evaluateZoneOutlineEvidence(rect, reader, state)).resolves.toMatchObject({
        status: 'observed',
        intersectionVerified: relation !== 'outside',
        containmentVerified: relation === 'inside',
        outlineKind: 'closed-polyline',
        intersection: relation,
        outline: null,
      });
    },
  );
  it('uses the shared async source reader used by board_dimensions', async () => {
    const { reader } = fixture({
      PCB_PrimitivePolyline: {
        getAll: async () => [
          {
            getState_Layer: async () => 11,
            getState_Polygon: async () => ({ getSource: async () => lOutline }),
          },
        ],
      },
    });
    await expect(
      evaluateZoneOutlineEvidence({ x: 60, y: -2, width: 20, height: 10 }, reader, state),
    ).resolves.toMatchObject({ status: 'observed', intersection: 'inside' });
  });
  it.each([
    ['unclosed outline', [0, 0, 'L', 100, 0, 100, -20, 40, -20, 40, -80, 0, -80]],
    ['self crossing', [0, 0, 'L', 40, -40, 0, -40, 40, 0, 0, 0]],
    ['curve segment', [0, 0, 'Q', 20, 20, 40, 40, 0, 0]],
    ['nonfinite vertex', [0, 0, 'L', 40, 0, Number.NaN, -40, 0, -40, 0, 0]],
  ])('fails closed for %s', async (_reason, source) => {
    const { reader } = fixture({
      PCB_PrimitivePolyline: {
        getAll: async () => [
          {
            getState_Layer: () => 11,
            getState_Polygon: () => ({ polygon: source }),
          },
        ],
      },
    });
    await expect(evaluateZoneOutlineEvidence(inside, reader, state)).resolves.toMatchObject({
      status: 'unsupported-outline',
      intersectionVerified: false,
    });
  });
  it('recognizes the live fixture native negative-Y rectangle', async () => {
    const { reader } = fixture();
    await expect(evaluateZoneOutlineEvidence(inside, reader, state)).resolves.toEqual({
      status: 'intersection-confirmed',
      intersectionVerified: true,
      containmentVerified: true,
      outlineKind: 'rectangle',
      intersection: 'inside',
      outline: { x: 0, y: 0, width: 3149.6063, height: 2362.2047 },
    });
  });
  it('resolves lower-case runtime PCB class aliases as used by EasyEDA Pro', async () => {
    const { reader } = fixture({
      PCB_PrimitivePolyline: undefined,
      PCB_PrimitiveLine: undefined,
      PCB_PrimitiveArc: undefined,
      PCB_PrimitiveRegion: undefined,
      pcb_PrimitivePolyline: { getAll: async () => [board] },
      pcb_PrimitiveLine: { getAll: async () => [] },
      pcb_PrimitiveArc: { getAll: async () => [] },
      pcb_PrimitiveRegion: { getAll: async () => [] },
    });
    await expect(evaluateZoneOutlineEvidence(inside, reader, state)).resolves.toMatchObject({
      status: 'intersection-confirmed',
      intersectionVerified: true,
    });
  });
  it('classifies the former positive-Y placement as outside the board', async () => {
    const { reader } = fixture();
    await expect(evaluateZoneOutlineEvidence(outside, reader, state)).resolves.toMatchObject({
      status: 'outside-board',
      intersectionVerified: false,
    });
  });
  it('distinguishes strict geometric containment, overhang and exact board-edge contact', async () => {
    const { reader } = fixture();
    const boardInside = await evaluateZoneOutlineEvidence(inside, reader, state);
    expect(boardInside).toMatchObject({
      intersectionVerified: true,
      containmentVerified: true,
      outlineKind: 'rectangle',
      intersection: 'inside',
    });
    const cases = [
      { x: 3140, y: -10, width: 100, height: 50 },
      { x: 0, y: -10, width: 100, height: 50 },
      { x: 40, y: 0, width: 20, height: 30 },
      { x: 40, y: -2300, width: 20, height: 62.2047 },
    ];
    for (const rectangle of cases) {
      expect(await evaluateZoneOutlineEvidence(rectangle, reader, state)).toMatchObject({
        intersectionVerified: true,
        containmentVerified: false,
        intersection: 'partial',
      });
    }
  });

  it('allows partial overhang while checking only rectangle intersection', async () => {
    const { reader } = fixture();
    await expect(
      evaluateZoneOutlineEvidence({ x: 3140, y: -10, width: 100, height: 50 }, reader, state),
    ).resolves.toMatchObject({ status: 'intersection-confirmed' });
  });
  it.each([
    ['multiple board frames', { PCB_PrimitivePolyline: { getAll: async () => [board, board] } }],
    [
      'cutout on outline',
      { PCB_PrimitiveLine: { getAll: async () => [{ getState_Layer: () => 11 }] } },
    ],
    ['outline arc', { PCB_PrimitiveArc: { getAll: async () => [{ getState_Layer: () => 11 }] } }],
    ['restrictive region', { PCB_PrimitiveRegion: { getAll: async () => [{}] } }],
    [
      'rotated shape',
      {
        PCB_PrimitivePolyline: {
          getAll: async () => [
            {
              ...board,
              getState_Polygon: () => ({ getSource: () => ['R', 0, 0, 50, 60, 90, 0] }),
            },
          ],
        },
      },
    ],
    [
      'malformed geometry',
      {
        PCB_PrimitivePolyline: {
          getAll: async () => [
            {
              ...board,
              getState_Polygon: () => ({ getSource: () => ['R', 0, 0, Number.NaN, 60, 0, 0] }),
            },
          ],
        },
      },
    ],
  ])('does not assert intersection for %s', async (_reason, overrides) => {
    const { reader } = fixture(overrides);
    await expect(evaluateZoneOutlineEvidence(inside, reader, state)).resolves.toMatchObject({
      status: 'unsupported-outline',
      intersectionVerified: false,
    });
  });
  it.each([
    ['project getter unavailable', { DMT_Project: {} }],
    ['native region API unavailable', { PCB_PrimitiveRegion: undefined }],
    [
      'failing outline read',
      {
        PCB_PrimitivePolyline: {
          getAll: async () => {
            throw Error('offline');
          },
        },
      },
    ],
    ['bad collection read', { PCB_PrimitivePolyline: { getAll: async () => null } }],
    [
      'missing project association',
      {
        DMT_SelectControl: {
          getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'pcb' }),
        },
      },
    ],
  ])('fails closed if %s', async (_reason, overrides) => {
    const { reader } = fixture(overrides);
    await expect(evaluateZoneOutlineEvidence(inside, reader, state)).resolves.toMatchObject({
      status: 'unavailable',
      intersectionVerified: false,
    });
  });
  it('rejects project/document changes during the survey', async () => {
    const getCurrentDocumentInfo = vi
      .fn()
      .mockResolvedValueOnce({ documentType: 3, uuid: 'pcb', parentProjectUuid: 'project' })
      .mockResolvedValueOnce({ documentType: 3, uuid: 'different', parentProjectUuid: 'project' });
    const { reader } = fixture({ DMT_SelectControl: { getCurrentDocumentInfo } });
    await expect(evaluateZoneOutlineEvidence(inside, reader, state)).resolves.toMatchObject({
      status: 'unavailable',
      intersectionVerified: false,
    });
  });
});

describe('bounded closed-polyline geometry negative paths', () => {
  const valid = [0, 0, 'L', 100, 0, 100, -20, 40, -20, 40, -80, 0, -80, 0, 0];
  it.each([
    ['missing source', undefined],
    ['short source', [0, 0, 'L', 10, 0]],
    ['extra unpaired vertex coordinate', [0, 0, 'L', 10, 0, 0, -10, 0, 0, 50]],
    ['not a native line', [0, 0, 'Q', 10, 0, 10, -10, 0, 0]],
    ['string coordinate', [0, 0, 'L', 10, 0, 10, '-10', 0, 0]],
    ['infinite coordinate', [0, 0, 'L', 10, 0, 10, -Infinity, 0, 0]],
    ['insufficient distinct vertices', [0, 0, 'L', 10, 0, 0, 0]],
    ['not explicitly closed', [0, 0, 'L', 10, 0, 10, -10, 0, -10]],
    ['zero area', [0, 0, 'L', 10, 0, 20, 0, 0, 0]],
    ['zero length edge', [0, 0, 'L', 10, 0, 10, 0, 10, -10, 0, -10, 0, 0]],
    ['self intersecting', [0, 0, 'L', 50, -50, 0, -50, 50, 0, 0, 0]],
    ['nonadjacent edge touching', [0, 0, 'L', 40, 0, 40, -40, 0, -40, 20, -20, 40, -20, 0, 0]],
    ['over vertex limit', [0, 0, 'L', ...Array.from({ length: 514 }, (_, i) => i)]],
  ] as const)('rejects %s rather than inferring board shape', (_reason, source) => {
    expect(nativeClosedPolyline(source)).toBeUndefined();
  });

  it('classifies an exactly boundary-touching candidate as partial, never fully inside', () => {
    const points = nativeClosedPolyline(valid);
    expect(points).toBeDefined();
    if (!points) return;
    expect(polygonRectangleRelation(points, { x: 40, y: -20, width: 20, height: 20 })).toBe(
      'partial',
    );
    expect(polygonRectangleRelation(points, { x: 100, y: -5, width: 20, height: 10 })).toBe(
      'partial',
    );
    expect(polygonRectangleRelation(points, { x: 140, y: -40, width: 10, height: 10 })).toBe(
      'outside',
    );
  });
});
