import type { ApiRuntime, BridgeErrorFactory } from './api-runtime.js';
import { isBlobLike, type BinaryResultNormalizer } from './binary-result.js';
import type { PcbReadOperations } from './pcb-read-operations.js';

export interface ExportOperationDependencies {
  callFirst: ApiRuntime['callFirst'];
  normalizeBinaryResult: BinaryResultNormalizer;
  createBridgeError: BridgeErrorFactory;
  readProjectScoped: PcbReadOperations['readProjectScoped'];
}

export interface ExportOperations {
  exportGerbers(params: Record<string, unknown>): Promise<unknown>;
  exportRouteContext(params: Record<string, unknown>): Promise<unknown>;
  exportPickPlace(params: Record<string, unknown>): Promise<unknown>;
  exportPdf(params: Record<string, unknown>): Promise<unknown>;
  exportNetlist(params: Record<string, unknown>): Promise<unknown>;
  exportOdb(params: Record<string, unknown>): Promise<unknown>;
  exportDesignFile(params: Record<string, unknown>): Promise<unknown>;
  preview3d(params: Record<string, unknown>): Promise<unknown>;
  export3d(params: Record<string, unknown>): Promise<unknown>;
}

/** Native document types reported by DMT_SelectControl.getCurrentDocumentInfo. */
const SCHEMATIC_DOCUMENT = 1;
const PCB_DOCUMENT = 3;

interface DesignFileSpec {
  /** Document that must be focused, because the native export reads the focused document. */
  documentType: typeof SCHEMATIC_DOCUMENT | typeof PCB_DOCUMENT;
  method: string;
  fallbackFileName: string;
  args: (fileName: string, params: Record<string, unknown>) => unknown[];
}

const IPC2581_OEM_NUMBERS = ['Device', 'Manufacturer Part', 'Supplier Part', 'Comment'];

/**
 * Reviewed allowlist of documented (beta) manufacture-data file exports. Only these
 * native methods are reachable through export.designFile; ordering methods and other
 * PCB_ManufactureData members are deliberately absent.
 */
export const DESIGN_FILE_SPECS: Readonly<Record<string, DesignFileSpec>> = {
  ipc2581: {
    documentType: PCB_DOCUMENT,
    method: 'PCB_ManufactureData.getIpc2581CFile',
    fallbackFileName: 'ipc-2581c.xml',
    args: (fileName, params) => [
      fileName,
      'xml',
      params.unit === 'inch' ? 'inch' : 'mm',
      IPC2581_OEM_NUMBERS.includes(params.oemNumber as string)
        ? params.oemNumber
        : 'Manufacturer Part',
    ],
  },
  ipc_d356: {
    documentType: PCB_DOCUMENT,
    method: 'PCB_ManufactureData.getIpcD356AFile',
    fallbackFileName: 'ipc-d-356a.ipc',
    args: (fileName) => [fileName],
  },
  pcb_info: {
    documentType: PCB_DOCUMENT,
    method: 'PCB_ManufactureData.getPcbInfoFile',
    fallbackFileName: 'pcb-info.txt',
    args: (fileName) => [fileName],
  },
  test_points: {
    documentType: PCB_DOCUMENT,
    method: 'PCB_ManufactureData.getTestPointFile',
    fallbackFileName: 'test-points.csv',
    args: (fileName) => [fileName, 'csv'],
  },
  pads_layout: {
    documentType: PCB_DOCUMENT,
    method: 'PCB_ManufactureData.getPadsFile',
    fallbackFileName: 'pads-layout.asc',
    args: (fileName) => [fileName],
  },
  schematic_svg: {
    documentType: SCHEMATIC_DOCUMENT,
    method: 'SCH_ManufactureData.getSvgFile',
    fallbackFileName: 'schematic.svg',
    args: (fileName) => [fileName],
  },
};

/** getIpc2581CFile documents a 2-byte empty file (no error) on failure; treat tiny files as failures. */
const MIN_DESIGN_FILE_BYTES = 3;

