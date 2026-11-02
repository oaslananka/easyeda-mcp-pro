import { describe, expect, it, vi } from 'vitest';
import { createExportOperations } from '../src/export-operations.js';

function makeOperations() {
  const callFirst = vi.fn(async () => 'native-result');
  const normalizeBinaryResult = vi.fn(async (value, fileName) => ({ value, fileName }));
  const createBridgeError = vi.fn(
    (_code: string, message: string, _suggestion: string) => new Error(message),
  );
  return {
    callFirst,
    normalizeBinaryResult,
    createBridgeError,
    operations: createExportOperations({ callFirst, normalizeBinaryResult, createBridgeError }),
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
      const { callFirst, normalizeBinaryResult, operations } = makeOperations();
      callFirst.mockImplementation(async (paths) =>
        paths[0] === 'DMT_SelectControl.getCurrentDocumentInfo'
          ? { documentType: type }
          : 'native-result',
      );

      await operations.exportNetlist({ projectId: 'proj-123', format: 'altium' });
      expect(callFirst).toHaveBeenNthCalledWith(1, ['DMT_SelectControl.getCurrentDocumentInfo']);
      expect(callFirst).toHaveBeenNthCalledWith(2, [path], 'proj-123-netlist', 'Protel2');
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
