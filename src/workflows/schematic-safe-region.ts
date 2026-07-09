/**
 * Schematic sheet safe-region planner.
 *
 * EasyEDA Pro schematic coordinates observed in live MSI testing use a
 * bottom-left-style sheet origin: larger Y values move objects upward on the
 * page. The default A4 title block occupies the lower/right portion of the
 * frame, so hard-coded low-Y coordinates easily collide with the title block.
 *
 * This module is deliberately pure and conservative. It does not resize the
 * sheet; it returns a safe bounding box/anchor or a blocked plan with reasons
 * that callers can surface before applying any writes.
 */

export type SchematicRegionPreference =
  | 'upper-left'
  | 'upper-center'
  | 'upper-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'lower-left'
  | 'lower-center'
  | 'lower-right';

export interface SchematicRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SchematicPoint {
  x: number;
  y: number;
}

export interface SchematicSheetGeometry {
  width: number;
  height: number;
  unit: string;
  origin: 'bottom-left';
  source: 'sheet-info' | 'default-a4-landscape';
}

export interface SafeSchematicRegionPlanInput {
  sheetInfo?: unknown;
  contentWidth: number;
  contentHeight: number;
  preferredRegion?: SchematicRegionPreference;
  margin?: number;
  titleBlockKeepout?: SchematicRect;
}

export interface SafeSchematicRegionPlan {
  blocked: boolean;
  preferredRegion: SchematicRegionPreference;
  sheet: SchematicSheetGeometry;
  usableBounds: SchematicRect;
  requestedBounds: SchematicRect;
  bounds: SchematicRect;
  anchor: SchematicPoint;
  keepouts: Array<SchematicRect & { kind: 'title-block' }>;
  warnings: string[];
  issues: Array<{ code: string; message: string }>;
}

const DEFAULT_A4_LANDSCAPE = {
  // EasyEDA schematic coordinates are not guaranteed to be true millimetres,
  // but the live A4 frame behaves consistently with this 1189x841-style
  // internal coordinate scale. Prefer runtime sheet-info when available.
  width: 1189,
  height: 841,
  unit: 'easyeda-coordinate',
} as const;

const TITLE_BLOCK_PAGE_SIZES = {
  A4: { width: 1189, height: 841 },
  A3: { width: 1682, height: 1189 },
} as const;

const DEFAULT_MARGIN = 80;

const REGION_ROWS: Record<SchematicRegionPreference, 'upper' | 'center' | 'lower'> = {
  'upper-left': 'upper',
  'upper-center': 'upper',
  'upper-right': 'upper',
  'center-left': 'center',
  center: 'center',
  'center-right': 'center',
  'lower-left': 'lower',
  'lower-center': 'lower',
  'lower-right': 'lower',
};

