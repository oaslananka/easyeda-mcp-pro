import type { ApiRuntime } from './api-runtime.js';
import { normalizeValue } from './api-introspection.js';
import { isRecord, logRecoverableError } from './utils.js';

interface RawPrimitiveBBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

type SheetInfoSource = 'current_page' | 'focused_document' | 'current_schematic_page_list';

type SheetInfoAttempt = {
  stage: string;
  status: 'value' | 'empty' | 'unavailable';
  error?: string;
};

export interface SchematicInspectionOperationDependencies {
  callFirst: ApiRuntime['callFirst'];
  readFirstPath<T>(paths: readonly string[]): T | undefined;
  readState(value: unknown, key: string): unknown;
  extractPrimitiveId(value: unknown): string;
  createBridgeError(code: string, message: string, suggestion: string, data?: unknown): Error;
}

export interface SchematicInspectionOperations {
  primitiveBounds(primitiveIds: unknown): Promise<unknown>;
  getSheetInfo(): Promise<unknown>;
  listRectangles(): Promise<unknown>;
}

function asNonEmptyRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || Object.keys(value).length === 0) return undefined;
  return value;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => isRecord(item));
}

export function createSchematicInspectionOperations({
  callFirst,
  readFirstPath,
  readState,
  extractPrimitiveId,
  createBridgeError,
}: SchematicInspectionOperationDependencies): SchematicInspectionOperations {
  async function primitiveBounds(primitiveIds: unknown): Promise<unknown> {
    const schematicPrimitiveClass = readFirstPath<{
      getPrimitivesBBox(ids: string[]): Promise<RawPrimitiveBBox | null | undefined>;
    }>(['SCH_Primitive', 'sch_Primitive']);
    if (!schematicPrimitiveClass) {
      throw new Error('SCH_Primitive class not found in EasyEDA Pro API');
    }
    const ids = Array.isArray(primitiveIds)
      ? primitiveIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];

    const items: Array<{ primitiveId: string; bounds: RawPrimitiveBBox | null }> = [];
    for (const id of ids) {
      let bounds: RawPrimitiveBBox | null = null;
      try {
        bounds = (await schematicPrimitiveClass.getPrimitivesBBox([id])) ?? null;
      } catch (error) {
        logRecoverableError(`failed to read bounding box for primitive ${id}`, error);
      }
      items.push({ primitiveId: id, bounds });
    }

    let combined: RawPrimitiveBBox | null = null;
    if (ids.length > 0) {
      try {
        combined = (await schematicPrimitiveClass.getPrimitivesBBox(ids)) ?? null;
      } catch (error) {
        logRecoverableError('failed to read combined bounding box', error);
      }
    }

    return { items, combined };
  }

  async function trySheetInfoCall(
    stage: string,
    paths: string[],
    attempts: SheetInfoAttempt[],
    ...args: unknown[]
  ): Promise<unknown> {
    try {
      const value = normalizeValue(await callFirst(paths, ...args), 5);
      const meaningful = Array.isArray(value)
        ? value.length > 0
        : Boolean(asNonEmptyRecord(value)) || (value !== null && value !== undefined);
      attempts.push({ stage, status: meaningful ? 'value' : 'empty' });
      return value;
    } catch (error) {
      attempts.push({
        stage,
        status: 'unavailable',
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async function getSheetInfo(): Promise<unknown> {
    const attempts: SheetInfoAttempt[] = [];
    let source: SheetInfoSource | undefined;

    let currentPage = asNonEmptyRecord(
      await trySheetInfoCall(
        'current_page',
        ['DMT_Schematic.getCurrentSchematicPageInfo'],
        attempts,
      ),
    );
    if (currentPage) source = 'current_page';

    let pages = asRecordArray(
      await trySheetInfoCall(
        'current_page_list',
        ['DMT_Schematic.getCurrentSchematicAllSchematicPagesInfo'],
        attempts,
      ),
    );
    if (pages.length === 0) {
      pages = asRecordArray(
        await trySheetInfoCall(
          'all_page_list',
          ['DMT_Schematic.getAllSchematicPagesInfo'],
          attempts,
        ),
      );
    }

    const focusedDocument = asNonEmptyRecord(
      await trySheetInfoCall(
        'focused_document',
        ['DMT_SelectControl.getCurrentDocumentInfo'],
        attempts,
      ),
    );
    const focusedPageUuid =
      typeof focusedDocument?.uuid === 'string' && focusedDocument.uuid.trim()
        ? focusedDocument.uuid
        : undefined;

    let currentSchematic: Record<string, unknown> | undefined;
    if (!currentPage || pages.length === 0) {
      currentSchematic = asNonEmptyRecord(
        await trySheetInfoCall(
          'current_schematic',
          ['DMT_Schematic.getCurrentSchematicInfo'],
          attempts,
        ),
      );
    }

    if (!currentPage && focusedPageUuid) {
      currentPage = asNonEmptyRecord(
        await trySheetInfoCall(
          'focused_document_page',
          ['DMT_Schematic.getSchematicPageInfo'],
          attempts,
          focusedPageUuid,
        ),
      );
      if (currentPage) source = 'focused_document';
    }

    const schematicPages = asRecordArray(currentSchematic?.page);
    if (pages.length === 0 && schematicPages.length > 0) pages = schematicPages;

    if (!currentPage && focusedPageUuid && pages.length > 0) {
      currentPage = pages.find((page) => page.uuid === focusedPageUuid);
      if (currentPage) source = 'focused_document';
    }

    if (!currentPage && pages.length === 1 && currentSchematic) {
      currentPage = pages[0];
      source = 'current_schematic_page_list';
    }

    const diagnostics = {
      stage: 'focused_sheet_resolution',
      currentPageAvailable: Boolean(currentPage),
      pageListAvailable: pages.length > 0,
      focusedDocumentAvailable: Boolean(focusedDocument),
      attempts,
    };

    if (!currentPage) {
      throw createBridgeError(
        'SHEET_INFO_UNAVAILABLE',
        'EasyEDA did not expose metadata for the focused schematic page.',
        'Focus the schematic editor tab and retry. The diagnostics identify which runtime paths were empty or unavailable.',
        diagnostics,
      );
    }

    return {
      currentPage,
      pages,
      source,
      focusedDocument,
      diagnostics,
    };
  }

  async function listRectangles(): Promise<unknown> {
    // Best-effort enumeration for section-layout overlap checks. Live verification
    // showed rectangles expose TopLeftX/TopLeftY rather than X/Y, with X/Y kept
    // as compatibility fallbacks for future runtimes.
    //
    // Live verification also showed annotation-layer rectangle Y values are the
    // exact sign inverse of creation coordinates. Negate numeric values so callers
    // receive the same coordinate convention as components, pins, and wires.
    const schematicRectangleClass = readFirstPath<{
      getAll(): Promise<unknown[] | null | undefined>;
    }>(['SCH_PrimitiveRectangle', 'sch_PrimitiveRectangle']);
    if (!schematicRectangleClass || typeof schematicRectangleClass.getAll !== 'function') {
      return { total: 0, items: [] };
    }

    let all: unknown[] = [];
    try {
      all = (await schematicRectangleClass.getAll()) || [];
    } catch (error) {
      logRecoverableError('failed to list rectangles', error);
      all = [];
    }

    const items = all.map((rectangle) => {
      const rawY = readState(rectangle, 'TopLeftY') ?? readState(rectangle, 'Y');
      return {
        primitiveId:
          extractPrimitiveId(rectangle) || String(readState(rectangle, 'PrimitiveId') ?? ''),
        x: readState(rectangle, 'TopLeftX') ?? readState(rectangle, 'X'),
        y: typeof rawY === 'number' ? -rawY : rawY,
        width: readState(rectangle, 'Width'),
        height: readState(rectangle, 'Height'),
        rotation: readState(rectangle, 'Rotation'),
      };
    });
    return { total: items.length, items };
  }

  return { primitiveBounds, getSheetInfo, listRectangles };
}
