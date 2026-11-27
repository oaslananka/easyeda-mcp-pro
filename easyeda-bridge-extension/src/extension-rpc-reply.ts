import type { JsonValue } from './utils.js';

export class RpcReplyBudgetError extends Error {}

class ReplyBudget {
  private readonly encoder = new TextEncoder();

  constructor(private remaining: number) {}

  ensure(bytes: number): void {
    if (bytes > this.remaining) throw new RpcReplyBudgetError();
  }

  consume(bytes: number): void {
    this.ensure(bytes);
    this.remaining -= bytes;
  }

  scalar(value: string | number | boolean | null): JsonValue {
    // UTF-8 JSON cannot be shorter than the original UTF-16 code-unit count.
    // Reject large strings before allocating their escaped/encoded copies.
    if (typeof value === 'string') this.ensure(value.length);
    this.consume(this.encoder.encode(JSON.stringify(value)).byteLength);
    return value;
  }
}

function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function copyArray(
  value: unknown[],
  budget: ReplyBudget,
  depth: number,
  seen: WeakSet<object>,
): JsonValue[] {
  // Even null placeholders take bytes. Refuse huge/sparse arrays before reading entries.
  budget.ensure(value.length);
  budget.consume(2);
  const output: JsonValue[] = [];
  for (let i = 0; i < value.length; i += 1) {
    if (i > 0) budget.consume(1);
    output.push(copyValue(ownData(value, String(i)), budget, depth - 1, seen));
  }
  return output;
}

function copyRecord(
  value: object,
  budget: ReplyBudget,
  depth: number,
  seen: WeakSet<object>,
): JsonValue {
  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  budget.consume(2);
  // Do not build an array of all keys, inspect prototypes for state methods,
  // or invoke accessors/toJSON. Charge even omitted members to bound traversal.
  for (const key in value) {
    budget.consume(2);
    budget.scalar(key);
    const member = ownData(value, key);
    if (key === '__methods' || member === undefined || typeof member === 'function') continue;
    output[key] = copyValue(member, budget, depth - 1, seen);
  }
  return output;
}

function copyValue(
  value: unknown,
  budget: ReplyBudget,
  depth: number,
  seen: WeakSet<object>,
): JsonValue {
  if (typeof value === 'string' || typeof value === 'boolean') return budget.scalar(value);
  if (typeof value === 'number') return budget.scalar(Number.isFinite(value) ? value : null);
  if (value === null || typeof value !== 'object') return budget.scalar(null);
  if (seen.has(value)) return budget.scalar('[Circular]');
  if (depth <= 0) return budget.scalar('[MaxDepth]');
  seen.add(value);
  try {
    return Array.isArray(value)
      ? copyArray(value, budget, depth, seen)
      : copyRecord(value, budget, depth, seen);
  } finally {
    seen.delete(value);
  }
}

/** Copy only bounded JSON data, counting UTF-8 wire bytes while traversing. */
export function normalizeExtensionRpcReply(
  reply: unknown,
  topic: string,
  timeoutMs: number,
  maxBytes: number,
): { topic: string; timeoutMs: number; result: JsonValue } {
  const budget = new ReplyBudget(maxBytes);
  // Reserve exact envelope bytes plus the result itself.
  budget.consume(
    new TextEncoder().encode(JSON.stringify({ topic, timeoutMs, result: null })).byteLength - 4,
  );
  return { topic, timeoutMs, result: copyValue(reply, budget, 10, new WeakSet<object>()) };
}
