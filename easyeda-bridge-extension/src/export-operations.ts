import type { ApiRuntime, BridgeErrorFactory } from './api-runtime.js';
import type { BinaryResultNormalizer } from './binary-result.js';

export interface ExportOperationDependencies {
  callFirst: ApiRuntime['callFirst'];
  normalizeBinaryResult: BinaryResultNormalizer;
  createBridgeError: BridgeErrorFactory;
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
  createBridgeError,
}: ExportOperationDependencies): ExportOperations {
  function requireProjectId(params: Record<string, unknown>, operation: string): string {
    const projectId = typeof params.projectId === 'string' ? params.projectId.trim() : '';
    if (!projectId) {
      throw createBridgeError(
        'INVALID_PARAMS',
        `${operation} requires a non-empty projectId string.`,
        'Provide the current EasyEDA projectId before requesting the export.',
      );
    }
    return projectId;
  }

  async function exportGerbers(params: Record<string, unknown>): Promise<unknown> {
    const projectId = requireProjectId(params, 'Gerber export');
    return normalizeBinaryResult(
      await callFirst(['PCB_ManufactureData.getGerberFile'], projectId),
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
    const projectId = requireProjectId(params, 'Pick-and-place export');
    return normalizeBinaryResult(
      await callFirst(['PCB_ManufactureData.getPickAndPlaceFile'], projectId),
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
