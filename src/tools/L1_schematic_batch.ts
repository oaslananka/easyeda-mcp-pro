import { z } from 'zod';
import { type EnvConfig } from '../config/env.js';
import {
  deletePrimitiveExact,
  getGlobalTransactionManager,
  getPrimitiveSnapshot,
  listPrimitiveIds,
  primitiveExists,
  recreatePrimitiveSnapshot,
  rollbackEasyedaTransaction,
  TransactionError,
} from '../transactions/index.js';
import { type ToolContext, type ToolDefinition } from './types.js';

const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() });
const operationIdSchema = z.string().min(1).max(120);
const textAlignModeSchema = z.number().int().min(1).max(9);
const deviceItemSchema = z
  .object({ libraryUuid: z.string().min(1), uuid: z.string().min(1) })
  .passthrough();
const commonCreateSchema = { operationId: operationIdSchema, action: z.literal('create') };

const createComponentSchema = z.object({
  ...commonCreateSchema,
  primitiveKind: z.literal('component'),
  deviceItem: deviceItemSchema,
  x: z.number().finite(),
  y: z.number().finite(),
  rotation: z.number().finite().optional(),
  mirror: z.boolean().optional(),
  addIntoBom: z.boolean().optional(),
  addIntoPcb: z.boolean().optional(),
});
const createWireSchema = z.object({
  ...commonCreateSchema,
  primitiveKind: z.literal('wire'),
  points: z.array(pointSchema).min(2).max(500),
  netName: z.string().min(1),
  color: z.string().optional(),
  lineWidth: z.number().positive().optional(),
  lineType: z.number().int().nonnegative().optional(),
});
const createTextSchema = z.object({
  ...commonCreateSchema,
  primitiveKind: z.literal('text'),
  x: z.number().finite(),
  y: z.number().finite(),
  content: z.string().min(1).max(10_000),
  rotation: z.number().finite().optional(),
  color: z.string().optional(),
  fontName: z.string().optional(),
  fontSize: z.number().positive().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  alignMode: textAlignModeSchema.optional(),
});
const createRectangleSchema = z.object({
  ...commonCreateSchema,
  primitiveKind: z.literal('rectangle'),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive(),
  height: z.number().positive(),
  cornerRadius: z.number().nonnegative().optional(),
  rotation: z.number().finite().optional(),
  color: z.string().optional(),
  fillColor: z.string().optional(),
  lineWidth: z.number().positive().optional(),
  lineType: z.number().int().nonnegative().optional(),
  fillStyle: z.string().optional(),
});
const createCircleSchema = z.object({
  ...commonCreateSchema,
  primitiveKind: z.literal('circle'),
  centerX: z.number().finite(),
  centerY: z.number().finite(),
  radius: z.number().positive(),
  color: z.string().optional(),
  fillColor: z.string().optional(),
  lineWidth: z.number().positive().optional(),
  lineType: z.number().int().nonnegative().optional(),
  fillStyle: z.string().optional(),
});
const createPolygonSchema = z.object({
  ...commonCreateSchema,
  primitiveKind: z.literal('polygon'),
  points: z.array(pointSchema).min(3).max(500),
  color: z.string().optional(),
  fillColor: z.string().optional(),
  lineWidth: z.number().positive().optional(),
  lineType: z.number().int().nonnegative().optional(),
});
const createNetFlagSchema = z.object({
  ...commonCreateSchema,
  primitiveKind: z.literal('netflag'),
  netName: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
  rotation: z.number().finite().optional(),
  identification: z.enum(['Power', 'Ground', 'AnalogGround', 'ProtectGround']),
});
const createNetPortSchema = z.object({
  ...commonCreateSchema,
  primitiveKind: z.literal('netport'),
  netName: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
  rotation: z.number().finite().optional(),
  portType: z.enum(['input', 'output', 'bidirectional', 'triState', 'passive']).optional(),
});
const createOperationSchema = z.union([
  createComponentSchema,
  createWireSchema,
  createTextSchema,
  createRectangleSchema,
  createCircleSchema,
  createPolygonSchema,
  createNetFlagSchema,
  createNetPortSchema,
]);
const modifyOperationSchema = z
  .object({
    operationId: operationIdSchema,
    action: z.literal('modify'),
    primitiveId: z.string().min(1),
    property: z.record(z.string(), z.unknown()),
  })
  .superRefine((value, context) => {
    if (
      Object.prototype.hasOwnProperty.call(value.property, 'alignMode') &&
      !textAlignModeSchema.safeParse(value.property.alignMode).success
    ) {
      context.addIssue({
        code: 'custom',
        path: ['property', 'alignMode'],
        message: 'alignMode must be an integer from 1 through 9',
      });
    }
  });
