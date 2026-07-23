import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSchematicInspectionOperations } from '../src/schematic-inspection.js';

function bridgeError(code: string, message: string, suggestion: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, suggestion, data });
}

function makeOperations(runtime: Record<string, unknown> = {}) {
  const callFirst = vi.fn(async (paths: readonly string[], ...args: unknown[]) => {
    for (const path of paths) {
      const value = runtime[path];
      if (typeof value === 'function') return (value as (...values: unknown[]) => unknown)(...args);
    }
    throw new Error(`No API path found: ${paths.join(', ')}`);
  });
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
    return record[key];
  });
  const extractPrimitiveId = vi.fn((value: unknown): string => {
    if (!value || typeof value !== 'object') return '';
    const id = (value as Record<string, unknown>).primitiveId;
    return typeof id === 'string' ? id : '';
  });

  return {
    callFirst,
    readFirstPath,
    readState,
    extractPrimitiveId,
    operations: createSchematicInspectionOperations({
      callFirst,
      readFirstPath,
      readState,
      extractPrimitiveId,
      createBridgeError: bridgeError,
    }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('schematic inspection operations', () => {
  it('rejects primitive bounds when the schematic primitive class is unavailable', async () => {
    await expect(makeOperations().operations.primitiveBounds(['p1'])).rejects.toThrow(
      'SCH_Primitive class not found in EasyEDA Pro API',
    );
  });

  it('filters primitive IDs and returns per-item plus combined native bounds', async () => {
    const getPrimitivesBBox = vi.fn(async (ids: string[]) =>
      ids.length === 1
        ? { minX: ids[0] === 'p1' ? 1 : 2, maxX: 3, minY: 4, maxY: 5 }
        : { minX: 1, maxX: 8, minY: 4, maxY: 9 },
    );
    const { operations } = makeOperations({ SCH_Primitive: { getPrimitivesBBox } });

    await expect(operations.primitiveBounds(['p1', '', 42, 'p2'])).resolves.toEqual({
      items: [
        { primitiveId: 'p1', bounds: { minX: 1, maxX: 3, minY: 4, maxY: 5 } },
        { primitiveId: 'p2', bounds: { minX: 2, maxX: 3, minY: 4, maxY: 5 } },
      ],
      combined: { minX: 1, maxX: 8, minY: 4, maxY: 9 },
    });
  });

  it('normalizes undefined native item and combined bounds to null', async () => {
    const getPrimitivesBBox = vi.fn(async () => undefined);
    const { operations } = makeOperations({ sch_Primitive: { getPrimitivesBBox } });

    await expect(operations.primitiveBounds(['p1'])).resolves.toEqual({
      items: [{ primitiveId: 'p1', bounds: null }],
      combined: null,
    });
  });

  it('contains item and combined bounding-box failures and accepts non-array input', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const getPrimitivesBBox = vi
      .fn()
      .mockRejectedValueOnce(new Error('item failed'))
      .mockRejectedValueOnce(new Error('combined failed'));
    const { operations } = makeOperations({ SCH_Primitive: { getPrimitivesBBox } });

    await expect(operations.primitiveBounds(['p1'])).resolves.toEqual({
      items: [{ primitiveId: 'p1', bounds: null }],
      combined: null,
    });
    await expect(operations.primitiveBounds('not-an-array')).resolves.toEqual({
      items: [],
      combined: null,
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('returns the current page with non-empty list and focus diagnostics', async () => {
    const currentPage = { uuid: 'page-1', name: 'Main' };
    const pages = [currentPage, { uuid: 'page-2', name: 'Power' }];
    const focusedDocument = { uuid: 'page-1', documentType: 'schematic' };
    const { operations } = makeOperations({
      'DMT_Schematic.getCurrentSchematicPageInfo': async () => currentPage,
      'DMT_Schematic.getCurrentSchematicAllSchematicPagesInfo': async () => pages,
      'DMT_SelectControl.getCurrentDocumentInfo': async () => focusedDocument,
    });

    await expect(operations.getSheetInfo()).resolves.toEqual({
      currentPage,
      pages,
      source: 'current_page',
      focusedDocument,
      diagnostics: {
        stage: 'focused_sheet_resolution',
        currentPageAvailable: true,
        pageListAvailable: true,
        focusedDocumentAvailable: true,
        attempts: [
          { stage: 'current_page', status: 'value' },
          { stage: 'current_page_list', status: 'value' },
          { stage: 'focused_document', status: 'value' },
        ],
      },
    });
  });

  it('recovers a focused page through the direct UUID lookup', async () => {
    const page = { uuid: 'focused-page', name: 'Recovered' };
    const { operations, callFirst } = makeOperations({
      'DMT_Schematic.getCurrentSchematicPageInfo': async () => ({}),
      'DMT_Schematic.getCurrentSchematicAllSchematicPagesInfo': async () => [],
      'DMT_Schematic.getAllSchematicPagesInfo': async () => [page, 'ignored'],
      'DMT_SelectControl.getCurrentDocumentInfo': async () => ({ uuid: 'focused-page' }),
      'DMT_Schematic.getCurrentSchematicInfo': async () => ({ page: [page] }),
      'DMT_Schematic.getSchematicPageInfo': async (uuid: unknown) =>
        uuid === 'focused-page' ? page : undefined,
    });

    await expect(operations.getSheetInfo()).resolves.toMatchObject({
      currentPage: page,
      pages: [page],
      source: 'focused_document',
    });
    expect(callFirst).toHaveBeenCalledWith(['DMT_Schematic.getSchematicPageInfo'], 'focused-page');
  });

  it('recovers from a non-Error rejection through a matching focused page list', async () => {
    const page = { uuid: 'focused-page', name: 'Recovered from list' };
    const { operations } = makeOperations({
      'DMT_Schematic.getCurrentSchematicPageInfo': async () => {
        throw 'page transport failed';
      },
      'DMT_Schematic.getCurrentSchematicAllSchematicPagesInfo': async () => [page],
      'DMT_SelectControl.getCurrentDocumentInfo': async () => ({ uuid: 'focused-page' }),
      'DMT_Schematic.getCurrentSchematicInfo': async () => ({ page: [page] }),
      'DMT_Schematic.getSchematicPageInfo': async () => null,
    });

    await expect(operations.getSheetInfo()).resolves.toMatchObject({
      currentPage: page,
      source: 'focused_document',
      diagnostics: {
        attempts: expect.arrayContaining([
          { stage: 'current_page', status: 'unavailable', error: 'page transport failed' },
          { stage: 'focused_document_page', status: 'empty' },
        ]),
      },
    });
  });

  it('uses a sole current-schematic page without a focused document', async () => {
    const page = { uuid: 'only-page', name: 'Only' };
    const { operations } = makeOperations({
      'DMT_Schematic.getCurrentSchematicPageInfo': async () => null,
      'DMT_Schematic.getCurrentSchematicAllSchematicPagesInfo': async () => null,
      'DMT_Schematic.getAllSchematicPagesInfo': async () => [],
      'DMT_SelectControl.getCurrentDocumentInfo': async () => 7,
      'DMT_Schematic.getCurrentSchematicInfo': async () => ({ page: [page] }),
    });

    await expect(operations.getSheetInfo()).resolves.toMatchObject({
      currentPage: page,
      pages: [page],
      source: 'current_schematic_page_list',
      focusedDocument: undefined,
    });
  });

  it('rejects when a focused UUID is absent from a non-empty page list', async () => {
    const { operations } = makeOperations({
      'DMT_Schematic.getCurrentSchematicPageInfo': async () => null,
      'DMT_Schematic.getCurrentSchematicAllSchematicPagesInfo': async () => [
        { uuid: 'page-1' },
        { uuid: 'page-2' },
      ],
      'DMT_SelectControl.getCurrentDocumentInfo': async () => ({ uuid: 'missing-page' }),
      'DMT_Schematic.getCurrentSchematicInfo': async () => ({ page: [] }),
      'DMT_Schematic.getSchematicPageInfo': async () => null,
    });

    await expect(operations.getSheetInfo()).rejects.toMatchObject({
      code: 'SHEET_INFO_UNAVAILABLE',
      data: {
        currentPageAvailable: false,
        pageListAvailable: true,
        focusedDocumentAvailable: true,
      },
    });
  });

  it('rejects when direct and list-based focused-page recovery are both empty', async () => {
    const { operations } = makeOperations({
      'DMT_Schematic.getCurrentSchematicPageInfo': async () => null,
      'DMT_Schematic.getCurrentSchematicAllSchematicPagesInfo': async () => [],
      'DMT_Schematic.getAllSchematicPagesInfo': async () => [],
      'DMT_SelectControl.getCurrentDocumentInfo': async () => ({ uuid: 'missing-page' }),
      'DMT_Schematic.getCurrentSchematicInfo': async () => ({ page: [] }),
      'DMT_Schematic.getSchematicPageInfo': async () => null,
    });

    await expect(operations.getSheetInfo()).rejects.toMatchObject({
      code: 'SHEET_INFO_UNAVAILABLE',
      data: {
        currentPageAvailable: false,
        pageListAvailable: false,
        focusedDocumentAvailable: true,
      },
    });
  });

  it('reports stable diagnostics when every sheet path is empty or unavailable', async () => {
    const { operations } = makeOperations({
      'DMT_Schematic.getCurrentSchematicPageInfo': async () => {
        throw new Error('page unavailable');
      },
      'DMT_Schematic.getCurrentSchematicAllSchematicPagesInfo': async () => [],
      'DMT_Schematic.getAllSchematicPagesInfo': async () => [],
      'DMT_SelectControl.getCurrentDocumentInfo': async () => ({ uuid: '' }),
      'DMT_Schematic.getCurrentSchematicInfo': async () => ({ page: [] }),
    });

    await expect(operations.getSheetInfo()).rejects.toMatchObject({
      code: 'SHEET_INFO_UNAVAILABLE',
      message: 'EasyEDA did not expose metadata for the focused schematic page.',
      data: {
        currentPageAvailable: false,
        pageListAvailable: false,
        focusedDocumentAvailable: true,
        attempts: expect.arrayContaining([
          { stage: 'current_page', status: 'unavailable', error: 'page unavailable' },
          { stage: 'current_page_list', status: 'empty' },
          { stage: 'all_page_list', status: 'empty' },
          { stage: 'focused_document', status: 'value' },
          { stage: 'current_schematic', status: 'value' },
        ]),
      },
    });
  });

  it('degrades rectangle inspection when the class or getAll method is unavailable', async () => {
    await expect(makeOperations().operations.listRectangles()).resolves.toEqual({
      total: 0,
      items: [],
    });
    await expect(
      makeOperations({ SCH_PrimitiveRectangle: {} }).operations.listRectangles(),
    ).resolves.toEqual({ total: 0, items: [] });
  });

  it('contains rectangle enumeration failures and null collections as empty results', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const getAll = vi
      .fn()
      .mockRejectedValueOnce(new Error('rectangle list failed'))
      .mockResolvedValueOnce(null);
    const { operations } = makeOperations({ sch_PrimitiveRectangle: { getAll } });

    await expect(operations.listRectangles()).resolves.toEqual({ total: 0, items: [] });
    await expect(operations.listRectangles()).resolves.toEqual({ total: 0, items: [] });
    expect(warn).toHaveBeenCalledWith(
      '[easyeda-mcp-pro]',
      'failed to list rectangles',
      expect.any(Error),
    );
  });

  it('maps rectangle IDs, live top-left fields, fallbacks, and the verified Y sign', async () => {
    const rectangles = [
      {
        primitiveId: 'r1',
        getState_TopLeftX: () => 10,
        getState_TopLeftY: () => -20,
        getState_Width: () => 30,
        getState_Height: () => 40,
        getState_Rotation: () => 90,
      },
      {
        getState_PrimitiveId: () => 'r2',
        getState_X: () => 50,
        getState_Y: () => 'unknown-y',
      },
      { getState_PrimitiveId: () => ({ unsafe: true }) },
    ];
    const { operations } = makeOperations({
      SCH_PrimitiveRectangle: { getAll: async () => rectangles },
    });

    await expect(operations.listRectangles()).resolves.toEqual({
      total: 3,
      items: [
        {
          primitiveId: 'r1',
          x: 10,
          y: 20,
          width: 30,
          height: 40,
          rotation: 90,
        },
        {
          primitiveId: 'r2',
          x: 50,
          y: 'unknown-y',
          width: undefined,
          height: undefined,
          rotation: undefined,
        },
        {
          primitiveId: '',
          x: undefined,
          y: undefined,
          width: undefined,
          height: undefined,
          rotation: undefined,
        },
      ],
    });
  });
});
