import { type TransactionManager } from './manager.js';
import { type RollbackResult, type TransactionOperation } from './model.js';
import { snapshotForHash, stableHash } from './stable.js';
import { assertFocusedSchematicScope, nativeSchematicTarget } from './schematic-scope.js';
import type { NativeSchematicScope } from './model.js';

export interface TransactionBridgeCaller {
  call: <TParams, TResult>(
    method: string,
    params?: TParams,
    opts?: { timeoutMs?: number; traceparent?: string },
  ) => Promise<TResult>;
}

interface DeletePrimitiveResult {
  deleted?: string[];
  notFound?: string[];
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
  nativeScope?: NativeSchematicScope,
  expectedSnapshot?: PrimitiveSnapshotResult,
): Promise<unknown> {
  const result = await bridge.call<
    {
      primitiveIds: string[];
      expectedProjectUuid?: string;
      expectedSchematicPageUuid?: string;
      expectedPrimitiveSnapshot?: PrimitiveSnapshotResult;
    },
    DeletePrimitiveResult
  >('schematic.deletePrimitive', {
    primitiveIds: [primitiveId],
    ...(nativeScope ? nativeSchematicTarget(nativeScope) : {}),
    ...(nativeScope && expectedSnapshot
      ? { expectedPrimitiveSnapshot: structuredClone(expectedSnapshot) }
      : {}),
  });
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
  nativeScope?: NativeSchematicScope,
): Promise<{ primitiveId: string; snapshot: PrimitiveSnapshotResult }> {
  const result = await bridge.call<
    { snapshot: unknown; expectedProjectUuid?: string; expectedSchematicPageUuid?: string },
    { primitiveId?: unknown; snapshot?: PrimitiveSnapshotResult }
  >('schematic.recreatePrimitiveSnapshot', {
    snapshot,
    ...(nativeScope ? nativeSchematicTarget(nativeScope) : {}),
  });
  if (typeof result?.primitiveId !== 'string' || !result.primitiveId) {
    throw new Error('Recreated primitive did not return an addressable primitive ID');
  }
  const expectedNativeKind = nativeGroundReadKind(snapshot);
  // The response from recreate is not evidence that the new primitive is
  // actually readable. Compensation runs on uncertain writes as well as
  // explicit rollback: trusting result.snapshot could falsely report a
  // restored wire/net even when the native sheet holds different data.
  const recreatedSnapshot = await getPrimitiveSnapshot(
    bridge,
    result.primitiveId,
    expectedNativeKind,
  );
  const expected = snapshot as PrimitiveSnapshotResult | null;
  if (
    !recreatedSnapshot ||
    recreatedSnapshot.primitiveId !== result.primitiveId ||
    (typeof expected?.primitiveKind === 'string' &&
      recreatedSnapshot.primitiveKind !== expected.primitiveKind)
  ) {
    throw new Error('Recreated primitive identity or type not verified by independent native read');
  }
  if (expectedNativeKind && nativeGroundReadKind(recreatedSnapshot) !== expectedNativeKind) {
    throw new Error('Recreated native Ground identity or scoped evidence is not verified');
  }
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

const CREATED_ID_KEYS = [
  'primitiveId',
  'primitive_id',
  'PrimitiveId',
  'id',
  'uuid',
  'componentId',
] as const;
const CREATED_ID_NESTED_KEYS = [
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
  'state',
] as const;

function firstCreatedPrimitiveId(values: Iterable<unknown>): string | undefined {
  for (const value of values) {
    const primitiveId = extractCreatedPrimitiveId(value);
    if (primitiveId) return primitiveId;
  }
  return undefined;
}

export function extractCreatedPrimitiveId(result: unknown): string | undefined {
  if (typeof result === 'string') return result.trim() || undefined;
  if (Array.isArray(result)) return firstCreatedPrimitiveId(result);
  if (!result || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  const direct = firstCreatedPrimitiveId(CREATED_ID_KEYS.map((key) => record[key]));
  return direct ?? firstCreatedPrimitiveId(CREATED_ID_NESTED_KEYS.map((key) => record[key]));
}

interface PinNoConnectSnapshot {
  schemaVersion: 'schematic-pin-no-connect-snapshot/v1';
  projectId: string;
  componentPrimitiveId: string;
  pinPrimitiveId: string;
  pinNumber: string;
  noConnected: boolean;
}

function asPinNoConnectSnapshot(value: unknown): PinNoConnectSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot = value as Partial<PinNoConnectSnapshot>;
  if (
    snapshot.schemaVersion !== 'schematic-pin-no-connect-snapshot/v1' ||
    typeof snapshot.projectId !== 'string' ||
    typeof snapshot.componentPrimitiveId !== 'string' ||
    typeof snapshot.pinPrimitiveId !== 'string' ||
    typeof snapshot.pinNumber !== 'string' ||
    typeof snapshot.noConnected !== 'boolean'
  ) {
    return undefined;
  }
  return snapshot as PinNoConnectSnapshot;
}

async function readPinNoConnectSnapshot(
  bridge: TransactionBridgeCaller,
  expected: PinNoConnectSnapshot,
): Promise<PinNoConnectSnapshot> {
  const state = await bridge.call<
    { projectId: string; primitiveId: string; pinNumber: string },
    {
      componentPrimitiveId?: unknown;
      pinPrimitiveId?: unknown;
      pinNumber?: unknown;
      noConnected?: unknown;
    }
  >('schematic.getPinNoConnect', {
    projectId: expected.projectId,
    primitiveId: expected.componentPrimitiveId,
    pinNumber: expected.pinNumber,
  });
  if (typeof state?.pinPrimitiveId !== 'string' || typeof state?.noConnected !== 'boolean') {
    throw new TypeError('Pin no-connect rollback verification returned an invalid state');
  }
  return {
    schemaVersion: 'schematic-pin-no-connect-snapshot/v1',
    projectId: expected.projectId,
    componentPrimitiveId:
      typeof state.componentPrimitiveId === 'string'
        ? state.componentPrimitiveId
        : expected.componentPrimitiveId,
    pinPrimitiveId: state.pinPrimitiveId,
    pinNumber: typeof state.pinNumber === 'string' ? state.pinNumber : expected.pinNumber,
    noConnected: state.noConnected,
  };
}

function requireBeforeSnapshot(operation: Readonly<TransactionOperation>): unknown {
  if (operation.beforeSnapshot === undefined) {
    throw new Error(`Operation ${operation.id} has no rollback snapshot`);
  }
  return operation.beforeSnapshot;
}

/**
 * Read-only native Ground evidence is meaningful only when the restored
 * primitive is independently queried in the same scoped native kind.
 * Nothing here grants permission to delete markers in production.
 */
function nativeGroundReadKind(beforeSnapshot: unknown): 'netflag' | undefined {
  if (!beforeSnapshot || typeof beforeSnapshot !== 'object') {
    return undefined;
  }
  if (Array.isArray(beforeSnapshot)) return undefined;
  const record = beforeSnapshot as Record<string, unknown>;
  const isolation = record.nativeIsolation;
  if (
    record.primitiveKind !== 'netflag' ||
    !record.nativeContext ||
    !isolation ||
    typeof isolation !== 'object' ||
    Array.isArray(isolation)
  ) {
    return undefined;
  }
  return (isolation as Record<string, unknown>).kind === 'verified-disconnected-ground/v2'
    ? 'netflag'
    : undefined;
}

function verifiedRollbackExactId(
  snapshot: PrimitiveSnapshotResult | PinNoConnectSnapshot,
  requestedId: string,
  pinSnapshot: PinNoConnectSnapshot | undefined,
): boolean {
  // Pin snapshots are verified through their independent native pin ID.
  if (pinSnapshot) return true;
  return 'primitiveId' in snapshot && snapshot.primitiveId === requestedId;
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
        case 'modify': {
          const snapshot = requireBeforeSnapshot(operation);
          const pinSnapshot = asPinNoConnectSnapshot(snapshot);
          if (pinSnapshot) {
            await bridge.call('schematic.setPinNoConnect', {
              projectId: pinSnapshot.projectId,
              primitiveId: pinSnapshot.componentPrimitiveId,
              pinNumber: pinSnapshot.pinNumber,
              noConnected: pinSnapshot.noConnected,
            });
            return;
          }
          await bridge.call('schematic.restorePrimitiveSnapshot', { snapshot });
          return;
        }
        case 'delete': {
          // A failed compensation may have created a replacement despite a
          // timeout or an unsuccessful readback. A second create is non-
          // idempotent and can duplicate real schematic connectivity.
          // Leave the failed transaction locked for native inspection rather
          // than automatically replaying an ambiguous write.
          if (operation.state === 'failed' && operation.compensation === 'failed') {
            throw new Error(
              'Native delete outcome and prior compensation are unresolved; ' +
                'inspect the schematic and cold-reopen before any manual recovery',
            );
          }
          const scope = operation.nativeSchematicScope;
          if (scope) {
            await assertFocusedSchematicScope(bridge, scope.projectId, scope.documentId);
          }
          const recreated = await recreatePrimitiveSnapshot(
            bridge,
            requireBeforeSnapshot(operation),
            scope,
          );
          if (scope) {
            await assertFocusedSchematicScope(bridge, scope.projectId, scope.documentId);
          }
          return { restoredTargetId: recreated.primitiveId };
        }
      }
    },
    verify: async (operation, restoreResult) => {
      if (operation.kind === 'create') {
        return !(await primitiveExists(bridge, operation.target.id));
      }
      const beforeSnapshot = requireBeforeSnapshot(operation);
      const pinSnapshot = asPinNoConnectSnapshot(beforeSnapshot);
      // A native-scoped Ground deletion must be verified through a fresh,
      // explicitly typed bridge read instead of a generic snapshot.
      const expectedNativeKind =
        operation.kind === 'delete' ? nativeGroundReadKind(beforeSnapshot) : undefined;
      const scope = operation.nativeSchematicScope;
      if (scope) await assertFocusedSchematicScope(bridge, scope.projectId, scope.documentId);
      const snapshot = pinSnapshot
        ? await readPinNoConnectSnapshot(bridge, pinSnapshot)
        : await getPrimitiveSnapshot(
            bridge,
            restoreResult.restoredTargetId ?? operation.target.id,
            expectedNativeKind,
          );
      if (scope) await assertFocusedSchematicScope(bridge, scope.projectId, scope.documentId);
      const requestedId = restoreResult.restoredTargetId ?? operation.target.id;
      if (!verifiedRollbackExactId(snapshot, requestedId, pinSnapshot)) return false;
      if (!operation.beforeHash) return false;
      return (
        stableHash(snapshotForHash(snapshot, operation.snapshotHashMode)) === operation.beforeHash
      );
    },
  });
}