const deleteOperationSchema = z.object({
  operationId: operationIdSchema,
  action: z.literal('delete'),
  primitiveId: z.string().min(1),
});
const batchOperationSchema = z.union([
  createOperationSchema,
  modifyOperationSchema,
  deleteOperationSchema,
]);
type BatchOperation = z.infer<typeof batchOperationSchema>;
type CreateOperation = z.infer<typeof createOperationSchema>;

const batchInputSchema = z
  .object({
    projectId: z.string().min(1),
    transactionId: z.string().min(1).optional(),
    operations: z.array(batchOperationSchema).min(1).max(200),
    atomic: z.literal(true).default(true),
    dryRun: z.boolean().default(false),
    confirmWrite: z.literal(true),
  })
  .superRefine((value, context) => {
    const operationIds = new Set<string>();
    const targetIds = new Set<string>();
    for (const [index, operation] of value.operations.entries()) {
      if (operationIds.has(operation.operationId)) {
        context.addIssue({
          code: 'custom',
          path: ['operations', index, 'operationId'],
          message: `Duplicate operationId: ${operation.operationId}`,
        });
      }
      operationIds.add(operation.operationId);
      if (operation.action !== 'create') {
        if (targetIds.has(operation.primitiveId)) {
          context.addIssue({
            code: 'custom',
            path: ['operations', index, 'primitiveId'],
            message: `Primitive ${operation.primitiveId} can be modified or deleted only once per atomic batch`,
          });
        }
        targetIds.add(operation.primitiveId);
      }
    }
  });
type BatchInput = z.infer<typeof batchInputSchema>;

const batchItemResultSchema = z.object({
  operation_id: z.string(),
  action: z.enum(['create', 'modify', 'delete']),
  status: z.enum(['planned', 'applied', 'failed', 'rolled-back']),
  primitive_id: z.string().optional(),
  restored_primitive_id: z.string().optional(),
  transaction_operation_id: z.string().optional(),
  error_code: z.string().optional(),
  error: z.string().optional(),
});
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
const batchOutputSchema = z.object({
  success: z.boolean(),
  atomic: z.literal(true),
  dry_run: z.boolean(),
  internally_managed_transaction: z.boolean(),
  transaction_id: z.string().optional(),
  transaction_state: transactionStateSchema.optional(),
  committed: z.boolean(),
  rolled_back: z.boolean(),
  results: z.array(batchItemResultSchema),
  error_code: z.string().optional(),
  error: z.string().optional(),
  rollback_error: z.string().optional(),
});
type BatchItemResult = z.infer<typeof batchItemResultSchema>;

const RECREATABLE_DELETE_KINDS = new Set(['wire', 'text', 'rectangle', 'circle', 'polygon']);

function bridgeCreateRequest(operation: CreateOperation): { method: string; params: object } {
  const { operationId: _operationId, action: _action, primitiveKind: _kind, ...params } = operation;
  switch (operation.primitiveKind) {
    case 'component':
      return { method: 'schematic.placeComponent', params };
    case 'wire':
      return { method: 'schematic.addWire', params };
    case 'text':
      return { method: 'schematic.addText', params };
    case 'rectangle':
      return { method: 'schematic.addRectangle', params };
    case 'circle':
      return { method: 'schematic.addCircle', params };
    case 'polygon':
      return { method: 'schematic.addPolygon', params };
    case 'netflag':
      return { method: 'schematic.createNetFlag', params };
    case 'netport':
      return { method: 'schematic.createNetPort', params };
  }
}

