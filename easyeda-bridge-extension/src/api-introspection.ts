import { isRecord, logRecoverableError, type JsonValue } from './utils.js';

const API_CLASS_PREFIXES = ['DMT_', 'SCH_', 'PCB_', 'LIB_'] as const;
const DENIED_API_METHODS = new Set([
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
]);

export function withClassNameVariants(paths: readonly string[]): string[] {
  const variants: string[] = [];
  for (const path of paths) {
    variants.push(path);
    const parts = path.split('.');
    const className = parts[0];
    if (!className) continue;

    const rest = parts.slice(1).join('.');
    const suffix = rest ? `.${rest}` : '';
    const lowerPrefixMatch = /^([a-z]+)_(.+)$/.exec(className);
    const upperPrefixMatch = /^([A-Z]+)_(.+)$/.exec(className);

    if (lowerPrefixMatch?.[1] && lowerPrefixMatch[2]) {
      variants.push(`${lowerPrefixMatch[1].toUpperCase()}_${lowerPrefixMatch[2]}${suffix}`);
    }

    if (upperPrefixMatch?.[1] && upperPrefixMatch[2]) {
      variants.push(`${upperPrefixMatch[1].toLowerCase()}_${upperPrefixMatch[2]}${suffix}`);
    }
  }

  return [...new Set(variants)];
}

export function normalizeApiClassName(className: string): string {
  const match = /^([a-z]+)_(.+)$/.exec(className);
  if (!match?.[1] || !match[2]) return className;
  return `${match[1].toUpperCase()}_${match[2]}`;
}

export function isAllowedApiClassName(className: string): boolean {
  const normalizedClassName = normalizeApiClassName(className);
  return API_CLASS_PREFIXES.some((prefix) => normalizedClassName.startsWith(prefix));
}

export function isAllowedApiPath(path: string): boolean {
  const parts = path.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const [className, methodName] = parts;
  if (DENIED_API_METHODS.has(methodName) || methodName.startsWith('__')) return false;
  if (!/^[A-Za-z]+_[A-Za-z0-9]+$/.test(className)) return false;
  if (!/^[A-Za-z]\w*$/.test(methodName)) return false;
  return isAllowedApiClassName(className);
}

/**
 * Audited native getters which may be called through the lower-privilege api.read route.
 * No method-name heuristic: native methods are not assumed pure because of a get/is prefix.
 * Keep classes/methods explicit until additional versions have read-only evidence.
 */
const READ_ONLY_API_METHODS: Readonly<Record<string, readonly string[]>> = {
  DMT_Project: ['getCurrentProjectInfo'],
  DMT_SelectControl: ['getCurrentDocumentInfo'],
  DMT_Pcb: ['getCurrentPcbInfo'],
  PCB_PrimitiveVia: ['getAll'],
  PCB_PrimitiveComponent: ['getAll', 'getAllPinsByPrimitiveId'],
  PCB_PrimitiveLine: ['getAll'],
  PCB_PrimitiveArc: ['getAll'],
  PCB_PrimitiveRegion: ['getAll'],
  PCB_PrimitivePoured: ['getAll'],
  PCB_PrimitivePour: ['getAll'],
  PCB_PrimitivePolyline: ['getAll'],
  PCB_PrimitiveTrack: ['getAll'],
  PCB_Net: ['getAll', 'getAllPrimitivesByNet'],
  SCH_PrimitiveComponent: ['getAll'],
  SCH_PrimitiveWire: ['getAll'],
};

export function isAllowedReadOnlyApiPath(path: string): boolean {
  if (!isAllowedApiPath(path)) return false;
  const [rawClass, method] = path.split('.');
  const className = normalizeApiClassName(rawClass ?? '');
  return (READ_ONLY_API_METHODS[className] ?? []).includes(method ?? '');
}

function getAllPropertyNames(value: unknown): string[] {
  const names: string[] = [];
  let cursor = value;
  let depth = 0;
  while (isRecord(cursor) && cursor !== Object.prototype && depth < 8) {
    try {
      names.push(...Object.getOwnPropertyNames(cursor));
    } catch (error) {
      logRecoverableError('failed to read API property names', error);
      break;
    }
    try {
      cursor = Object.getPrototypeOf(cursor);
    } catch (error) {
      logRecoverableError('failed to read API property prototype', error);
      break;
    }
    depth += 1;
  }
  return Array.from(new Set(names)).filter(
    (name) => !['length', 'name', 'prototype', 'constructor'].includes(name),
  );
}

