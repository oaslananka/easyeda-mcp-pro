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
  exportOdb(params: Record<string, unknown>): Promise<unknown>;
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
        `${operation} requires a non-empty projectId.`,
        'Specify a projectId.',
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
    // getPickAndPlaceFile(fileName?, fileType?: 'xlsx' | 'csv', unit?) writes xlsx without a type;
    // both formats of the tool (csv, txt) are CSV text.
    return normalizeBinaryResult(
      await callFirst(['PCB_ManufactureData.getPickAndPlaceFile'], projectId, 'csv'),
      `pick-place.${typeof params.format === 'string' ? params.format : 'csv'}`,
    );
  }

  async function exportPdf(params: Record<string, unknown>): Promise<unknown> {
    return normalizeBinaryResult(
      await callFirst(
        [
          params.what === 'schematic'
            ? 'SCH_ManufactureData.getExportDocumentFile'
            : 'PCB_ManufactureData.getPdfFile',
        ],
        params.fileName,
        params.what === 'schematic' ? 'PDF' : undefined,
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

  // ODB++ (BETA in EasyEDA Pro's API): getOpenDatabaseDoublePlusFile(fileName, unit, otherData, layers, objects).
  // Its unit type admits ESYS_Unit.INCH only; layers and objects default to JLCPCB's production set.
  async function exportOdb(params: Record<string, unknown>): Promise<unknown> {
    requireProjectId(params, 'ODB++ export');
    const fileName =
      typeof params.fileName === 'string' && params.fileName.trim()
        ? params.fileName.trim()
        : 'odb';
    return normalizeBinaryResult(
      await callFirst(['PCB_ManufactureData.getOpenDatabaseDoublePlusFile'], fileName, 'inch', {
        metallizedDrilledHoles: params.platedHoles !== false,
        nonMetallizedDrilledHoles: params.nonPlatedHoles !== false,
      }),
      'odb.tgz',
    );
  }

  return {
    exportGerbers,
    exportRouteContext,
    exportPickPlace,
    exportPdf,
    exportNetlist,
    exportOdb,
  };
}
