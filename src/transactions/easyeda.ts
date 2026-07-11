import { type TransactionManager } from './manager.js';
import { type RollbackResult, type TransactionOperation } from './model.js';
import { snapshotForHash, stableHash } from './stable.js';

export interface TransactionBridgeCaller {
  call: <TParams, TResult>(
    method: string,
    params?: TParams,
    opts?: { timeoutMs?: number; traceparent?: string },
  ) => Promise<TResult>;
}

export interface PrimitiveSnapshotResult {
  schemaVersion?: string;
  primitiveId?: string;
  primitiveKind?: string;
  property?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function getPrimitiveSnapshot(
  bridge: TransactionBridgeCaller,
  primitiveId: string,
  expectedPrimitiveKind?: string,
): Promise<PrimitiveSnapshotResult> {
  return bridge.call('schematic.getPrimitiveSnapshot', {
    primitiveId,
    ...(expectedPrimitiveKind ? { expectedPrimitiveKind } : {}),
  });
}

function isPrimitiveNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  if (record.code === 'PRIMITIVE_NOT_FOUND') return true;
  const message = record.message;
  return typeof message === 'string' && /primitive.+not found/i.test(message);
}

export async function primitiveExists(
  bridge: TransactionBridgeCaller,
  primitiveId: string,
  expectedPrimitiveKind?: string,
): Promise<boolean> {
  try {
    await getPrimitiveSnapshot(bridge, primitiveId, expectedPrimitiveKind);
    return true;
  } catch (error) {
    if (isPrimitiveNotFoundError(error)) return false;
    throw error;
  }
}

export async function deletePrimitiveExact(
  bridge: TransactionBridgeCaller,
  primitiveId: string,
): Promise<unknown> {
  const result = await bridge.call<
    { primitiveIds: string[] },
    { deleted?: string[]; notFound?: string[] } | unknown
  >('schematic.deletePrimitive', { primitiveIds: [primitiveId] });
  if (
    result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    Array.isArray((result as { notFound?: unknown[] }).notFound) &&
    (result as { notFound: unknown[] }).notFound.includes(primitiveId)
  ) {
    throw new Error(`Primitive ${primitiveId} was not found during delete`);
  }
  return result;
}

export async function recreatePrimitiveSnapshot(
  bridge: TransactionBridgeCaller,
  snapshot: unknown,
): Promise<{ primitiveId: string; snapshot: PrimitiveSnapshotResult }> {
  const result = await bridge.call<
    { snapshot: unknown },
    { primitiveId?: unknown; snapshot?: PrimitiveSnapshotResult }
  >('schematic.recreatePrimitiveSnapshot', { snapshot });
  if (typeof result?.primitiveId !== 'string' || !result.primitiveId) {
    throw new Error('Recreated primitive did not return an addressable primitive ID');
  }
  const recreatedSnapshot =
    result.snapshot ?? (await getPrimitiveSnapshot(bridge, result.primitiveId));
  return { primitiveId: result.primitiveId, snapshot: recreatedSnapshot };
}

export async function listPrimitiveIds(
  bridge: TransactionBridgeCaller,
  primitiveKind: string,
): Promise<string[]> {
  const result = await bridge.call<{ primitiveKind: string }, { primitiveIds?: unknown }>(
    'schematic.listPrimitiveIds',
    { primitiveKind },
  );
  return Array.isArray(result?.primitiveIds)
    ? result.primitiveIds.filter((value): value is string => typeof value === 'string')
    : [];
}

export function extractCreatedPrimitiveId(result: unknown): string | undefined {
  if (typeof result === 'string' && result.trim()) return result;
  if (!result || typeof result !== 'object') return undefined;
  if (Array.isArray(result)) {
    for (const item of result) {
      const primitiveId = extractCreatedPrimitiveId(item);
      if (primitiveId) return primitiveId;
    }
    return undefined;
  }
  const record = result as Record<string, unknown>;
  for (const key of ['primitiveId', 'primitive_id', 'PrimitiveId', 'id', 'uuid', 'componentId']) {
    if (typeof record[key] === 'string' && record[key]) return record[key];
  }
  for (const key of [
    'result',
    'data',
    'item',
    'primitive',
    'component',
    'wire',
    'text',
    'rectangle',
    'circle',
    'polygon',
  ]) {
    const primitiveId = extractCreatedPrimitiveId(record[key]);
    if (primitiveId) return primitiveId;
  }
  const state = record.state;
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const primitiveId = (state as Record<string, unknown>).PrimitiveId;
    if (typeof primitiveId === 'string' && primitiveId) return primitiveId;
  }
  return undefined;
}

function requireBeforeSnapshot(operation: Readonly<TransactionOperation>): unknown {
  if (operation.beforeSnapshot === undefined) {
    throw new Error(`Operation ${operation.id} has no rollback snapshot`);
  }
  return operation.beforeSnapshot;
}

export async function rollbackEasyedaTransaction(
  manager: TransactionManager,
  transactionId: string,
  bridge: TransactionBridgeCaller,
): Promise<RollbackResult> {
  return manager.rollback(transactionId, {
    restore: async (operation) => {
      switch (operation.kind) {
        case 'create':
          await deletePrimitiveExact(bridge, operation.target.id);
          return;
        case 'modify':
          await bridge.call('schematic.restorePrimitiveSnapshot', {
            snapshot: requireBeforeSnapshot(operation),
          });
          return;
        case 'delete': {
          const recreated = await recreatePrimitiveSnapshot(
            bridge,
            requireBeforeSnapshot(operation),
          );
          return { restoredTargetId: recreated.primitiveId };
        }
      }
    },
    verify: async (operation, restoreResult) => {
      if (operation.kind === 'create') {
        return !(await primitiveExists(bridge, operation.target.id));
      }
      const targetId = restoreResult.restoredTargetId ?? operation.target.id;
      const snapshot = await getPrimitiveSnapshot(bridge, targetId);
      if (!operation.beforeHash) return false;
      return (
        stableHash(snapshotForHash(snapshot, operation.snapshotHashMode)) === operation.beforeHash
      );
    },
  });
}
