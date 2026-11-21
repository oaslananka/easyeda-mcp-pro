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

/**
 * Native EasyEDA Pro 4.1.105 may reverse the endpoint order of one straight
 * wire when it is recreated. Only a single finite, nonzero two-point segment
 * has a proven direction-independent geometry. Multi-segment/branching wire
 * paths remain exact until native connectivity equivalence is independently
 * validated. Network, style and all other snapshot properties remain intact.
 */
function normalizeUndirectedTwoPointWire(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  if (
    snapshot.primitiveKind !== 'wire' ||
    !snapshot.property ||
    typeof snapshot.property !== 'object' ||
    Array.isArray(snapshot.property)
  ) {
    return snapshot;
  }
  const property = snapshot.property as Record<string, unknown>;
  const line = property.line;
  if (
    !Array.isArray(line) ||
    line.length !== 4 ||
    !line.every((point) => typeof point === 'number' && Number.isFinite(point))
  ) {
    return snapshot;
  }
  const [x1, y1, x2, y2] = line as [number, number, number, number];
  if (x1 === x2 && y1 === y2) return snapshot;
  if (x1 < x2 || (x1 === x2 && y1 < y2)) return snapshot;
  return { ...snapshot, property: { ...property, line: [x2, y2, x1, y1] } };
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
  const normalized = normalizeUndirectedTwoPointWire(rest);
  // A verified native Ground isolation report is read-only provenance, not
  // an intrinsic primitive attribute. A recreated marker receives a NEW
  // primitive ID and a correspondingly NEW markerId in its proven topology.
  // Compare all the other evidence (including native project/page/version,
  // wire and pin counts) while permitting only that expected ID rotation.
  // Unknown isolation kinds are never normalized.
  const isolation = record.nativeIsolation;
  if (
    isolation !== null &&
    typeof isolation === 'object' &&
    !Array.isArray(isolation) &&
    record.primitiveKind === 'netflag' &&
    (isolation as Record<string, unknown>).kind === 'verified-disconnected-ground/v2' &&
    typeof record.primitiveId === 'string' &&
    (isolation as Record<string, unknown>).markerId === record.primitiveId
  ) {
    const { markerId: _markerId, ...restIsolation } = isolation as Record<string, unknown>;
    return { ...normalized, nativeIsolation: restIsolation };
  }
  return normalized;
}
