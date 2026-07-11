import { describe, expect, it, vi } from 'vitest';
import {
  TransactionManager,
  stableHash,
  stableStringify,
} from '../../../src/transactions/index.js';

describe('TransactionManager', () => {
  it('allows only one active transaction per document', () => {
    const manager = new TransactionManager();
    const first = manager.begin({ documentId: 'doc-1' });

    expect(first.state).toBe('active');
    expect(() => manager.begin({ documentId: 'doc-1' })).toThrowError(
      expect.objectContaining({ code: 'TRANSACTION_ACTIVE' }),
    );
    expect(manager.begin({ documentId: 'doc-2' }).state).toBe('active');
  });

  it('records a successful modification with before and after hashes', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'doc-1' });
    let state = { primitiveId: 'p1', property: { value: '1k' } };

    const result = await manager.runModify(transaction.id, 'p1', {
      getSnapshot: async () => structuredClone(state),
      apply: async () => {
        state = { primitiveId: 'p1', property: { value: '10k' } };
        return { ok: true };
      },
      restore: async (snapshot) => {
        state = structuredClone(snapshot as typeof state);
        return true;
      },
    });

    expect(result.result).toEqual({ ok: true });
    expect(result.operation).toMatchObject({
      state: 'applied',
      target: { type: 'schematic-primitive', id: 'p1' },
      beforeHash: stableHash({ primitiveId: 'p1', property: { value: '1k' } }),
      afterHash: stableHash({ primitiveId: 'p1', property: { value: '10k' } }),
    });
    expect(manager.get(transaction.id).operations).toHaveLength(1);
  });

  it('cancels a failed operation without restoring when state did not change', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'doc-1' });
    const state = { primitiveId: 'p1', property: { value: '1k' } };
    let restoreCalls = 0;

    await expect(
      manager.runModify(transaction.id, 'p1', {
        getSnapshot: async () => structuredClone(state),
        apply: async () => {
          throw new Error('write rejected');
        },
        restore: async () => {
          restoreCalls += 1;
        },
      }),
    ).rejects.toMatchObject({
      code: 'TRANSACTION_OPERATION_FAILED',
      details: { compensation: 'not-needed' },
    });

    expect(restoreCalls).toBe(0);
    expect(manager.get(transaction.id)).toMatchObject({
      state: 'active',
      operations: [expect.objectContaining({ state: 'cancelled', compensation: 'not-needed' })],
    });
  });

  it('restores the before snapshot when apply succeeds but after-read fails', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'doc-1' });
    let state = { primitiveId: 'p1', property: { value: '1k' } };
    let snapshotReads = 0;

    await expect(
      manager.runModify(transaction.id, 'p1', {
        getSnapshot: async () => {
          snapshotReads += 1;
          if (snapshotReads === 2) throw new Error('post-write read failed');
          return structuredClone(state);
        },
        apply: async () => {
          state = { primitiveId: 'p1', property: { value: '10k' } };
          return true;
        },
        restore: async (snapshot) => {
          state = structuredClone(snapshot as typeof state);
          return true;
        },
      }),
    ).rejects.toMatchObject({
      code: 'TRANSACTION_OPERATION_FAILED',
      details: { compensation: 'restored' },
    });

    expect(state.property.value).toBe('1k');
    expect(manager.get(transaction.id)).toMatchObject({
      state: 'active',
      operations: [expect.objectContaining({ state: 'cancelled', compensation: 'restored' })],
    });
  });

  it('marks the transaction failed when automatic compensation cannot restore state', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'doc-1' });
    let state = { primitiveId: 'p1', property: { value: '1k' } };

    await expect(
      manager.runModify(transaction.id, 'p1', {
        getSnapshot: async () => structuredClone(state),
        apply: async () => {
          state = { primitiveId: 'p1', property: { value: '10k' } };
          throw new Error('connection lost after write');
        },
        restore: async () => {
          throw new Error('restore unavailable');
        },
      }),
    ).rejects.toMatchObject({
      code: 'TRANSACTION_OPERATION_FAILED',
      details: { compensation: 'failed' },
    });

    expect(manager.get(transaction.id)).toMatchObject({
      state: 'failed',
      rollbackComplete: false,
      operations: [expect.objectContaining({ state: 'failed' })],
    });
    expect(() => manager.begin({ documentId: 'doc-1' })).toThrowError(
      expect.objectContaining({ code: 'TRANSACTION_ACTIVE' }),
    );
  });

  it('runs validation gates and returns to active when a gate fails', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'doc-1' });

    await expect(
      manager.validate(transaction.id, [
        {
          name: 'operation-count',
          run: async () => ({ gate: '', passed: false, message: 'Expected one operation' }),
        },
      ]),
    ).rejects.toMatchObject({ code: 'TRANSACTION_VALIDATION_FAILED' });

    expect(manager.get(transaction.id)).toMatchObject({
      state: 'active',
      validations: [{ gate: 'operation-count', passed: false }],
    });

    const validated = await manager.validate(transaction.id, [
      {
        name: 'no-pending',
        run: () => ({ gate: '', passed: true, message: 'No pending operations' }),
      },
    ]);
    expect(validated.state).toBe('validated');
  });

  it('rolls applied operations back in reverse order and verifies snapshots', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'doc-1' });
    const states: Record<string, { primitiveId: string; property: { value: string } }> = {
      p1: { primitiveId: 'p1', property: { value: '1k' } },
      p2: { primitiveId: 'p2', property: { value: '2k' } },
    };

    for (const [id, value] of [
      ['p1', '10k'],
      ['p2', '20k'],
    ] as const) {
      await manager.runModify(transaction.id, id, {
        getSnapshot: async () => structuredClone(states[id]),
        apply: async () => {
          states[id] = { primitiveId: id, property: { value } };
          return true;
        },
        restore: async (snapshot) => {
          states[id] = structuredClone(snapshot as (typeof states)[string]);
        },
      });
    }

    const order: string[] = [];
    const result = await manager.rollback(transaction.id, {
      restore: async (operation) => {
        order.push(operation.target.id);
        states[operation.target.id] = structuredClone(
          operation.beforeSnapshot as (typeof states)[string],
        );
      },
      getSnapshot: async (operation) => structuredClone(states[operation.target.id]),
    });

    expect(order).toEqual(['p2', 'p1']);
    expect(states.p1.property.value).toBe('1k');
    expect(states.p2.property.value).toBe('2k');
    expect(result.failedOperationIds).toEqual([]);
    expect(result.transaction).toMatchObject({ state: 'rolled-back', rollbackComplete: true });
  });

  it('continues rollback attempts and reports every failed operation', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'doc-1' });
    for (const id of ['p1', 'p2']) {
      let state = { primitiveId: id, property: { value: 'before' } };
      await manager.runModify(transaction.id, id, {
        getSnapshot: async () => structuredClone(state),
        apply: async () => {
          state = { primitiveId: id, property: { value: 'after' } };
          return true;
        },
        restore: async (snapshot) => {
          state = structuredClone(snapshot as typeof state);
        },
      });
    }

    await expect(
      manager.rollback(transaction.id, {
        restore: async (operation) => {
          if (operation.target.id === 'p2') throw new Error('p2 restore failed');
        },
      }),
    ).rejects.toMatchObject({
      code: 'TRANSACTION_ROLLBACK_FAILED',
      details: {
        restoredOperationIds: expect.any(Array),
        failedOperationIds: expect.any(Array),
      },
    });
    expect(manager.get(transaction.id)).toMatchObject({ state: 'failed', rollbackComplete: false });
    expect(() => manager.begin({ documentId: 'doc-1' })).toThrowError(
      expect.objectContaining({ code: 'TRANSACTION_ACTIVE' }),
    );

    const recovered = await manager.rollback(transaction.id, {
      restore: async () => undefined,
    });
    expect(recovered.transaction).toMatchObject({ state: 'rolled-back', rollbackComplete: true });
    expect(manager.begin({ documentId: 'doc-1' }).state).toBe('active');
  });

  it('allows a later manual rollback to recover an operation whose automatic compensation failed', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'doc-1' });
    const before = { primitiveId: 'p1', property: { value: '1k' } };
    let state = structuredClone(before);

    await expect(
      manager.runModify(transaction.id, 'p1', {
        getSnapshot: async () => structuredClone(state),
        apply: async () => {
          state = { primitiveId: 'p1', property: { value: '10k' } };
          throw new Error('connection lost after write');
        },
        restore: async () => {
          throw new Error('temporary restore failure');
        },
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_OPERATION_FAILED' });

    const rolledBack = await manager.rollback(transaction.id, {
      restore: async (operation) => {
        state = structuredClone(operation.beforeSnapshot as typeof state);
      },
      getSnapshot: async () => structuredClone(state),
    });

    expect(state).toEqual(before);
    expect(rolledBack.transaction).toMatchObject({ state: 'rolled-back', rollbackComplete: true });
    expect(rolledBack.restoredOperationIds).toHaveLength(1);
    expect(manager.begin({ documentId: 'doc-1' }).state).toBe('active');
  });

  it('rejects commit before validation succeeds', () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'doc-1' });

    expect(() => manager.commit(transaction.id)).toThrowError(
      expect.objectContaining({ code: 'TRANSACTION_INVALID_STATE' }),
    );
    expect(manager.get(transaction.id).state).toBe('active');
  });

  it('commits a validated transaction and prevents rollback afterward', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'doc-1' });
    await manager.validate(transaction.id, []);
    const committed = manager.commit(transaction.id);

    expect(committed.state).toBe('committed');
    await expect(
      manager.rollback(transaction.id, { restore: async () => undefined }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_INVALID_STATE' });
    expect(manager.begin({ documentId: 'doc-1' }).state).toBe('active');
  });

  it('retains the document lock when a transaction expires with unresolved writes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T12:00:00.000Z'));
    try {
      const manager = new TransactionManager();
      const transaction = manager.begin({ documentId: 'doc-1', ttlMs: 60_000 });
      let state = { primitiveId: 'p1', property: { value: '1k' } };
      await manager.runModify(transaction.id, 'p1', {
        getSnapshot: async () => structuredClone(state),
        apply: async () => {
          state = { primitiveId: 'p1', property: { value: '10k' } };
          return true;
        },
        restore: async (snapshot) => {
          state = structuredClone(snapshot as typeof state);
        },
      });

      vi.advanceTimersByTime(60_001);
      expect(manager.get(transaction.id)).toMatchObject({
        state: 'failed',
        rollbackComplete: false,
        error: 'Transaction expired with unresolved writes; rollback is required',
      });
      expect(() => manager.begin({ documentId: 'doc-1' })).toThrowError(
        expect.objectContaining({ code: 'TRANSACTION_ACTIVE' }),
      );

      await manager.rollback(transaction.id, {
        restore: async (operation) => {
          state = structuredClone(operation.beforeSnapshot as typeof state);
        },
        getSnapshot: async () => structuredClone(state),
      });
      expect(manager.begin({ documentId: 'doc-1' }).state).toBe('active');
    } finally {
      vi.useRealTimers();
    }
  });

  it('records a successful create with an addressable target snapshot', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'doc-1' });
    const snapshots: Record<string, unknown> = {};

    const created = await manager.runCreate(transaction.id, 'batch-create-1', {
      apply: async () => {
        snapshots.w1 = {
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'w1',
          primitiveKind: 'wire',
          property: { line: [0, 0, 10, 0], net: 'N1' },
        };
        return { result: { primitiveId: 'w1' }, targetId: 'w1' };
      },
      getSnapshot: async (targetId) => structuredClone(snapshots[targetId]),
      remove: async (targetId) => {
        delete snapshots[targetId];
      },
      exists: async (targetId) => targetId in snapshots,
    });

    expect(created.targetId).toBe('w1');
    expect(created.operation).toMatchObject({
      kind: 'create',
      state: 'applied',
      target: { id: 'w1' },
      snapshotHashMode: 'absence',
      beforeSnapshot: { exists: false },
    });
    expect(created.operation.afterHash).toBe(stableHash(snapshots.w1));
  });

  it('removes a created primitive when its post-write snapshot fails', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'doc-1' });
    const existing = new Set<string>();

    await expect(
      manager.runCreate(transaction.id, 'batch-create-1', {
        apply: async () => {
          existing.add('text1');
          return { result: true, targetId: 'text1' };
        },
        getSnapshot: async () => {
          throw new Error('post-create read failed');
        },
        remove: async (targetId) => {
          existing.delete(targetId);
        },
        exists: async (targetId) => existing.has(targetId),
      }),
    ).rejects.toMatchObject({
      code: 'TRANSACTION_OPERATION_FAILED',
      details: { compensation: 'restored', targetId: 'text1' },
    });

    expect(existing.has('text1')).toBe(false);
    expect(manager.get(transaction.id)).toMatchObject({
      state: 'active',
      operations: [
        expect.objectContaining({ kind: 'create', state: 'cancelled', compensation: 'restored' }),
      ],
    });
  });

  it('locks the document when a failed create cannot be reconciled to a primitive ID', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'doc-1' });

    await expect(
      manager.runCreate(transaction.id, 'batch-create-1', {
        apply: async () => {
          throw new Error('connection lost after create request');
        },
        getSnapshot: async () => undefined,
        remove: async () => undefined,
        exists: async () => false,
        reconcile: async () => ({ status: 'ambiguous' as const }),
      }),
    ).rejects.toMatchObject({
      code: 'TRANSACTION_OPERATION_FAILED',
      details: { compensation: 'failed' },
    });

    expect(manager.get(transaction.id)).toMatchObject({
      state: 'failed',
      rollbackComplete: false,
      operations: [expect.objectContaining({ kind: 'create', state: 'failed' })],
    });
    expect(() => manager.begin({ documentId: 'doc-1' })).toThrowError(
      expect.objectContaining({ code: 'TRANSACTION_ACTIVE' }),
    );
  });

  it('records a successful delete with identity-independent snapshot hashing', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'doc-1' });
    let snapshot: Record<string, unknown> | undefined = {
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'wire-old',
      primitiveKind: 'wire',
      property: { line: [0, 0, 10, 0], net: 'N1' },
    };

    const deleted = await manager.runDelete(transaction.id, 'wire-old', {
      getSnapshot: async () => structuredClone(snapshot),
      apply: async () => {
        snapshot = undefined;
        return { deleted: true };
      },
      exists: async () => snapshot !== undefined,
      recreate: async () => {
        throw new Error('not needed');
      },
    });

    expect(deleted.operation).toMatchObject({
      kind: 'delete',
      state: 'applied',
      target: { id: 'wire-old' },
      snapshotHashMode: 'ignore-primitive-id',
      afterSnapshot: { exists: false },
    });
    expect(deleted.operation.beforeHash).toBe(
      stableHash({
        schemaVersion: 'schematic-primitive-snapshot/v1',
        primitiveKind: 'wire',
        property: { line: [0, 0, 10, 0], net: 'N1' },
      }),
    );
  });

  it('recreates a deleted primitive when delete verification fails after the write', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'doc-1' });
    const before = {
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'text-old',
      primitiveKind: 'text',
      property: { x: 10, y: 20, content: 'LABEL' },
    };
    let current: typeof before | undefined = structuredClone(before);

    await expect(
      manager.runDelete(transaction.id, 'text-old', {
        getSnapshot: async () => {
          if (!current) throw new Error('not found');
          return structuredClone(current);
        },
        apply: async () => {
          current = undefined;
          throw new Error('connection lost after delete');
        },
        exists: async () => current !== undefined,
        recreate: async (snapshot) => {
          current = {
            ...(structuredClone(snapshot) as typeof before),
            primitiveId: 'text-new',
          };
          return { targetId: 'text-new', snapshot: structuredClone(current) };
        },
      }),
    ).rejects.toMatchObject({
      code: 'TRANSACTION_OPERATION_FAILED',
      details: { compensation: 'restored', restoredTargetId: 'text-new' },
    });

    expect(current?.primitiveId).toBe('text-new');
    expect(manager.get(transaction.id)).toMatchObject({
      state: 'active',
      operations: [
        expect.objectContaining({
          kind: 'delete',
          state: 'cancelled',
          restoredTargetId: 'text-new',
          compensation: 'restored',
        }),
      ],
    });
  });

  it('rolls back mixed create, modify, and delete operations in reverse order', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'doc-1' });
    const snapshots: Record<string, any> = {
      m1: { primitiveId: 'm1', primitiveKind: 'text', property: { content: 'before' } },
      d1: { primitiveId: 'd1', primitiveKind: 'wire', property: { line: [0, 0, 5, 0] } },
    };

    await manager.runCreate(transaction.id, 'create-1', {
      apply: async () => {
        snapshots.c1 = { primitiveId: 'c1', primitiveKind: 'circle', property: { radius: 5 } };
        return { result: true, targetId: 'c1' };
      },
      getSnapshot: async (id) => structuredClone(snapshots[id]),
      remove: async (id) => delete snapshots[id],
      exists: async (id) => id in snapshots,
    });
    await manager.runModify(transaction.id, 'm1', {
      getSnapshot: async () => structuredClone(snapshots.m1),
      apply: async () => {
        snapshots.m1.property.content = 'after';
        return true;
      },
      restore: async (snapshot) => {
        snapshots.m1 = structuredClone(snapshot);
      },
    });
    await manager.runDelete(transaction.id, 'd1', {
      getSnapshot: async () => structuredClone(snapshots.d1),
      apply: async () => delete snapshots.d1,
      exists: async () => 'd1' in snapshots,
      recreate: async () => {
        throw new Error('not needed during apply');
      },
    });

    const order: string[] = [];
    const rolledBack = await manager.rollback(transaction.id, {
      restore: async (operation) => {
        order.push(operation.kind);
        if (operation.kind === 'create') {
          delete snapshots[operation.target.id];
          return;
        }
        if (operation.kind === 'modify') {
          snapshots[operation.target.id] = structuredClone(operation.beforeSnapshot);
          return;
        }
        const restoredId = 'd1-restored';
        snapshots[restoredId] = {
          ...(structuredClone(operation.beforeSnapshot) as Record<string, unknown>),
          primitiveId: restoredId,
        };
        return { restoredTargetId: restoredId };
      },
      verify: async (operation, restoreResult) => {
        if (operation.kind === 'create') return !(operation.target.id in snapshots);
        const id = restoreResult.restoredTargetId ?? operation.target.id;
        const snapshot = snapshots[id];
        if (!snapshot || !operation.beforeHash) return false;
        const comparable =
          operation.snapshotHashMode === 'ignore-primitive-id'
            ? (({ primitiveId: _primitiveId, ...rest }) => rest)(snapshot)
            : snapshot;
        return stableHash(comparable) === operation.beforeHash;
      },
    });

    expect(order).toEqual(['delete', 'modify', 'create']);
    expect(snapshots.c1).toBeUndefined();
    expect(snapshots.m1.property.content).toBe('before');
    expect(snapshots['d1-restored']).toBeDefined();
    expect(rolledBack.transaction).toMatchObject({ state: 'rolled-back', rollbackComplete: true });
  });

  it('enforces the configured operation limit', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'doc-1', maxOperations: 1 });
    let state = { primitiveId: 'p1', property: { value: '1k' } };
    const hooks = {
      getSnapshot: async () => structuredClone(state),
      apply: async () => {
        state = { primitiveId: 'p1', property: { value: '10k' } };
        return true;
      },
      restore: async (snapshot: unknown) => {
        state = structuredClone(snapshot as typeof state);
      },
    };

    await manager.runModify(transaction.id, 'p1', hooks);
    await expect(manager.runModify(transaction.id, 'p1', hooks)).rejects.toMatchObject({
      code: 'TRANSACTION_OPERATION_LIMIT',
    });
  });
});

describe('stable snapshot encoding', () => {
  it('hashes object keys deterministically', () => {
    expect(stableHash({ b: 2, a: 1 })).toBe(stableHash({ a: 1, b: 2 }));
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it('rejects circular and prototype-pollution-shaped snapshots', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => stableStringify(circular)).toThrow('Circular snapshot');

    const unsafe = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(() => stableStringify(unsafe)).toThrow('Forbidden snapshot key');
  });
});