async function preflightDeleteOperations(
  context: ToolContext,
  operations: BatchOperation[],
): Promise<Map<string, Record<string, unknown>>> {
  const snapshots = new Map<string, Record<string, unknown>>();
  for (const operation of operations) {
    if (operation.action !== 'delete') continue;
    const snapshot = await getPrimitiveSnapshot(context.bridge, operation.primitiveId);
    const primitiveKind = snapshot.primitiveKind;
    if (typeof primitiveKind !== 'string' || !RECREATABLE_DELETE_KINDS.has(primitiveKind)) {
      throw new TransactionError(
        'TRANSACTION_INVALID_STATE',
        `Atomic delete rollback is not supported for ${String(primitiveKind)} primitive ${operation.primitiveId}`,
        {
          primitiveId: operation.primitiveId,
          primitiveKind,
          supportedKinds: Array.from(RECREATABLE_DELETE_KINDS),
        },
      );
    }
    snapshots.set(operation.primitiveId, snapshot);
  }
  return snapshots;
}

const CREATE_RECONCILE_ATTEMPTS = 30;
const CREATE_RECONCILE_DELAY_MS = 100;
const CREATE_RECONCILE_FAILURE_ATTEMPTS = 10;

async function pollAddedPrimitiveIds(
  context: ToolContext,
  primitiveKind: string,
  beforeIds: ReadonlySet<string>,
  attempts: number,
): Promise<string[]> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const afterIds = await listPrimitiveIds(context.bridge, primitiveKind);
    const added = afterIds.filter((id) => !beforeIds.has(id));
    if (added.length > 0 || attempt === attempts - 1) return added;
    await new Promise<void>((resolve) => setTimeout(resolve, CREATE_RECONCILE_DELAY_MS));
  }
  return [];
}

async function executeCreate(
  context: ToolContext,
  transactionId: string,
  operation: CreateOperation,
) {
  const manager = getGlobalTransactionManager();
  const beforeIds = new Set(await listPrimitiveIds(context.bridge, operation.primitiveKind));
  const request = bridgeCreateRequest(operation);
  return manager.runCreate(transactionId, operation.operationId, {
    apply: async () => {
      const result = await context.bridge.call(request.method, request.params);
      const added = await pollAddedPrimitiveIds(
        context,
        operation.primitiveKind,
        beforeIds,
        CREATE_RECONCILE_ATTEMPTS,
      );
      if (added.length > 1) {
        throw new Error(
          `Create reconciliation is ambiguous: ${added.length} new ${operation.primitiveKind} primitives`,
        );
      }

      // EasyEDA create() results are not consistently typed and can contain
      // an unrelated primitive ID. The expected-kind inventory delta is the
      // sole authority for transactional create identity.
      const targetId = added[0];
      if (!targetId) throw new Error('Create result did not expose a unique primitive ID');
      return { result, targetId };
    },
    getSnapshot: async (targetId) =>
      getPrimitiveSnapshot(context.bridge, targetId, operation.primitiveKind),
    remove: async (targetId) => deletePrimitiveExact(context.bridge, targetId),
    exists: async (targetId) => primitiveExists(context.bridge, targetId, operation.primitiveKind),
    reconcile: async () => {
      const added = await pollAddedPrimitiveIds(
        context,
        operation.primitiveKind,
        beforeIds,
        CREATE_RECONCILE_FAILURE_ATTEMPTS,
      );
      if (added.length === 0) return { status: 'none' as const };
      if (added.length === 1) return { status: 'created' as const, targetId: added[0] };
      return { status: 'ambiguous' as const };
    },
  });
}

