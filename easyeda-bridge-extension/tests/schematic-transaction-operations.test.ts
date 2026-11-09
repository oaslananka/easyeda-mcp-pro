import { describe, expect, it, vi } from 'vitest';
import { createSchematicTransactionOperations } from '../src/schematic-transaction-operations.js';

function bridgeError(code: string, message: string, suggestion: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, suggestion, data });
}

function readState(source: unknown, key: string): unknown {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  const getter = record[`getState_${key}`];
  if (typeof getter === 'function') return getter.call(source);
  if (typeof record.getState === 'function') {
    const value = record.getState.call(source) as Record<string, unknown> | undefined;
    if (value && key in value) return value[key];
  }
  const lower = key.charAt(0).toLowerCase() + key.slice(1);
  return record[key] ?? record[lower];
}

function scalarId(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const raw = record.primitiveId ?? record.uuid ?? readState(value, 'PrimitiveId');
  return typeof raw === 'string' ||
    typeof raw === 'number' ||
    typeof raw === 'boolean' ||
    typeof raw === 'bigint'
    ? String(raw)
    : '';
}

function createSubject(
  classes: Record<string, unknown> = {},
  overrides: Partial<Parameters<typeof createSchematicTransactionOperations>[0]> = {},
) {
  const textAlignCache = new Map<string, 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9>();
  const callFirst = vi.fn();
  const logRecoverableError = vi.fn();
  const operations = createSchematicTransactionOperations({
    callFirst,
    readFirstPath: (paths) => paths.map((path) => classes[path]).find(Boolean),
    readState,
    extractPrimitiveId: scalarId,
    readComponentType: (value) => String(readState(value, 'ComponentType') ?? '').toLowerCase(),
    readPinPoint: (value) => ({
      x: readState(value, 'X') as number | undefined,
      y: readState(value, 'Y') as number | undefined,
      rotation: readState(value, 'Rotation') as number | undefined,
    }),
    createBridgeError: bridgeError,
    logRecoverableError,
    asPublicTextAlignMode: (value) =>
      typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 9
        ? (value as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9)
        : undefined,
    requirePublicTextAlignMode: (value, field = 'alignMode') => {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 9) {
        throw bridgeError(
          'INVALID_PARAMS',
          `${field} must be an integer from 1 through 9`,
          'Use the documented ESCH_PrimitiveTextAlignMode values: LEFT_TOP=1 through RIGHT_BOTTOM=9.',
        );
      }
      return value as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
    },
    getCachedTextAlignMode: (primitiveId) => textAlignCache.get(primitiveId),
    setCachedTextAlignMode: (primitiveId, alignMode) => textAlignCache.set(primitiveId, alignMode),
    deleteCachedTextAlignMode: (primitiveId) => textAlignCache.delete(primitiveId),
    ...overrides,
  });
  return { operations, callFirst, logRecoverableError, textAlignCache };
}

