import { describe, expect, it, vi } from 'vitest';
import { normalizeBinaryResult as normalize } from '../src/binary-result.js';
import { createExportOperations } from '../src/export-operations.js';

function makeOperations() {
  const callFirst = vi.fn(async () => 'native-result');
  const normalizeBinaryResult = vi.fn(async (value, fileName) => ({ value, fileName }));
  const createBridgeError = vi.fn(
    (_code: string, message: string, _suggestion: string) => new Error(message),
  );
  const readProjectScoped = vi.fn(
    async (_projectId: string, read: () => Promise<unknown>, _documentType?: number | null) =>
      read(),
  );
  return {
    callFirst,
    normalizeBinaryResult,
    createBridgeError,
    readProjectScoped,
    operations: createExportOperations({
      callFirst,
      normalizeBinaryResult,
      createBridgeError,
      readProjectScoped,
    }),
  };
}

describe('export operations', () => {
  it('exports Gerbers with the projectId string as the native file-name argument', async () => {
    const { callFirst, normalizeBinaryResult, operations } = makeOperations();

    await expect(operations.exportGerbers({ projectId: 'proj-123' })).resolves.toEqual({
      value: 'native-result',
      fileName: 'gerbers.zip',
    });
    expect(callFirst).toHaveBeenCalledWith(['PCB_ManufactureData.getGerberFile'], 'proj-123');
    expect(normalizeBinaryResult).toHaveBeenCalledWith('native-result', 'gerbers.zip');
  });

  it.each([{}, { projectId: '' }, { projectId: '   ' }])(
    'rejects Gerber export before the native call when projectId is missing or blank: %j',
    async (params) => {
      const { callFirst, normalizeBinaryResult, operations } = makeOperations();

      await expect(operations.exportGerbers(params)).rejects.toThrow(/non-empty projectId/i);
      expect(callFirst).not.toHaveBeenCalled();
      expect(normalizeBinaryResult).not.toHaveBeenCalled();
    },
  );

  it('exports route context with only a string file name', async () => {
    const { callFirst, operations } = makeOperations();

    await operations.exportRouteContext({ fileName: 'board.dsn' });
    await operations.exportRouteContext({ fileName: 42 });

    expect(callFirst).toHaveBeenNthCalledWith(1, ['PCB_ManufactureData.getDsnFile'], 'board.dsn');
    expect(callFirst).toHaveBeenNthCalledWith(2, ['PCB_ManufactureData.getDsnFile'], undefined);
  });

  it('exports pick-and-place as CSV with the projectId string and preserves the output-name fallback', async () => {
    const { callFirst, normalizeBinaryResult, operations } = makeOperations();

    await operations.exportPickPlace({ projectId: 'proj-123', format: 'csv' });
    await operations.exportPickPlace({ projectId: 'proj-456', format: 7 });

    expect(callFirst).toHaveBeenNthCalledWith(
      1,
      ['PCB_ManufactureData.getPickAndPlaceFile'],
      'proj-123',
      'csv',
    );
    expect(callFirst).toHaveBeenNthCalledWith(
      2,
      ['PCB_ManufactureData.getPickAndPlaceFile'],
      'proj-456',
      'csv',
    );
    expect(normalizeBinaryResult).toHaveBeenNthCalledWith(1, 'native-result', 'pick-place.csv');
    expect(normalizeBinaryResult).toHaveBeenNthCalledWith(2, 'native-result', 'pick-place.csv');
  });

  it.each([{}, { projectId: '' }, { projectId: '   ' }])(
    'rejects pick-and-place export before the native call when projectId is missing or blank: %j',
    async (params) => {
      const { callFirst, normalizeBinaryResult, operations } = makeOperations();

      await expect(operations.exportPickPlace(params)).rejects.toThrow(/non-empty projectId/i);
      expect(callFirst).not.toHaveBeenCalled();
      expect(normalizeBinaryResult).not.toHaveBeenCalled();
    },
  );

  it('routes board and existing combined requests to the PCB PDF API with its native signature', async () => {
    const { callFirst, operations } = makeOperations();
    await operations.exportPdf({ what: 'board', fileName: 'board' });
    await operations.exportPdf({ what: 'both' });
    expect(callFirst).toHaveBeenNthCalledWith(
      1,
      ['PCB_ManufactureData.getPdfFile'],
      'board',
      undefined,
    );
    expect(callFirst).toHaveBeenNthCalledWith(
      2,
      ['PCB_ManufactureData.getPdfFile'],
      undefined,
      undefined,
    );
  });

  it('exports a schematic PDF through the schematic API, never the PCB export', async () => {
    const { callFirst, normalizeBinaryResult, operations } = makeOperations();

    await operations.exportPdf({ what: 'schematic' });
    await operations.exportPdf({ what: 'schematic', fileName: 'main' });

    expect(callFirst).toHaveBeenNthCalledWith(
      1,
      ['SCH_ManufactureData.getExportDocumentFile'],
      undefined,
      'PDF',
    );
    expect(callFirst).toHaveBeenNthCalledWith(
      2,
      ['SCH_ManufactureData.getExportDocumentFile'],
      'main',
      'PDF',
    );
    expect(normalizeBinaryResult).toHaveBeenCalledWith('native-result', 'export.pdf');
  });

  it.each([
    [1, 'SCH_ManufactureData.getNetlistFile'],
    [3, 'PCB_ManufactureData.getNetlistFile'],
  ])(
    'exports the netlist for native document type %i using the correct API signature',
    async (type, path) => {
      const { callFirst, normalizeBinaryResult, readProjectScoped, operations } = makeOperations();
      callFirst.mockImplementation(async (paths) =>
        paths[0] === 'DMT_SelectControl.getCurrentDocumentInfo'
          ? { documentType: type }
          : 'native-result',
      );

      await operations.exportNetlist({ projectId: 'proj-123', format: 'altium' });
      expect(callFirst).toHaveBeenNthCalledWith(1, ['DMT_SelectControl.getCurrentDocumentInfo']);
      expect(callFirst).toHaveBeenNthCalledWith(2, [path], 'proj-123-netlist', 'Protel2');
      expect(readProjectScoped).toHaveBeenCalledWith('proj-123', expect.any(Function), type);
      expect(normalizeBinaryResult).toHaveBeenCalledWith('native-result', 'netlist.altium');
    },
  );

  it.each([
    ['pads', 'PADS'],
    ['allegro', 'Allegro'],
    ['altium', 'Protel2'],
  ])('maps format %s to the vendor netlist enum %s', async (format, expected) => {
    const { callFirst, operations } = makeOperations();
    callFirst.mockImplementation(async (paths) =>
      paths[0] === 'DMT_SelectControl.getCurrentDocumentInfo'
        ? { documentType: 3 }
        : 'native-result',
    );

    await operations.exportNetlist({ projectId: 'proj-123', format });
    expect(callFirst).toHaveBeenNthCalledWith(
      2,
      ['PCB_ManufactureData.getNetlistFile'],
      'proj-123-netlist',
      expected,
    );
  });

  it('fails closed for missing/incorrect document focus and empty native netlist', async () => {
    const { callFirst, normalizeBinaryResult, operations } = makeOperations();
    callFirst.mockResolvedValue({ documentType: 0 });
    await expect(
      operations.exportNetlist({ projectId: 'proj-123', format: 'pads' }),
    ).rejects.toThrow(/active schematic or PCB/);
    expect(callFirst).toHaveBeenCalledTimes(1);
    expect(normalizeBinaryResult).not.toHaveBeenCalled();

    callFirst
      .mockReset()
      .mockImplementation(async (paths) =>
        paths[0] === 'DMT_SelectControl.getCurrentDocumentInfo' ? { documentType: 1 } : undefined,
      );
    await expect(
      operations.exportNetlist({ projectId: 'proj-123', format: 'pads' }),
    ).rejects.toThrow(/did not return a netlist/);
    expect(normalizeBinaryResult).not.toHaveBeenCalled();
  });

  it('rejects missing project IDs and unsupported native netlist formats', async () => {
    const { callFirst, operations } = makeOperations();
    await expect(operations.exportNetlist({ format: 'pads' })).rejects.toThrow(
      /non-empty projectId/,
    );
    await expect(
      operations.exportNetlist({ projectId: 'proj-123', format: 'spice' }),
    ).rejects.toThrow(/format must be/);
    expect(callFirst).not.toHaveBeenCalled();
  });

  it('exports ODB++ in inch with the file name and both kinds of drill holes', async () => {
    const { callFirst, normalizeBinaryResult, operations } = makeOperations();

    await expect(
      operations.exportOdb({ projectId: 'proj-123', fileName: 'board-odb' }),
    ).resolves.toEqual({ value: 'native-result', fileName: 'odb.tgz' });
    expect(callFirst).toHaveBeenCalledWith(
      ['PCB_ManufactureData.getOpenDatabaseDoublePlusFile'],
      'board-odb',
      'inch',
      { metallizedDrilledHoles: true, nonMetallizedDrilledHoles: true },
    );
    expect(normalizeBinaryResult).toHaveBeenCalledWith('native-result', 'odb.tgz');
  });

  it('passes the drill options through and names the file when no name is given', async () => {
    const { callFirst, operations } = makeOperations();

    await operations.exportOdb({
      projectId: 'proj-123',
      platedHoles: false,
      nonPlatedHoles: false,
    });

    expect(callFirst).toHaveBeenCalledWith(
      ['PCB_ManufactureData.getOpenDatabaseDoublePlusFile'],
      'odb',
      'inch',
      { metallizedDrilledHoles: false, nonMetallizedDrilledHoles: false },
    );
  });

  it.each([{}, { projectId: '' }, { projectId: '   ' }])(
    'rejects ODB++ export before the native call when projectId is missing or blank: %j',
    async (params) => {
      const { callFirst, normalizeBinaryResult, operations } = makeOperations();

      await expect(operations.exportOdb(params)).rejects.toThrow(/non-empty projectId/i);
      expect(callFirst).not.toHaveBeenCalled();
      expect(normalizeBinaryResult).not.toHaveBeenCalled();
    },
  );
});