export function createExportOperations({
  callFirst,
  normalizeBinaryResult,
  createBridgeError,
  readProjectScoped,
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
    // Native netlist generation uses the focused document, not the file-name argument.
    // Never return bytes until the requested project and document identity have been
    // verified before and after generation and binary normalization.
    return readProjectScoped(
      projectId,
      async () => {
        const result = await callFirst([target], projectId + '-netlist', nativeType);
        if (result == null) {
          throw createBridgeError(
            'NETLIST_NOT_AVAILABLE',
            'EasyEDA did not return a netlist file for the active document.',
            'Check the native document focus and try again.',
          );
        }
        return normalizeBinaryResult(result, 'netlist.' + format);
      },
      info.documentType,
    );
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

  // Additional documented manufacture-data files (IPC-2581C, IPC-D-356A, ...). Each is
  // generated from the focused document, so require the matching document type and keep
  // the project identity stable across generation before returning any bytes.
  async function exportDesignFile(params: Record<string, unknown>): Promise<unknown> {
    const projectId = requireProjectId(params, 'Design file export');
    const kind = typeof params.kind === 'string' ? params.kind : '';
    const spec = Object.prototype.hasOwnProperty.call(DESIGN_FILE_SPECS, kind)
      ? DESIGN_FILE_SPECS[kind]
      : undefined;
    if (!spec) {
      throw createBridgeError(
        'INVALID_PARAMS',
        `Unsupported design file kind: ${kind || '(missing)'}.`,
        `Choose one of: ${Object.keys(DESIGN_FILE_SPECS).join(', ')}.`,
      );
    }
    const info = (await callFirst(['DMT_SelectControl.getCurrentDocumentInfo'])) as
      { documentType?: number } | undefined;
    if (info?.documentType !== spec.documentType) {
      const label = spec.documentType === PCB_DOCUMENT ? 'PCB' : 'schematic';
      throw createBridgeError(
        'DOCUMENT_NOT_FOCUSED',
        `${kind} export requires the ${label} document to be focused.`,
        `Activate the ${label} document, then retry.`,
      );
    }
    const fileName =
      (typeof params.fileName === 'string' && params.fileName.trim()) || `${projectId}-${kind}`;
    return readProjectScoped(
      projectId,
      async () => {
        const result = await callFirst([spec.method], ...spec.args(fileName, params));
        if (
          !isBlobLike(result) ||
          !Number.isSafeInteger(result.size) ||
          result.size < MIN_DESIGN_FILE_BYTES
        ) {
          throw createBridgeError(
            'EXPORT_NOT_AVAILABLE',
            `EasyEDA did not return a ${kind} file for the focused document.`,
            'Check the document content and EasyEDA version, then retry.',
          );
        }
        return normalizeBinaryResult(result, spec.fallbackFileName);
      },
      spec.documentType,
    );
  }

  const ELEMENTS_3D = ['Component Model', 'Via', 'Silkscreen', 'Wire In Signal Layer'];

  // 3D model of the focused PCB (PCB_ManufactureData.get3DFile, beta). Only component models
  // imported as STEP appear in a STEP export; autoGenerateModels boxes the others by height.
  async function export3d(params: Record<string, unknown>): Promise<unknown> {
    const projectId = requireProjectId(params, '3D export');
    const info = (await callFirst(['DMT_SelectControl.getCurrentDocumentInfo'])) as
      { documentType?: number; parentProjectUuid?: string } | undefined;
    if (info?.documentType !== 3) {
      throw createBridgeError(
        'DOCUMENT_NOT_FOCUSED',
        '3D export requires the PCB document to be focused.',
        'Activate the PCB document, then retry.',
      );
    }
    // The native 3D export is scoped to the focused PCB, not the supplied projectId.
    // Reject absent or mismatched native identity before requesting the file.
    if (info.parentProjectUuid !== projectId) {
      throw createBridgeError(
        'PROJECT_MISMATCH',
        'The focused PCB does not belong to the requested project.',
        'Select the intended project and focus its PCB before exporting.',
      );
    }
    const fileType = params.fileType === 'obj' ? 'obj' : 'step';
    const elements = Array.isArray(params.elements)
      ? params.elements.filter((e): e is string => ELEMENTS_3D.includes(e as string))
      : ['Component Model'];
    const result = await callFirst(
      [p + 'get3DFile'],
      (typeof params.fileName === 'string' && params.fileName.trim()) || 'board-3d',
      fileType,
      elements,
      params.modelMode === 'Parts' ? 'Parts' : 'Outfit',
      params.autoGenerateModels !== false,
    );
    if (result == null) {
      throw createBridgeError(
        'EXPORT_NOT_AVAILABLE',
        'EasyEDA did not return a 3D file for the focused PCB.',
        'Check that the PCB has an outline, then retry.',
      );
    }
    return normalizeBinaryResult(result, fileType === 'obj' ? 'board.obj' : 'board.step');
  }

  async function preview3d(params: Record<string, unknown>): Promise<unknown> {
    const projectId = requireProjectId(params, '3D preview');
    const pcbId = typeof params.pcbId === 'string' ? params.pcbId.trim() : '';
    if (!pcbId) {
      throw createBridgeError('INVALID_PARAMS', '3D preview requires a PCB ID.', 'Specify pcbId.');
    }
    const verifyFocus = async () => {
      const info = (await callFirst(['DMT_SelectControl.getCurrentDocumentInfo'])) as
        { documentType?: number; parentProjectUuid?: string; uuid?: string } | undefined;
      if (info?.documentType !== 3 || info.parentProjectUuid !== projectId || info.uuid !== pcbId) {
        throw createBridgeError(
          'DOCUMENT_NOT_FOCUSED',
          'Requested PCB is not focused.',
          'Focus the requested PCB and retry.',
        );
      }
    };
    return readProjectScoped(
      projectId,
      async () => {
        await verifyFocus();
        const result = await callFirst(
          [p + 'get3DFile'],
          'board-3d-preview',
          'obj',
          ['Component Model'],
          'Parts',
          false,
        );
        if (
          !isBlobLike(result) ||
          !Number.isSafeInteger(result.size) ||
          result.size <= 0 ||
          result.size > 700 * 1024
        ) {
          throw createBridgeError(
            'EXPORT_NOT_AVAILABLE',
            'Native OBJ export is unavailable or exceeds the preview budget.',
            'Check the board outline and model export; use regular 3D export for larger boards.',
          );
        }
        const binary = await normalizeBinaryResult(result, 'board-3d-preview.zip');
        await verifyFocus();
        return {
          ...(binary as Record<string, unknown>),
          projectId,
          pcbId,
          autoGenerateModels: false,
        };
      },
      3,
    );
  }

  return {
    preview3d,
    export3d,
    exportGerbers,
    exportRouteContext,
    exportPickPlace,
    exportPdf,
    exportNetlist,
    exportOdb,
    exportDesignFile,
  };
}
