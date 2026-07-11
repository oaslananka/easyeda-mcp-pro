import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../../../src/config/env.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { registerTransactionTools } from '../../../src/tools/L1_transactions.js';
import { type ToolContext } from '../../../src/tools/types.js';
import {
  getGlobalTransactionManager,
  resetGlobalTransactionManagerForTests,
} from '../../../src/transactions/index.js';

describe('Project transaction tools', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetGlobalTransactionManagerForTests();
    registry = new ToolRegistry();
    registerTransactionTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
    bridgeCall = vi.fn();
    context = {
      profile: 'core',
      bridge: { connected: true, call: bridgeCall },
      config: { bridgeTimeoutMs: 1000, artifactDir: '.easyeda-mcp-pro/artifacts' },
      vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
    };
  });

  it('registers five core transaction tools with expected safety metadata', () => {
    const names = [
      'easyeda_project_begin_transaction',
      'easyeda_project_get_transaction_status',
      'easyeda_project_validate_transaction',
      'easyeda_project_commit_transaction',
      'easyeda_project_rollback_transaction',
    ];
    for (const name of names) {
      const tool = registry.get(name);
      expect(tool).toBeDefined();
      expect(tool?.profile).toBe('core');
      expect(tool?.group).toBe('project');
    }
    expect(registry.get('easyeda_project_commit_transaction')?.confirmWrite).toBe(true);
    expect(registry.get('easyeda_project_rollback_transaction')?.confirmWrite).toBe(true);
    expect(registry.get('easyeda_project_get_transaction_status')?.annotations.readOnlyHint).toBe(
      true,
    );
  });

  it('begins a transaction and exposes status without snapshots', async () => {
    const begin = registry.get('easyeda_project_begin_transaction');
    const status = registry.get('easyeda_project_get_transaction_status');

    const started = (await begin?.handler(context, {
      projectId: 'proj-1',
      label: 'Normalize imported project',
      maxOperations: 10,
      ttlSeconds: 600,
    })) as any;
    const readback = (await status?.handler(context, {
      transactionId: started.transaction.id,
    })) as any;

    expect(started).toMatchObject({
      success: true,
      transaction: {
        document_id: 'proj-1',
        label: 'Normalize imported project',
        state: 'active',
        max_operations: 10,
        operation_count: 0,
      },
    });
    expect(readback).toMatchObject({
      success: true,
      transaction: { id: started.transaction.id, operations: [] },
    });
    expect(JSON.stringify(readback)).not.toContain('beforeSnapshot');
  });

  it('returns a structured conflict when a document already has an active transaction', async () => {
    const begin = registry.get('easyeda_project_begin_transaction');
    await begin?.handler(context, {
      projectId: 'proj-1',
      maxOperations: 10,
      ttlSeconds: 600,
    });

    const conflict = await begin?.handler(context, {
      projectId: 'proj-1',
      maxOperations: 10,
      ttlSeconds: 600,
    });

    expect(conflict).toMatchObject({ success: false, error_code: 'TRANSACTION_ACTIVE' });
  });

  it('validates bridge and operation-count gates', async () => {
    const begin = registry.get('easyeda_project_begin_transaction');
    const validate = registry.get('easyeda_project_validate_transaction');
    const started = (await begin?.handler(context, {
      projectId: 'proj-1',
      maxOperations: 10,
      ttlSeconds: 600,
    })) as any;

    const failure = await validate?.handler(
      { ...context, bridge: { ...context.bridge, connected: false } },
      {
        transactionId: started.transaction.id,
        expectedOperationCount: 1,
        requireAppliedOperations: true,
        requireBridgeConnected: true,
      },
    );

    expect(failure).toMatchObject({
      success: false,
      error_code: 'TRANSACTION_VALIDATION_FAILED',
      transaction: { state: 'active' },
    });
    expect((failure as any).transaction.validations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gate: 'bridge-connected', passed: false }),
        expect.objectContaining({ gate: 'operation-count', passed: false }),
        expect.objectContaining({ gate: 'applied-operation-required', passed: false }),
      ]),
    );

    const success = await validate?.handler(context, {
      transactionId: started.transaction.id,
      expectedOperationCount: 0,
      requireAppliedOperations: false,
      requireBridgeConnected: true,
    });
    expect(success).toMatchObject({ success: true, transaction: { state: 'validated' } });
  });

  it('commits and releases the document lock', async () => {
    const begin = registry.get('easyeda_project_begin_transaction');
    const validate = registry.get('easyeda_project_validate_transaction');
    const commit = registry.get('easyeda_project_commit_transaction');
    const started = (await begin?.handler(context, {
      projectId: 'proj-1',
      maxOperations: 10,
      ttlSeconds: 600,
    })) as any;

    await validate?.handler(context, {
      transactionId: started.transaction.id,
      expectedOperationCount: 0,
      requireAppliedOperations: false,
      requireBridgeConnected: true,
    });
    const committed = await commit?.handler(context, {
      transactionId: started.transaction.id,
      confirmWrite: true,
    });

    expect(committed).toMatchObject({ success: true, transaction: { state: 'committed' } });
    const next = await begin?.handler(context, {
      projectId: 'proj-1',
      maxOperations: 10,
      ttlSeconds: 600,
    });
    expect(next).toMatchObject({ success: true, transaction: { state: 'active' } });
  });

  it('rolls applied snapshots back in reverse order through the bridge', async () => {
    const manager = getGlobalTransactionManager();
    const transaction = manager.begin({ documentId: 'proj-1' });
    const states: Record<string, any> = {
      p1: {
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'p1',
        property: { x: 1 },
      },
      p2: {
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveId: 'p2',
        property: { x: 2 },
      },
    };
    for (const id of ['p1', 'p2']) {
      await manager.runModify(transaction.id, id, {
        getSnapshot: async () => structuredClone(states[id]),
        apply: async () => {
          states[id] = { ...states[id], property: { x: states[id].property.x + 10 } };
          return true;
        },
        restore: async (snapshot) => {
          states[id] = structuredClone(snapshot);
        },
      });
    }
    const restoreOrder: string[] = [];
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.restorePrimitiveSnapshot') {
        const snapshot = structuredClone(params.snapshot);
        restoreOrder.push(snapshot.primitiveId);
        states[snapshot.primitiveId] = snapshot;
        return { restored: true, snapshot };
      }
      if (method === 'schematic.getPrimitiveSnapshot') {
        return structuredClone(states[params.primitiveId]);
      }
      throw new Error(`unexpected ${method}`);
    });

    const rollback = registry.get('easyeda_project_rollback_transaction');
    const result = await rollback?.handler(context, {
      transactionId: transaction.id,
      confirmWrite: true,
    });

    expect(restoreOrder).toEqual(['p2', 'p1']);
    expect(result).toMatchObject({
      success: true,
      transaction: { state: 'rolled-back', rollback_complete: true },
      restored_operation_ids: expect.any(Array),
      failed_operation_ids: [],
    });
  });

  it('reports partial rollback instead of hiding a failed restore', async () => {
    const manager = getGlobalTransactionManager();
    const transaction = manager.begin({ documentId: 'proj-1' });
    let state = {
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'p1',
      property: { x: 1 },
    };
    await manager.runModify(transaction.id, 'p1', {
      getSnapshot: async () => structuredClone(state),
      apply: async () => {
        state = { ...state, property: { x: 11 } };
        return true;
      },
      restore: async (snapshot) => {
        state = structuredClone(snapshot as typeof state);
      },
    });
    bridgeCall.mockRejectedValue(new Error('restore unavailable'));

    const rollback = registry.get('easyeda_project_rollback_transaction');
    const result = await rollback?.handler(context, {
      transactionId: transaction.id,
      confirmWrite: true,
    });

    expect(result).toMatchObject({
      success: false,
      error_code: 'TRANSACTION_ROLLBACK_FAILED',
      transaction: { state: 'failed', rollback_complete: false },
      failed_operation_ids: expect.any(Array),
    });
  });

  it('recreates a deleted primitive with a new ID during explicit rollback', async () => {
    const manager = getGlobalTransactionManager();
    const transaction = manager.begin({ documentId: 'proj-1' });
    const before = {
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'wire-old',
      primitiveKind: 'wire',
      property: { line: [0, 0, 10, 0], net: 'N1' },
    };
    let exists = true;
    await manager.runDelete(transaction.id, 'wire-old', {
      getSnapshot: async () => structuredClone(before),
      apply: async () => {
        exists = false;
        return true;
      },
      exists: async () => exists,
      recreate: async () => {
        throw new Error('not needed while applying delete');
      },
    });

    const recreated = { ...before, primitiveId: 'wire-new' };
    bridgeCall.mockImplementation(async (method: string, params: any) => {
      if (method === 'schematic.recreatePrimitiveSnapshot') {
        expect(params.snapshot).toEqual(before);
        return { primitiveId: 'wire-new', snapshot: structuredClone(recreated) };
      }
      if (method === 'schematic.getPrimitiveSnapshot' && params.primitiveId === 'wire-new') {
        return structuredClone(recreated);
      }
      throw new Error(`unexpected ${method}`);
    });

    const result = await registry.get('easyeda_project_rollback_transaction')?.handler(context, {
      transactionId: transaction.id,
      confirmWrite: true,
    });

    expect(result).toMatchObject({
      success: true,
      transaction: {
        state: 'rolled-back',
        operations: [
          {
            kind: 'delete',
            state: 'rolled-back',
            restored_target_id: 'wire-new',
          },
        ],
      },
    });
  });
});
