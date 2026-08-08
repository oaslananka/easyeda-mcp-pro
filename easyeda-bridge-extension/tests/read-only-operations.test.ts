import { describe, expect, it, vi } from 'vitest';
import { createReadOnlyOperations } from '../src/read-only-operations.js';

function createDependencies(overrides: Record<string, unknown> = {}) {
  return {
    callFirst: vi.fn(async (paths: string[], ...args: unknown[]) => ({ paths, args })),
    schematicTransactionOperations: {
      getPrimitiveSnapshot: vi.fn(async (primitiveId: string, kind?: string) => ({
        primitiveId,
        kind,
      })),
      listPrimitiveIds: vi.fn(async (primitiveKind: unknown) => ({ primitiveKind })),
    },
    schematicComponentInspection: {
      listComponents: vi.fn(async (limit?: number, offset?: number) => ({
        limit,
        offset,
        items: [],
      })),
    },
    schematicInspection: {
      getSheetInfo: vi.fn(async () => ({ sheet: true })),
      primitiveBounds: vi.fn(async (primitiveIds: unknown) => ({ primitiveIds })),
      listRectangles: vi.fn(async () => [{ id: 'rect-1' }]),
    },
    listNets: vi.fn(async () => []),
    getNetDetail: vi.fn(async (netName: string, operationTimeoutMs: unknown) => ({
      netName,
      operationTimeoutMs,
    })),
    getPinNoConnect: vi.fn(async (componentPrimitiveId: string, pinNumber: string) => ({
      componentPrimitiveId,
      pinNumber,
      noConnected: true,
    })),
    findFloatingPins: vi.fn(async () => ({ floatingPins: [], partRefs: [] })),
    runSchematicCheck: vi.fn(async () => ({ errorCount: 0, warningCount: 0, passed: true })),
    logRecoverableError: vi.fn(),
    ...overrides,
  };
}

