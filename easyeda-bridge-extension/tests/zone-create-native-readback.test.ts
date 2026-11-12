import { describe, expect, it, vi } from 'vitest';
import { readNativeZoneInventory } from '../src/pcb-mutation-operations.js';

const pour = (id = 'e336', linkedCopper: () => unknown = () => poured(id)) => ({
  getState_PrimitiveId: () => id,
  getCopperRegion: async () => linkedCopper(),
  getState_Net: () => 'GND',
  getState_Layer: () => 1,
  getState_ComplexPolygon: () => ({ getSource: () => ['R', 0, 0, 200, 120, 0, 0] }),
  getState_PourFillMethod: () => 'solid',
  getState_PreserveSilos: () => false,
  getState_PourName: () => 'POUR2',
  getState_PourPriority: () => 1,
  getState_LineWidth: () => 0.2,
  getState_PrimitiveLock: () => false,
});
const poured = (id = 'e336', sourceId = 'e336', filled = true) => ({
  getState_PrimitiveId: () => id,
  getState_PourPrimitiveId: () => sourceId,
  getState_PourFills: () => [
    {
      id: 'fill1',
      lineWidth: 0.2,
      fill: filled,
      path: { getSource: () => ['R', 0, 0, 100, 80, 0, 0] },
    },
  ],
});

function runtime(sources: unknown[], derived: unknown[]) {
  const getAllSources = vi.fn(async () => sources);
  const getAllDerived = vi.fn(async () => derived);
  const lookup = (paths: readonly string[]) =>
    paths[0] === 'PCB_PrimitivePour'
      ? { getAll: getAllSources }
      : paths[0] === 'PCB_PrimitivePoured'
        ? { getAll: getAllDerived }
        : undefined;
  return { lookup, getAllSources, getAllDerived };
}

describe('native source and Poured inventory readback is independently snapshotted', () => {
  it('reads valid source/Poured from both native APIs into immutable evidence', async () => {
    const source = pour();
    const derived = poured();
    const { lookup, getAllSources, getAllDerived } = runtime([source], [derived]);
    const result = await readNativeZoneInventory(lookup);
    expect(result?.sources.get('e336')).toMatchObject({
      sourceId: 'e336',
      net: 'GND',
      layer: 1,
      polygonSignature: JSON.stringify(['R', 0, 0, 200, 120, 0, 0]),
    });
    expect(result?.derived.get('e336')).toMatchObject({
      sourceId: 'e336',
      pouredId: 'e336',
      hasFilledGeometry: true,
    });
    expect(getAllSources).toHaveBeenCalledOnce();
    expect(getAllDerived).toHaveBeenCalledOnce();
  });

  it('rejects two distinct Pour sources claiming one native Poured identity', async () => {
    const shared = 'same-native-poured';
    const first = poured(shared, 'source-1');
    const second = poured(shared, 'source-2');
    const r = runtime(
      [pour('source-1', () => first), pour('source-2', () => second)],
      [first, second],
    );
    expect(await readNativeZoneInventory(r.lookup)).toBeUndefined();
  });

  it('retains proof that an outline-only Poured has no actual filled geometry', async () => {
    const r = runtime(
      [pour('e336', () => poured('e336', 'e336', false))],
      [poured('e336', 'e336', false)],
    );
    expect((await readNativeZoneInventory(r.lookup))?.derived.get('e336')?.hasFilledGeometry).toBe(
      false,
    );
  });

  it.each([
    ['duplicate Pour primitive id', [pour(), pour()], [poured()]],
    ['duplicate derived source link', [pour()], [poured(), poured('new-id')]],
    ['invalid source polygon', [{ ...pour(), getState_ComplexPolygon: () => null }], [poured()]],
    ['Poured missing fills', [pour()], [{ ...poured(), getState_PourFills: () => [] }]],
  ] as const)(
    'rejects ambiguous %s instead of returning partial evidence',
    async (_, sources, derived) => {
      expect(
        await readNativeZoneInventory(runtime([...sources], [...derived]).lookup),
      ).toBeUndefined();
    },
  );

  it('cross-checks the native source association against independently enumerated Poured geometry', async () => {
    const baseline = poured();
    expect(
      (
        await readNativeZoneInventory(runtime([pour('e336', () => baseline)], [baseline]).lookup)
      )?.derived.get('e336')?.pouredId,
    ).toBe('e336');

    for (const association of [
      undefined,
      null,
      poured('old-poured', 'old-source'),
      poured('different-poured', 'e336'),
      poured('e336', 'different-source'),
      poured('e336', 'e336', false),
    ]) {
      const source = pour('e336', () => association);
      expect(await readNativeZoneInventory(runtime([source], [baseline]).lookup)).toBeUndefined();
    }
  });

  it('denies a stale source association when no independently enumerated Poured exists', async () => {
    expect(await readNativeZoneInventory(runtime([pour('e336')], []).lookup)).toBeUndefined();
    const noFill = pour('e336', () => undefined);
    expect((await readNativeZoneInventory(runtime([noFill], []).lookup))?.derived.size).toBe(0);
  });

  it('rejects missing association capability and getter failure without claiming a valid inventory', async () => {
    const missing = { ...pour(), getCopperRegion: undefined };
    expect(await readNativeZoneInventory(runtime([missing], [poured()]).lookup)).toBeUndefined();
    const failing = pour('e336', () => {
      throw new Error('beta association failed');
    });
    await expect(readNativeZoneInventory(runtime([failing], [poured()]).lookup)).rejects.toThrow(
      'beta association failed',
    );
  });

  it('fails closed on missing runtime capabilities and rejected native inventory getters', async () => {
    const r = runtime([pour()], [poured()]);
    r.getAllDerived.mockRejectedValueOnce(Error('native API failure'));
    await expect(readNativeZoneInventory(r.lookup)).rejects.toThrow('native API failure');
    expect(await readNativeZoneInventory(() => undefined)).toBeUndefined();
  });
});
