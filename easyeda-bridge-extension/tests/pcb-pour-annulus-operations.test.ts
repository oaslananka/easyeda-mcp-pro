import { describe, expect, it, vi } from 'vitest';
import { createPcbReadOperations } from '../src/pcb-read-operations.js';

const requested = {
  pourPrimitiveId: 'p1',
  expectedNet: 'GND',
  expectedLayer: 1,
  pads: [{ componentPrimitiveId: 'c1', designator: 'U1', padNumber: '3', primitiveId: 'pad1' }],
};
const ring = [0, 0, 'L', 100, 0, 100, 100, 0, 100, 0, 0];
function native(data: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => ['getState_' + k, () => v]));
}
function fixture(mode = '') {
  const fill = {
    id: 'copper0',
    fill: true,
    lineWidth: 0,
    path: { getSource: (): unknown => ring },
  };
  const derived = {
    ...native({ PrimitiveId: 'p1', PourPrimitiveId: 'p1', Layer: 1, PourFills: [fill] }),
  };
  const linked =
    mode === 'different-geometry'
      ? native({
          PrimitiveId: 'p1',
          PourPrimitiveId: 'p1',
          Layer: 1,
          PourFills: [{ ...fill, path: { getSource: () => [...ring.slice(0, -2), 1, 0] } }],
        })
      : mode === 'absent'
        ? undefined
        : derived;
  const pour = {
    ...native({ PrimitiveId: 'p1', Net: mode === 'wrong-net' ? 'VCC' : 'GND', Layer: 1 }),
    getCopperRegion: vi.fn(async () => linked),
  };
  const pad = native({
    PrimitiveId: 'pad1',
    ParentComponentPrimitiveId: 'c1',
    PadNumber: '3',
    Net: 'GND',
    Layer: 12,
    X: -20,
    Y: 500,
    Pad: ['ELLIPSE', 80, 80],
    Hole: ['ROUND', 4, 4],
    Metallization: true,
    HeatWelding: null,
    HoleOffsetX: 0,
    HoleOffsetY: 0,
    SpecialPad: [],
  });
  if (mode === 'missing-getter') delete pad.getState_HeatWelding;
  if (mode === 'wrong-owner') pad.getState_ParentComponentPrimitiveId = () => 'other';
  if (mode === 'wrong-pad-net') pad.getState_Net = () => 'VCC';
  if (mode === 'malformed-pad') pad.getState_Pad = () => Array(100).fill(1);
  if (mode === 'unsupported-path') fill.path.getSource = () => [0, 0, 'ARC', 90, 100, 100, 0, 0];
  if (mode === 'oversized-path') fill.path.getSource = () => Array(8194).fill(0);
  if (mode === 'nested-path') fill.path.getSource = () => [ring];
  if (mode === 'nonfinite-path') fill.path.getSource = () => [0, 0, 'L', 100, 0, 100, NaN, 0, 0];
  if (mode === 'multiple-fills') derived.getState_PourFills = () => [fill, fill];
  if (mode === 'stroke-fill') fill.lineWidth = 1;
  if (mode === 'wrong-derived-layer') derived.getState_Layer = () => 2;
  const pad2 = { ...pad, getState_PrimitiveId: () => 'pad2', getState_PadNumber: () => '4' };
  const components = [native({ PrimitiveId: 'c1', Designator: 'U1' })];
  if (mode === 'colliding-pad') components.push(native({ PrimitiveId: 'pad1', Designator: 'U2' }));
  if (mode === 'colliding-component')
    components.push(native({ PrimitiveId: 'p1', Designator: 'U2' }));
  if (mode === 'duplicate-designator')
    components.push(native({ PrimitiveId: 'c2', Designator: 'U1' }));
  if (mode === 'cross-owner-duplicate')
    components.push(native({ PrimitiveId: 'c2', Designator: 'U2' }));
  const runtime: Record<string, unknown> = {
    PCB_PrimitivePour: { getAll: async () => (mode === 'duplicate-pour' ? [pour, pour] : [pour]) },
    PCB_PrimitivePoured: {
      getAll: async () =>
        mode === 'duplicate-poured'
          ? [derived, derived]
          : mode === 'wrong-source'
            ? [native({ PrimitiveId: 'p1', PourPrimitiveId: 'other', Layer: 1, PourFills: [fill] })]
            : [derived],
    },
    PCB_PrimitiveComponent: {
      getAll: async () =>
        mode === 'duplicate-component' ? [...components, ...components] : components,
      getAllPinsByPrimitiveId: vi.fn(async (id: string) => {
        if (mode === 'duplicate-pad') return [pad, pad];
        if (mode === 'multiple-pins') return [pad, pad2];
        if (mode === 'cross-owner-duplicate' && id === 'c2')
          return [
            { ...pad, getState_ParentComponentPrimitiveId: () => 'c2' },
            { ...pad2, getState_ParentComponentPrimitiveId: () => 'c2' },
          ];
        return [pad];
      }),
    },
  };
  if (mode === 'non-array-inventory') runtime.PCB_PrimitivePour = { getAll: async () => null };
  if (mode === 'oversized-inventory')
    runtime.PCB_PrimitivePour = { getAll: async () => Array(257).fill(pour) };
  if (mode === 'missing-api') delete runtime.PCB_PrimitivePoured;
  if (mode === 'throw')
    runtime.PCB_PrimitivePoured = {
      getAll: async () => {
        throw Error('beta failure');
      },
    };
  const operations = createPcbReadOperations({
    requireActivePcbContext: vi.fn(async () => undefined),
    readFirstPath: <T>(paths: readonly string[]) =>
      paths.map((p) => runtime[p]).find(Boolean) as T | undefined,
    readState: (v: unknown, k: string) =>
      (v as Record<string, () => unknown> | undefined)?.['getState_' + k]?.(),
  });
  return { operations, pour, runtime };
}

