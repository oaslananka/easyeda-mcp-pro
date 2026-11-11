import { describe, expect, it, vi } from 'vitest';
import { createNativeZoneApiAdapter } from '../src/zone-native-api-adapter.js';
import type { ExpectedZoneSource } from '../src/zone-create-evidence.js';

const expected: ExpectedZoneSource = {
  net: 'GND',
  layer: 2,
  polygonSignature: JSON.stringify(['R', 1400, -1200, 120, 80, 0, 0]),
  fillMethod: 'solid',
  preserveSilos: true,
  pourName: 'Z480_ADAPTER',
  pourPriority: 1,
  lineWidth: 0.2,
  locked: false,
};

const board = {
  getState_Layer: () => 11,
  getState_Polygon: () => ({ getSource: () => ['R', 0, 0, 3149.6063, 2362.2047, 0, 0] }),
};

function source(id: string, overrides: Partial<ExpectedZoneSource> = {}) {
  const fields = {
    ...expected,
    polygonSignature: JSON.stringify(['R', 400, -400, 120, 80, 0, 0]),
    pourName: 'BASELINE',
    ...overrides,
  };
  return {
    getState_PrimitiveId: () => id,
    getState_Net: () => fields.net,
    getState_Layer: () => fields.layer,
    getState_ComplexPolygon: () => ({
      getSource: () => JSON.parse(fields.polygonSignature) as unknown,
    }),
    getState_PourFillMethod: () => fields.fillMethod,
    getState_PreserveSilos: () => fields.preserveSilos,
    getState_PourName: () => fields.pourName,
    getState_PourPriority: () => fields.pourPriority,
    getState_LineWidth: () => fields.lineWidth,
    getState_PrimitiveLock: () => fields.locked,
  };
}

function copper(id: string) {
  return {
    getState_PrimitiveId: () => id,
    getState_PourPrimitiveId: () => id,
    getState_PourFills: () => [
      {
        id: 'fill-' + id,
        lineWidth: 0.2,
        fill: true,
        path: { getSource: () => ['R', 1400, -1200, 100, 60, 0, 0] },
      },
    ],
  };
}

function fixture() {
  const sources = [source('existing')];
  const derived = [copper('existing')];
  const create = vi.fn(
    async (
      net: string,
      layer: number,
      polygon: { getSource: () => unknown },
      fillMethod: string,
      preserveSilos: boolean,
      pourName: string,
      pourPriority: number,
      lineWidth: number,
      locked: boolean,
    ) => {
      sources.push(
        source('created', {
          net,
          layer,
          polygonSignature: JSON.stringify(polygon.getSource()),
          fillMethod,
          preserveSilos,
          pourName,
          pourPriority,
          lineWidth,
          locked,
        }),
      );
      return sources[0]; // Native beta result can be stale.
    },
  );
  const rebuild = vi.fn(async () => {
    derived.push(copper('created'));
    return sources[0]; // Real native return can point to an old source.
  });
  const get = vi.fn(async (id: string) =>
    id === 'created' ? { getState_PrimitiveId: () => id, rebuildCopperRegion: rebuild } : undefined,
  );
  const save = vi.fn(async () => true);
  const del = vi.fn(async (ids: string[]) => {
    for (const id of ids) {
      const index = sources.findIndex((item) => item.getState_PrimitiveId() === id);
      if (index < 0) return false;
      sources.splice(index, 1);
    }
    return true;
  });
  const getAllSource = vi.fn(async () => [...sources]);
  const getAllPoured = vi.fn(async () => [...derived]);
  const api: Record<string, unknown> = {
    DMT_Project: { getCurrentProjectInfo: vi.fn(async () => ({ uuid: 'project-id' })) },
    DMT_SelectControl: {
      getCurrentDocumentInfo: vi.fn(async () => ({
        uuid: 'pcb-id',
        documentType: 3,
        parentProjectUuid: 'project-id',
      })),
    },
    SYS_Environment: { getEditorCurrentVersion: vi.fn(async () => '3.2.209') },
    PCB_Net: { getAllNetName: vi.fn(async () => ['GND']) },
    PCB_Layer: { getTheNumberOfCopperLayers: vi.fn(async () => 2) },
    PCB_PrimitivePolyline: { getAll: vi.fn(async () => [board]) },
    PCB_PrimitiveLine: { getAll: vi.fn(async () => []) },
    PCB_PrimitiveArc: { getAll: vi.fn(async () => []) },
    PCB_PrimitiveRegion: { getAll: vi.fn(async () => []) },
    PCB_PrimitivePour: {
      create,
      get,
      getAll: getAllSource,
      getAllPrimitiveId: vi.fn(async () => sources.map((item) => item.getState_PrimitiveId())),
      delete: del,
    },
    PCB_PrimitivePoured: { getAll: getAllPoured },
    PCB_Document: { save },
    PCB_MathPolygon: { createPolygon: vi.fn((input: unknown) => ({ getSource: () => input })) },
  };
  const fenceCells = new Map<string, string>();
  const getExtensionUserConfig = vi.fn((key: string): unknown => fenceCells.get(key));
  const setExtensionUserConfig = vi.fn(async (key: string, value: string) => {
    fenceCells.set(key, value);
    return true;
  });
  api.SYS_Storage = { getExtensionUserConfig, setExtensionUserConfig };
  let occupied = false;
  const lockManager = {
    request: vi.fn(
      async (
        _name: string,
        _options: { mode: string; ifAvailable: boolean },
        callback: (lock: { name: string } | null) => Promise<boolean>,
      ) => {
        if (occupied) return callback(null);
        occupied = true;
        try {
          return await callback({ name: 'easyeda-mcp-pro.native-zone-reservation.v1' });
        } finally {
          occupied = false;
        }
      },
    ),
  };
  const reader = <T>(paths: readonly string[]): T | undefined =>
    paths.map((path) => api[path]).find(Boolean) as T | undefined;
  const adapter = () =>
    createNativeZoneApiAdapter({
      readFirstPath: reader,
      readState: (item, key) => (item as Record<string, () => unknown>)?.['getState_' + key]?.(),
      lockManager,
    });
  return {
    api,
    adapter,
    create,
    rebuild,
    save,
    del,
    get,
    getAllSource,
    getAllPoured,
    sources,
    derived,
    getExtensionUserConfig,
    setExtensionUserConfig,
    lockManager,
  };
}

