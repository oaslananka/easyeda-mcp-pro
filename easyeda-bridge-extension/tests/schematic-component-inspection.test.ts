import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSchematicComponentInspectionOperations } from '../src/schematic-component-inspection.js';

function makeStateful(state: Record<string, unknown>): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(state)) value[`getState_${key}`] = () => entry;
  return value;
}

function makeOperations(runtime: Record<string, unknown> = {}) {
  const readFirstPath = vi.fn(<T>(paths: readonly string[]): T | undefined => {
    for (const path of paths) {
      if (path in runtime) return runtime[path] as T;
    }
    return undefined;
  });
  const readState = vi.fn((value: unknown, key: string): unknown => {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    const getter = record[`getState_${key}`];
    if (typeof getter === 'function') return (getter as () => unknown).call(value);
    const lowerCamelKey = key.charAt(0).toLowerCase() + key.slice(1);
    return record[key] ?? record[lowerCamelKey];
  });
  return {
    readFirstPath,
    readState,
    operations: createSchematicComponentInspectionOperations({ readFirstPath, readState }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('schematic component inspection operations', () => {
  it('rejects inspection when the schematic component class is unavailable', async () => {
    await expect(makeOperations().operations.listComponents()).rejects.toThrow(
      'SCH_PrimitiveComponent class not found in EasyEDA Pro API',
    );
  });

  it('filters non-BOM primitives and maps live component metadata', async () => {
    const frame = makeStateful({
      PrimitiveId: 'frame1',
      ComponentType: 'sheet',
      Component: { name: 'Drawing-Symbol_A4' },
    });
    const netflag = makeStateful({
      PrimitiveId: 'flag1',
      ComponentType: 'netflag',
      Component: { name: 'Power-Flag' },
    });
    const netport = makeStateful({
      PrimitiveId: 'port1',
      ComponentType: 'netport',
      Component: { name: 'Net-Port' },
    });
    const drawingPart = makeStateful({
      PrimitiveId: 'drawing1',
      ComponentType: 'part',
      Component: { name: 'Drawing-Symbol_Custom' },
    });
    const resistor = makeStateful({
      PrimitiveId: 'r1',
      ComponentType: 'part',
      Component: { uuid: 'res-dev', libraryUuid: 'lib', name: 'RES_1K' },
      Symbol: { name: 'RES' },
      Footprint: { uuid: 'fp-r', libraryUuid: 'lib', name: 'R0805' },
      Designator: 'R1',
      Name: '={Value}',
      Manufacturer: 'Example',
      ManufacturerId: 'RES-1K',
      SupplierId: 'C1',
      OtherProperty: { Value: '1kΩ', Datasheet: 'https://example.invalid/r1' },
      X: 100,
      Y: 200,
      Rotation: 90,
    });
    const timer = makeStateful({
      PrimitiveId: 'u1',
      ComponentType: 'part',
      Component: { uuid: 'timer-dev', libraryUuid: 'lib', name: 'NE555P' },
      Symbol: { name: 'NE555P' },
      Footprint: null,
      Designator: 'U1',
      Name: '={Manufacturer Part}',
      Manufacturer: 'TI',
      ManufacturerId: 'NE555P',
      SupplierId: 'C2',
      OtherProperty: { 'Supplier Footprint': 'DIP-8' },
      X: 300,
      Y: 400,
      Rotation: 0,
    });
    const getAll = vi.fn(async () => [frame, netflag, netport, drawingPart, resistor, timer]);
    const { operations } = makeOperations({ SCH_PrimitiveComponent: { getAll } });

    await expect(operations.listComponents()).resolves.toEqual({
      total: 2,
      items: [
        {
          primitiveId: 'r1',
          reference: 'R1',
          value: '1kΩ',
          footprint: 'R0805',
          lcsc: 'C1',
          manufacturer: 'Example',
          manufacturerId: 'RES-1K',
          datasheet: 'https://example.invalid/r1',
          deviceUuid: 'res-dev',
          deviceLibraryUuid: 'lib',
          deviceName: 'RES_1K',
          symbolName: 'RES',
          x: 100,
          y: 200,
          rotation: 90,
        },
        {
          primitiveId: 'u1',
          reference: 'U1',
          value: 'NE555P',
          footprint: 'DIP-8',
          lcsc: 'C2',
          manufacturer: 'TI',
          manufacturerId: 'NE555P',
          datasheet: '',
          deviceUuid: 'timer-dev',
          deviceLibraryUuid: 'lib',
          deviceName: 'NE555P',
          symbolName: 'NE555P',
          x: 300,
          y: 400,
          rotation: 0,
        },
      ],
    });
    expect(getAll).toHaveBeenCalledWith(undefined, true);
  });

  it('resolves an unnamed footprint from the library and prefers native names', async () => {
    const footprintGet = vi.fn(async () => ({ name: 'SOT-23' }));
    const direct = makeStateful({
      PrimitiveId: 'q1',
      ComponentType: 'part',
      Component: { name: 'Q' },
      Designator: 'Q1',
      Name: 'Q',
      Footprint: { uuid: 'native-fp', libraryUuid: 'lib', name: 'SOT-223' },
      OtherProperty: {},
    });
    const lookup = makeStateful({
      PrimitiveId: 'q2',
      ComponentType: 'part',
      Component: { name: 'Q' },
      Designator: 'Q2',
      Name: 'Q',
      Footprint: { uuid: 'lookup-fp', libraryUuid: 'lib' },
      OtherProperty: {},
    });
    const { operations } = makeOperations({
      SCH_PrimitiveComponent: { getAll: async () => [direct, lookup] },
      LIB_Footprint: { get: footprintGet },
    });

    await expect(operations.listComponents()).resolves.toMatchObject({
      items: [
        { primitiveId: 'q1', footprint: 'SOT-223' },
        { primitiveId: 'q2', footprint: 'SOT-23' },
      ],
    });
    expect(footprintGet).toHaveBeenCalledOnce();
    expect(footprintGet).toHaveBeenCalledWith('lookup-fp', 'lib');
  });

  it('contains library lookup failures and uses case-insensitive property fallbacks', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const footprintGet = vi.fn(async () => Promise.reject(new Error('offline')));
    const part = makeStateful({
      PrimitiveId: 'q1',
      ComponentType: 'part',
      Component: { name: 'Q' },
      Designator: 'Q1',
      Name: '',
      ManufacturerId: 'Q-MFR',
      Footprint: { uuid: 'fp', libraryUuid: 'lib' },
      OtherProperty: {
        footprint: 'QFN-16',
        datasheet: 'https://example.invalid/q1',
        value: 'MOSFET',
      },
    });
    const { operations } = makeOperations({
      SCH_PrimitiveComponent: { getAll: async () => [part] },
      lib_Footprint: { get: footprintGet },
    });

    await expect(operations.listComponents()).resolves.toMatchObject({
      items: [
        {
          primitiveId: 'q1',
          value: 'MOSFET',
          footprint: 'QFN-16',
          datasheet: 'https://example.invalid/q1',
        },
      ],
    });
    expect(warn).toHaveBeenCalledWith(
      '[easyeda-mcp-pro]',
      'failed to resolve component footprint',
      expect.any(Error),
    );
  });

  it('falls back through display expressions without inventing metadata', async () => {
    const part = (id: string, name: unknown, manufacturerId: string, deviceName: string) =>
      makeStateful({
        PrimitiveId: id,
        ComponentType: 'part',
        Component: { name: deviceName },
        Designator: id.toUpperCase(),
        Name: name,
        ManufacturerId: manufacturerId,
        OtherProperty: {},
      });
    const { operations } = makeOperations({
      SCH_PrimitiveComponent3: {
        getAll: async () => [
          part('a', '={Unknown}', 'MFR-A', 'DEV-A'),
          part('b', '={Manufacturer Part}', 'MFR-B', 'DEV-B'),
          part('c', '', '', 'DEV-C'),
        ],
      },
    });

    await expect(operations.listComponents()).resolves.toMatchObject({
      items: [
        { primitiveId: 'a', value: 'MFR-A' },
        { primitiveId: 'b', value: 'MFR-B' },
        { primitiveId: 'c', value: 'DEV-C' },
      ],
    });
  });

  it('paginates only after filtering and clamps offset and limit', async () => {
    const part = (id: string) =>
      makeStateful({
        PrimitiveId: id,
        ComponentType: 'part',
        Component: { name: id },
        Designator: id.toUpperCase(),
        Name: id,
        OtherProperty: {},
      });
    const frame = makeStateful({
      ComponentType: 'sheet',
      Component: { name: 'Drawing-Symbol_A4' },
    });
    const { operations } = makeOperations({
      sch_PrimitiveComponent: { getAll: async () => [frame, part('a'), part('b')] },
    });

    await expect(operations.listComponents(0, 1)).resolves.toMatchObject({
      total: 2,
      items: [{ primitiveId: 'b' }],
    });
    await expect(operations.listComponents(1, -10)).resolves.toMatchObject({
      total: 2,
      items: [{ primitiveId: 'a' }],
    });
  });

  it('keeps sparse and malformed native metadata within scalar compatibility fallbacks', async () => {
    const part = (state: Record<string, unknown>) =>
      makeStateful({ ComponentType: 'part', ...state });
    const footprintGet = vi.fn(async () => 'not-a-record');
    const { operations } = makeOperations({
      SCH_PrimitiveComponent: {
        getAll: async () => [
          part({
            PrimitiveId: 'device-only',
            Component: { name: 'DEVICE' },
            Name: '={Unknown}',
            ManufacturerId: '',
            OtherProperty: {},
          }),
          part({
            PrimitiveId: 'expression-only',
            Component: {},
            Name: '={Unknown}',
            ManufacturerId: '',
            OtherProperty: {},
          }),
          part({
            PrimitiveId: 'empty',
            Component: {},
            Name: '',
            ManufacturerId: '',
          }),
          part({
            PrimitiveId: 'malformed-footprint',
            Component: { name: 'F' },
            Name: 'F',
            Footprint: { uuid: 'fp', libraryUuid: 'lib' },
            OtherProperty: { 'Supplier Footprint': 'SOIC-8' },
          }),
        ],
      },
      LIB_Footprint: { get: footprintGet },
    });

    await expect(operations.listComponents()).resolves.toMatchObject({
      total: 4,
      items: [
        { primitiveId: 'device-only', value: 'DEVICE' },
        { primitiveId: 'expression-only', value: '={Unknown}' },
        { primitiveId: 'empty', value: '', footprint: '' },
        { primitiveId: 'malformed-footprint', footprint: 'SOIC-8' },
      ],
    });
    expect(footprintGet).toHaveBeenCalledWith('fp', 'lib');
  });

  it('normalizes a null native collection to an empty result', async () => {
    const { operations } = makeOperations({
      SCH_PrimitiveComponent: { getAll: async () => null },
    });

    await expect(operations.listComponents()).resolves.toEqual({ total: 0, items: [] });
  });

  it('covers empty metadata and non-record footprint lookup fallbacks without inventing values', async () => {
    const part = (state: Record<string, unknown>) =>
      makeStateful({ ComponentType: 'part', ...state });
    const { operations } = makeOperations({
      SCH_PrimitiveComponent: {
        getAll: async () => [
          part({
            PrimitiveId: 'device-fallback',
            Component: { name: 'DEV-FALLBACK' },
            Name: '={Unknown}',
          }),
          part({
            PrimitiveId: 'expression-fallback',
            Component: { name: '' },
            Name: '={Unknown}',
            OtherProperty: {},
          }),
          part({
            PrimitiveId: 'empty-value',
            Component: { name: '' },
            Name: '',
            OtherProperty: {},
          }),
          part({
            PrimitiveId: 'non-record-footprint',
            Component: { name: 'Device' },
            Name: 'Device',
            Footprint: { uuid: 'fp', libraryUuid: 'lib' },
            OtherProperty: { 'Supplier Footprint': 'FALLBACK-FP' },
          }),
        ],
      },
      LIB_Footprint: { get: async () => 'not-a-record' },
    });

    await expect(operations.listComponents()).resolves.toMatchObject({
      items: [
        { primitiveId: 'device-fallback', value: 'DEV-FALLBACK' },
        { primitiveId: 'expression-fallback', value: '={Unknown}' },
        { primitiveId: 'empty-value', value: '' },
        { primitiveId: 'non-record-footprint', footprint: 'FALLBACK-FP' },
      ],
    });
  });
});