async function executeModify(
  context: ToolContext,
  transactionId: string,
  operation: z.infer<typeof modifyOperationSchema>,
) {
  return getGlobalTransactionManager().runModify(transactionId, operation.primitiveId, {
    getSnapshot: async () => getPrimitiveSnapshot(context.bridge, operation.primitiveId),
    apply: async () =>
      context.bridge.call('schematic.modifyPrimitive', {
        primitiveId: operation.primitiveId,
        property: operation.property,
      }),
    restore: async (snapshot) =>
      context.bridge.call('schematic.restorePrimitiveSnapshot', { snapshot }),
  });
}

async function executeDelete(
  context: ToolContext,
  transactionId: string,
  operation: z.infer<typeof deleteOperationSchema>,
) {
  return getGlobalTransactionManager().runDelete(transactionId, operation.primitiveId, {
    getSnapshot: async () => getPrimitiveSnapshot(context.bridge, operation.primitiveId),
    apply: async () => deletePrimitiveExact(context.bridge, operation.primitiveId),
    exists: async () => primitiveExists(context.bridge, operation.primitiveId),
    recreate: async (snapshot) => {
      const recreated = await recreatePrimitiveSnapshot(context.bridge, snapshot);
      return { targetId: recreated.primitiveId, snapshot: recreated.snapshot };
    },
  });
}

async function validateAndCommitInternalTransaction(
  transactionId: string,
  expectedOperationCount: number,
) {
  const manager = getGlobalTransactionManager();
  await manager.validate(transactionId, [
    {
      name: 'batch-operation-count',
      run: (transaction) => ({
        gate: '',
        passed: transaction.operations.length === expectedOperationCount,
        message: `Expected ${expectedOperationCount} operation(s); found ${transaction.operations.length}.`,
      }),
    },
    {
      name: 'batch-operation-state',
      run: (transaction) => {
        const incomplete = transaction.operations.filter((item) => item.state !== 'applied');
        return {
          gate: '',
          passed: incomplete.length === 0,
          message:
            incomplete.length === 0
              ? 'All batch operations are applied.'
              : `${incomplete.length} operation(s) are not applied.`,
        };
      },
    },
  ]);
  return manager.commit(transactionId);
}