describe('PCB geometry preview export', () => {
  const identity = { documentType: 3, uuid: 'pcb-1', parentProjectUuid: 'project-1' };
  const params = { projectId: 'project-1', pcbId: 'pcb-1' };
  function previewOperations(
    before: unknown = identity,
    after: unknown = identity,
    result: unknown = new Blob(['zip']),
  ) {
    const callFirst = vi
      .fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(result)
      .mockResolvedValueOnce(after);
    const operations = createExportOperations({
      callFirst,
      normalizeBinaryResult: normalize,
      createBridgeError: (_code, message) => new Error(message),
      readProjectScoped: async (_id, read) => read(),
    });
    return { callFirst, operations };
  }

  it('exports only the requested PCB without generating models', async () => {
    const { operations, callFirst } = previewOperations();
    await expect(operations.preview3d(params)).resolves.toMatchObject({
      projectId: 'project-1',
      pcbId: 'pcb-1',
      autoGenerateModels: false,
      base64: 'emlw',
      byteLength: 3,
    });
    expect(callFirst).toHaveBeenNthCalledWith(
      2,
      ['PCB_ManufactureData.get3DFile'],
      'board-3d-preview',
      'obj',
      ['Component Model'],
      'Parts',
      false,
    );
  });

  it('rejects a different focused PCB before exporting', async () => {
    const { operations, callFirst } = previewOperations({ ...identity, uuid: 'other' });
    await expect(operations.preview3d(params)).rejects.toThrow(/focus/i);
    expect(callFirst).toHaveBeenCalledTimes(1);
  });

  it('discards the export if document focus changes', async () => {
    const { operations } = previewOperations(identity, { ...identity, uuid: 'other' });
    await expect(operations.preview3d(params)).rejects.toThrow(/focus/i);
  });

  it.each([undefined, {}, new Blob([]), new Blob([new Uint8Array(700 * 1024 + 1)])])(
    'rejects unavailable or over-budget native bytes',
    async (result) => {
      const { operations } = previewOperations(identity, identity, result ?? null);
      await expect(operations.preview3d(params)).rejects.toThrow(/export/i);
    },
  );
});