const REGION_COLUMNS: Record<SchematicRegionPreference, 'left' | 'center' | 'right'> = {
  'upper-left': 'left',
  'upper-center': 'center',
  'upper-right': 'right',
  'center-left': 'left',
  center: 'center',
  'center-right': 'right',
  'lower-left': 'left',
  'lower-center': 'center',
  'lower-right': 'right',
};

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return undefined;
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function readTitleBlockPageSize(
  root: Record<string, unknown>,
  currentOrRoot: Record<string, unknown>,
) {
  const titleBlock = readRecord(currentOrRoot.titleBlockData ?? root.titleBlockData);
  const sizeRecord = readRecord(titleBlock.Size);
  const sizeValue = String(sizeRecord.value ?? '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
  if (sizeValue === 'A3') return TITLE_BLOCK_PAGE_SIZES.A3;
  if (sizeValue === 'A4') return TITLE_BLOCK_PAGE_SIZES.A4;
  return undefined;
}

export function inferSchematicSheetGeometry(sheetInfo: unknown): SchematicSheetGeometry {
  const root = readRecord(sheetInfo);
  const current = readRecord(root.currentPage);
  const currentOrRoot = Object.keys(current).length > 0 ? current : root;
  const pageSize = readRecord(
    root.page_size ?? root.pageSize ?? currentOrRoot.page_size ?? currentOrRoot.pageSize,
  );
  const width =
    readNumber(pageSize, ['width', 'pageWidth', 'paperWidth', 'w']) ??
    readNumber(currentOrRoot, ['width', 'pageWidth', 'paperWidth', 'w', 'Width']) ??
    readNumber(root, ['width', 'pageWidth', 'paperWidth', 'w', 'Width']);
  const height =
    readNumber(pageSize, ['height', 'pageHeight', 'paperHeight', 'h']) ??
    readNumber(currentOrRoot, ['height', 'pageHeight', 'paperHeight', 'h', 'Height']) ??
    readNumber(root, ['height', 'pageHeight', 'paperHeight', 'h', 'Height']);
  const unit =
    readString(pageSize, ['unit', 'units', 'pageUnit']) ??
    readString(currentOrRoot, ['unit', 'units', 'pageUnit']) ??
    readString(root, ['unit', 'units', 'pageUnit']) ??
    DEFAULT_A4_LANDSCAPE.unit;

  if (width !== undefined && height !== undefined) {
    return { width, height, unit, origin: 'bottom-left', source: 'sheet-info' };
  }

  const titleBlockSize = readTitleBlockPageSize(root, currentOrRoot);
  if (titleBlockSize !== undefined) {
    return {
      width: titleBlockSize.width,
      height: titleBlockSize.height,
      unit,
      origin: 'bottom-left',
      source: 'sheet-info',
    };
  }

  return {
    width: DEFAULT_A4_LANDSCAPE.width,
    height: DEFAULT_A4_LANDSCAPE.height,
    unit,
    origin: 'bottom-left',
    source: 'default-a4-landscape',
  };
}

export function defaultTitleBlockKeepout(sheet: SchematicSheetGeometry): SchematicRect {
  return {
    x: sheet.width * 0.55,
    y: 0,
    width: sheet.width * 0.45,
    height: sheet.height * 0.26,
  };
}

export function rectsOverlap(a: SchematicRect, b: SchematicRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function candidateBounds(
  usable: SchematicRect,
  width: number,
  height: number,
  preference: SchematicRegionPreference,
): SchematicRect {
  const column = REGION_COLUMNS[preference];
  const row = REGION_ROWS[preference];
  const x =
    column === 'left'
      ? usable.x
      : column === 'center'
        ? usable.x + (usable.width - width) / 2
        : usable.x + usable.width - width;
  const y =
    row === 'lower'
      ? usable.y
      : row === 'center'
        ? usable.y + (usable.height - height) / 2
        : usable.y + usable.height - height;
  return { x, y, width, height };
}

function clampBoundsToUsable(bounds: SchematicRect, usable: SchematicRect): SchematicRect {
  return {
    ...bounds,
    x: Math.min(Math.max(bounds.x, usable.x), usable.x + usable.width - bounds.width),
    y: Math.min(Math.max(bounds.y, usable.y), usable.y + usable.height - bounds.height),
  };
}

const FALLBACK_REGIONS: SchematicRegionPreference[] = [
  'upper-left',
  'upper-center',
  'center-left',
  'center',
  'upper-right',
  'center-right',
  'lower-left',
  'lower-center',
  'lower-right',
];

export function planSafeSchematicRegion(
  input: SafeSchematicRegionPlanInput,
): SafeSchematicRegionPlan {
  const sheet = inferSchematicSheetGeometry(input.sheetInfo);
  const margin = input.margin ?? DEFAULT_MARGIN;
  const preferredRegion = input.preferredRegion ?? 'upper-left';
  const keepout = {
    ...(input.titleBlockKeepout ?? defaultTitleBlockKeepout(sheet)),
    kind: 'title-block' as const,
  };
  const usableBounds: SchematicRect = {
    x: margin,
    y: margin,
    width: Math.max(0, sheet.width - margin * 2),
    height: Math.max(0, sheet.height - margin * 2),
  };

  const issues: SafeSchematicRegionPlan['issues'] = [];
  const warnings: string[] = [];

  if (input.contentWidth <= 0 || input.contentHeight <= 0) {
    issues.push({
      code: 'INVALID_CONTENT_SIZE',
      message: 'contentWidth and contentHeight must be positive.',
    });
  }
  if (input.contentWidth > usableBounds.width || input.contentHeight > usableBounds.height) {
    issues.push({
      code: 'CONTENT_DOES_NOT_FIT_USABLE_BOUNDS',
      message: `Requested content ${input.contentWidth}x${input.contentHeight} exceeds usable sheet bounds ${usableBounds.width}x${usableBounds.height}.`,
    });
  }

  const requestedBounds = clampBoundsToUsable(
    candidateBounds(usableBounds, input.contentWidth, input.contentHeight, preferredRegion),
    usableBounds,
  );

  let bounds = requestedBounds;
  if (rectsOverlap(bounds, keepout)) {
    warnings.push(
      `Preferred region ${preferredRegion} intersects the title-block keep-out; searching fallback safe regions.`,
    );
    const fallback = FALLBACK_REGIONS.map((region) =>
      clampBoundsToUsable(
        candidateBounds(usableBounds, input.contentWidth, input.contentHeight, region),
        usableBounds,
      ),
    ).find((candidate) => !rectsOverlap(candidate, keepout));
    if (fallback) {
      bounds = fallback;
    } else {
      issues.push({
        code: 'NO_SAFE_REGION_OUTSIDE_TITLE_BLOCK',
        message: 'No candidate region fits outside the title-block keep-out.',
      });
    }
  }

  if (bounds.x < usableBounds.x || bounds.y < usableBounds.y) {
    issues.push({
      code: 'BOUNDS_OUTSIDE_USABLE_AREA',
      message: 'Computed bounds start outside usable area.',
    });
  }
  if (
    bounds.x + bounds.width > usableBounds.x + usableBounds.width ||
    bounds.y + bounds.height > usableBounds.y + usableBounds.height
  ) {
    issues.push({
      code: 'BOUNDS_EXCEED_USABLE_AREA',
      message: 'Computed bounds exceed usable area.',
    });
  }
  if (rectsOverlap(bounds, keepout)) {
    issues.push({
      code: 'TITLE_BLOCK_OVERLAP',
      message: 'Computed bounds overlap the title-block keep-out.',
    });
  }

  return {
    blocked: issues.length > 0,
    preferredRegion,
    sheet,
    usableBounds,
    requestedBounds,
    bounds,
    anchor: { x: bounds.x, y: bounds.y + bounds.height },
    keepouts: [keepout],
    warnings,
    issues,
  };
}
