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
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(methodName)) return false;
  return isAllowedApiClassName(className);
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

export function normalizeValue(value: unknown, depth = 3, seen = new WeakSet<object>()): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (value === undefined) return null;
  if (typeof value === 'function') return `[Function ${value.name ?? 'anonymous'}]`;
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  if (depth <= 0) return '[MaxDepth]';

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeValue(item, depth - 1, seen));
    }

    const output: Record<string, JsonValue | undefined> = {};
    const ctorName = (value as { constructor?: { name?: string } }).constructor?.name;
    if (ctorName && ctorName !== 'Object') output.__class = ctorName;

    const getterNames = getFunctionNames(value).filter((name) => name.startsWith('getState_'));
    if (getterNames.length > 0) {
      const state: Record<string, JsonValue | undefined> = {};
      for (const getterName of getterNames) {
        const getter = readMember(value, getterName);
        if (typeof getter !== 'function') continue;
        try {
          state[getterName.replace(/^getState_/, '')] = normalizeValue(
            getter.call(value),
            depth - 1,
            seen,
          );
        } catch (error) {
          state[getterName.replace(/^getState_/, '')] = `ERROR: ${String(error)}`;
        }
      }
      output.state = state;
    }

    const methodNames = getFunctionNames(value);
    if (methodNames.length > 0) output.__methods = methodNames;

    for (const key of Object.keys(value)) {
      output[key] = normalizeValue((value as Record<string, unknown>)[key], depth - 1, seen);
    }

    return output;
  } finally {
    // Track only the active recursion path. Repeated references are valid data;
    // only a reference back into the current path is a true cycle.
    seen.delete(value);
  }
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
