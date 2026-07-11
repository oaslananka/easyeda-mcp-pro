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

type TransactionErrorCode =
  | 'TRANSACTION_ACTIVE'
  | 'TRANSACTION_NOT_FOUND'
  | 'TRANSACTION_NOT_ACTIVE'
  | 'TRANSACTION_INVALID_STATE'
  | 'TRANSACTION_OPERATION_LIMIT'
  | 'TRANSACTION_SNAPSHOT_TOO_LARGE'
  | 'TRANSACTION_VALIDATION_FAILED'
  | 'TRANSACTION_ROLLBACK_FAILED'
  | 'TRANSACTION_OPERATION_FAILED';

type CompensationResult = NonNullable<TransactionOperation['compensation']>;

interface CreateReconciliationResult {
  targetId?: string;
  noSideEffect: boolean;
}

interface DeleteCompensationResult {
  compensation: CompensationResult;
  restoredTargetId?: string;
}

export class TransactionError extends Error {
  constructor(
    public readonly code: TransactionErrorCode,
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
  ): Promise<CompensationResult> {
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

  private async reconcileCreateFailure<TResult>(
    hooks: TransactionalCreateHooks<TResult>,
  ): Promise<CreateReconciliationResult> {
    if (!hooks.reconcile) return { noSideEffect: false };
    try {
      const reconciliation = await hooks.reconcile();
      if (reconciliation.status === 'none') return { noSideEffect: true };
      if (reconciliation.status === 'created' && reconciliation.targetId) {
        return { targetId: reconciliation.targetId, noSideEffect: false };
      }
    } catch {
      // An unavailable reconciliation leaves the side effect unresolved.
    }
    return { noSideEffect: false };
  }

  private async compensateCreate<TResult>(
    targetId: string | undefined,
    hooks: TransactionalCreateHooks<TResult>,
  ): Promise<CompensationResult> {
    if (!targetId) return 'failed';
    try {
      if (await hooks.exists(targetId)) await hooks.remove(targetId);
      return (await hooks.exists(targetId)) ? 'failed' : 'restored';
    } catch {
      return 'failed';
    }
  }

  private recordFailedOperation(
    transaction: TransactionRecord,
    operation: TransactionOperation,
    error: unknown,
    compensation: CompensationResult,
    failureMessage: string,
    restoredTargetId?: string,
  ): void {
    operation.restoredTargetId = restoredTargetId;
    operation.compensation = compensation;
    operation.error = error instanceof Error ? error.message : String(error);
    operation.rolledBackAt = compensation === 'restored' ? nowIso() : undefined;
    operation.state = compensation === 'failed' ? 'failed' : 'cancelled';
    transaction.updatedAt = nowIso();
    if (compensation === 'failed') {
      this.failTransaction(transaction, operation, failureMessage);
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
      const reconciliation = targetId
        ? { targetId, noSideEffect: false }
        : await this.reconcileCreateFailure(hooks);
      targetId = reconciliation.targetId;
      if (targetId) operation.target.id = targetId;
      const compensation = reconciliation.noSideEffect
        ? 'not-needed'
        : await this.compensateCreate(targetId, hooks);
      this.recordFailedOperation(
        transaction,
        operation,
        error,
        compensation,
        `Create operation ${operation.id} failed with an unresolved side effect`,
      );
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

  private async compensateDelete<TResult>(
    operation: TransactionOperation,
    beforeSnapshot: unknown,
    hooks: TransactionalDeleteHooks<TResult>,
  ): Promise<DeleteCompensationResult> {
    try {
      if (await hooks.exists()) {
        const current = await hooks.getSnapshot();
        const matches =
          stableHash(snapshotForHash(current, 'ignore-primitive-id')) === operation.beforeHash;
        return { compensation: matches ? 'not-needed' : 'failed' };
      }
      const recreated = await hooks.recreate(structuredClone(beforeSnapshot));
      const matches =
        recreated.snapshot !== undefined &&
        stableHash(snapshotForHash(recreated.snapshot, 'ignore-primitive-id')) ===
          operation.beforeHash;
      return {
        compensation: matches ? 'restored' : 'failed',
        restoredTargetId: recreated.targetId,
      };
    } catch {
      return { compensation: 'failed' };
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
      const { compensation, restoredTargetId } = await this.compensateDelete(
        operation,
        beforeSnapshot,
        hooks,
      );
      this.recordFailedOperation(
        transaction,
        operation,
        error,
        compensation,
        `Delete operation ${operation.id} failed and automatic compensation failed`,
        restoredTargetId,
      );
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

  private rollbackCandidates(transaction: TransactionRecord): TransactionOperation[] {
    return [...transaction.operations]
      .filter(
        (operation) =>
          operation.state === 'applied' ||
          (operation.state === 'failed' && operation.compensation === 'failed'),
      )
      .sort((a, b) => b.sequence - a.sequence);
  }

  private async verifyRollback(
    operation: TransactionOperation,
    hooks: RollbackHooks,
    restoreResult: { restoredTargetId?: string },
  ): Promise<boolean> {
    if (hooks.verify) return hooks.verify(structuredClone(operation), restoreResult);
    if (!hooks.getSnapshot || operation.beforeHash === undefined) return true;
    const current = await hooks.getSnapshot(structuredClone(operation));
    return (
      stableHash(snapshotForHash(current, operation.snapshotHashMode)) === operation.beforeHash
    );
  }

  private async rollbackOperation(
    operation: TransactionOperation,
    hooks: RollbackHooks,
  ): Promise<boolean> {
    try {
      const restoreResult = (await hooks.restore(structuredClone(operation))) ?? {};
      if (restoreResult.restoredTargetId) {
        operation.restoredTargetId = restoreResult.restoredTargetId;
      }
      if (!(await this.verifyRollback(operation, hooks, restoreResult))) {
        throw new Error('Rollback verification did not match the captured state');
      }
      operation.state = 'rolled-back';
      operation.compensation = 'restored';
      operation.rolledBackAt = nowIso();
      return true;
    } catch (error) {
      operation.state = 'failed';
      operation.compensation = 'failed';
      operation.error = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  private finalizeRollback(
    transaction: TransactionRecord,
    restoredOperationIds: string[],
    failedOperationIds: string[],
  ): RollbackResult {
    transaction.rollbackComplete = failedOperationIds.length === 0;
    transaction.state = transaction.rollbackComplete ? 'rolled-back' : 'failed';
    transaction.updatedAt = nowIso();
    transaction.error = transaction.rollbackComplete
      ? undefined
      : `Rollback failed for ${failedOperationIds.length} operation(s)`;
    if (transaction.rollbackComplete) this.activeByDocument.delete(transaction.documentId);
    else this.activeByDocument.set(transaction.documentId, transaction.id);

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
    for (const operation of this.rollbackCandidates(transaction)) {
      const restored = await this.rollbackOperation(operation, hooks);
      (restored ? restoredOperationIds : failedOperationIds).push(operation.id);
    }
    return this.finalizeRollback(transaction, restoredOperationIds, failedOperationIds);
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
