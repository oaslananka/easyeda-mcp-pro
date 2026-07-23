import { describe, expect, it, vi } from 'vitest';
import { createExportOperations } from '../src/export-operations.js';

function makeOperations() {
  const callFirst = vi.fn(async () => 'native-result');
  const normalizeBinaryResult = vi.fn(async (value, fileName) => ({ value, fileName }));
  return {
    callFirst,
    normalizeBinaryResult,
    operations: createExportOperations({ callFirst, normalizeBinaryResult }),
  };
}

describe('export operations', () => {
  it('exports Gerbers with the original API path, params, and fallback name', async () => {
    const { callFirst, normalizeBinaryResult, operations } = makeOperations();
    const params = { includeDrill: true };

    await expect(operations.exportGerbers(params)).resolves.toEqual({
      value: 'native-result',
      fileName: 'gerbers.zip',
    });
    expect(callFirst).toHaveBeenCalledWith(['PCB_ManufactureData.getGerberFile'], params);
    expect(normalizeBinaryResult).toHaveBeenCalledWith('native-result', 'gerbers.zip');
  });

  it('exports route context with only a string file name', async () => {
    const { callFirst, operations } = makeOperations();

    await operations.exportRouteContext({ fileName: 'board.dsn' });
    await operations.exportRouteContext({ fileName: 42 });

    expect(callFirst).toHaveBeenNthCalledWith(1, ['PCB_ManufactureData.getDsnFile'], 'board.dsn');
    expect(callFirst).toHaveBeenNthCalledWith(2, ['PCB_ManufactureData.getDsnFile'], undefined);
  });

  it('preserves pick-and-place format fallback behavior', async () => {
    const { normalizeBinaryResult, operations } = makeOperations();

    await operations.exportPickPlace({ format: 'tsv' });
    await operations.exportPickPlace({ format: 7 });

    expect(normalizeBinaryResult).toHaveBeenNthCalledWith(1, 'native-result', 'pick-place.tsv');
    expect(normalizeBinaryResult).toHaveBeenNthCalledWith(2, 'native-result', 'pick-place.csv');
  });

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
