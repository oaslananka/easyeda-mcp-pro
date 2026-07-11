import { randomUUID } from 'node:crypto';
import {
  type BeginTransactionInput,
  type RollbackHooks,
  type RollbackResult,
  type TransactionOperation,
  type TransactionOperationKind,
  type TransactionRecord,
  type TransactionSnapshotHashMode,
  type TransactionValidationGate,
  type TransactionalCreateHooks,
  type TransactionalCreateResult,
  type TransactionalDeleteHooks,
  type TransactionalDeleteResult,
  type TransactionalModifyHooks,
  type TransactionalModifyResult,
} from './model.js';
import { serializedSize, snapshotForHash, stableHash } from './stable.js';

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_OPERATIONS = 250;
const MAX_OPERATIONS = 2_000;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export class TransactionError extends Error {
  constructor(
    public readonly code:
      | 'TRANSACTION_ACTIVE'
      | 'TRANSACTION_NOT_FOUND'
      | 'TRANSACTION_NOT_ACTIVE'
      | 'TRANSACTION_INVALID_STATE'
      | 'TRANSACTION_OPERATION_LIMIT'
      | 'TRANSACTION_SNAPSHOT_TOO_LARGE'
      | 'TRANSACTION_VALIDATION_FAILED'
      | 'TRANSACTION_ROLLBACK_FAILED'
      | 'TRANSACTION_OPERATION_FAILED',
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TransactionError';
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`Expected an integer between ${min} and ${max}`);
  }
  return value;
}

function cloneTransaction(transaction: TransactionRecord): TransactionRecord {
  return structuredClone(transaction);
}

function holdsDocumentLock(transaction: TransactionRecord): boolean {
  return (
    ['active', 'validating', 'validated', 'rolling-back'].includes(transaction.state) ||
    (transaction.state === 'failed' && transaction.rollbackComplete === false)
  );
}

export class TransactionManager {
  private readonly transactions = new Map<string, TransactionRecord>();
  private readonly activeByDocument = new Map<string, string>();

  begin(input: BeginTransactionInput): TransactionRecord {
    const documentId = input.documentId.trim();
    if (!documentId) throw new TypeError('documentId is required');
    this.expireStaleTransactions();
    const existingId = this.activeByDocument.get(documentId);
    if (existingId) {
      const existing = this.transactions.get(existingId);
      if (existing && holdsDocumentLock(existing)) {
        throw new TransactionError(
          'TRANSACTION_ACTIVE',
          `Document ${documentId} already has an active transaction`,
          { transactionId: existingId },
        );
      }
      this.activeByDocument.delete(documentId);
    }

    const ttlMs = clampInteger(input.ttlMs, DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS);
    const maxOperations = clampInteger(
      input.maxOperations,
      DEFAULT_MAX_OPERATIONS,
      1,
      MAX_OPERATIONS,
    );
    const createdAt = nowIso();
    const transaction: TransactionRecord = {
      id: `tx_${randomUUID()}`,
      documentId,
      label: input.label?.trim() || undefined,
      state: 'active',
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      maxOperations,
      operations: [],
      validations: [],
    };
    this.transactions.set(transaction.id, transaction);
    this.activeByDocument.set(documentId, transaction.id);
    return cloneTransaction(transaction);
  }