describe('bounded native pour annulus geometry', () => {
  it('correlates exact native pour and derived fill plus selected pad metadata', async () => {
    const { operations, pour } = fixture();
    expect(await operations.listPourAnnulusGeometry(requested)).toEqual({
      evidence: 'native_source_linked_filled_region',
      pourPrimitiveId: 'p1',
      net: 'GND',
      layer: 1,
      fill: { id: 'copper0', fill: true, lineWidth: 0, path: { complexPolygon: [ring] } },
      pads: [
        {
          ...requested.pads[0],
          net: 'GND',
          layer: 12,
          x: -20,
          y: 500,
          pad: ['ELLIPSE', 80, 80],
          hole: ['ROUND', 4, 4],
          metallization: true,
          heatWelding: null,
          holeOffsetX: 0,
          holeOffsetY: 0,
          specialPad: [],
        },
      ],
      electricalContinuity: 'UNKNOWN',
    });
    expect(pour.getCopperRegion).toHaveBeenCalledOnce();
  });
  it.each([
    'different-geometry',
    'nonfinite-path',
    'multiple-fills',
    'stroke-fill',
    'wrong-derived-layer',
    'duplicate-designator',
    'non-array-inventory',
    'oversized-inventory',
    'absent',
    'wrong-net',
    'missing-getter',
    'wrong-owner',
    'wrong-pad-net',
    'malformed-pad',
    'unsupported-path',
    'oversized-path',
    'duplicate-pour',
    'colliding-pad',
    'colliding-component',
    'duplicate-poured',
    'wrong-source',
    'duplicate-component',
    'duplicate-pad',
    'missing-api',
    'throw',
  ])('fails closed: %s', async (mode) => {
    expect(await fixture(mode).operations.listPourAnnulusGeometry(requested)).toMatchObject({
      evidence: 'unavailable',
      electricalContinuity: 'UNKNOWN',
    });
  });
  it('supports the single nested contour and caches an exact component pin inventory', async () => {
    const nested = await fixture('nested-path').operations.listPourAnnulusGeometry(requested);
    expect(nested).toMatchObject({
      evidence: 'native_source_linked_filled_region',
      fill: { path: { complexPolygon: [ring] } },
    });
    const { operations, runtime } = fixture('multiple-pins');
    const result = await operations.listPourAnnulusGeometry({
      ...requested,
      pads: [...requested.pads, { ...requested.pads[0], padNumber: '4', primitiveId: 'pad2' }],
    });
    expect(result).toMatchObject({
      evidence: 'native_source_linked_filled_region',
      pads: [
        { primitiveId: 'pad1', padNumber: '3' },
        { primitiveId: 'pad2', padNumber: '4' },
      ],
    });
    expect(
      (runtime.PCB_PrimitiveComponent as { getAllPinsByPrimitiveId: unknown })
        .getAllPinsByPrimitiveId,
    ).toHaveBeenCalledTimes(1);
  });

  it('does not reuse contradictory component or pin identities', async () => {
    for (const pad of [
      { ...requested.pads[0], designator: 'U2' },
      { ...requested.pads[0], padNumber: '999' },
      { ...requested.pads[0], primitiveId: 'other' },
    ]) {
      expect(
        await fixture().operations.listPourAnnulusGeometry({ ...requested, pads: [pad] }),
      ).toMatchObject({ evidence: 'unavailable' });
    }
    expect(
      await fixture('cross-owner-duplicate').operations.listPourAnnulusGeometry({
        ...requested,
        pads: [
          ...requested.pads,
          { componentPrimitiveId: 'c2', designator: 'U2', padNumber: '4', primitiveId: 'pad2' },
        ],
      }),
    ).toMatchObject({ evidence: 'unavailable' });
  });

  it('rejects malformed and repeated declarations before copper reads', async () => {
    const { operations, pour } = fixture();
    for (const request of [
      null,
      {},
      { ...requested, expectedLayer: 15 },
      { ...requested, pourPrimitiveId: ' p1' },
      { ...requested, pads: [] },
      { ...requested, pads: [{ ...requested.pads[0], padNumber: '' }] },
      { ...requested, pads: [...requested.pads, { ...requested.pads[0], primitiveId: 'pad2' }] },
      { ...requested, pads: [...requested.pads, ...requested.pads] },
    ]) {
      expect(await operations.listPourAnnulusGeometry(request)).toMatchObject({
        evidence: 'unavailable',
      });
    }
    expect(pour.getCopperRegion).not.toHaveBeenCalled();
  });
});
