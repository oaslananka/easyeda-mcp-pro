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

  const p = 'PCB_ManufactureData.';

  async function exportFile(
    paths: string[],
    fileName: string,
    ...args: unknown[]
  ): Promise<unknown> {
    return normalizeBinaryResult(await callFirst(paths, ...args), fileName);
  }

  async function exportGerbers(params: Record<string, unknown>): Promise<unknown> {
    return exportFile(
      [p + 'getGerberFile'],
      'gerbers.zip',
      requireProjectId(params, 'Gerber export'),
    );
  }

  async function exportRouteContext(params: Record<string, unknown>): Promise<unknown> {
    return exportFile(
      [p + 'getDsnFile'],
      'route-context.dsn',
      typeof params.fileName === 'string' ? params.fileName : undefined,
    );
  }

  async function exportPickPlace(params: Record<string, unknown>): Promise<unknown> {
    return exportFile(
      [p + 'getPickAndPlaceFile'],
      'pick-place.' + (typeof params.format === 'string' ? params.format : 'csv'),
      requireProjectId(params, 'Pick-and-place export'),
      'csv',
    );
  }

  async function exportPdf(params: Record<string, unknown>): Promise<unknown> {
    return exportFile(
      [
        params.what === 'schematic'
          ? 'SCH_ManufactureData.getExportDocumentFile'
          : p + 'getPdfFile',
      ],
      'export.pdf',
      params.fileName,
      params.what === 'schematic' ? 'PDF' : undefined,
    );
  }

  async function exportNetlist(params: Record<string, unknown>): Promise<unknown> {
    const projectId = requireProjectId(params, 'Netlist export');
    const format = params.format;
    const nativeType =
      format === 'pads'
        ? 'PADS'
        : format === 'allegro'
          ? 'Allegro'
          : format === 'altium'
            ? 'Protel2'
            : undefined;
    if (!nativeType) {
      throw createBridgeError(
        'INVALID_PARAMS',
        'Netlist format must be pads, allegro, or altium.',
        'Choose a supported netlist format.',
      );
    }

    // Both documented manufacture-data methods take (fileName, nativeType).
    const info = (await callFirst(['DMT_SelectControl.getCurrentDocumentInfo'])) as
      { documentType?: number } | undefined;
    if (info?.documentType !== 1 && info?.documentType !== 3) {
      throw createBridgeError(
        'DOCUMENT_NOT_FOCUSED',
        'Netlist export requires an active schematic or PCB document.',
        'Open a schematic or PCB document, then retry.',
      );
    }
    const target = `${info.documentType === 1 ? 'SCH' : 'PCB'}_ManufactureData.getNetlistFile`;
    const result = await callFirst([target], projectId + '-netlist', nativeType);
    if (result == null) {
      throw createBridgeError(
        'NETLIST_NOT_AVAILABLE',
        'EasyEDA did not return a netlist file for the active document.',
        'Check the native document focus and try again.',
      );
    }
    return normalizeBinaryResult(result, 'netlist.' + format);
  }

  // Beta EasyEDA ODB++ export; this is not manufacturing verification.
  async function exportOdb(params: Record<string, unknown>): Promise<unknown> {
    requireProjectId(params, 'ODB++ export');
    return exportFile(
      [p + 'getOpenDatabaseDoublePlusFile'],
      'odb.tgz',
      (typeof params.fileName === 'string' && params.fileName.trim()) || 'odb',
      'inch',
      {
        metallizedDrilledHoles: params.platedHoles !== false,
        nonMetallizedDrilledHoles: params.nonPlatedHoles !== false,
      },
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