  get(transactionId: string): TransactionRecord {
    this.expireStaleTransactions();
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      throw new TransactionError(
        'TRANSACTION_NOT_FOUND',
        `Transaction ${transactionId} was not found`,
      );
    }
    return cloneTransaction(transaction);
  }

  private mutable(transactionId: string): TransactionRecord {
    this.expireStaleTransactions();
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      throw new TransactionError(
        'TRANSACTION_NOT_FOUND',
        `Transaction ${transactionId} was not found`,
      );
    }
    return transaction;
  }

  private assertActive(transaction: TransactionRecord): void {
    if (!['active', 'validated'].includes(transaction.state)) {
      throw new TransactionError(
        'TRANSACTION_NOT_ACTIVE',
        `Transaction ${transaction.id} is ${transaction.state}, not active`,
        { state: transaction.state },
      );
    }
  }

  private assertSnapshotSize(snapshot: unknown): void {
    const bytes = serializedSize(snapshot);
    if (bytes > MAX_SNAPSHOT_BYTES) {
      throw new TransactionError(
        'TRANSACTION_SNAPSHOT_TOO_LARGE',
        `Snapshot is ${bytes} bytes; the limit is ${MAX_SNAPSHOT_BYTES}`,
        { bytes, limit: MAX_SNAPSHOT_BYTES },
      );
    }
  }

  private reserveOperation(
    transaction: TransactionRecord,
    kind: TransactionOperationKind,
    targetId: string,
    hashMode: TransactionSnapshotHashMode,
    beforeSnapshot?: unknown,
  ): TransactionOperation {
    this.assertActive(transaction);
    if (transaction.operations.length >= transaction.maxOperations) {
      throw new TransactionError(
        'TRANSACTION_OPERATION_LIMIT',
        `Transaction ${transaction.id} reached its operation limit`,
        { maxOperations: transaction.maxOperations },
      );
    }
    if (beforeSnapshot !== undefined) this.assertSnapshotSize(beforeSnapshot);
    const operation: TransactionOperation = {
      id: `txop_${randomUUID()}`,
      sequence: transaction.operations.length + 1,
      kind,
      state: 'pending',
      target: { type: 'schematic-primitive', id: targetId },
      beforeSnapshot: beforeSnapshot === undefined ? undefined : structuredClone(beforeSnapshot),
      beforeHash:
        beforeSnapshot === undefined
          ? undefined
          : stableHash(snapshotForHash(beforeSnapshot, hashMode)),
      snapshotHashMode: hashMode,
    };
    transaction.operations.push(operation);
    transaction.validations = [];
    if (transaction.state === 'validated') transaction.state = 'active';
    transaction.updatedAt = nowIso();
    return operation;
  }

  private failTransaction(
    transaction: TransactionRecord,
    operation: TransactionOperation,
    message: string,
  ): void {
    transaction.state = 'failed';
    transaction.rollbackComplete = false;
    transaction.error = message;
    operation.state = 'failed';
    operation.compensation = 'failed';
    transaction.updatedAt = nowIso();
    this.activeByDocument.set(transaction.documentId, transaction.id);
  }

  private async compensateModify(
    operation: TransactionOperation,
    hooks: TransactionalModifyHooks,
  ): Promise<'not-needed' | 'restored' | 'failed'> {
    let currentHash: string | undefined;
    try {
      currentHash = stableHash(await hooks.getSnapshot());
      if (currentHash === operation.beforeHash) return 'not-needed';
    } catch {
      // The current state is unknown. Restore the captured snapshot defensively.
    }

    try {
      await hooks.restore(structuredClone(operation.beforeSnapshot));
      const restored = await hooks.getSnapshot();
      if (stableHash(restored) !== operation.beforeHash) return 'failed';
      return 'restored';
    } catch {
      return 'failed';
    }
  }

  async runModify<TResult>(
    transactionId: string,
    targetId: string,
    hooks: TransactionalModifyHooks<TResult>,
  ): Promise<TransactionalModifyResult<TResult>> {
    const transaction = this.mutable(transactionId);
    this.assertActive(transaction);
    const beforeSnapshot = await hooks.getSnapshot();
    const operation = this.reserveOperation(
      transaction,
      'modify',
      targetId,
      'exact',
      beforeSnapshot,
    );

    try {
      const result = await hooks.apply();
      const afterSnapshot = await hooks.getSnapshot();
      this.assertSnapshotSize(afterSnapshot);
      operation.afterSnapshot = structuredClone(afterSnapshot);
      operation.afterHash = stableHash(afterSnapshot);
      operation.state = 'applied';
      operation.appliedAt = nowIso();
      transaction.updatedAt = nowIso();
      return { result, operation: structuredClone(operation) };
    } catch (error) {
      const compensation = await this.compensateModify(operation, hooks);
      operation.compensation = compensation;
      operation.error = error instanceof Error ? error.message : String(error);
      operation.rolledBackAt = compensation === 'restored' ? nowIso() : undefined;
      operation.state = compensation === 'failed' ? 'failed' : 'cancelled';
      transaction.updatedAt = nowIso();
      if (compensation === 'failed') {
        this.failTransaction(
          transaction,
          operation,
          `Operation ${operation.id} failed and automatic compensation failed`,
        );
      }
      throw new TransactionError(
        'TRANSACTION_OPERATION_FAILED',
        `Transactional modification failed: ${operation.error}`,
        {
          transactionId,
          operationId: operation.id,
          compensation,
          cause: operation.error,
        },
      );
    }
  }

  async runCreate<TResult>(
    transactionId: string,
    targetHint: string,
    hooks: TransactionalCreateHooks<TResult>,
  ): Promise<TransactionalCreateResult<TResult>> {
    const transaction = this.mutable(transactionId);
    const operation = this.reserveOperation(transaction, 'create', targetHint, 'absence', {
      exists: false,
    });
    let targetId: string | undefined;
    let result: TResult | undefined;

    try {
      const applied = await hooks.apply();
      targetId = applied.targetId.trim();
      if (!targetId) throw new Error('Create operation did not return a primitive ID');
      result = applied.result;
      operation.target.id = targetId;
      const afterSnapshot = await hooks.getSnapshot(targetId);
      this.assertSnapshotSize(afterSnapshot);
      operation.afterSnapshot = structuredClone(afterSnapshot);
      operation.afterHash = stableHash(afterSnapshot);
      operation.state = 'applied';
      operation.appliedAt = nowIso();
      transaction.updatedAt = nowIso();
      return { result, targetId, operation: structuredClone(operation) };
    } catch (error) {
      let reconciledNoSideEffect = false;
      if (!targetId && hooks.reconcile) {
        try {
          const reconciliation = await hooks.reconcile();
          if (reconciliation.status === 'none') reconciledNoSideEffect = true;
          if (reconciliation.status === 'created' && reconciliation.targetId) {
            targetId = reconciliation.targetId;
            operation.target.id = targetId;
          }
        } catch {
          // Reconciliation failure is treated as an unknown side effect below.
        }
      }

      let compensation: 'not-needed' | 'restored' | 'failed' = reconciledNoSideEffect
        ? 'not-needed'
        : 'failed';
      if (targetId) {
        try {
          if (await hooks.exists(targetId)) {
            await hooks.remove(targetId);
          }
          compensation = (await hooks.exists(targetId)) ? 'failed' : 'restored';
        } catch {
          compensation = 'failed';
        }
      }

      operation.compensation = compensation;
      operation.error = error instanceof Error ? error.message : String(error);
      operation.rolledBackAt = compensation === 'restored' ? nowIso() : undefined;
      operation.state = compensation === 'failed' ? 'failed' : 'cancelled';
      transaction.updatedAt = nowIso();
      if (compensation === 'failed') {
        this.failTransaction(
          transaction,
          operation,
          `Create operation ${operation.id} failed with an unresolved side effect`,
        );
      }
      throw new TransactionError(
        'TRANSACTION_OPERATION_FAILED',
        `Transactional create failed: ${operation.error}`,
        {
          transactionId,
          operationId: operation.id,
          targetId,
          compensation,
          cause: operation.error,
        },
      );
    }
  }

  async runDelete<TResult>(
    transactionId: string,
    targetId: string,
    hooks: TransactionalDeleteHooks<TResult>,
  ): Promise<TransactionalDeleteResult<TResult>> {
    const transaction = this.mutable(transactionId);
    this.assertActive(transaction);
    const beforeSnapshot = await hooks.getSnapshot();
    const operation = this.reserveOperation(
      transaction,
      'delete',
      targetId,
      'ignore-primitive-id',
      beforeSnapshot,
    );

    try {
      const result = await hooks.apply();
      if (await hooks.exists()) {
        throw new Error(`Primitive ${targetId} still exists after delete`);
      }
      operation.afterSnapshot = { exists: false };
      operation.afterHash = stableHash(snapshotForHash(operation.afterSnapshot, 'absence'));
      operation.state = 'applied';
      operation.appliedAt = nowIso();
      transaction.updatedAt = nowIso();
      return { result, operation: structuredClone(operation) };
    } catch (error) {
      let compensation: 'not-needed' | 'restored' | 'failed';
      let restoredTargetId: string | undefined;
      try {
        if (await hooks.exists()) {
          const current = await hooks.getSnapshot();
          compensation =
            stableHash(snapshotForHash(current, 'ignore-primitive-id')) === operation.beforeHash
              ? 'not-needed'
              : 'failed';
        } else {
          const recreated = await hooks.recreate(structuredClone(beforeSnapshot));
          restoredTargetId = recreated.targetId;
          const recreatedSnapshot = recreated.snapshot;
          compensation =
            recreatedSnapshot !== undefined &&
            stableHash(snapshotForHash(recreatedSnapshot, 'ignore-primitive-id')) ===
              operation.beforeHash
              ? 'restored'
              : 'failed';
        }
      } catch {
        compensation = 'failed';
      }

      operation.restoredTargetId = restoredTargetId;
      operation.compensation = compensation;
      operation.error = error instanceof Error ? error.message : String(error);
      operation.rolledBackAt = compensation === 'restored' ? nowIso() : undefined;
      operation.state = compensation === 'failed' ? 'failed' : 'cancelled';
      transaction.updatedAt = nowIso();
      if (compensation === 'failed') {
        this.failTransaction(
          transaction,
          operation,
          `Delete operation ${operation.id} failed and automatic compensation failed`,
        );
      }
      throw new TransactionError(
        'TRANSACTION_OPERATION_FAILED',
        `Transactional delete failed: ${operation.error}`,
        {
          transactionId,
          operationId: operation.id,
          restoredTargetId,
          compensation,
          cause: operation.error,
        },
      );
    }
  }

  async validate(
    transactionId: string,
    gates: TransactionValidationGate[],
  ): Promise<TransactionRecord> {
    const transaction = this.mutable(transactionId);
    this.assertActive(transaction);
    if (transaction.operations.some((operation) => operation.state === 'pending')) {
      throw new TransactionError(
        'TRANSACTION_INVALID_STATE',
        `Transaction ${transactionId} contains pending operations`,
      );
    }
    if (transaction.operations.some((operation) => operation.state === 'failed')) {
      throw new TransactionError(
        'TRANSACTION_INVALID_STATE',
        `Transaction ${transactionId} contains failed operations`,
      );
    }

    transaction.state = 'validating';
    transaction.updatedAt = nowIso();
    const results = [];
    for (const gate of gates) {
      try {
        const result = await gate.run(cloneTransaction(transaction));
        results.push({ ...result, gate: gate.name });
      } catch (error) {
        results.push({
          gate: gate.name,
          passed: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    transaction.validations = results;
    const failed = results.filter((result) => !result.passed);
    transaction.state = failed.length === 0 ? 'validated' : 'active';
    transaction.updatedAt = nowIso();
    if (failed.length > 0) {
      throw new TransactionError(
        'TRANSACTION_VALIDATION_FAILED',
        `${failed.length} transaction validation gate(s) failed`,
        { failed },
      );
    }
    return cloneTransaction(transaction);
  }

  commit(transactionId: string): TransactionRecord {
    const transaction = this.mutable(transactionId);
    if (transaction.state !== 'validated') {
      throw new TransactionError(
        'TRANSACTION_INVALID_STATE',
        `Transaction ${transactionId} must be validated before commit; current state is ${transaction.state}`,
      );
    }
    if (
      transaction.operations.some((operation) => ['pending', 'failed'].includes(operation.state))
    ) {
      throw new TransactionError(
        'TRANSACTION_INVALID_STATE',
        `Transaction ${transactionId} has incomplete operations`,
      );
    }
    transaction.state = 'committed';
    transaction.updatedAt = nowIso();
    transaction.rollbackComplete = undefined;
    this.activeByDocument.delete(transaction.documentId);
    return cloneTransaction(transaction);
  }

  async rollback(transactionId: string, hooks: RollbackHooks): Promise<RollbackResult> {
    const transaction = this.mutable(transactionId);
    if (!['active', 'validated', 'failed', 'expired'].includes(transaction.state)) {
      throw new TransactionError(
        'TRANSACTION_INVALID_STATE',
        `Transaction ${transactionId} cannot be rolled back from state ${transaction.state}`,
      );
    }
    transaction.state = 'rolling-back';
    transaction.updatedAt = nowIso();

    const restoredOperationIds: string[] = [];
    const failedOperationIds: string[] = [];
    const operations = [...transaction.operations]
      .filter(
        (operation) =>
          operation.state === 'applied' ||
          (operation.state === 'failed' && operation.compensation === 'failed'),
      )
      .sort((a, b) => b.sequence - a.sequence);

    for (const operation of operations) {
      try {
        const restoreResult = (await hooks.restore(structuredClone(operation))) ?? {};
        if (restoreResult.restoredTargetId) {
          operation.restoredTargetId = restoreResult.restoredTargetId;
        }
        let verified = true;
        if (hooks.verify) {
          verified = await hooks.verify(structuredClone(operation), restoreResult);
        } else if (hooks.getSnapshot && operation.beforeHash !== undefined) {
          const current = await hooks.getSnapshot(structuredClone(operation));
          verified =
            stableHash(snapshotForHash(current, operation.snapshotHashMode)) ===
            operation.beforeHash;
        }
        if (!verified) throw new Error('Rollback verification did not match the captured state');
        operation.state = 'rolled-back';
        operation.compensation = 'restored';
        operation.rolledBackAt = nowIso();
        restoredOperationIds.push(operation.id);
      } catch (error) {
        operation.state = 'failed';
        operation.compensation = 'failed';
        operation.error = error instanceof Error ? error.message : String(error);
        failedOperationIds.push(operation.id);
      }
    }

    transaction.rollbackComplete = failedOperationIds.length === 0;
    transaction.state = transaction.rollbackComplete ? 'rolled-back' : 'failed';
    transaction.updatedAt = nowIso();
    transaction.error = transaction.rollbackComplete
      ? undefined
      : `Rollback failed for ${failedOperationIds.length} operation(s)`;
    if (transaction.rollbackComplete) {
      this.activeByDocument.delete(transaction.documentId);
    } else {
      this.activeByDocument.set(transaction.documentId, transaction.id);
    }

    const result = {
      transaction: cloneTransaction(transaction),
      restoredOperationIds,
      failedOperationIds,
    };
    if (!transaction.rollbackComplete) {
      throw new TransactionError(
        'TRANSACTION_ROLLBACK_FAILED',
        transaction.error ?? 'Transaction rollback failed',
        result as unknown as Record<string, unknown>,
      );
    }
    return result;
  }

  private expireStaleTransactions(): void {
    const now = Date.now();
    for (const transaction of this.transactions.values()) {
      if (!['active', 'validated'].includes(transaction.state)) continue;
      if (Date.parse(transaction.expiresAt) > now) continue;
      const unresolvedWrites = transaction.operations.some(
        (operation) =>
          operation.state === 'applied' ||
          (operation.state === 'failed' && operation.compensation === 'failed'),
      );
      transaction.updatedAt = nowIso();
      if (unresolvedWrites) {
        transaction.state = 'failed';
        transaction.rollbackComplete = false;
        transaction.error = 'Transaction expired with unresolved writes; rollback is required';
        this.activeByDocument.set(transaction.documentId, transaction.id);
      } else {
        transaction.state = 'expired';
        transaction.error = 'Transaction expired before commit or rollback';
        this.activeByDocument.delete(transaction.documentId);
      }
    }
  }

  clear(): void {
    this.transactions.clear();
    this.activeByDocument.clear();
  }
}

let globalManager = new TransactionManager();

export function getGlobalTransactionManager(): TransactionManager {
  return globalManager;
}

export function resetGlobalTransactionManagerForTests(): TransactionManager {
  globalManager = new TransactionManager();
  return globalManager;
}
