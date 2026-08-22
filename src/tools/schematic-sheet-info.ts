import type { SchematicReadScope } from './schematic-read-scope.js';
import { resolveSheetInfoScope } from './schematic-read-scope.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasLegacySheetData(root: Record<string, unknown>): boolean {
  return [
    'uuid',
    'name',
    'width',
    'height',
    'pageWidth',
    'pageHeight',
    'paperWidth',
    'paperHeight',
    'frame',
    'titleBlock',
    'origin',
    'canvasOrigin',
    'grid',
    'gridSize',
  ].some((key) => root[key] !== undefined && root[key] !== null);
}

function firstNumber(
  current: Record<string, unknown>,
  root: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = current[key] ?? root[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') continue;
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstString(
  current: Record<string, unknown>,
  root: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = current[key] ?? root[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function sheetGeometry(current: Record<string, unknown>, root: Record<string, unknown>) {
  const width = firstNumber(current, root, ['width', 'pageWidth', 'paperWidth', 'w']);
  const height = firstNumber(current, root, ['height', 'pageHeight', 'paperHeight', 'h']);
  const unit = firstString(current, root, ['unit', 'units', 'pageUnit']);
  const frame = current.frame ?? current.titleBlock ?? root.frame;
  const origin = current.origin ?? current.canvasOrigin ?? root.origin;
  const grid = current.grid ?? current.gridSize ?? root.grid;
  const available = [width, height, unit, frame, origin, grid].some((value) => value !== undefined);
  return {
    available,
    pageSize:
      width !== undefined || height !== undefined || unit !== undefined
        ? { width, height, unit }
        : undefined,
    frame,
    origin,
    grid,
  };
}

function metadataFields(root: Record<string, unknown>) {
  return {
    ...(root.focusedDocument !== undefined ? { focused_document: root.focusedDocument } : {}),
    ...(root.diagnostics !== undefined ? { diagnostics: root.diagnostics } : {}),
  };
}

function formatCurrentSheetInfo(
  result: unknown,
  root: Record<string, unknown>,
  current: Record<string, unknown>,
  projectId: string | undefined,
  scope: SchematicReadScope | undefined,
  resolved: ReturnType<typeof resolveSheetInfoScope>,
) {
  const geometry = sheetGeometry(current, root);
  const metadataSource =
    resolved.metadataSource ?? (typeof root.source === 'string' ? root.source : undefined);
  const warning = geometry.available
    ? undefined
    : scope === 'page'
      ? 'Selected schematic page identity is available, but this EasyEDA runtime did not expose page geometry.'
      : 'Focused schematic page identity is available, but this EasyEDA runtime did not expose page geometry.';
  return {
    project_id: projectId,
    sheet: current,
    ...(resolved.readScope ? { read_scope: resolved.readScope } : {}),
    ...(geometry.pageSize ? { page_size: geometry.pageSize } : {}),
    ...(geometry.frame !== undefined ? { frame: geometry.frame } : {}),
    ...(geometry.origin !== undefined ? { origin: geometry.origin } : {}),
    ...(geometry.grid !== undefined ? { grid: geometry.grid } : {}),
    raw: result,
    ...(metadataSource ? { metadata_source: metadataSource } : {}),
    ...metadataFields(root),
    geometry_available: geometry.available,
    ...(warning ? { warning } : {}),
  };
}

export function formatSchematicSheetInfo(
  result: unknown,
  projectId: string | undefined,
  scope?: SchematicReadScope,
  pageUuid?: string,
) {
  const root = record(result) ?? {};
  const resolved = resolveSheetInfoScope(root, scope, pageUuid);
  if (resolved.allPages) {
    return {
      project_id: projectId,
      pages: resolved.pages,
      read_scope: resolved.readScope,
      metadata_source: resolved.metadataSource,
      ...metadataFields(root),
      raw: result,
      geometry_available: false,
    };
  }
  const current = resolved.current ?? (!scope && hasLegacySheetData(root) ? root : undefined);
  if (!current) {
    return {
      project_id: projectId,
      geometry_available: false,
      not_available: true,
      diagnostics: root.diagnostics,
      error: 'EasyEDA did not expose metadata for the focused schematic page.',
    };
  }
  return formatCurrentSheetInfo(result, root, current, projectId, scope, resolved);
}