describe('real native API adapter for guarded zone candidate (not a public dispatcher route)', () => {
  it('creates true-filled copper, verifies actual source and saves through the real native API shape', async () => {
    const f = fixture();
    const result = await f.adapter().execute(expected);
    expect(result).toEqual({
      status: 'saved-readback',
      sourceId: 'created',
      pouredId: 'created',
      saveReturnedTrue: true,
      persistenceVerified: false,
    });
    expect(f.create).toHaveBeenCalledExactlyOnceWith(
      'GND',
      2,
      expect.objectContaining({ getSource: expect.any(Function) }),
      'solid',
      true,
      'Z480_ADAPTER',
      1,
      0.2,
      false,
    );
    expect(f.get).toHaveBeenCalledExactlyOnceWith('created');
    expect(f.rebuild).toHaveBeenCalledOnce();
    expect(f.save).toHaveBeenCalledOnce();
    expect(f.del).not.toHaveBeenCalled();
  });

  it('blocks an identical second write across freshly constructed adapters after save', async () => {
    const f = fixture();
    await expect(f.adapter().execute(expected)).resolves.toMatchObject({
      status: 'saved-readback',
      persistenceVerified: false,
    });
    await expect(
      f.adapter().execute({ ...expected, pourName: 'ANOTHER_ZONE' }),
    ).resolves.toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('reconciliation'),
    });
    expect(f.create).toHaveBeenCalledOnce();
  });

  it('never enters native creation when durable write-fence storage fails', async () => {
    const f = fixture();
    // Test adapter shall use mandatory, injected storage. The fixture supplies a denied store.
    f.getExtensionUserConfig.mockImplementationOnce(() => {
      throw Error('storage denied');
    });
    await expect(f.adapter().execute(expected)).resolves.toMatchObject({ status: 'blocked' });
    expect(f.create).not.toHaveBeenCalled();
  });

  it('requires a native extension storage capability before touching copper', async () => {
    const f = fixture();
    delete f.api.SYS_Storage;
    await expect(f.adapter().execute(expected)).resolves.toMatchObject({ status: 'blocked' });
    expect(f.create).not.toHaveBeenCalled();
  });

  it('rejects a native storage write that returns false before any Pour creation', async () => {
    const f = fixture();
    f.setExtensionUserConfig.mockResolvedValueOnce(false);
    await expect(f.adapter().execute(expected)).resolves.toMatchObject({ status: 'blocked' });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.setExtensionUserConfig).toHaveBeenCalledOnce();
  });

  it('refuses native creation when another tab already holds the exclusive lock', async () => {
    const f = fixture();
    f.lockManager.request.mockImplementationOnce(async (_name, _options, callback) =>
      callback(null),
    );
    await expect(f.adapter().execute(expected)).resolves.toMatchObject({ status: 'blocked' });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.setExtensionUserConfig).not.toHaveBeenCalled();
  });

  it('permits at most one creation across two concurrently reconstructed adapters', async () => {
    const f = fixture();
    const [a, b] = await Promise.all([
      f.adapter().execute(expected),
      f.adapter().execute({ ...expected, pourName: 'Z480_OTHER_NONRETRY' }),
    ]);
    expect([a.status, b.status]).toContain('blocked');
    expect([a.status, b.status].filter((status) => status === 'saved-readback')).toHaveLength(1);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.setExtensionUserConfig).toHaveBeenCalledOnce();
  });

  it('rolls back only the exact created source when native rebuild produces no associated copper', async () => {
    const f = fixture();
    f.rebuild.mockResolvedValue(undefined); // No new native Poured is generated.
    await expect(f.adapter().execute(expected)).resolves.toMatchObject({
      status: 'rollback-readback',
      sourceId: 'created',
      persistenceVerified: false,
    });
    expect(f.del).toHaveBeenCalledExactlyOnceWith(['created']);
    expect(f.sources.map((item) => item.getState_PrimitiveId())).toEqual(['existing']);
    expect(f.save).toHaveBeenCalledOnce();
  });

  it('does not claim persistence when native save returns false', async () => {
    const f = fixture();
    f.save.mockResolvedValue(false);
    await expect(f.adapter().execute(expected)).resolves.toMatchObject({ status: 'uncertain' });
    expect(f.save).toHaveBeenCalledOnce();
    expect(f.del).not.toHaveBeenCalled();
  });

  it('rejects a stale mismatched source returned by get() without rebuilding or saving', async () => {
    const f = fixture();
    f.get.mockResolvedValue({ getState_PrimitiveId: () => 'other-source' } as never);
    await expect(f.adapter().execute(expected)).resolves.toMatchObject({ status: 'uncertain' });
    expect(f.rebuild).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });

  it('blocks an identical source in fresh inventory before another creation', async () => {
    const f = fixture();
    f.sources.push(source('duplicate-existing', expected));
    f.derived.push(copper('duplicate-existing'));
    await expect(f.adapter().execute(expected)).resolves.toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('existing'),
    });
    expect(f.create).not.toHaveBeenCalled();
  });

  it('does not create when the native Poured preflight inventory is not an array', async () => {
    const f = fixture();
    f.getAllPoured.mockResolvedValue(null as never);
    await expect(f.adapter().execute(expected)).resolves.toMatchObject({ status: 'blocked' });
    expect(f.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      'unverified editor version',
      (f: ReturnType<typeof fixture>) => {
        f.api.SYS_Environment = { getEditorCurrentVersion: async () => '3.2.206' };
      },
    ],
    [
      'non-PCB document',
      (f: ReturnType<typeof fixture>) => {
        f.api.DMT_SelectControl = {
          getCurrentDocumentInfo: async () => ({
            uuid: 'schematic',
            documentType: 1,
            parentProjectUuid: 'project-id',
          }),
        };
      },
    ],
    [
      'net missing from selected PCB',
      (f: ReturnType<typeof fixture>) => {
        f.api.PCB_Net = { getAllNetName: async () => [] };
      },
    ],
    [
      'less than two copper layers',
      (f: ReturnType<typeof fixture>) => {
        f.api.PCB_Layer = { getTheNumberOfCopperLayers: async () => 1 };
      },
    ],
    [
      'native polygon class missing',
      (f: ReturnType<typeof fixture>) => {
        delete f.api.PCB_MathPolygon;
      },
    ],
    [
      'native deletion capability missing',
      (f: ReturnType<typeof fixture>) => {
        f.api.PCB_PrimitivePour = {
          ...(f.api.PCB_PrimitivePour as Record<string, unknown>),
          delete: undefined,
        };
      },
    ],
    [
      'unsupported board outline',
      (f: ReturnType<typeof fixture>) => {
        f.api.PCB_PrimitivePolyline = { getAll: async () => [] };
      },
    ],
  ])('blocks %s before any native create', async (_, change) => {
    const f = fixture();
    change(f);
    const result = await f.adapter().execute(expected);
    expect(result).toMatchObject({ status: 'blocked' });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.rebuild).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });

  it.each([
    ['coordinates beyond the native board', JSON.stringify(['R', 3100, -1200, 200, 80, 0, 0])],
    ['malformed polygon source', '{bad-json'],
    ['nonfinite rectangle', JSON.stringify(['R', 1400, -1200, -10, 80, 0, 0])],
    ['unverified rotated source', JSON.stringify(['R', 1400, -1200, 120, 80, 90, 0])],
  ])('rejects %s before create', async (_, polygonSignature) => {
    const f = fixture();
    const result = await f.adapter().execute({ ...expected, polygonSignature });
    expect(result).toMatchObject({ status: 'blocked' });
    expect(f.create).not.toHaveBeenCalled();
  });
});
