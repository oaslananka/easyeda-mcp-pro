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

  it('rejects overlapping creates in one transaction until the native call settles', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'same-tx-create' });
    const created = new Set<string>();
    let releaseNative!: () => void;
    const nativeBarrier = new Promise<void>((resolve) => {
      releaseNative = resolve;
    });
    const hooks = (id: string, wait = Promise.resolve()) => ({
      apply: async () => {
        await wait;
        created.add(id);
        return { result: id, targetId: id };
      },
      getSnapshot: async (targetId: string) => ({ primitiveId: targetId }),
      remove: async (targetId: string) => {
        created.delete(targetId);
      },
      exists: async (targetId: string) => created.has(targetId),
    });

    const pending = manager.runCreate(transaction.id, 'first', hooks('first', nativeBarrier));
    expect(manager.get(transaction.id).operations[0]?.state).toBe('pending');
    await expect(
      manager.runCreate(transaction.id, 'second', hooks('second')),
    ).rejects.toMatchObject({
      code: 'TRANSACTION_INVALID_STATE',
    });
    expect(created.has('second')).toBe(false);

    releaseNative();
    await pending;
    await expect(
      manager.runCreate(transaction.id, 'second', hooks('second')),
    ).resolves.toMatchObject({
      targetId: 'second',
    });
    expect(created).toEqual(new Set(['first', 'second']));
  });

  it('guards the initial snapshot read against parallel writes and premature rollback', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'same-tx-snapshot' });
    const original = { primitiveId: 'wire-1', property: { net: 'GND' } };
    let primitive: typeof original | undefined = structuredClone(original);
    let releaseSnapshot!: () => void;
    const snapshotBarrier = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const pending = manager.runDelete(transaction.id, 'wire-1', {
      getSnapshot: async () => {
        await snapshotBarrier;
        return structuredClone(primitive);
      },
      apply: async () => {
        primitive = undefined;
      },
      exists: async () => primitive !== undefined,
      recreate: async () => {
        throw new Error('Not needed for a successful delete');
      },
    });
    const secondApply = vi.fn(async () => ({ result: true, targetId: 'extra' }));
    await expect(
      manager.runCreate(transaction.id, 'extra', {
        apply: secondApply,
        getSnapshot: async (id) => ({ primitiveId: id }),
        remove: async () => undefined,
        exists: async () => false,
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_INVALID_STATE' });
    expect(secondApply).not.toHaveBeenCalled();
    const restore = vi.fn(async () => {
      primitive = structuredClone(original);
    });
    await expect(
      manager.rollback(transaction.id, {
        restore,
        getSnapshot: async () => structuredClone(primitive),
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_INVALID_STATE' });
    expect(restore).not.toHaveBeenCalled();

    releaseSnapshot();
    await pending;
    expect(primitive).toBeUndefined();
    const rollback = await manager.rollback(transaction.id, {
      restore,
      getSnapshot: async () => structuredClone(primitive),
    });
    expect(rollback.transaction).toMatchObject({ state: 'rolled-back', rollbackComplete: true });
    expect(primitive).toEqual(original);
  });

  it('retains the document lock when the TTL expires during the initial native snapshot read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T13:10:00.000Z'));
    let releaseRead: (() => void) | undefined;
    try {
      const manager = new TransactionManager();
      const transaction = manager.begin({ documentId: 'expiry-during-snapshot', ttlMs: 60_000 });
      const snapshotBarrier = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const nativeApply = vi.fn(async () => undefined);
      const pending = manager.runDelete(transaction.id, 'wire-1', {
        getSnapshot: async () => {
          await snapshotBarrier;
          return { primitiveId: 'wire-1', property: { net: 'GND' } };
        },
        apply: nativeApply,
        exists: async () => true,
        recreate: async () => {
          throw new Error('Must never mutate after TTL');
        },
      });

      expect(manager.get(transaction.id).operations).toHaveLength(0);
      vi.advanceTimersByTime(60_001);
      expect(manager.get(transaction.id)).toMatchObject({
        state: 'failed',
        rollbackComplete: false,
      });
      expect(() => manager.begin({ documentId: 'expiry-during-snapshot' })).toThrowError(
        expect.objectContaining({ code: 'TRANSACTION_ACTIVE' }),
      );
      await expect(
        manager.rollback(transaction.id, { restore: async () => undefined }),
      ).rejects.toMatchObject({ code: 'TRANSACTION_INVALID_STATE' });

      releaseRead();
      await expect(pending).rejects.toMatchObject({ code: 'TRANSACTION_NOT_ACTIVE' });
      expect(nativeApply).not.toHaveBeenCalled();
      const rollback = await manager.rollback(transaction.id, {
        restore: async () => undefined,
      });
      expect(rollback.transaction).toMatchObject({ state: 'rolled-back', rollbackComplete: true });
      expect(manager.begin({ documentId: 'expiry-during-snapshot' }).state).toBe('active');
    } finally {
      releaseRead?.();
      vi.useRealTimers();
    }
  });

  it('checks the TTL before applying a delete even without an intervening status request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T13:20:00.000Z'));
    let releaseRead: (() => void) | undefined;
    try {
      const manager = new TransactionManager();
      const transaction = manager.begin({ documentId: 'expiry-before-apply', ttlMs: 60_000 });
      const snapshotBarrier = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const nativeApply = vi.fn(async () => undefined);
      const pending = manager.runDelete(transaction.id, 'wire-2', {
        getSnapshot: async () => {
          await snapshotBarrier;
          return { primitiveId: 'wire-2', property: { net: 'VCC' } };
        },
        apply: nativeApply,
        exists: async () => true,
        recreate: async () => {
          throw new Error('Must never mutate after TTL');
        },
      });

      vi.advanceTimersByTime(60_001);
      releaseRead();
      await expect(pending).rejects.toMatchObject({ code: 'TRANSACTION_NOT_ACTIVE' });
      expect(nativeApply).not.toHaveBeenCalled();
      expect(manager.get(transaction.id)).toMatchObject({
        state: 'failed',
        rollbackComplete: false,
        operations: [],
      });
      expect(() => manager.begin({ documentId: 'expiry-before-apply' })).toThrowError(
        expect.objectContaining({ code: 'TRANSACTION_ACTIVE' }),
      );
      await manager.rollback(transaction.id, { restore: async () => undefined });
      expect(manager.begin({ documentId: 'expiry-before-apply' }).state).toBe('active');
    } finally {
      releaseRead?.();
      vi.useRealTimers();
    }
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

  it('records an explicitly requested PCB primitive target type', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'pcb-doc-1' });
    let state = { primitiveId: 'pcb1', layer: 1 };

    const result = await manager.runModify(
      transaction.id,
      'pcb1',
      {
        getSnapshot: async () => structuredClone(state),
        apply: async () => {
          state = { primitiveId: 'pcb1', layer: 2 };
          return true;
        },
        restore: async (snapshot) => {
          state = structuredClone(snapshot as typeof state);
        },
      },
      'pcb-primitive',
    );

    expect(result.operation.target).toEqual({ type: 'pcb-primitive', id: 'pcb1' });
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

  it('rejects rollback while a native create is still in flight, then restores once settled', async () => {
    const manager = new TransactionManager();
    const tx = manager.begin({ documentId: 'pending-create-doc' });
    const primitives = new Set<string>();
    let releaseApply!: () => void;
    const suspendedApply = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });

    const inFlight = manager.runCreate(tx.id, 'wire-create', {
      apply: async () => {
        await suspendedApply;
        primitives.add('wire-one');
        return { result: true, targetId: 'wire-one' };
      },
      getSnapshot: async (id) => ({ primitiveId: id, primitiveKind: 'wire' }),
      remove: async (id) => {
        primitives.delete(id);
      },
      exists: async (id) => primitives.has(id),
    });
    expect(manager.get(tx.id).operations[0]?.state).toBe('pending');

    const restore = vi.fn(async (operation: { target: { id: string } }) => {
      primitives.delete(operation.target.id);
    });
    await expect(manager.rollback(tx.id, { restore })).rejects.toMatchObject({
      code: 'TRANSACTION_INVALID_STATE',
    });
    expect(restore).not.toHaveBeenCalled();
    expect(manager.get(tx.id)).toMatchObject({
      state: 'active',
      operations: [expect.objectContaining({ state: 'pending' })],
    });
    expect(() => manager.begin({ documentId: 'pending-create-doc' })).toThrowError(
      expect.objectContaining({ code: 'TRANSACTION_ACTIVE' }),
    );

    releaseApply();
    await inFlight;
    const result = await manager.rollback(tx.id, {
      restore,
      verify: async () => !primitives.has('wire-one'),
    });
    expect(result.transaction).toMatchObject({ state: 'rolled-back', rollbackComplete: true });
    expect(primitives.size).toBe(0);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('keeps an expired document locked while a pending native create may still complete', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T11:40:00.000Z'));
    try {
      const manager = new TransactionManager();
      const tx = manager.begin({ documentId: 'pending-expiry-doc', ttlMs: 60_000 });
      const primitives = new Set<string>();
      let releaseApply!: () => void;
      const nativeResult = new Promise<void>((resolve) => {
        releaseApply = resolve;
      });
      const inFlight = manager.runCreate(tx.id, 'wire-create', {
        apply: async () => {
          await nativeResult;
          primitives.add('wire-two');
          return { result: true, targetId: 'wire-two' };
        },
        getSnapshot: async (id) => ({ primitiveId: id, primitiveKind: 'wire' }),
        remove: async (id) => {
          primitives.delete(id);
        },
        exists: async (id) => primitives.has(id),
      });

      vi.advanceTimersByTime(60_001);
      expect(manager.get(tx.id)).toMatchObject({
        state: 'failed',
        rollbackComplete: false,
        operations: [expect.objectContaining({ state: 'pending' })],
      });
      expect(() => manager.begin({ documentId: 'pending-expiry-doc' })).toThrowError(
        expect.objectContaining({ code: 'TRANSACTION_ACTIVE' }),
      );
      const restore = vi.fn(async () => {
        primitives.delete('wire-two');
      });
      await expect(manager.rollback(tx.id, { restore })).rejects.toMatchObject({
        code: 'TRANSACTION_INVALID_STATE',
      });
      expect(restore).not.toHaveBeenCalled();

      releaseApply();
      await inFlight;
      expect(manager.get(tx.id)).toMatchObject({
        state: 'failed',
        rollbackComplete: false,
        operations: [expect.objectContaining({ state: 'applied' })],
      });
      expect(() => manager.begin({ documentId: 'pending-expiry-doc' })).toThrowError(
        expect.objectContaining({ code: 'TRANSACTION_ACTIVE' }),
      );
      const recovered = await manager.rollback(tx.id, {
        restore,
        verify: async () => !primitives.has('wire-two'),
      });
      expect(recovered.transaction).toMatchObject({ state: 'rolled-back', rollbackComplete: true });
      expect(primitives.size).toBe(0);
      expect(manager.begin({ documentId: 'pending-expiry-doc' }).state).toBe('active');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not race rollback against an expired native delete still in flight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T11:50:00.000Z'));
    try {
      const manager = new TransactionManager();
      const tx = manager.begin({ documentId: 'pending-delete-doc', ttlMs: 60_000 });
      const original = {
        primitiveId: 'wire-old',
        primitiveKind: 'wire',
        property: { line: [10, 10, 20, 10], net: '' },
      };
      let primitive: typeof original | undefined = structuredClone(original);
      let releaseDelete!: () => void;
      const deleting = new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });
      const pendingDelete = manager.runDelete(tx.id, 'wire-old', {
        getSnapshot: async () => structuredClone(primitive),
        apply: async () => {
          await deleting;
          primitive = undefined;
          return { deleted: ['wire-old'] };
        },
        exists: async () => primitive !== undefined,
        recreate: async () => {
          throw new Error('No compensation expected');
        },
      });
      await Promise.resolve();
      expect(manager.get(tx.id).operations[0]?.state).toBe('pending');

      vi.advanceTimersByTime(60_001);
      expect(manager.get(tx.id)).toMatchObject({
        state: 'failed',
        rollbackComplete: false,
      });
      expect(() => manager.begin({ documentId: 'pending-delete-doc' })).toThrowError(
        expect.objectContaining({ code: 'TRANSACTION_ACTIVE' }),
      );
      const restore = vi.fn(async () => {
        primitive = { ...original, primitiveId: 'wire-new' };
        return { restoredTargetId: 'wire-new' };
      });
      await expect(
        manager.rollback(tx.id, {
          restore,
          getSnapshot: async () => structuredClone(primitive),
        }),
      ).rejects.toMatchObject({ code: 'TRANSACTION_INVALID_STATE' });
      expect(restore).not.toHaveBeenCalled();

      releaseDelete();
      await pendingDelete;
      expect(primitive).toBeUndefined();
      const restored = await manager.rollback(tx.id, {
        restore,
        getSnapshot: async () => structuredClone(primitive),
      });
      expect(restored.transaction).toMatchObject({
        state: 'rolled-back',
        rollbackComplete: true,
        operations: [expect.objectContaining({ restoredTargetId: 'wire-new' })],
      });
      expect(primitive?.primitiveId).toBe('wire-new');
      expect(manager.begin({ documentId: 'pending-delete-doc' }).state).toBe('active');
    } finally {
      vi.useRealTimers();
    }
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

  it('refuses to delete when initial schematic snapshot ID belongs to another primitive', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'same-page' });
    const apply = vi.fn(async () => ({ deleted: ['wire-requested'] }));

    await expect(
      manager.runDelete(transaction.id, 'wire-requested', {
        getSnapshot: async () => ({
          schemaVersion: 'schematic-primitive-snapshot/v1',
          primitiveId: 'wire-other',
          primitiveKind: 'wire',
          property: { line: [0, 0, 10, 0], net: 'GND' },
        }),
        apply,
        exists: async () => true,
        recreate: async () => {
          throw new Error('must not restore without mutation');
        },
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_INVALID_STATE' });
    expect(apply).not.toHaveBeenCalled();
    expect(manager.get(transaction.id).operations).toEqual([]);
  });

  it('does not mark an uncertain deletion untouched when existence read refers to another ID', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'same-page' });
    const original = {
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'wire-requested',
      primitiveKind: 'wire',
      property: { line: [0, 0, 10, 0], net: 'GND' },
    };
    let reads = 0;
    await expect(
      manager.runDelete(transaction.id, 'wire-requested', {
        getSnapshot: async () => {
          reads += 1;
          return reads === 1 ? original : { ...original, primitiveId: 'wire-other' };
        },
        apply: async () => {
          throw new Error('delete result ambiguous');
        },
        exists: async () => true,
        recreate: async () => {
          throw new Error('recreate must not happen when existence is unknown');
        },
      }),
    ).rejects.toMatchObject({
      code: 'TRANSACTION_OPERATION_FAILED',
      details: expect.objectContaining({ compensation: 'failed' }),
    });
    expect(reads).toBe(2);
    expect(manager.get(transaction.id)).toMatchObject({
      state: 'failed',
      rollbackComplete: false,
      operations: [expect.objectContaining({ state: 'failed', compensation: 'failed' })],
    });
    expect(() => manager.begin({ documentId: 'same-page' })).toThrowError(
      expect.objectContaining({ code: 'TRANSACTION_ACTIVE' }),
    );
  });

  it('does not mark compensation restored when recreated snapshot names a different primitive', async () => {
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'same-page' });
    const original = {
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'wire-requested',
      primitiveKind: 'wire',
      property: { line: [0, 0, 10, 0], net: 'GND' },
    };
    await expect(
      manager.runDelete(transaction.id, 'wire-requested', {
        getSnapshot: async () => original,
        apply: async () => {
          throw new Error('delete may have happened');
        },
        exists: async () => false,
        recreate: async () => ({
          targetId: 'wire-restored',
          snapshot: { ...original, primitiveId: 'wire-unrelated' },
        }),
      }),
    ).rejects.toMatchObject({
      code: 'TRANSACTION_OPERATION_FAILED',
      details: expect.objectContaining({ compensation: 'failed' }),
    });
    expect(manager.get(transaction.id)).toMatchObject({
      state: 'failed',
      rollbackComplete: false,
      operations: [expect.objectContaining({ state: 'failed', compensation: 'failed' })],
    });
  });

  it('refuses Source API Ground recreation that adds even empty native attributes', async () => {
    // Real disposable EasyEDA V4.1.105 Source API evidence: addNetFlag('Ground')
    // regenerated the same pin/net/symbol but persisted six extra blank
    // attributes after native Save and a fresh-renderer cold reopen.
    const originalAttributes = {
      Symbol: '17c558f9e954b079',
      Description: '',
      'Global Net Name': 'GND',
      Name: 'GND',
      Device: 'af20086a8911a85a',
      Relevance: '[]',
    };
    const createdDefaults = {
      'Unique ID': '',
      Footprint: '',
      Designator: '',
      'Reuse Block': '',
      'Group ID': '',
      'Channel ID': '',
    };
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'source-netflag-fixture' });
    const before = {
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'ground-original',
      primitiveKind: 'netflag',
      componentType: 'netflag',
      property: {
        net: 'GND',
        x: 240,
        y: 250,
        rotation: 0,
        mirror: false,
        nativeAttributes: originalAttributes,
      },
    };
    const recreate = vi.fn(async () => ({
      targetId: 'ground-recreated',
      snapshot: {
        ...before,
        primitiveId: 'ground-recreated',
        property: {
          ...before.property,
          nativeAttributes: { ...originalAttributes, ...createdDefaults },
        },
      },
    }));

    await expect(
      manager.runDelete(transaction.id, before.primitiveId, {
        getSnapshot: async () => structuredClone(before),
        apply: async () => {
          throw new Error('Source delete completed but acknowledgement was uncertain');
        },
        exists: async () => false,
        recreate,
      }),
    ).rejects.toMatchObject({
      code: 'TRANSACTION_OPERATION_FAILED',
      details: expect.objectContaining({ compensation: 'failed' }),
    });
    expect(recreate).toHaveBeenCalledTimes(1);
    expect(manager.get(transaction.id)).toMatchObject({
      state: 'failed',
      rollbackComplete: false,
      operations: [
        expect.objectContaining({
          kind: 'delete',
          state: 'failed',
          compensation: 'failed',
        }),
      ],
    });
    expect(() => manager.begin({ documentId: 'source-netflag-fixture' })).toThrowError(
      expect.objectContaining({ code: 'TRANSACTION_ACTIVE' }),
    );
  });

  it('accepts an exact pre-existing Source 12-property Ground after native ID rotation', async () => {
    // Genuine disposable V4.1.105 native Source test: a Ground which already
    // has all 12 Source fields retains all 53 native attributes after one
    // remove/add, SCH_Document.save and a fresh headless cold reopen.
    // This models strict compensation fingerprinting, NOT production
    // permission to delete a marker or an editor-wide writer lease.
    const initial = {
      schemaVersion: 'schematic-primitive-snapshot/v1',
      primitiveId: 'source-ground-original',
      primitiveKind: 'netflag',
      componentType: 'netflag',
      property: {
        identification: 'Ground',
        net: 'GND',
        x: 240,
        y: 250,
        rotation: 0,
        mirror: false,
        sourceProperties: {
          Symbol: '17c558f9e954b079',
          Description: '',
          'Global Net Name': 'GND',
          Name: 'GND',
          Device: 'af20086a8911a85a',
          'Unique ID': '',
          Footprint: '',
          Designator: '',
          'Reuse Block': '',
          'Group ID': '',
          'Channel ID': '',
          Relevance: '[]',
        },
        nativeAttributes: {
          count: 53,
          semanticSha256: 'b18848017ed743f5c7c7c8e3dec8a34163688199bd02d8f11d04caf1f2a262bf',
        },
        groundPin: { name: 'Pin1', x: 240, y: 250 },
      },
    };
    const manager = new TransactionManager();
    const transaction = manager.begin({ documentId: 'source-12-property-fixture' });
    const recreate = vi.fn(async () => ({
      targetId: 'source-ground-restored',
      snapshot: { ...structuredClone(initial), primitiveId: 'source-ground-restored' },
    }));

    await expect(
      manager.runDelete(transaction.id, initial.primitiveId, {
        getSnapshot: async () => structuredClone(initial),
        apply: async () => {
          throw new Error('Source delete response dropped after native write');
        },
        exists: async () => false,
        recreate,
      }),
    ).rejects.toMatchObject({
      code: 'TRANSACTION_OPERATION_FAILED',
      details: {
        compensation: 'restored',
        restoredTargetId: 'source-ground-restored',
      },
    });
    expect(recreate).toHaveBeenCalledTimes(1);
    expect(manager.get(transaction.id)).toMatchObject({
      state: 'active',
      operations: [
        expect.objectContaining({
          kind: 'delete',
          state: 'cancelled',
          compensation: 'restored',
          restoredTargetId: 'source-ground-restored',
        }),
      ],
    });
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