export function readMember(source: unknown, key: string): unknown {
  if (!isRecord(source) || !(key in source)) return undefined;
  try {
    return source[key];
  } catch (error) {
    logRecoverableError(`failed to read API member ${key}`, error);
    return undefined;
  }
}

export function getFunctionNames(value: unknown): string[] {
  return getAllPropertyNames(value).filter((name) => {
    const member = readMember(value, name);
    return typeof member === 'function';
  });
}

function normalizeStateGetters(
  value: object,
  depth: number,
  seen: WeakSet<object>,
  includeMethods: boolean,
): Record<string, JsonValue | undefined> | undefined {
  const getterNames = getFunctionNames(value).filter((name) => name.startsWith('getState_'));
  if (getterNames.length === 0) return undefined;

  const state: Record<string, JsonValue | undefined> = {};
  for (const getterName of getterNames) {
    const getter = readMember(value, getterName);
    if (typeof getter !== 'function') continue;
    try {
      state[getterName.replace(/^getState_/, '')] = normalizeValue(
        getter.call(value),
        depth - 1,
        seen,
        includeMethods,
      );
    } catch (error) {
      state[getterName.replace(/^getState_/, '')] = `ERROR: ${String(error)}`;
    }
  }
  return state;
}

function normalizeRecordValue(
  value: object,
  depth: number,
  seen: WeakSet<object>,
  includeMethods: boolean,
): JsonValue {
  const output: Record<string, JsonValue | undefined> = {};
  const ctorName = (value as { constructor?: { name?: string } }).constructor?.name;
  if (ctorName && ctorName !== 'Object') output.__class = ctorName;

  const state = normalizeStateGetters(value, depth, seen, includeMethods);
  if (state) output.state = state;

  if (includeMethods) {
    const methodNames = getFunctionNames(value);
    if (methodNames.length > 0) output.__methods = methodNames;
  }

  for (const key of Object.keys(value)) {
    const member = (value as Record<string, unknown>)[key];
    if (!includeMethods && (key === '__methods' || typeof member === 'function')) continue;
    output[key] = normalizeValue(member, depth - 1, seen, includeMethods);
  }
  return output;
}

function normalizeObjectValue(
  value: object,
  depth: number,
  seen: WeakSet<object>,
  includeMethods: boolean,
): JsonValue {
  if (seen.has(value)) return '[Circular]';
  if (depth <= 0) return '[MaxDepth]';

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeValue(item, depth - 1, seen, includeMethods));
    }
    return normalizeRecordValue(value, depth, seen, includeMethods);
  } finally {
    // Track only the active recursion path. Repeated references are valid data;
    // only a reference back into the current path is a true cycle.
    seen.delete(value);
  }
}

export function normalizeValue(
  value: unknown,
  depth = 3,
  seen = new WeakSet<object>(),
  includeMethods = true,
): JsonValue {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value;
  if (value === undefined) return null;
  if (typeof value === 'function') return `[Function ${value.name ?? 'anonymous'}]`;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol') return value.toString();
  return normalizeObjectValue(value, depth, seen, includeMethods);
}

export function normalizeStandalone(value: unknown, depth = 4): JsonValue {
  return normalizeValue(value, depth, new WeakSet<object>());
}

export function readStateValue(
  source: unknown,
  stateName: string,
  depth = 4,
): JsonValue | undefined {
  const getter = readMember(source, `getState_${stateName}`);
  if (typeof getter !== 'function') return undefined;
  try {
    return normalizeStandalone(getter.call(source), depth);
  } catch (error) {
    return `ERROR: ${String(error)}`;
  }
}

export function compactPrimitiveSummary(
  value: unknown,
  stateNames: readonly string[],
): Record<string, JsonValue | undefined> {
  const state: Record<string, JsonValue | undefined> = {};
  for (const stateName of stateNames) {
    state[stateName] = readStateValue(value, stateName, 5);
  }
  return state;
}
