import type { ApiRuntime } from './api-runtime.js';
import type { BinaryResultNormalizer } from './binary-result.js';

export interface ExportOperationDependencies {
  callFirst: ApiRuntime['callFirst'];
  normalizeBinaryResult: BinaryResultNormalizer;
}

export interface ExportOperations {
  exportGerbers(params: Record<string, unknown>): Promise<unknown>;
  exportRouteContext(params: Record<string, unknown>): Promise<unknown>;
  exportPickPlace(params: Record<string, unknown>): Promise<unknown>;
  exportPdf(params: Record<string, unknown>): Promise<unknown>;
  exportNetlist(params: Record<string, unknown>): Promise<unknown>;
}

export function createExportOperations({
  callFirst,
  normalizeBinaryResult,
}: ExportOperationDependencies): ExportOperations {
  async function exportGerbers(params: Record<string, unknown>): Promise<unknown> {
    return normalizeBinaryResult(
      await callFirst(['PCB_ManufactureData.getGerberFile'], params),
      'gerbers.zip',
    );
  }

  async function exportRouteContext(params: Record<string, unknown>): Promise<unknown> {
    return normalizeBinaryResult(
      await callFirst(
        ['PCB_ManufactureData.getDsnFile'],
        typeof params.fileName === 'string' ? params.fileName : undefined,
      ),
      'route-context.dsn',
    );
  }

  async function exportPickPlace(params: Record<string, unknown>): Promise<unknown> {
    return normalizeBinaryResult(
      await callFirst(['PCB_ManufactureData.getPickAndPlaceFile'], params),
      `pick-place.${typeof params.format === 'string' ? params.format : 'csv'}`,
    );
  }

  async function exportPdf(params: Record<string, unknown>): Promise<unknown> {
    return normalizeBinaryResult(
      await callFirst(
        ['PCB_ManufactureData.getPdfFile', 'SCH_ManufactureData.getExportDocumentFile'],
        params.what === 'board' ? params : { ...params, type: 'schematic' },
      ),
      'export.pdf',
    );
  }

  async function exportNetlist(params: Record<string, unknown>): Promise<unknown> {
    return normalizeBinaryResult(
      await callFirst(
        [
          'SCH_Netlist.getNetlist',
          'SCH_ManufactureData.getNetlistFile',
          'PCB_ManufactureData.getNetlistFile',
        ],
        params,
      ),
      `netlist.${typeof params.format === 'string' ? params.format : 'txt'}`,
    );
  }

  return {
    exportGerbers,
    exportRouteContext,
    exportPickPlace,
    exportPdf,
    exportNetlist,
  };
}