describe('design file export', () => {
  function designOperations(documentType: number | undefined, result: unknown) {
    const callFirst = vi.fn(async (paths: string[]) =>
      paths[0] === 'DMT_SelectControl.getCurrentDocumentInfo' ? { documentType } : result,
    );
    const normalizeBinaryResult = vi.fn(async (value, fileName) => ({ value, fileName }));
    const createBridgeError = vi.fn((code: string, message: string, _suggestion: string) =>
      Object.assign(new Error(message), { code }),
    );
    const readProjectScoped = vi.fn(
      async (_projectId: string, read: () => Promise<unknown>, _documentType?: number | null) =>
        read(),
    );
    return {
      callFirst,
      normalizeBinaryResult,
      readProjectScoped,
      operations: createExportOperations({
        callFirst,
        normalizeBinaryResult,
        createBridgeError,
        readProjectScoped,
      }),
    };
  }
  const file = new Blob(['IPC data']);

  it.each([
    ['ipc_d356', 3, 'PCB_ManufactureData.getIpcD356AFile', ['p-ipc_d356'], 'ipc-d-356a.ipc'],
    ['pcb_info', 3, 'PCB_ManufactureData.getPcbInfoFile', ['p-pcb_info'], 'pcb-info.txt'],
    [
      'test_points',
      3,
      'PCB_ManufactureData.getTestPointFile',
      ['p-test_points', 'csv'],
      'test-points.csv',
    ],
    ['pads_layout', 3, 'PCB_ManufactureData.getPadsFile', ['p-pads_layout'], 'pads-layout.asc'],
    ['schematic_svg', 1, 'SCH_ManufactureData.getSvgFile', ['p-schematic_svg'], 'schematic.svg'],
  ])(
    'exports %s from the focused document type %i inside the project scope',
    async (kind, documentType, method, args, fallback) => {
      const { callFirst, normalizeBinaryResult, readProjectScoped, operations } = designOperations(
        documentType,
        file,
      );
      await expect(operations.exportDesignFile({ projectId: 'p', kind })).resolves.toEqual({
        value: file,
        fileName: fallback,
      });
      expect(callFirst).toHaveBeenLastCalledWith([method], ...args);
      expect(normalizeBinaryResult).toHaveBeenCalledWith(file, fallback);
      expect(readProjectScoped).toHaveBeenCalledWith('p', expect.any(Function), documentType);
    },
  );

  it('passes IPC-2581 unit and OEM number, falling back to safe defaults', async () => {
    const { callFirst, operations } = designOperations(3, file);
    await operations.exportDesignFile({
      projectId: 'p',
      kind: 'ipc2581',
      unit: 'inch',
      oemNumber: 'Supplier Part',
    });
    expect(callFirst).toHaveBeenLastCalledWith(
      ['PCB_ManufactureData.getIpc2581CFile'],
      'p-ipc2581',
      'xml',
      'inch',
      'Supplier Part',
    );
    await operations.exportDesignFile({
      projectId: 'p',
      kind: 'ipc2581',
      unit: 'furlong',
      oemNumber: 'anything',
    });
    expect(callFirst).toHaveBeenLastCalledWith(
      ['PCB_ManufactureData.getIpc2581CFile'],
      'p-ipc2581',
      'xml',
      'mm',
      'Manufacturer Part',
    );
  });

  it.each(['', 'placePcbOrder', 'toString', '__proto__', undefined])(
    'rejects unsupported kind %j before any native call',
    async (kind) => {
      const { callFirst, operations } = designOperations(3, file);
      await expect(operations.exportDesignFile({ projectId: 'p', kind })).rejects.toThrow(
        /unsupported design file kind/i,
      );
      expect(callFirst).not.toHaveBeenCalled();
    },
  );

  it('rejects a blank projectId before any native call', async () => {
    const { callFirst, operations } = designOperations(3, file);
    await expect(operations.exportDesignFile({ projectId: ' ', kind: 'ipc_d356' })).rejects.toThrow(
      /non-empty projectId/i,
    );
    expect(callFirst).not.toHaveBeenCalled();
  });

  it.each([
    ['ipc2581', 1],
    ['schematic_svg', 3],
    ['ipc_d356', undefined],
  ])('rejects %s when the wrong document (%s) is focused', async (kind, documentType) => {
    const { callFirst, operations } = designOperations(documentType, file);
    await expect(operations.exportDesignFile({ projectId: 'p', kind })).rejects.toMatchObject({
      code: 'DOCUMENT_NOT_FOCUSED',
    });
    expect(callFirst).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, {}, 'text', new Blob([]), new Blob(['{}'])])(
    'rejects missing or empty native output %#',
    async (result) => {
      const { normalizeBinaryResult, operations } = designOperations(3, result);
      await expect(
        operations.exportDesignFile({ projectId: 'p', kind: 'ipc2581' }),
      ).rejects.toMatchObject({ code: 'EXPORT_NOT_AVAILABLE' });
      expect(normalizeBinaryResult).not.toHaveBeenCalled();
    },
  );
});
