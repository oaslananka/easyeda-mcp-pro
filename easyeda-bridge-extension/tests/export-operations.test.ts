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

  it('uses the original netlist fallback chain and file-name fallback', async () => {
    const { callFirst, normalizeBinaryResult, operations } = makeOperations();
    const params = { format: 'spice', includeModels: true };

    await operations.exportNetlist(params);
    await operations.exportNetlist({ format: false });

    const paths = [
      'SCH_Netlist.getNetlist',
      'SCH_ManufactureData.getNetlistFile',
      'PCB_ManufactureData.getNetlistFile',
    ];
    expect(callFirst).toHaveBeenNthCalledWith(1, paths, params);
    expect(callFirst).toHaveBeenNthCalledWith(2, paths, { format: false });
    expect(normalizeBinaryResult).toHaveBeenNthCalledWith(1, 'native-result', 'netlist.spice');
    expect(normalizeBinaryResult).toHaveBeenNthCalledWith(2, 'native-result', 'netlist.txt');
  });
});