export function registerSchematicBatchTools(
  registry: { register: (definition: ToolDefinition) => void },
  _config: EnvConfig,
): void {
  registry.register({
    name: 'easyeda_schematic_batch_write',
    title: 'Atomic schematic batch write',
    description:
      'Apply up to 200 validated schematic create, modify, and delete operations in one snapshot-backed transaction. Any failure rolls the whole transaction back. Delete is limited to safely recreatable drawing primitives.',
    profile: 'core',
    evidence: ['runtime-probe', 'inferred'],
    risk: 'high',
    confirmWrite: true,
    group: 'schematic',
    version: '1.0.0',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: batchInputSchema,
    outputSchema: batchOutputSchema,
    handler: async (context: ToolContext, input: unknown) => {
      const parsed: BatchInput = batchInputSchema.parse(input);
      const results: BatchItemResult[] = [];
      let transactionId = parsed.transactionId;
      let internallyManaged = false;
      let transactionEngaged = false;

      try {
        await preflightDeleteOperations(context, parsed.operations);
        if (parsed.dryRun) {
          return {
            success: true,
            atomic: true as const,
            dry_run: true,
            internally_managed_transaction: false,
            committed: false,
            rolled_back: false,
            results: parsed.operations.map((operation) => ({
              operation_id: operation.operationId,
              action: operation.action,
              status: 'planned' as const,
              primitive_id: operation.action === 'create' ? undefined : operation.primitiveId,
            })),
          };
        }

        const manager = getGlobalTransactionManager();
        if (transactionId) {
          const transaction = manager.get(transactionId);
          if (transaction.documentId !== parsed.projectId) {
            throw new TransactionError(
              'TRANSACTION_INVALID_STATE',
              `Transaction ${transactionId} belongs to ${transaction.documentId}, not ${parsed.projectId}`,
            );
          }
          transactionEngaged = true;
        } else {
          transactionId = manager.begin({
            documentId: parsed.projectId,
            label: 'atomic schematic batch',
            maxOperations: parsed.operations.length,
          }).id;
          internallyManaged = true;
          transactionEngaged = true;
        }

        const initialOperationCount = manager.get(transactionId).operations.length;
        for (const operation of parsed.operations) {
          if (operation.action === 'create') {
            const executed = await executeCreate(context, transactionId, operation);
            results.push({
              operation_id: operation.operationId,
              action: 'create',
              status: 'applied',
              primitive_id: executed.targetId,
              transaction_operation_id: executed.operation.id,
            });
          } else if (operation.action === 'modify') {
            const executed = await executeModify(context, transactionId, operation);
            results.push({
              operation_id: operation.operationId,
              action: 'modify',
              status: 'applied',
              primitive_id: operation.primitiveId,
              transaction_operation_id: executed.operation.id,
            });
          } else {
            const executed = await executeDelete(context, transactionId, operation);
            results.push({
              operation_id: operation.operationId,
              action: 'delete',
              status: 'applied',
              primitive_id: operation.primitiveId,
              transaction_operation_id: executed.operation.id,
            });
          }
        }

        if (internallyManaged) {
          const committed = await validateAndCommitInternalTransaction(
            transactionId,
            initialOperationCount + parsed.operations.length,
          );
          return {
            success: true,
            atomic: true as const,
            dry_run: false,
            internally_managed_transaction: true,
            transaction_id: transactionId,
            transaction_state: committed.state,
            committed: true,
            rolled_back: false,
            results,
          };
        }

        const transaction = manager.get(transactionId);
        return {
          success: true,
          atomic: true as const,
          dry_run: false,
          internally_managed_transaction: false,
          transaction_id: transactionId,
          transaction_state: transaction.state,
          committed: false,
          rolled_back: false,
          results,
        };
      } catch (error) {
        const errorPrimitiveId =
          error instanceof TransactionError && typeof error.details?.primitiveId === 'string'
            ? error.details.primitiveId
            : undefined;
        const failedOperation =
          (errorPrimitiveId
            ? parsed.operations.find(
                (operation) =>
                  operation.action !== 'create' && operation.primitiveId === errorPrimitiveId,
              )
            : undefined) ?? parsed.operations[results.length];
        if (failedOperation) {
          results.push({
            operation_id: failedOperation.operationId,
            action: failedOperation.action,
            status: 'failed',
            primitive_id:
              failedOperation.action === 'create' ? undefined : failedOperation.primitiveId,
            error_code: error instanceof TransactionError ? error.code : undefined,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        let rolledBack = false;
        let rollbackError: string | undefined;
        let transactionState:
          | 'active'
          | 'validating'
          | 'validated'
          | 'committed'
          | 'rolling-back'
          | 'rolled-back'
          | 'failed'
          | 'expired'
          | undefined;
        if (transactionId && transactionEngaged) {
          try {
            const rollback = await rollbackEasyedaTransaction(
              getGlobalTransactionManager(),
              transactionId,
              context.bridge,
            );
            rolledBack = rollback.transaction.rollbackComplete === true;
            transactionState = rollback.transaction.state;
            if (rolledBack) {
              for (const result of results) {
                if (result.status === 'applied') result.status = 'rolled-back';
              }
            }
          } catch (rollbackFailure) {
            rollbackError =
              rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure);
            try {
              transactionState = getGlobalTransactionManager().get(transactionId).state;
            } catch {
              // Keep the original batch error when transaction status is unavailable.
            }
          }
        }

        return {
          success: false,
          atomic: true as const,
          dry_run: parsed.dryRun,
          internally_managed_transaction: internallyManaged,
          transaction_id: transactionId,
          transaction_state: transactionState,
          committed: false,
          rolled_back: rolledBack,
          results,
          error_code: error instanceof TransactionError ? error.code : 'BATCH_WRITE_FAILED',
          error: error instanceof Error ? error.message : String(error),
          rollback_error: rollbackError,
        };
      }
    },
  });
}
