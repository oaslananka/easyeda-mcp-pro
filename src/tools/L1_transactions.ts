import { z } from 'zod';
import { type EnvConfig } from '../config/env.js';
import {
  getGlobalTransactionManager,
  rollbackEasyedaTransaction,
  TransactionError,
  type TransactionRecord,
} from '../transactions/index.js';
import { type ToolContext, type ToolDefinition } from './types.js';

const transactionStateSchema = z.enum([
  'active',
  'validating',
  'validated',
  'committed',
  'rolling-back',
  'rolled-back',
  'failed',
  'expired',
]);

const transactionPublicSchema = z.object({
  id: z.string(),
  document_id: z.string(),
  label: z.string().optional(),
  state: transactionStateSchema,
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string(),
  max_operations: z.number().int().positive(),
  operation_count: z.number().int().nonnegative(),
  applied_operation_count: z.number().int().nonnegative(),
  rolled_back_operation_count: z.number().int().nonnegative(),
  failed_operation_count: z.number().int().nonnegative(),
  rollback_complete: z.boolean().optional(),
  error: z.string().optional(),
  validations: z.array(
    z.object({
      gate: z.string(),
      passed: z.boolean(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  operations: z.array(
    z.object({
      id: z.string(),
      sequence: z.number().int().positive(),
      kind: z.enum(['create', 'modify', 'delete']),
      state: z.enum(['pending', 'applied', 'rolled-back', 'cancelled', 'failed']),
      target_type: z.literal('schematic-primitive'),
      target_id: z.string(),
      before_hash: z.string().optional(),
      snapshot_hash_mode: z.enum(['exact', 'ignore-primitive-id', 'absence']),
      restored_target_id: z.string().optional(),
      after_hash: z.string().optional(),
      applied_at: z.string().optional(),
      rolled_back_at: z.string().optional(),
      compensation: z.enum(['not-needed', 'restored', 'failed']).optional(),
      error: z.string().optional(),
    }),
  ),
});

const transactionResultSchema = z.object({
  success: z.boolean(),
  transaction: transactionPublicSchema.optional(),
  restored_operation_ids: z.array(z.string()).optional(),
  failed_operation_ids: z.array(z.string()).optional(),
  error_code: z.string().optional(),
  error: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

function publicTransaction(transaction: TransactionRecord) {
  return {
    id: transaction.id,
    document_id: transaction.documentId,
    label: transaction.label,
    state: transaction.state,
    created_at: transaction.createdAt,
    updated_at: transaction.updatedAt,
    expires_at: transaction.expiresAt,
    max_operations: transaction.maxOperations,
    operation_count: transaction.operations.length,
    applied_operation_count: transaction.operations.filter(
      (operation) => operation.state === 'applied',
    ).length,
    rolled_back_operation_count: transaction.operations.filter(
      (operation) => operation.state === 'rolled-back',
    ).length,
    failed_operation_count: transaction.operations.filter(
      (operation) => operation.state === 'failed',
    ).length,
    rollback_complete: transaction.rollbackComplete,
    error: transaction.error,
    validations: transaction.validations,
    operations: transaction.operations.map((operation) => ({
      id: operation.id,
      sequence: operation.sequence,
      kind: operation.kind,
      state: operation.state,
      target_type: operation.target.type,
      target_id: operation.target.id,
      before_hash: operation.beforeHash,
      after_hash: operation.afterHash,
      snapshot_hash_mode: operation.snapshotHashMode,
      restored_target_id: operation.restoredTargetId,
      applied_at: operation.appliedAt,
      rolled_back_at: operation.rolledBackAt,
      compensation: operation.compensation,
      error: operation.error,
    })),
  };
}

function transactionFailure(error: unknown, transactionId?: string) {
  const manager = getGlobalTransactionManager();
  let transaction: ReturnType<typeof publicTransaction> | undefined;
  if (transactionId) {
    try {
      transaction = publicTransaction(manager.get(transactionId));
    } catch {
      // Preserve the original error when the transaction itself is unavailable.
    }
  }
  if (error instanceof TransactionError) {
    const details = error.details ? { ...error.details } : undefined;
    if (details) delete details.transaction;
    return {
      success: false,
      transaction,
      error_code: error.code,
      error: error.message,
      details,
    };
  }
  return {
    success: false,
    transaction,
    error_code: 'TRANSACTION_INTERNAL_ERROR',
    error: error instanceof Error ? error.message : String(error),
  };
}

export function registerTransactionTools(
  registry: { register: (definition: ToolDefinition) => void },
  _config: EnvConfig,
): void {
  registry.register({
    name: 'easyeda_project_begin_transaction',
    title: 'Begin project transaction',
    description:
      'Open an in-memory, document-scoped transaction for snapshot-backed schematic writes. Only one ' +
      'active transaction is allowed per document. Beginning a transaction does not modify EasyEDA.',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'project',
    version: '1.0.0',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: z.object({
      projectId: z.string().min(1),
      label: z.string().max(200).optional(),
      maxOperations: z.coerce.number().int().min(1).max(2000).default(250),
      ttlSeconds: z.coerce.number().int().min(60).max(86_400).default(1800),
    }),
    outputSchema: transactionResultSchema,
    handler: async (_ctx: ToolContext, input: unknown) => {
      const parsed = z
        .object({
          projectId: z.string().min(1),
          label: z.string().max(200).optional(),
          maxOperations: z.coerce.number().int().min(1).max(2000).default(250),
          ttlSeconds: z.coerce.number().int().min(60).max(86_400).default(1800),
        })
        .parse(input);
      try {
        const transaction = getGlobalTransactionManager().begin({
          documentId: parsed.projectId,
          label: parsed.label,
          maxOperations: parsed.maxOperations,
          ttlMs: parsed.ttlSeconds * 1000,
        });
        return { success: true, transaction: publicTransaction(transaction) };
      } catch (error) {
        return transactionFailure(error);
      }
    },
  });

  registry.register({
    name: 'easyeda_project_get_transaction_status',
    title: 'Get project transaction status',
    description:
      'Read transaction state, validation results, operation hashes, and rollback status without ' +
      'exposing captured primitive snapshots.',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'project',
    version: '1.0.0',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema: z.object({ transactionId: z.string().min(1) }),
    outputSchema: transactionResultSchema,
    handler: async (_ctx: ToolContext, input: unknown) => {
      const { transactionId } = z.object({ transactionId: z.string().min(1) }).parse(input);
      try {
        return {
          success: true,
          transaction: publicTransaction(getGlobalTransactionManager().get(transactionId)),
        };
      } catch (error) {
        return transactionFailure(error, transactionId);
      }
    },
  });

  registry.register({
    name: 'easyeda_project_validate_transaction',
    title: 'Validate project transaction',
    description:
      'Run transaction consistency gates before commit: bridge availability, pending/failed operation ' +
      'checks, optional expected operation count, and optional requirement for at least one applied write.',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'project',
    version: '1.0.0',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema: z.object({
      transactionId: z.string().min(1),
      expectedOperationCount: z.coerce.number().int().nonnegative().optional(),
      requireAppliedOperations: z.boolean().default(false),
      requireBridgeConnected: z.boolean().default(true),
    }),
    outputSchema: transactionResultSchema,
    handler: async (ctx: ToolContext, input: unknown) => {
      const parsed = z
        .object({
          transactionId: z.string().min(1),
          expectedOperationCount: z.coerce.number().int().nonnegative().optional(),
          requireAppliedOperations: z.boolean().default(false),
          requireBridgeConnected: z.boolean().default(true),
        })
        .parse(input);
      try {
        const transaction = await getGlobalTransactionManager().validate(parsed.transactionId, [
          {
            name: 'bridge-connected',
            run: () => ({
              gate: '',
              passed: !parsed.requireBridgeConnected || ctx.bridge.connected,
              message:
                !parsed.requireBridgeConnected || ctx.bridge.connected
                  ? 'Bridge connection requirement satisfied.'
                  : 'Bridge is not connected.',
            }),
          },
          {
            name: 'operation-count',
            run: (current) => ({
              gate: '',
              passed:
                parsed.expectedOperationCount === undefined ||
                current.operations.length === parsed.expectedOperationCount,
              message:
                parsed.expectedOperationCount === undefined
                  ? 'No exact operation count requested.'
                  : `Expected ${parsed.expectedOperationCount} operation(s); found ${current.operations.length}.`,
              details: {
                expected: parsed.expectedOperationCount,
                actual: current.operations.length,
              },
            }),
          },
          {
            name: 'applied-operation-required',
            run: (current) => {
              const applied = current.operations.filter(
                (operation) => operation.state === 'applied',
              ).length;
              return {
                gate: '',
                passed: !parsed.requireAppliedOperations || applied > 0,
                message:
                  !parsed.requireAppliedOperations || applied > 0
                    ? `${applied} applied operation(s) available.`
                    : 'At least one applied operation is required.',
                details: { applied },
              };
            },
          },
        ]);
        return { success: true, transaction: publicTransaction(transaction) };
      } catch (error) {
        return transactionFailure(error, parsed.transactionId);
      }
    },
  });

  registry.register({
    name: 'easyeda_project_commit_transaction',
    title: 'Commit project transaction',
    description:
      'Finalize a transaction after its writes and validation gates succeed. Commit removes rollback ' +
      'eligibility and releases the document transaction lock.',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'medium',
    confirmWrite: true,
    group: 'project',
    version: '1.0.0',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: z.object({
      transactionId: z.string().min(1),
      confirmWrite: z.literal(true),
    }),
    outputSchema: transactionResultSchema,
    handler: async (_ctx: ToolContext, input: unknown) => {
      const { transactionId } = z
        .object({ transactionId: z.string().min(1), confirmWrite: z.literal(true) })
        .parse(input);
      try {
        return {
          success: true,
          transaction: publicTransaction(getGlobalTransactionManager().commit(transactionId)),
        };
      } catch (error) {
        return transactionFailure(error, transactionId);
      }
    },
  });

  registry.register({
    name: 'easyeda_project_rollback_transaction',
    title: 'Rollback project transaction',
    description:
      'Controlled write: restore applied schematic primitive snapshots in reverse order, verify each ' +
      'restored hash, and report partial rollback explicitly instead of hiding inconsistencies.',
    profile: 'core',
    evidence: ['runtime-probe', 'inferred'],
    risk: 'medium',
    confirmWrite: true,
    group: 'project',
    version: '1.0.0',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: z.object({
      transactionId: z.string().min(1),
      confirmWrite: z.literal(true),
    }),
    outputSchema: transactionResultSchema,
    handler: async (ctx: ToolContext, input: unknown) => {
      const { transactionId } = z
        .object({ transactionId: z.string().min(1), confirmWrite: z.literal(true) })
        .parse(input);
      try {
        const result = await rollbackEasyedaTransaction(
          getGlobalTransactionManager(),
          transactionId,
          ctx.bridge,
        );
        return {
          success: true,
          transaction: publicTransaction(result.transaction),
          restored_operation_ids: result.restoredOperationIds,
          failed_operation_ids: result.failedOperationIds,
        };
      } catch (error) {
        const failure = transactionFailure(error, transactionId);
        const details = error instanceof TransactionError ? error.details : undefined;
        return {
          ...failure,
          restored_operation_ids: Array.isArray(details?.restoredOperationIds)
            ? (details.restoredOperationIds as string[])
            : undefined,
          failed_operation_ids: Array.isArray(details?.failedOperationIds)
            ? (details.failedOperationIds as string[])
            : undefined,
        };
      }
    },
  });
}