describe('read-only dispatcher operations', () => {
  it('delegates schematic inspection and transaction reads with existing coercion semantics', async () => {
    const dependencies = createDependencies();
    const operations = createReadOnlyOperations(dependencies as any);

    await expect(operations.listNets()).resolves.toEqual([]);
    await expect(
      operations.getNetDetail({ netName: 'VBUS', operationTimeoutMs: 1234 }),
    ).resolves.toEqual({ netName: 'VBUS', operationTimeoutMs: 1234 });
    await expect(
      operations.getPrimitiveSnapshot({ primitiveId: 'p1', expectedPrimitiveKind: 'text' }),
    ).resolves.toEqual({ primitiveId: 'p1', kind: 'text' });
    await expect(
      operations.getPrimitiveSnapshot({ primitiveId: 'p2', expectedPrimitiveKind: 42 }),
    ).resolves.toEqual({ primitiveId: 'p2', kind: undefined });
    await expect(operations.listPrimitiveIds({ primitiveKind: 'wire' })).resolves.toEqual({
      primitiveKind: 'wire',
    });
    await expect(operations.listComponents({ limit: 2, offset: 3 })).resolves.toMatchObject({
      limit: 2,
      offset: 3,
    });
    await expect(operations.listComponents({ limit: 'bad', offset: 'bad' })).resolves.toMatchObject(
      {
        limit: undefined,
        offset: 0,
      },
    );
    await expect(operations.getSheetInfo()).resolves.toEqual({ sheet: true });
    await expect(operations.primitiveBounds({ primitiveIds: ['p1'] })).resolves.toEqual({
      primitiveIds: ['p1'],
    });
    await expect(operations.listRectangles()).resolves.toEqual([{ id: 'rect-1' }]);
    await expect(
      operations.getPinNoConnect({ primitiveId: 'cmp-1', pinNumber: '2' }),
    ).resolves.toEqual({ componentPrimitiveId: 'cmp-1', pinNumber: '2', noConnected: true });
  });

  it('preserves device search and LCSC lookup argument order/defaults', async () => {
    const dependencies = createDependencies();
    const operations = createReadOnlyOperations(dependencies as any);

    await operations.searchDevice({
      key: 'NE555',
      libraryUuid: 'lib-1',
      classification: 'IC',
      symbolType: 'symbol',
      itemsOfPage: 20,
      page: 2,
    });
    expect(dependencies.callFirst).toHaveBeenNthCalledWith(
      1,
      ['LIB_Device.search', 'lib_Device.search'],
      'NE555',
      'lib-1',
      'IC',
      'symbol',
      20,
      2,
    );

    await operations.getDeviceByLcscId({ lcscId: 123, libraryUuid: 'lib-2' });
    expect(dependencies.callFirst).toHaveBeenNthCalledWith(
      2,
      ['LIB_Device.getByLcscIds'],
      ['123'],
      'lib-2',
      false,
    );

    await operations.getDeviceByLcscId({});
    expect(dependencies.callFirst).toHaveBeenNthCalledWith(
      3,
      ['LIB_Device.getByLcscIds'],
      [''],
      undefined,
      false,
    );
  });

  it('builds netlist validation output and surfaces inferred/native warnings', async () => {
    const floatingPins = [{ primitiveId: 'u2', designator: 'U2', pinNumber: '3' }];
    const dependencies = createDependencies({
      listNets: vi.fn(async () => [
        {
          netName: 'GND',
          nodes: [
            { component: 'U1', pin: '1' },
            { component: 'U1', pin: '2' },
          ],
        },
      ]),
      findFloatingPins: vi.fn(async () => ({ floatingPins, partRefs: ['U1', 'U2'] })),
      runSchematicCheck: vi.fn(async () => ({ errorCount: 2, warningCount: 1, passed: false })),
    });
    const operations = createReadOnlyOperations(dependencies as any);

    await expect(operations.validateNetlist()).resolves.toEqual({
      nets: [
        {
          netName: 'GND',
          refs: ['U1'],
          pins: ['1', '2'],
          hasNetFlag: true,
        },
      ],
      floatingPins,
      wiresWithoutNetlist: [],
      nativeErc: { errorCount: 2, warningCount: 1, passed: false },
      warnings: [
        '1 pin(s) are not connected to any net.',
        '1 component(s) have no net connections.',
        expect.stringContaining('Native ERC reports 2 error(s)'),
      ],
    });
  });

  it('keeps validation conclusive when there are no inferred/native findings', async () => {
    const dependencies = createDependencies({
      listNets: vi.fn(async () => [{ netName: 'VCC', nodes: [{ component: 'U1', pin: '1' }] }]),
      findFloatingPins: vi.fn(async () => ({ floatingPins: [], partRefs: ['U1'] })),
      runSchematicCheck: vi.fn(async () => ({ errorCount: 0, warningCount: 2, passed: true })),
    });
    const operations = createReadOnlyOperations(dependencies as any);

    await expect(operations.validateNetlist()).resolves.toMatchObject({
      nativeErc: { errorCount: 0, warningCount: 2, passed: true },
      warnings: [],
    });
  });

  it('logs a native ERC read failure without discarding inferred validation evidence', async () => {
    const nativeError = new Error('native ERC unavailable');
    const dependencies = createDependencies({
      listNets: vi.fn(async () => []),
      findFloatingPins: vi.fn(async () => ({
        floatingPins: [{ primitiveId: 'r1', designator: 'R1', pinNumber: '1' }],
        partRefs: ['R1'],
      })),
      runSchematicCheck: vi.fn(async () => {
        throw nativeError;
      }),
    });
    const operations = createReadOnlyOperations(dependencies as any);

    await expect(operations.validateNetlist()).resolves.toMatchObject({
      nativeErc: undefined,
      warnings: [
        '1 pin(s) are not connected to any net.',
        '1 component(s) have no net connections.',
      ],
    });
    expect(dependencies.logRecoverableError).toHaveBeenCalledWith(
      'validateNetlist: native ERC cross-check failed',
      nativeError,
    );
  });

  it('groups BOM entries by value, LCSC, and footprint while preserving fallback keys', async () => {
    const items = [
      {
        reference: 'R1',
        value: '10k',
        footprint: '0603',
        lcsc: 'C1',
        manufacturer: 'Maker',
      },
      {
        reference: 'R2',
        value: '10k',
        footprint: '0603',
        lcsc: 'C1',
        manufacturer: 'Maker',
      },
      {
        reference: 'C1',
        value: '',
        footprint: '',
        lcsc: '',
        manufacturer: undefined,
      },
    ];
    const dependencies = createDependencies({
      schematicComponentInspection: {
        listComponents: vi.fn(async () => ({ items })),
      },
    });
    const operations = createReadOnlyOperations(dependencies as any);

    await expect(operations.generateBom({})).resolves.toEqual([
      {
        reference: 'R1, R2',
        value: '10k',
        footprint: '0603',
        lcsc: 'C1',
        quantity: 2,
        manufacturer: 'Maker',
      },
      {
        reference: 'C1',
        value: '',
        footprint: '',
        lcsc: '',
        quantity: 1,
        manufacturer: undefined,
      },
    ]);
    await operations.generateBom({ groupBy: 'lcsc' });
    await operations.generateBom({ groupBy: 'footprint' });
    await expect(operations.validateBom()).resolves.toEqual({
      totalParts: 3,
      missing: [],
      obsolete: [],
      alternates: [],
    });
  });

  it('keeps inventory placeholders explicitly empty', async () => {
    const operations = createReadOnlyOperations(createDependencies() as any);

    await expect(operations.inventorySearch()).resolves.toEqual([]);
    await expect(operations.inventoryGetPrice()).resolves.toBeNull();
  });
});
