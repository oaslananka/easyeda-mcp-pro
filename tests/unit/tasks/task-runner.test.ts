import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableTaskStore, type SafeTaskOperation } from '../../../src/tasks/task-store.js';
import {
  DurableReadOnlyTaskRunner,
  type ReadOnlyTaskExecutor,
} from '../../../src/tasks/task-runner.js';

const stores: DurableTaskStore[] = [];
const owner = (name = 'alice', allowed: SafeTaskOperation[] = ['easyeda_bom_generate']) => ({
  ownerId: name,
  authorizedOperations: new Set(allowed),
});
const okResult = { content: [{ type: 'text', text: 'verified' }] };
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function fixture(execute: ReadOnlyTaskExecutor) {
  const store = new DurableTaskStore(':memory:');
  stores.push(store);
  return { store, runner: new DurableReadOnlyTaskRunner(store, execute) };
}
afterEach(() => {
  vi.useRealTimers();
  while (stores.length) stores.pop()?.close();
});

describe('single-process Tasks executor staging substrate', () => {
  it('durably persists the task before execution and completes a read-only result', async () => {
    const seen: string[] = [];
    const test = fixture(async (_operation, _args) => {
      seen.push(test.store.list('alice')[0]?.status ?? 'missing');
      return okResult;
    });
    const record = test.runner.submit(owner(), 'easyeda_bom_generate', { projectId: 'fixture' });
    expect(record.status).toBe('working');
    expect(test.store.get('alice', record.id)?.id).toBe(record.id);
    await flush();
    expect(seen).toEqual(['working']);
    expect(test.store.get('alice', record.id)).toMatchObject({
      status: 'completed',
      result: okResult,
    });
  });

  it('rejects unauthorized principals and native mutation operations before any record is created', () => {
    const test = fixture(async () => okResult);
    expect(() => test.runner.submit(owner(''), 'easyeda_bom_generate', {})).toThrow('Unauthorized');
    expect(() => test.runner.submit(owner('bob'), 'easyeda_bom_generate', {})).not.toThrow();
    expect(() => test.runner.submit(owner('alice', []), 'easyeda_bom_generate', {})).toThrow(
      'Unauthorized',
    );
    expect(() =>
      test.runner.submit(owner('alice'), 'easyeda_pcb_add_track' as SafeTaskOperation, {}),
    ).toThrow('Unauthorized');
    expect(test.store.list('alice')).toEqual([]);
    expect(test.store.list('bob')).toHaveLength(1);
    test.runner.stop();
  });

  it('cancels queued work without ever dispatching it', async () => {
    let resolveFirst!: (value: typeof okResult) => void;
    const first = new Promise<typeof okResult>((resolve) => {
      resolveFirst = resolve;
    });
    let executed = 0;
    const test = fixture(async (_operation, args) => {
      executed++;
      if ((args as { hold?: boolean }).hold) return first;
      return okResult;
    });
    const blocked = [
      test.runner.submit(owner(), 'easyeda_bom_generate', { hold: true }),
      test.runner.submit(owner(), 'easyeda_bom_generate', { hold: true }),
      test.runner.submit(owner(), 'easyeda_bom_generate', { hold: true }),
    ];
    await flush();
    const queued = test.runner.submit(owner(), 'easyeda_bom_generate', { hold: false });
    expect(test.runner.cancel(owner('bob'), queued.id)).toBe(false);
    expect(test.runner.cancel(owner('alice', []), queued.id)).toBe(false);
    expect(test.runner.cancel(owner(), queued.id)).toBe(true);
    await flush();
    expect(executed).toBe(3);
    expect(test.store.get('alice', queued.id)?.status).toBe('cancelled');
    for (const task of blocked) expect(test.runner.cancel(owner(), task.id)).toBe(true);
    resolveFirst(okResult);
    await flush();
    for (const task of blocked) expect(test.store.get('alice', task.id)?.status).toBe('cancelled');
  });

  it('does not expose thrown exception details, while marking the job failed', async () => {
    const test = fixture(async () => {
      throw new Error('private CAD value secret token=very-sensitive');
    });
    const task = test.runner.submit(owner(), 'easyeda_bom_generate', {});
    await flush();
    const record = test.store.get('alice', task.id);
    expect(record?.status).toBe('failed');
    expect(record?.error).toBe('The read-only task could not be completed.');
    expect(JSON.stringify(record)).not.toContain('very-sensitive');
  });

  it('marks a timed-out operation failed instead of returning a phantom working status', async () => {
    vi.useFakeTimers();
    const test = fixture(async () => new Promise<typeof okResult>(() => undefined));
    const record = test.runner.submit(owner(), 'easyeda_bom_generate', {});
    await flush();
    await vi.advanceTimersByTimeAsync(30001);
    expect(test.store.get('alice', record.id)).toMatchObject({
      status: 'failed',
      error: 'The task exceeded its execution deadline.',
    });
  });

  it('prevents late results from overwriting an accepted cancellation', async () => {
    let finish!: (result: typeof okResult) => void;
    const pending = new Promise<typeof okResult>((resolve) => {
      finish = resolve;
    });
    const test = fixture(async () => pending);
    const record = test.runner.submit(owner(), 'easyeda_bom_generate', {});
    await flush();
    expect(test.runner.cancel(owner(), record.id)).toBe(true);
    finish(okResult);
    await flush();
    expect(test.store.get('alice', record.id)?.status).toBe('cancelled');
    expect(test.store.get('alice', record.id)?.result).toBeUndefined();
  });

  it('rejects submissions after stop without claiming abandoned work has completed', () => {
    const test = fixture(async () => okResult);
    test.runner.stop();
    expect(() => test.runner.submit(owner(), 'easyeda_bom_generate', {})).toThrow('stopped');
    expect(test.store.list('alice')).toEqual([]);
  });
});
