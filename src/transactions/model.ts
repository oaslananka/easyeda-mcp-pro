export type TransactionState =
  | 'active'
  | 'validating'
  | 'validated'
  | 'committed'
  | 'rolling-back'
  | 'rolled-back'
  | 'failed'
  | 'expired';

export type TransactionOperationState =
  'pending' | 'applied' | 'rolled-back' | 'cancelled' | 'failed';

export type TransactionOperationKind = 'create' | 'modify' | 'delete';
export type TransactionSnapshotHashMode = 'exact' | 'ignore-primitive-id' | 'absence';

export interface TransactionTarget {
  type: 'schematic-primitive';
  id: string;
}

export interface TransactionOperation {
  id: string;
  sequence: number;
  kind: TransactionOperationKind;
  state: TransactionOperationState;
  target: TransactionTarget;
  beforeSnapshot?: unknown;
  beforeHash?: string;
  afterSnapshot?: unknown;
  afterHash?: string;
  snapshotHashMode: TransactionSnapshotHashMode;
  restoredTargetId?: string;
  appliedAt?: string;
  rolledBackAt?: string;
  error?: string;
  compensation?: 'not-needed' | 'restored' | 'failed';
}

export interface TransactionValidationResult {
  gate: string;
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface TransactionRecord {
  id: string;
  documentId: string;
  label?: string;
  state: TransactionState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  maxOperations: number;
  operations: TransactionOperation[];
  validations: TransactionValidationResult[];
  rollbackComplete?: boolean;
  error?: string;
}

export interface BeginTransactionInput {
  documentId: string;
  label?: string;
  maxOperations?: number;
  ttlMs?: number;
}

export interface TransactionValidationGate {
  name: string;
  run: (
    transaction: Readonly<TransactionRecord>,
  ) => TransactionValidationResult | Promise<TransactionValidationResult>;
}

export interface TransactionalModifyHooks<TResult = unknown> {
  getSnapshot: () => Promise<unknown>;
  apply: () => Promise<TResult>;
  restore: (snapshot: unknown) => Promise<unknown>;
}

export interface TransactionalModifyResult<TResult = unknown> {
  result: TResult;
  operation: TransactionOperation;
}

export interface TransactionalCreateApplyResult<TResult = unknown> {
  result: TResult;
  targetId: string;
}

export interface TransactionalCreateReconciliation {
  status: 'none' | 'created' | 'ambiguous';
  targetId?: string;
}

export interface TransactionalCreateHooks<TResult = unknown> {
  apply: () => Promise<TransactionalCreateApplyResult<TResult>>;
  getSnapshot: (targetId: string) => Promise<unknown>;
  remove: (targetId: string) => Promise<unknown>;
  exists: (targetId: string) => Promise<boolean>;
  reconcile?: () => Promise<TransactionalCreateReconciliation>;
}

export interface TransactionalCreateResult<TResult = unknown> {
  result: TResult;
  targetId: string;
  operation: TransactionOperation;
}

export interface TransactionalDeleteRecreateResult {
  targetId: string;
  snapshot?: unknown;
}

export interface TransactionalDeleteHooks<TResult = unknown> {
  getSnapshot: () => Promise<unknown>;
  apply: () => Promise<TResult>;
  exists: () => Promise<boolean>;
  recreate: (snapshot: unknown) => Promise<TransactionalDeleteRecreateResult>;
}

export interface TransactionalDeleteResult<TResult = unknown> {
  result: TResult;
  operation: TransactionOperation;
}

export interface RollbackRestoreResult {
  restoredTargetId?: string;
}

export interface RollbackHooks {
  restore: (operation: Readonly<TransactionOperation>) => Promise<RollbackRestoreResult | void>;
  verify?: (
    operation: Readonly<TransactionOperation>,
    restoreResult: Readonly<RollbackRestoreResult>,
  ) => Promise<boolean>;
  getSnapshot?: (operation: Readonly<TransactionOperation>) => Promise<unknown>;
}

export interface RollbackResult {
  transaction: TransactionRecord;
  restoredOperationIds: string[];
  failedOperationIds: string[];
}
