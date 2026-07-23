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

function nativeScalarString(value: unknown): string {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
    ? String(value)
    : '';
}

function readFocusedPageUuid(
  focusedDocument: Record<string, unknown> | undefined,
): string | undefined {
  const uuid = focusedDocument?.uuid;
  return typeof uuid === 'string' && uuid.trim() ? uuid : undefined;
}

function mergeSchematicPages(
  pages: Array<Record<string, unknown>>,
  currentSchematic: Record<string, unknown> | undefined,
): Array<Record<string, unknown>> {
  if (pages.length > 0) return pages;
  const schematicPages = asRecordArray(currentSchematic?.page);
  return schematicPages.length > 0 ? schematicPages : pages;
}

function resolveCurrentPage(
  currentPage: Record<string, unknown> | undefined,
  focusedDocumentPage: Record<string, unknown> | undefined,
  focusedPageUuid: string | undefined,
  pages: Array<Record<string, unknown>>,
  currentSchematic: Record<string, unknown> | undefined,
): { currentPage?: Record<string, unknown>; source?: SheetInfoSource } {
  if (currentPage) return { currentPage, source: 'current_page' };
  if (focusedDocumentPage) {
    return { currentPage: focusedDocumentPage, source: 'focused_document' };
  }
  const matchedPage = focusedPageUuid
    ? pages.find((page) => page.uuid === focusedPageUuid)
    : undefined;
  if (matchedPage) return { currentPage: matchedPage, source: 'focused_document' };
  if (pages.length === 1 && currentSchematic) {
    return { currentPage: pages[0], source: 'current_schematic_page_list' };
  }
  return {};
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

  async function readSheetPages(
    attempts: SheetInfoAttempt[],
  ): Promise<Array<Record<string, unknown>>> {
    const currentPages = asRecordArray(
      await trySheetInfoCall(
        'current_page_list',
        ['DMT_Schematic.getCurrentSchematicAllSchematicPagesInfo'],
        attempts,
      ),
    );
    if (currentPages.length > 0) return currentPages;
    return asRecordArray(
      await trySheetInfoCall('all_page_list', ['DMT_Schematic.getAllSchematicPagesInfo'], attempts),
    );
  }

  async function readCurrentSchematicIfNeeded(
    currentPage: Record<string, unknown> | undefined,
    pages: Array<Record<string, unknown>>,
    attempts: SheetInfoAttempt[],
  ): Promise<Record<string, unknown> | undefined> {
    if (currentPage && pages.length > 0) return undefined;
    return asNonEmptyRecord(
      await trySheetInfoCall(
        'current_schematic',
        ['DMT_Schematic.getCurrentSchematicInfo'],
        attempts,
      ),
    );
  }

  async function readFocusedDocumentPage(
    currentPage: Record<string, unknown> | undefined,
    focusedPageUuid: string | undefined,
    attempts: SheetInfoAttempt[],
  ): Promise<Record<string, unknown> | undefined> {
    if (currentPage || !focusedPageUuid) return undefined;
    return asNonEmptyRecord(
      await trySheetInfoCall(
        'focused_document_page',
        ['DMT_Schematic.getSchematicPageInfo'],
        attempts,
        focusedPageUuid,
      ),
    );
  }

  async function getSheetInfo(): Promise<unknown> {
    const attempts: SheetInfoAttempt[] = [];
    const initialCurrentPage = asNonEmptyRecord(
      await trySheetInfoCall(
        'current_page',
        ['DMT_Schematic.getCurrentSchematicPageInfo'],
        attempts,
      ),
    );
    const initialPages = await readSheetPages(attempts);
    const focusedDocument = asNonEmptyRecord(
      await trySheetInfoCall(
        'focused_document',
        ['DMT_SelectControl.getCurrentDocumentInfo'],
        attempts,
      ),
    );
    const focusedPageUuid = readFocusedPageUuid(focusedDocument);
    const currentSchematic = await readCurrentSchematicIfNeeded(
      initialCurrentPage,
      initialPages,
      attempts,
    );
    const focusedDocumentPage = await readFocusedDocumentPage(
      initialCurrentPage,
      focusedPageUuid,
      attempts,
    );
    const pages = mergeSchematicPages(initialPages, currentSchematic);
    const resolution = resolveCurrentPage(
      initialCurrentPage,
      focusedDocumentPage,
      focusedPageUuid,
      pages,
      currentSchematic,
    );
    const diagnostics = {
      stage: 'focused_sheet_resolution',
      currentPageAvailable: Boolean(resolution.currentPage),
      pageListAvailable: pages.length > 0,
      focusedDocumentAvailable: Boolean(focusedDocument),
      attempts,
    };

    if (!resolution.currentPage) {
      throw createBridgeError(
        'SHEET_INFO_UNAVAILABLE',
        'EasyEDA did not expose metadata for the focused schematic page.',
        'Focus the schematic editor tab and retry. The diagnostics identify which runtime paths were empty or unavailable.',
        diagnostics,
      );
    }

    return {
      currentPage: resolution.currentPage,
      pages,
      source: resolution.source,
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
          extractPrimitiveId(rectangle) || nativeScalarString(readState(rectangle, 'PrimitiveId')),
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