describe('schematic transaction operations', () => {
  it('captures a scalar-safe component snapshot', async () => {
    const component = {
      getState_PrimitiveId: () => 'cmp-1',
      getState_ComponentType: () => 'component',
      getState_X: () => 10,
      getState_Y: () => 20,
      getState_Designator: () => 'U1',
      getState_OtherProperty: () => ({ value: 'MCU' }),
    };
    const { operations } = createSubject({
      SCH_PrimitiveComponent: { get: vi.fn().mockResolvedValue(component) },
    });

    await expect(operations.getPrimitiveSnapshot('cmp-1')).resolves.toMatchObject({
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'cmp-1',
      primitiveKind: 'component',
      property: { x: 10, y: 20, designator: 'U1', otherProperty: { value: 'MCU' } },
    });
  });

  it('rejects malformed restore input before mutation', async () => {
    const { operations, callFirst } = createSubject();

    await expect(
      operations.restorePrimitiveSnapshot({ schemaVersion: 'wrong' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'snapshot does not match schematic-primitive-snapshot/v1',
    });
    expect(callFirst).not.toHaveBeenCalled();
  });

  it('does not stringify object-valued primitive IDs', async () => {
    const { operations } = createSubject({
      SCH_PrimitiveWire: {
        getAll: vi.fn().mockResolvedValue([{ primitiveId: { unsafe: true } }]),
      },
    });

    await expect(operations.listPrimitiveIds('wire')).resolves.toEqual({
      primitiveKind: 'wire',
      primitiveIds: [],
    });
  });

  it('routes deletion to the owning class and reports missing IDs', async () => {
    const componentDelete = vi.fn().mockResolvedValue(true);
    const wireDelete = vi.fn().mockResolvedValue(true);
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn(async (id) => (id === 'cmp-1' ? { primitiveId: id } : undefined)),
        delete: componentDelete,
      },
      SCH_PrimitiveWire: {
        get: vi.fn(async (id) => (id === 'wire-1' ? { primitiveId: id } : undefined)),
        delete: wireDelete,
      },
    });

    await expect(operations.deletePrimitives(['cmp-1', 'wire-1', 'missing'])).resolves.toEqual({
      success: false,
      deleted: ['cmp-1', 'wire-1'],
      notFound: ['missing'],
    });
    expect(componentDelete).toHaveBeenCalledWith(['cmp-1']);
    expect(wireDelete).toHaveBeenCalledWith(['wire-1']);
  });

  it('rejects component recreation without a complete creation descriptor', async () => {
    const { operations } = createSubject();

    await expect(
      operations.recreatePrimitiveSnapshot({
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'cmp-1',
        primitiveKind: 'component',
        property: {},
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_RUNTIME' });
  });
  it.each([
    ['netflag', { x: 12 }],
    ['netflag', { y: 21 }],
    ['netflag', { rotation: 90 }],
    ['netflag', { mirror: true }],
    ['netport', { x: 12 }],
    ['netport', { y: 21 }],
    ['netport', { rotation: 90 }],
    ['netport', { mirror: true }],
  ] as const)(
    'rejects #945 %s connection-marker topology mutation %j before any setter or done',
    async (kind, property) => {
      const setX = vi.fn(),
        setY = vi.fn(),
        setRotation = vi.fn(),
        setMirror = vi.fn();
      const setNet = vi.fn(),
        done = vi.fn().mockResolvedValue(undefined);
      const modify = vi.fn();
      const { operations } = createSubject({
        SCH_PrimitiveComponent: {
          get: vi.fn().mockResolvedValue({
            getState_ComponentType: () => kind,
            getState_X: () => 10,
            getState_Y: () => 20,
            getState_Rotation: () => 0,
            getState_Mirror: () => false,
            setState_X: setX,
            setState_Y: setY,
            setState_Rotation: setRotation,
            setState_Mirror: setMirror,
            setState_Net: setNet,
            done,
          }),
          modify,
        },
      });
      await expect(operations.modifyPrimitive('marker-1', property)).rejects.toMatchObject({
        code: 'MOVE_CONNECTIVITY_UNVERIFIED',
      });
      for (const setter of [setX, setY, setRotation, setMirror, setNet, done, modify])
        expect(setter).not.toHaveBeenCalled();
    },
  );

  it('keeps intentional net-name updates allowed on an unmoved net flag', async () => {
    const setNet = vi.fn();
    const done = vi.fn().mockResolvedValue(undefined);
    const current = {
      getState_ComponentType: () => 'netflag',
      getState_X: () => 10,
      getState_Y: () => 20,
      getState_Rotation: () => 0,
      getState_Mirror: () => false,
      setState_Net: setNet,
      done,
    };
    const { operations } = createSubject({
      SCH_PrimitiveComponent: { get: vi.fn().mockResolvedValue(current), modify: vi.fn() },
    });

    await expect(operations.modifyPrimitive('flag-1', { net: 'GND' })).resolves.toEqual({
      primitiveId: 'flag-1',
      componentType: 'netflag',
      applied: { net: 'GND' },
    });
    expect(setNet).toHaveBeenCalledWith('GND');
    expect(done).toHaveBeenCalledOnce();
  });

  it('allows same-valued net-port positioning without changing electrical placement', async () => {
    const setX = vi.fn(),
      setY = vi.fn(),
      setRotation = vi.fn(),
      setMirror = vi.fn();
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'netport',
          getState_X: () => 10,
          getState_Y: () => 20,
          getState_Rotation: () => 0,
          getState_Mirror: () => false,
          setState_X: setX,
          setState_Y: setY,
          setState_Rotation: setRotation,
          setState_Mirror: setMirror,
        }),
        modify: vi.fn(),
      },
    });
    await expect(
      operations.modifyPrimitive('port-1', { x: 10, y: 20, rotation: 0, mirror: false }),
    ).resolves.toMatchObject({
      primitiveId: 'port-1',
      componentType: 'netport',
    });
    for (const setter of [setX, setY, setRotation, setMirror]) {
      expect(setter).not.toHaveBeenCalled();
    }
  });

  it('rejects missing native net-marker coordinates before a setter even when requested', async () => {
    const setter = vi.fn();
    const done = vi.fn();
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'netflag',
          setState_X: setter,
          done,
        }),
        modify: vi.fn(),
      },
    });
    await expect(operations.modifyPrimitive('flag-1', { x: 10 })).rejects.toMatchObject({
      code: 'MOVE_CONNECTIVITY_UNVERIFIED',
    });
    expect(setter).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it('continues to a class alias when an earlier snapshot getter throws', async () => {
    const failure = new Error('primary getter failed');
    const { operations, logRecoverableError } = createSubject({
      SCH_PrimitiveCircle: { get: vi.fn().mockRejectedValue(failure) },
      sch_PrimitiveCircle: {
        get: vi.fn().mockResolvedValue({
          getState_CenterX: () => 1,
          getState_CenterY: () => 2,
          getState_Radius: () => 3,
        }),
      },
    });

    await expect(operations.getPrimitiveSnapshot('circle-1', 'circle')).resolves.toMatchObject({
      primitiveKind: 'circle',
      property: { centerX: 1, centerY: 2, radius: 3 },
    });
    expect(logRecoverableError).toHaveBeenCalledWith(
      'SCH_PrimitiveCircle.get(circle-1) failed while creating snapshot',
      failure,
    );
  });

  it('captures polygon and net-flag/net-port snapshots by expected kind', async () => {
    const componentGet = vi.fn(async (id: string) => ({
      primitiveId: id,
      getState_ComponentType: () => (id === 'flag-1' ? 'netflag' : 'netport'),
      getState_X: () => 10,
      getState_Y: () => 20,
      getState_Net: () => 'VCC',
    }));
    const { operations } = createSubject({
      SCH_PrimitiveComponent: { get: componentGet },
      SCH_PrimitivePolygon: {
        get: vi.fn().mockResolvedValue({
          getState_Line: () => [0, 0, 5, 0, 5, 5],
          getState_Color: () => '#111111',
        }),
      },
    });

    await expect(operations.getPrimitiveSnapshot('flag-1', 'netflag')).resolves.toMatchObject({
      primitiveKind: 'netflag',
      property: { x: 10, y: 20, net: 'VCC' },
    });
    await expect(operations.getPrimitiveSnapshot('port-1', 'netport')).resolves.toMatchObject({
      primitiveKind: 'netport',
    });
    await expect(operations.getPrimitiveSnapshot('poly-1', 'polygon')).resolves.toMatchObject({
      primitiveKind: 'polygon',
      property: { line: [0, 0, 5, 0, 5, 5], color: '#111111' },
    });
  });

  it('rejects missing IDs and distinguishes expected-kind misses', async () => {
    const { operations } = createSubject();

    await expect(operations.getPrimitiveSnapshot('')).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'primitiveId is required',
    });
    await expect(operations.getPrimitiveSnapshot('missing', 'rectangle')).rejects.toMatchObject({
      code: 'PRIMITIVE_NOT_FOUND',
      message: 'Primitive missing was not found as expected kind rectangle',
    });
    await expect(operations.getPrimitiveSnapshot('missing')).rejects.toMatchObject({
      code: 'PRIMITIVE_NOT_FOUND',
      message: 'Primitive missing was not found in a transaction-safe schematic class',
    });
  });

  it('rejects a component snapshot when its runtime kind differs from the expected kind', async () => {
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({ getState_ComponentType: () => 'netflag' }),
      },
    });

    await expect(operations.getPrimitiveSnapshot('flag-1', 'component')).rejects.toMatchObject({
      code: 'PRIMITIVE_NOT_FOUND',
    });
  });

  it('uses persistent text inventory to validate a lossy public wrapper', async () => {
    const persistent = {
      primitiveId: 'text-1',
      x: 5,
      y: 6,
      content: 'persistent',
      color: '#222222',
    };
    const publicText = {
      getState_AlignMode: () => 4,
      getState_Content: () => undefined,
    };
    const { operations } = createSubject({
      SCH_PrimitiveText: {
        getAll: vi.fn().mockResolvedValue([persistent]),
        get: vi.fn().mockResolvedValue(publicText),
      },
    });

    await expect(operations.getPrimitiveSnapshot('text-1', 'text')).resolves.toMatchObject({
      primitiveKind: 'text',
      property: { x: 5, y: 6, content: 'persistent', color: '#222222', alignMode: 4 },
    });
  });

  it('rejects text rollback when an addressable text has no public alignment', async () => {
    const sameId = { primitiveId: 'text-1', content: 'hello' };
    const { operations } = createSubject({
      SCH_PrimitiveText: {
        getAll: vi.fn().mockResolvedValue([sameId]),
        get: vi.fn().mockResolvedValue(sameId),
      },
    });

    await expect(operations.getPrimitiveSnapshot('text-1', 'text')).rejects.toMatchObject({
      code: 'UNSUPPORTED_RUNTIME',
      message: 'Text text-1 did not expose a public alignMode',
    });
  });

  it('contains text read failures and ignores unrelated wrappers', async () => {
    const getError = new Error('get failed');
    const getAllError = new Error('getAll failed');
    const { operations, logRecoverableError } = createSubject({
      SCH_PrimitiveText: {
        getAll: vi.fn().mockRejectedValue(getAllError),
        get: vi.fn().mockRejectedValue(getError),
      },
      sch_PrimitiveText: {
        getAll: vi.fn().mockResolvedValue({ not: 'an array' }),
        get: vi.fn().mockResolvedValue({ primitiveId: 'other-id', getState_AlignMode: () => 3 }),
      },
    });

    await expect(operations.getPrimitiveSnapshot('text-1', 'text')).rejects.toMatchObject({
      code: 'PRIMITIVE_NOT_FOUND',
    });
    expect(logRecoverableError).toHaveBeenCalledWith(
      'SCH_PrimitiveText.getAll() failed while reading text fallback state',
      getAllError,
    );
    expect(logRecoverableError).toHaveBeenCalledWith(
      'SCH_PrimitiveText.get(text-1) failed while reading text',
      getError,
    );
  });

  it('rejects non-object snapshots and unsupported primitive kinds', async () => {
    const { operations } = createSubject();

    await expect(operations.restorePrimitiveSnapshot(null)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'snapshot must be an object',
    });
    await expect(operations.listPrimitiveIds('triangle')).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'Unsupported schematic primitive kind: triangle',
    });
  });

  it('returns an empty inventory when the requested primitive class is unavailable', async () => {
    const { operations } = createSubject();
    await expect(operations.listPrimitiveIds('circle')).resolves.toEqual({
      primitiveKind: 'circle',
      primitiveIds: [],
    });
  });

  it('falls back to getAllPrimitiveId after getAll fails and de-duplicates IDs', async () => {
    const listError = new Error('inventory failed');
    const { operations, logRecoverableError } = createSubject({
      SCH_PrimitiveRectangle: {
        getAll: vi.fn().mockRejectedValue(listError),
        getAllPrimitiveId: vi.fn().mockResolvedValue(['b', '', 'a', 'b', 3]),
      },
    });

    await expect(operations.listPrimitiveIds('rectangle')).resolves.toEqual({
      primitiveKind: 'rectangle',
      primitiveIds: ['a', 'b'],
    });
    expect(logRecoverableError).toHaveBeenCalledWith(
      'failed to list rectangle primitives',
      listError,
    );
  });

  it('contains getAllPrimitiveId failures and returns an empty inventory', async () => {
    const idError = new Error('id inventory failed');
    const { operations, logRecoverableError } = createSubject({
      SCH_PrimitiveCircle: { getAllPrimitiveId: vi.fn().mockRejectedValue(idError) },
    });

    await expect(operations.listPrimitiveIds('circle')).resolves.toEqual({
      primitiveKind: 'circle',
      primitiveIds: [],
    });
    expect(logRecoverableError).toHaveBeenCalledWith(
      'failed to list circle primitive IDs',
      idError,
    );
  });

  it('filters component, net-flag, and net-port inventories by runtime type', async () => {
    const values = [
      { primitiveId: 'component-1', getState_ComponentType: () => 'component' },
      { primitiveId: 'flag-1', getState_ComponentType: () => 'netflag' },
      { primitiveId: 'port-1', getState_ComponentType: () => 'netport' },
    ];
    const getAll = vi.fn().mockResolvedValue(values);
    const { operations } = createSubject({ SCH_PrimitiveComponent: { getAll } });

    await expect(operations.listPrimitiveIds('component')).resolves.toMatchObject({
      primitiveIds: ['component-1'],
    });
    await expect(operations.listPrimitiveIds('netflag')).resolves.toMatchObject({
      primitiveIds: ['flag-1'],
    });
    await expect(operations.listPrimitiveIds('netport')).resolves.toMatchObject({
      primitiveIds: ['port-1'],
    });
    expect(getAll).toHaveBeenCalledWith(undefined, true);
  });

  it('accepts scalar PrimitiveId fallback values but rejects objects', async () => {
    const values = [
      { PrimitiveId: 'string-id' },
      { PrimitiveId: 42 },
      { PrimitiveId: 9n },
      { PrimitiveId: { unsafe: true } },
    ];
    const { operations } = createSubject(
      { SCH_PrimitiveWire: { getAll: vi.fn().mockResolvedValue(values) } },
      { extractPrimitiveId: () => '' },
    );

    await expect(operations.listPrimitiveIds('wire')).resolves.toEqual({
      primitiveKind: 'wire',
      primitiveIds: ['42', '9', 'string-id'],
    });
  });

  it('handles non-array deletion input without touching native classes', async () => {
    const { operations } = createSubject();
    await expect(operations.deletePrimitives('wire-1')).resolves.toEqual({
      success: true,
      deleted: [],
      notFound: [],
    });
  });

  it('uses getAllPrimitiveId ownership fallback for deletion', async () => {
    const remove = vi.fn().mockResolvedValue(true);
    const { operations } = createSubject({
      SCH_PrimitiveRectangle: {
        getAllPrimitiveId: vi.fn().mockResolvedValue(['rect-1']),
        delete: remove,
      },
    });

    await expect(operations.deletePrimitives(['', 'rect-1', 7])).resolves.toEqual({
      success: true,
      deleted: ['rect-1'],
      notFound: [],
    });
    expect(remove).toHaveBeenCalledWith(['rect-1']);
  });

  it('treats ownership probe failures and missing probe APIs as not found', async () => {
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockRejectedValue(new Error('get failed')),
        delete: vi.fn(),
      },
      SCH_PrimitiveWire: {
        getAllPrimitiveId: vi.fn().mockRejectedValue(new Error('ids failed')),
        delete: vi.fn(),
      },
      SCH_PrimitiveText: { delete: vi.fn() },
    });

    await expect(operations.deletePrimitives(['missing'])).resolves.toEqual({
      success: false,
      deleted: [],
      notFound: ['missing'],
    });
  });
  it('recreates text, rectangle, circle, and polygon snapshots with exact explicit arguments', async () => {
    const text = {
      primitiveId: 'text-new',
      getState_AlignMode: () => 7,
      getState_X: () => 1,
      getState_Y: () => -2,
      getState_Content: () => 'note',
    };
    const classes = {
      SCH_PrimitiveText: {
        getAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue(text),
      },
      SCH_PrimitiveRectangle: {
        getAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue({
          getState_TopLeftX: () => 3,
          getState_TopLeftY: () => -4,
          getState_Width: () => 5,
          getState_Height: () => 6,
        }),
      },
      SCH_PrimitiveCircle: {
        getAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue({
          getState_CenterX: () => 7,
          getState_CenterY: () => 8,
          getState_Radius: () => 9,
        }),
      },
      SCH_PrimitivePolygon: {
        getAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue({ getState_Line: () => [0, 0, 1, 1] }),
      },
    };
    const { operations, callFirst } = createSubject(classes);
    callFirst.mockImplementation(async (paths: string[]) => {
      if (paths[0].includes('Text')) return { primitiveId: 'text-new' };
      if (paths[0].includes('Rectangle')) return { primitiveId: 'rect-new' };
      if (paths[0].includes('Circle')) return { primitiveId: 'circle-new' };
      return { primitiveId: 'poly-new' };
    });

    await operations.recreatePrimitiveSnapshot({
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'text-old',
      primitiveKind: 'text',
      property: {
        x: 1,
        y: 2,
        content: 'note',
        rotation: 90,
        color: '#123456',
        fontName: 'Inter',
        fontSize: 12,
        bold: true,
        italic: true,
        underline: true,
        alignMode: 7,
      },
    });
    await operations.recreatePrimitiveSnapshot({
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'rect-old',
      primitiveKind: 'rectangle',
      property: {
        x: 3,
        y: 4,
        width: 5,
        height: 6,
        cornerRadius: 1,
        rotation: 45,
        color: '#111111',
        fillColor: '#222222',
        lineWidth: 2,
        lineType: 3,
        fillStyle: 'solid',
      },
    });
    await operations.recreatePrimitiveSnapshot({
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'circle-old',
      primitiveKind: 'circle',
      property: {
        centerX: 7,
        centerY: 8,
        radius: 9,
        color: '#333333',
        fillColor: '#444444',
        lineWidth: 2,
        lineType: 4,
        fillStyle: 'solid',
      },
    });
    await operations.recreatePrimitiveSnapshot({
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'poly-old',
      primitiveKind: 'polygon',
      property: {
        line: [0, 0, 1, 1],
        color: '#555555',
        fillColor: '#666666',
        lineWidth: 3,
        lineType: 5,
      },
    });

    expect(callFirst).toHaveBeenNthCalledWith(
      1,
      ['SCH_PrimitiveText.create', 'sch_PrimitiveText.create'],
      1,
      -2,
      'note',
      90,
      '#123456',
      'Inter',
      12,
      true,
      true,
      true,
      7,
    );
    expect(callFirst).toHaveBeenNthCalledWith(
      2,
      ['SCH_PrimitiveRectangle.create', 'sch_PrimitiveRectangle.create'],
      3,
      -4,
      5,
      6,
      1,
      45,
      '#111111',
      '#222222',
      2,
      3,
      'solid',
    );
    expect(callFirst).toHaveBeenNthCalledWith(
      3,
      ['SCH_PrimitiveCircle.create', 'sch_PrimitiveCircle.create'],
      7,
      8,
      9,
      '#333333',
      '#444444',
      2,
      4,
      'solid',
    );
    expect(callFirst).toHaveBeenNthCalledWith(
      4,
      ['SCH_PrimitivePolygon.create', 'sch_PrimitivePolygon.create'],
      [0, 0, 1, 1],
      '#555555',
      '#666666',
      3,
      5,
    );
  });

  it('uses recreation defaults for rectangle, circle, and polygon optional fields', async () => {
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveRectangle: {
        getAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue({
          getState_TopLeftX: () => 1,
          getState_TopLeftY: () => -2,
          getState_Width: () => 3,
          getState_Height: () => 4,
        }),
      },
      SCH_PrimitiveCircle: {
        getAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue({
          getState_CenterX: () => 1,
          getState_CenterY: () => 2,
          getState_Radius: () => 3,
        }),
      },
      SCH_PrimitivePolygon: {
        getAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue({ getState_Line: () => [0, 0, 1, 1] }),
      },
    });
    callFirst
      .mockResolvedValueOnce({ primitiveId: 'rect-new' })
      .mockResolvedValueOnce({ primitiveId: 'circle-new' })
      .mockResolvedValueOnce({ primitiveId: 'poly-new' });

    await operations.recreatePrimitiveSnapshot({
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'rect-old',
      primitiveKind: 'rectangle',
      property: { x: 1, y: 2, width: 3, height: 4 },
    });
    await operations.recreatePrimitiveSnapshot({
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'circle-old',
      primitiveKind: 'circle',
      property: { centerX: 1, centerY: 2, radius: 3 },
    });
    await operations.recreatePrimitiveSnapshot({
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'poly-old',
      primitiveKind: 'polygon',
      property: { line: [0, 0, 1, 1] },
    });

    expect(callFirst.mock.calls[0].slice(5)).toEqual([0, 0, '#000000', 'none', 1, 0, 'none']);
    expect(callFirst.mock.calls[1].slice(4)).toEqual(['#000000', 'none', 1, 0, 'none']);
    expect(callFirst.mock.calls[2].slice(1)).toEqual([[0, 0, 1, 1], '#000000', 'none', 1, 0]);
  });

  it('rejects non-finite required recreation coordinates', async () => {
    const { operations } = createSubject({
      SCH_PrimitiveCircle: { getAll: vi.fn().mockResolvedValue([]) },
    });

    await expect(
      operations.recreatePrimitiveSnapshot({
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'circle-old',
        primitiveKind: 'circle',
        property: { centerX: Number.NaN, centerY: 2, radius: 3 },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'Snapshot property centerX must be a finite number',
    });
  });

  it.each(['netflag', 'netport'] as const)(
    'rejects %s recreation because no complete creation descriptor exists',
    async (primitiveKind) => {
      const { operations } = createSubject({
        SCH_PrimitiveComponent: { getAll: vi.fn().mockResolvedValue([]) },
      });
      await expect(
        operations.recreatePrimitiveSnapshot({
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'old',
          primitiveKind,
          property: {},
        }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_RUNTIME' });
    },
  );

  it('recovers a recreated ID from an exact one-item inventory diff', async () => {
    const getAll = vi
      .fn()
      .mockResolvedValueOnce([{ primitiveId: 'before' }])
      .mockResolvedValueOnce([{ primitiveId: 'before' }, { primitiveId: 'after' }]);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveWire: {
        getAll,
        get: vi.fn().mockResolvedValue({
          primitiveId: 'after',
          getState_Line: () => [0, 0, 10, 0],
        }),
      },
    });
    callFirst.mockResolvedValue({});

    await expect(
      operations.recreatePrimitiveSnapshot({
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'old',
        primitiveKind: 'wire',
        property: { line: [0, 0, 10, 0], net: 'GND' },
      }),
    ).resolves.toMatchObject({ primitiveId: 'after' });
  });

  it('rejects an unconfirmed recreation when inventory diff is ambiguous', async () => {
    const getAll = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ primitiveId: 'a' }, { primitiveId: 'b' }]);
    const { operations, callFirst } = createSubject({ SCH_PrimitiveWire: { getAll } });
    callFirst.mockResolvedValue({});

    await expect(
      operations.recreatePrimitiveSnapshot({
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'old',
        primitiveKind: 'wire',
        property: { line: [0, 0, 10, 0] },
      }),
    ).rejects.toMatchObject({ code: 'CREATE_UNCONFIRMED' });
  });
  it('captures a wire snapshot through an expected-kind lookup', async () => {
    const { operations } = createSubject({
      SCH_PrimitiveWire: {
        get: vi.fn().mockResolvedValue({
          getState_Line: () => [0, 0, 5, 0],
          getState_Net: () => 'GND',
        }),
      },
    });
    await expect(operations.getPrimitiveSnapshot('wire-1', 'wire')).resolves.toMatchObject({
      primitiveKind: 'wire',
      property: { line: [0, 0, 5, 0], net: 'GND' },
    });
  });

  it('merges component state and contains a failed pin-coordinate read', async () => {
    const pinFailure = new Error('pins unavailable');
    const modify = vi.fn().mockResolvedValue({ ok: true });
    const current = {
      getState_ComponentType: () => 'component',
      getState_X: () => 1,
      getState_Y: () => 2,
      getState_OtherProperty: () => ({ existing: 'yes' }),
      getState_Designator: () => 'U1',
    };
    const { operations, callFirst, logRecoverableError } = createSubject({
      SCH_PrimitiveComponent: { get: vi.fn().mockResolvedValue(current), modify },
    });
    callFirst.mockRejectedValue(pinFailure);

    await expect(
      operations.modifyPrimitive('cmp-1', {
        x: 10,
        otherProperty: { incoming: 'yes' },
      }),
    ).rejects.toMatchObject({ code: 'MOVE_CONNECTIVITY_UNVERIFIED' });
    expect(modify).not.toHaveBeenCalled();
    expect(logRecoverableError).toHaveBeenCalledWith('failed to read pins for cmp-1', pinFailure);
  });

  it('rejects malformed native pin or wire inventory before writing', async () => {
    const modifyComponent = vi.fn().mockResolvedValue({ moved: true });
    const modifyWire = vi.fn().mockResolvedValue(true);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 0,
          getState_Y: () => 0,
        }),
        modify: modifyComponent,
      },
      SCH_PrimitiveWire: {
        getAll: vi.fn().mockResolvedValue([{ primitiveId: 'bad', line: [1, 2, 'malformed'] }]),
        modify: modifyWire,
      },
    });
    callFirst.mockResolvedValue([{ getState_X: () => 1, getState_Y: () => 2 }]);
    await expect(operations.modifyPrimitive('cmp-1', { x: 10, y: 20 })).rejects.toMatchObject({
      code: 'MOVE_CONNECTIVITY_UNVERIFIED',
    });
    expect(modifyComponent).not.toHaveBeenCalled();
    expect(modifyWire).not.toHaveBeenCalled();
  });

  it('returns a successful component move when no usable wire class exists', async () => {
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 1,
          getState_Y: () => 2,
        }),
        modify: vi.fn().mockResolvedValue(true),
      },
      SCH_PrimitiveWire: { getAll: vi.fn() },
    });
    callFirst.mockResolvedValue([{ getState_X: () => 1, getState_Y: () => 2 }]);

    await expect(operations.modifyPrimitive('cmp-1', { x: 2 })).rejects.toMatchObject({
      code: 'MOVE_CONNECTIVITY_UNVERIFIED',
    });
  });

  it('contains wire inventory failures during component following', async () => {
    const wireReadFailure = new Error('wire inventory failed');
    const { operations, callFirst, logRecoverableError } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 1,
          getState_Y: () => 2,
        }),
        modify: vi.fn().mockResolvedValue(true),
      },
      SCH_PrimitiveWire: {
        getAll: vi.fn().mockRejectedValue(wireReadFailure),
        modify: vi.fn(),
      },
    });
    callFirst.mockResolvedValue([{ getState_X: () => 1, getState_Y: () => 2 }]);

    await expect(operations.modifyPrimitive('cmp-1', { y: 3 })).rejects.toMatchObject({
      code: 'MOVE_CONNECTIVITY_UNVERIFIED',
    });
    expect(logRecoverableError).toHaveBeenCalledWith(
      'failed to preflight wires before a component move',
      wireReadFailure,
    );
  });

  it.each([
    ['horizontal', { x: 500, y: 400 }],
    ['vertical', { x: 300, y: 300 }],
  ])('blocks #945 %s move of a 2-pin resistor attached to different nets', async (_axis, next) => {
    const componentModify = vi.fn(async () => true);
    const wireModify = vi.fn(async () => true);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 300,
          getState_Y: () => 400,
        }),
        modify: componentModify,
      },
      SCH_PrimitiveWire: {
        getAll: vi.fn().mockResolvedValue([
          { primitiveId: 'stub-a', line: [250, 400, 280, 400], net: 'REPRO_A' },
          { primitiveId: 'stub-b', line: [350, 400, 320, 400], net: 'REPRO_B' },
        ]),
        modify: wireModify,
      },
    });
    callFirst.mockResolvedValue([
      { getState_X: () => 280, getState_Y: () => 400 },
      { getState_X: () => 320, getState_Y: () => 400 },
    ]);
    await expect(operations.modifyPrimitive('R19', next)).rejects.toMatchObject({
      code: 'CONNECTED_COMPONENT_MOVE_UNSAFE',
    });
    expect(componentModify).not.toHaveBeenCalled();
    expect(wireModify).not.toHaveBeenCalled();
  });

  it('allows an isolated component move after complete native pin and unrelated wire read', async () => {
    const componentModify = vi.fn(async () => true);
    const wireModify = vi.fn(async () => true);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 300,
          getState_Y: () => 400,
        }),
        modify: componentModify,
      },
      SCH_PrimitiveWire: {
        getAll: vi.fn().mockResolvedValue([
          {
            primitiveId: 'unrelated',
            line: [
              [900, 900],
              [1000, 1000],
            ],
            net: 'OTHER',
          },
        ]),
        modify: wireModify,
      },
    });
    callFirst.mockResolvedValue([
      { getState_X: () => 280, getState_Y: () => 400 },
      { getState_X: () => 320, getState_Y: () => 400 },
    ]);
    await expect(operations.modifyPrimitive('R19', { x: 500, y: 400 })).resolves.toMatchObject({
      followedWireIds: [],
      wireFollowFailures: [],
    });
    expect(componentModify).toHaveBeenCalledOnce();
    expect(wireModify).not.toHaveBeenCalled();
  });

  it('refuses an unwired move that would place a pin on another net endpoint', async () => {
    const componentModify = vi.fn(async () => true);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({ getState_X: () => 0, getState_Y: () => 0 }),
        modify: componentModify,
      },
      SCH_PrimitiveWire: {
        getAll: vi
          .fn()
          .mockResolvedValue([{ primitiveId: 'other-net', line: [100, 100, 110, 100] }]),
      },
    });
    callFirst.mockResolvedValue([{ getState_X: () => 0, getState_Y: () => 0 }]);
    await expect(operations.modifyPrimitive('cmp', { x: 100, y: 100 })).rejects.toMatchObject({
      code: 'CONNECTED_COMPONENT_MOVE_UNSAFE',
    });
    expect(componentModify).not.toHaveBeenCalled();
  });

  it.each([
    ['source interior', [250, 400, 330, 400], { x: 500, y: 400 }, 280, 400],
    ['destination interior', [450, 400, 530, 400], { x: 500, y: 400 }, 280, 400],
    ['diagonal interior', [250, 370, 310, 430], { x: 500, y: 400 }, 280, 400],
    [
      'polyline interior',
      [
        [100, 100],
        [250, 400],
        [330, 400],
      ],
      { x: 500, y: 400 },
      280,
      400,
    ],
    ['near-contact', [250, 400.0003, 330, 400.0003], { x: 500, y: 400 }, 280, 400],
    ['degenerate wire', [250, 400, 250, 400], { x: 500, y: 400 }, 280, 400],
  ])(
    'refuses #945 move when a pin touches a wire segment at %s',
    async (_scenario, line, next, pinX, pinY) => {
      const componentModify = vi.fn(async () => true);
      const wireModify = vi.fn(async () => true);
      const { operations, callFirst } = createSubject({
        SCH_PrimitiveComponent: {
          get: vi.fn().mockResolvedValue({
            getState_ComponentType: () => 'component',
            getState_X: () => 300,
            getState_Y: () => 400,
          }),
          modify: componentModify,
        },
        SCH_PrimitiveWire: {
          getAll: vi.fn().mockResolvedValue([{ primitiveId: 'mid-segment-net', line }]),
          modify: wireModify,
        },
      });
      callFirst.mockResolvedValue([{ getState_X: () => pinX, getState_Y: () => pinY }]);
      await expect(operations.modifyPrimitive('cmp', next)).rejects.toMatchObject({
        code: 'CONNECTED_COMPONENT_MOVE_UNSAFE',
      });
      expect(componentModify).not.toHaveBeenCalled();
      expect(wireModify).not.toHaveBeenCalled();
    },
  );

  it('permits an unwired move when a pin lies near but outside the wire span', async () => {
    const componentModify = vi.fn(async () => true);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({ getState_X: () => 0, getState_Y: () => 0 }),
        modify: componentModify,
      },
      SCH_PrimitiveWire: {
        getAll: vi
          .fn()
          .mockResolvedValue([{ primitiveId: 'bystander', line: [100, 100, 120, 100] }]),
      },
    });
    callFirst.mockResolvedValue([{ getState_X: () => 130, getState_Y: () => 100 }]);
    await expect(operations.modifyPrimitive('cmp', { x: 5, y: 0 })).resolves.toMatchObject({
      followedWireIds: [],
      wireFollowFailures: [],
    });
    expect(componentModify).toHaveBeenCalledOnce();
  });

  it.each([
    ['rotation', { rotation: 90 }],
    ['mirroring', { mirror: true }],
  ])('refuses #945 unverified component %s without writing', async (_case, property) => {
    const componentModify = vi.fn(async () => true);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 300,
          getState_Y: () => 400,
          getState_Rotation: () => 0,
          getState_Mirror: () => false,
        }),
        modify: componentModify,
      },
      SCH_PrimitiveWire: { getAll: vi.fn().mockResolvedValue([]) },
    });
    await expect(operations.modifyPrimitive('cmp', property)).rejects.toMatchObject({
      code: 'MOVE_CONNECTIVITY_UNVERIFIED',
    });
    expect(callFirst).not.toHaveBeenCalled();
    expect(componentModify).not.toHaveBeenCalled();
  });

  it.each([
    ['rotation', { rotation: 0 }],
    ['mirroring', { mirror: false }],
  ])('permits #945 unchanged component %s metadata', async (_case, property) => {
    const componentModify = vi.fn(async () => true);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 300,
          getState_Y: () => 400,
          getState_Rotation: () => 0,
          getState_Mirror: () => false,
        }),
        modify: componentModify,
      },
    });
    await expect(operations.modifyPrimitive('cmp', property)).resolves.toMatchObject({
      followedWireIds: [],
      wireFollowFailures: [],
    });
    expect(callFirst).not.toHaveBeenCalled();
    expect(componentModify).toHaveBeenCalledOnce();
  });

  it('does not require pin/wire inventory for a same-coordinate property edit', async () => {
    const componentModify = vi.fn(async () => true);
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({ getState_X: () => 100, getState_Y: () => 200 }),
        modify: componentModify,
      },
    });
    await expect(operations.modifyPrimitive('cmp', { x: 100 })).resolves.toMatchObject({
      followedWireIds: [],
      wireFollowFailures: [],
    });
    expect(callFirst).not.toHaveBeenCalled();
    expect(componentModify).toHaveBeenCalledOnce();
  });

  it('modifies wire state through the owning class', async () => {
    const modify = vi.fn().mockResolvedValue({ ok: true });
    const { operations } = createSubject({
      SCH_PrimitiveWire: {
        get: vi.fn().mockResolvedValue({
          getState_Line: () => [0, 0, 1, 1],
          getState_Net: () => 'OLD',
          getState_Color: () => '#000',
          getState_LineWidth: () => 1,
          getState_LineType: () => 0,
        }),
        modify,
      },
    });

    await expect(operations.modifyPrimitive('wire-1', { net: 'NEW' })).resolves.toEqual({
      ok: true,
    });
    expect(modify).toHaveBeenCalledWith('wire-1', {
      line: [0, 0, 1, 1],
      net: 'NEW',
      color: '#000',
      lineWidth: 1,
      lineType: 0,
    });
  });

  it.each([
    ['rotate', { rotation: 90 }],
    ['mirror', { mirror: true }],
  ])(
    'refuses #945 untyped %s when component identity cannot be verified',
    async (_action, property) => {
      const nativeModify = vi.fn(async () => true);
      const { operations, callFirst } = createSubject({
        SCH_PrimitiveComponent: {
          get: vi.fn().mockResolvedValue(undefined),
          modify: nativeModify,
        },
      });
      callFirst.mockResolvedValue({ fallback: true });

      await expect(operations.modifyPrimitive('cmp-1', property)).rejects.toMatchObject({
        code: 'MOVE_CONNECTIVITY_UNVERIFIED',
      });
      expect(callFirst).not.toHaveBeenCalled();
      expect(nativeModify).not.toHaveBeenCalled();
    },
  );

  it.each(['missing', 'throwing'])(
    'refuses a component coordinate update when the native owner getter is %s',
    async (condition) => {
      const componentModify = vi.fn();
      const { operations, callFirst } = createSubject({
        SCH_PrimitiveComponent: {
          get:
            condition === 'missing'
              ? vi.fn().mockResolvedValue(undefined)
              : vi.fn().mockRejectedValue(new Error('native getter unavailable')),
          modify: componentModify,
        },
      });
      callFirst.mockResolvedValue({ fallback: true });

      await expect(operations.modifyPrimitive('cmp-1', { x: 500, y: 400 })).rejects.toMatchObject({
        code: 'MOVE_CONNECTIVITY_UNVERIFIED',
      });
      expect(componentModify).not.toHaveBeenCalled();
      expect(callFirst).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['x NaN', { x: Number.NaN }],
    ['x infinity', { x: Number.POSITIVE_INFINITY }],
    ['y negative infinity', { y: Number.NEGATIVE_INFINITY }],
    ['x string', { x: '100' }],
    ['y null', { y: null }],
  ])(
    'refuses #945 invalid target coordinate %s before native mutation',
    async (_case, property) => {
      const componentModify = vi.fn(async () => true);
      const { operations, callFirst } = createSubject({
        SCH_PrimitiveComponent: {
          get: vi.fn().mockResolvedValue({
            getState_ComponentType: () => 'component',
            getState_X: () => 300,
            getState_Y: () => 400,
          }),
          modify: componentModify,
        },
      });
      await expect(operations.modifyPrimitive('cmp', property)).rejects.toMatchObject({
        code: 'MOVE_CONNECTIVITY_UNVERIFIED',
      });
      expect(callFirst).not.toHaveBeenCalled();
      expect(componentModify).not.toHaveBeenCalled();
    },
  );

  it('refuses a coordinate change when a component lacks verified original coordinates', async () => {
    const componentModify = vi.fn();
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 300,
        }),
        modify: componentModify,
      },
    });
    await expect(operations.modifyPrimitive('cmp-1', { x: 500 })).rejects.toMatchObject({
      code: 'MOVE_CONNECTIVITY_UNVERIFIED',
    });
    expect(componentModify).not.toHaveBeenCalled();
    expect(callFirst).not.toHaveBeenCalled();
  });

  it('contains owner getter failures and reaches the generic modify fallback', async () => {
    const componentFailure = new Error('component get failed');
    const wireFailure = new Error('wire get failed');
    const circleFailure = new Error('circle get failed');
    const polygonFailure = new Error('polygon get failed');
    const { operations, callFirst, logRecoverableError } = createSubject({
      SCH_PrimitiveComponent: { get: vi.fn().mockRejectedValue(componentFailure), modify: vi.fn() },
      SCH_PrimitiveWire: { get: vi.fn().mockRejectedValue(wireFailure), modify: vi.fn() },
      SCH_PrimitiveCircle: { get: vi.fn().mockRejectedValue(circleFailure), modify: vi.fn() },
      SCH_PrimitivePolygon: { get: vi.fn().mockRejectedValue(polygonFailure), modify: vi.fn() },
    });
    callFirst.mockResolvedValue({ fallback: true });

    await expect(operations.modifyPrimitive('unknown', { value: 1 })).resolves.toEqual({
      fallback: true,
    });
    expect(callFirst).toHaveBeenCalledWith(
      [
        'SCH_PrimitiveComponent.modify',
        'SCH_PrimitiveWire.modify',
        'sch_PrimitiveComponent.modify',
        'sch_PrimitiveWire.modify',
      ],
      'unknown',
      { value: 1 },
    );
    expect(logRecoverableError).toHaveBeenCalledWith(
      'SCH_PrimitiveComponent.get(unknown) failed',
      componentFailure,
    );
    expect(logRecoverableError).toHaveBeenCalledWith(
      'SCH_PrimitiveWire.get(unknown) failed',
      wireFailure,
    );
    expect(logRecoverableError).toHaveBeenCalledWith(
      'SCH_PrimitiveCircle.get(unknown) failed',
      circleFailure,
    );
    expect(logRecoverableError).toHaveBeenCalledWith(
      'SCH_PrimitivePolygon.get(unknown) failed',
      polygonFailure,
    );
  });

  it('rejects text modification when neither public nor cached alignment is available', async () => {
    const sameId = { primitiveId: 'text-1', content: 'hello' };
    const { operations } = createSubject({
      SCH_PrimitiveText: {
        getAll: vi.fn().mockResolvedValue([sameId]),
        get: vi.fn().mockResolvedValue(sameId),
        modify: vi.fn(),
      },
    });

    await expect(operations.modifyPrimitive('text-1', { content: 'new' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_RUNTIME',
      message: 'Text text-1 did not expose a public alignMode',
    });
  });

  it('normalizes text aliases and uses cached alignment when public get is lossy', async () => {
    const persistent = { primitiveId: 'text-1', content: 'old', color: '#000' };
    const modify = vi.fn().mockResolvedValue({ getState_AlignMode: () => 8 });
    const { operations, textAlignCache } = createSubject({
      SCH_PrimitiveText: {
        getAll: vi.fn().mockResolvedValue([persistent]),
        get: vi.fn().mockResolvedValue({}),
        modify,
      },
    });
    textAlignCache.set('text-1', 3);

    await operations.modifyPrimitive('text-1', {
      content: 'new',
      color: '#fff',
      underline: true,
    });
    expect(modify).toHaveBeenCalledWith(
      'text-1',
      expect.objectContaining({
        content: 'new',
        textColor: '#fff',
        underLine: true,
        alignMode: 3,
      }),
    );
    expect(textAlignCache.get('text-1')).toBe(8);
  });

  it('uses requested text alignment and preserves it when modify returns no public alignment', async () => {
    const persistent = { primitiveId: 'text-1', content: 'old', color: '#000' };
    const modify = vi.fn().mockResolvedValue({});
    const { operations, textAlignCache } = createSubject({
      SCH_PrimitiveText: {
        getAll: vi.fn().mockResolvedValue([persistent]),
        get: vi.fn().mockResolvedValue({ primitiveId: 'text-1' }),
        modify,
      },
    });

    await operations.modifyPrimitive('text-1', { content: 'new', alignMode: 6 });
    expect(textAlignCache.get('text-1')).toBe(6);
  });
  it('reads text through persistent inventory only when cached alignment is known', async () => {
    const persistent = { primitiveId: 'text-1', x: 1, y: 2, content: 'cached' };
    const { operations, textAlignCache } = createSubject({
      SCH_PrimitiveText: { getAll: vi.fn().mockResolvedValue([persistent]) },
    });
    textAlignCache.set('text-1', 5);

    await expect(operations.getPrimitiveSnapshot('text-1', 'text')).resolves.toMatchObject({
      primitiveKind: 'text',
      property: { content: 'cached', alignMode: 5 },
    });
  });

  it('handles null text inventories without inventing a candidate', async () => {
    const { operations } = createSubject({
      SCH_PrimitiveText: {
        getAll: vi.fn().mockResolvedValue(null),
        get: vi.fn().mockResolvedValue(undefined),
      },
    });
    await expect(operations.getPrimitiveSnapshot('text-1', 'text')).rejects.toMatchObject({
      code: 'PRIMITIVE_NOT_FOUND',
    });
  });

  it('uses an empty otherProperty object when a component exposes none', async () => {
    const { operations } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 1,
          getState_Y: () => 2,
        }),
      },
    });
    await expect(operations.getPrimitiveSnapshot('cmp-1')).resolves.toMatchObject({
      property: { otherProperty: {} },
    });
  });

  it('falls back from TopLeft coordinates to X/Y in rectangle snapshots', async () => {
    const { operations } = createSubject({
      SCH_PrimitiveRectangle: {
        get: vi.fn().mockResolvedValue({
          getState_X: () => 11,
          getState_Y: () => 12,
          getState_Width: () => 3,
          getState_Height: () => 4,
        }),
      },
    });
    await expect(operations.getPrimitiveSnapshot('rect-1', 'rectangle')).resolves.toMatchObject({
      property: { x: 11, y: 12, width: 3, height: 4 },
    });
  });

  it('finds unconstrained circle and polygon snapshots after earlier classes miss', async () => {
    const circleSubject = createSubject({
      SCH_PrimitiveCircle: {
        get: vi.fn().mockResolvedValue({
          getState_CenterX: () => 1,
          getState_CenterY: () => 2,
          getState_Radius: () => 3,
        }),
      },
    });
    await expect(circleSubject.operations.getPrimitiveSnapshot('shape-1')).resolves.toMatchObject({
      primitiveKind: 'circle',
    });

    const polygonSubject = createSubject({
      SCH_PrimitivePolygon: {
        get: vi.fn().mockResolvedValue({ getState_Line: () => [0, 0, 1, 1] }),
      },
    });
    await expect(polygonSubject.operations.getPrimitiveSnapshot('shape-2')).resolves.toMatchObject({
      primitiveKind: 'polygon',
    });
  });

  it('throws the text alignment error after all unconstrained shape fallbacks miss', async () => {
    const sameId = { primitiveId: 'text-1', content: 'hello' };
    const { operations } = createSubject({
      SCH_PrimitiveText: {
        getAll: vi.fn().mockResolvedValue([sameId]),
        get: vi.fn().mockResolvedValue(sameId),
      },
    });
    await expect(operations.getPrimitiveSnapshot('text-1')).rejects.toMatchObject({
      code: 'UNSUPPORTED_RUNTIME',
    });
  });

  it('normalizes null component and wire inventories to empty lists', async () => {
    const componentSubject = createSubject({
      SCH_PrimitiveComponent: { getAll: vi.fn().mockResolvedValue(null) },
    });
    await expect(componentSubject.operations.listPrimitiveIds('component')).resolves.toMatchObject({
      primitiveIds: [],
    });

    const wireSubject = createSubject({
      SCH_PrimitiveWire: { getAll: vi.fn().mockResolvedValue(null) },
    });
    await expect(wireSubject.operations.listPrimitiveIds('wire')).resolves.toMatchObject({
      primitiveIds: [],
    });
  });

  it('normalizes null ID inventories in listing and ownership checks', async () => {
    const listSubject = createSubject({
      SCH_PrimitiveCircle: { getAllPrimitiveId: vi.fn().mockResolvedValue(null) },
    });
    await expect(listSubject.operations.listPrimitiveIds('circle')).resolves.toMatchObject({
      primitiveIds: [],
    });

    const deleteSubject = createSubject({
      SCH_PrimitiveRectangle: {
        getAllPrimitiveId: vi.fn().mockResolvedValue(null),
        delete: vi.fn(),
      },
    });
    await expect(deleteSubject.operations.deletePrimitives(['missing'])).resolves.toMatchObject({
      notFound: ['missing'],
    });
  });

  it('rejects non-array pin inventories before moving a component', async () => {
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 1,
          getState_Y: () => 2,
        }),
        modify: vi.fn().mockResolvedValue(true),
      },
    });
    callFirst.mockResolvedValue({ not: 'pins' });
    await expect(operations.modifyPrimitive('cmp-1', { x: 2 })).rejects.toMatchObject({
      code: 'MOVE_CONNECTIVITY_UNVERIFIED',
    });
  });

  it('allows unrelated wire geometry but rejects a missing follow-up wire inventory', async () => {
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveComponent: {
        get: vi.fn().mockResolvedValue({
          getState_ComponentType: () => 'component',
          getState_X: () => 0,
          getState_Y: () => 0,
        }),
        modify: vi.fn().mockResolvedValue(true),
      },
      SCH_PrimitiveWire: {
        getAll: vi
          .fn()
          .mockResolvedValueOnce([{ primitiveId: 'other', line: [9, 9, 8, 8] }])
          .mockResolvedValueOnce(null),
        modify: vi.fn(),
      },
    });
    callFirst.mockResolvedValue([{ getState_X: () => 1, getState_Y: () => 2 }]);

    await expect(operations.modifyPrimitive('cmp-1', { x: 1 })).resolves.toMatchObject({
      followedWireIds: [],
    });
    await expect(operations.modifyPrimitive('cmp-1', { y: 1 })).rejects.toMatchObject({
      code: 'MOVE_CONNECTIVITY_UNVERIFIED',
    });
  });

  it('falls through when a qualified text class cannot find the requested text', async () => {
    const { operations, callFirst } = createSubject({
      SCH_PrimitiveText: {
        get: vi.fn().mockResolvedValue(undefined),
        modify: vi.fn(),
      },
    });
    callFirst.mockResolvedValue({ fallback: true });
    await expect(operations.modifyPrimitive('missing', { content: 'x' })).resolves.toEqual({
      fallback: true,
    });
  });

  it('falls through when the polygon class lacks a modify API', async () => {
    const { operations, callFirst } = createSubject({
      SCH_PrimitivePolygon: { get: vi.fn().mockResolvedValue({}) },
    });
    callFirst.mockResolvedValue({ fallback: true });
    await expect(operations.modifyPrimitive('poly-1', { line: [] })).resolves.toEqual({
      fallback: true,
    });
  });
});
