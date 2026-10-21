import { describe, expect, it, vi } from 'vitest';
import { evaluateZoneOutlineEvidence } from '../src/zone-outline-evidence.js';

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
  it('recognizes the live fixture native negative-Y rectangle', async () => {
    const { reader } = fixture();
    await expect(evaluateZoneOutlineEvidence(inside, reader, state)).resolves.toEqual({
      status: 'intersection-confirmed',
      intersectionVerified: true,
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
