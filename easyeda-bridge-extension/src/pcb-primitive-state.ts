import { isRecord } from './utils.js';

function lowerCamel(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toLowerCase()}${value.slice(1)}`;
}

function readDirectState(record: Record<string, unknown>, key: string): unknown {
  const candidates = [key, lowerCamel(key), `getState_${key}`];
  for (const candidate of candidates) {
    if (candidate in record && typeof record[candidate] !== 'function') {
      return record[candidate];
    }
  }
  return undefined;
}

/**
 * Reads EasyEDA primitive state across the wrapper shapes observed in desktop
 * runtimes: getState_* methods, direct PascalCase/lower-camel properties, and
 * nested state records. Object values are returned intact and are never
 * coerced to strings.
 */
export function readPrimitiveState(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;

  const getter = value[`getState_${key}`];
  if (typeof getter === 'function') {
    try {
      const result = getter.call(value);
      if (result !== undefined) return result;
    } catch {
      // Some EasyEDA wrappers retain stale getters after a native mutation.
      // Fall through to direct and nested state without failing inspection.
    }
  }

  const direct = readDirectState(value, key);
  if (direct !== undefined) return direct;

  for (const containerName of ['state', 'State']) {
    const container = value[containerName];
    if (!isRecord(container)) continue;
    const nested = readDirectState(container, key);
    if (nested !== undefined) return nested;
  }

  return undefined;
}

function normalizeLayerName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
}

function isBoardOutlineName(value: string): boolean {
  const normalized = normalizeLayerName(value);
  return (
    normalized === '11' ||
    normalized === 'board outline' ||
    normalized === 'board outline layer' ||
    normalized === 'boardoutline' ||
    normalized === 'boardoutline layer'
  );
}

/** Recognizes the numeric and named layer representations used by EasyEDA. */
export function isBoardOutlineLayer(value: unknown): boolean {
  if (value === 11) return true;
  if (typeof value === 'string') return isBoardOutlineName(value);
  if (!isRecord(value)) return false;

  for (const key of ['id', 'layerId', 'layer', 'name', 'title', 'type', 'value', 'code']) {
    if (key in value && isBoardOutlineLayer(value[key])) return true;
  }
  return false;
}

export function primitiveIsOnBoardOutline(value: unknown): boolean {
  const layer = readPrimitiveState(value, 'Layer');
  if (isBoardOutlineLayer(layer)) return true;

  for (const key of ['LayerName', 'PrimitiveType', 'Type', 'ObjectType']) {
    if (isBoardOutlineLayer(readPrimitiveState(value, key))) return true;
  }
  return false;
}

export function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
