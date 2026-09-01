// Small stateless helpers shared by the loader (index.ts) and the dispatcher
// module. This file is bundled into BOTH artifacts (dist/index.js and
// dist/dispatcher.js); nothing here may hold cross-bundle state.

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function logRecoverableError(context: string, error: unknown): void {
  // Pass `context` as a plain argument (never interpolated into the first/format
  // argument) so a value derived from external data can't be read as a printf-style
  // format specifier by `console.warn`'s format-string handling.
  console.warn('[easyeda-mcp-pro]', context, error);
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    logRecoverableError('failed to stringify log payload', error);
    return String(value);
  }
}

export function log(message: string, data?: unknown): void {
  const suffix = data === undefined ? '' : ` ${safeStringify(data)}`;
  console.log(`[easyeda-mcp-pro ${new Date().toISOString()}] ${message}${suffix}`);
}

const unsafePathSegments = new Set(['__proto__', 'constructor', 'prototype']);

function readPropertyDescriptorValue(source: Record<string, unknown>, property: string): unknown {
  let owner: object | null = source;
  while (owner) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, property);
    if (descriptor) {
      return 'value' in descriptor ? descriptor.value : descriptor.get?.call(source);
    }
    owner = Object.getPrototypeOf(owner);
  }
  return undefined;
}

export function readPath<T>(source: unknown, path: string): T | undefined {
  const parts = path.split('.');
  let cursor: unknown = source;
  for (const part of parts) {
    if (unsafePathSegments.has(part) || !isRecord(cursor)) return undefined;
    try {
      cursor = readPropertyDescriptorValue(cursor, part);
    } catch (error) {
      logRecoverableError(`failed to read path segment ${part}`, error);
      return undefined;
    }
    if (cursor === undefined) return undefined;
  }
  return cursor as T;
}

export function readPathParent(source: unknown, path: string): unknown {
  const parentPath = path.split('.').slice(0, -1).join('.');
  return parentPath ? readPath(source, parentPath) : source;
}
