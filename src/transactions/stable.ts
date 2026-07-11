import { createHash } from 'node:crypto';

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function canonicalize(value: unknown, seen: WeakSet<object>): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined) return null;
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`Unsupported snapshot value type: ${typeof value}`);
  }
  if (seen.has(value)) throw new TypeError('Circular snapshot values are not supported');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>).sort((a, b) =>
      a.localeCompare(b),
    )) {
      if (FORBIDDEN_KEYS.has(key)) throw new TypeError(`Forbidden snapshot key: ${key}`);
      output[key] = canonicalize((value as Record<string, unknown>)[key], seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value, new WeakSet()));
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function serializedSize(value: unknown): number {
  return Buffer.byteLength(stableStringify(value), 'utf8');
}

export function snapshotForHash(
  snapshot: unknown,
  mode: 'exact' | 'ignore-primitive-id' | 'absence',
): unknown {
  if (mode === 'absence') return { exists: false };
  if (mode === 'exact') return snapshot;
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return snapshot;
  const record = snapshot as Record<string, unknown>;
  const { primitiveId: _primitiveId, ...rest } = record;
  return rest;
}
