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

  it('exports pick-and-place with the projectId string and preserves the output-name fallback', async () => {
    const { callFirst, normalizeBinaryResult, operations } = makeOperations();

    await operations.exportPickPlace({ projectId: 'proj-123', format: 'csv' });
    await operations.exportPickPlace({ projectId: 'proj-456', format: 7 });

    expect(callFirst).toHaveBeenNthCalledWith(
      1,
      ['PCB_ManufactureData.getPickAndPlaceFile'],
      'proj-123',
    );
    expect(callFirst).toHaveBeenNthCalledWith(
      2,
      ['PCB_ManufactureData.getPickAndPlaceFile'],
      'proj-456',
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

  it('keeps board PDF params unchanged and marks every other request schematic', async () => {
    const { callFirst, operations } = makeOperations();
    const boardParams = { what: 'board', pageSize: 'A4' };
    const schematicParams = { what: 'schematic', pageSize: 'A3' };

    await operations.exportPdf(boardParams);
    await operations.exportPdf(schematicParams);

    expect(callFirst).toHaveBeenNthCalledWith(
      1,
      ['PCB_ManufactureData.getPdfFile', 'SCH_ManufactureData.getExportDocumentFile'],
      boardParams,
    );
    expect(callFirst).toHaveBeenNthCalledWith(
      2,
      ['PCB_ManufactureData.getPdfFile', 'SCH_ManufactureData.getExportDocumentFile'],
      { ...schematicParams, type: 'schematic' },
    );
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
