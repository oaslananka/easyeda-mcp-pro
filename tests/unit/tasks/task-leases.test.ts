import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableTaskStore } from '../../../src/tasks/task-store.js';
import { DurableTaskLeaseStore } from '../../../src/tasks/task-leases.js';

const directories: string[] = [];
const stores: Array<{ close: () => void }> = [];
let time = Date.parse('2026-10-28T00:00:00Z');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'easyeda-mcp-leases-'));
  directories.push(dir);
  const dbPath = join(dir, 'tasks.db');
  const state = new DurableTaskStore(dbPath, () => time);
  const workerA = new DurableTaskLeaseStore(dbPath, () => time);
  const workerB = new DurableTaskLeaseStore(dbPath, () => time);
  stores.push(state, workerA, workerB);
  return { state, workerA, workerB };
}
const content = { content: [{ type: 'text', text: 'read-only BOM result' }] };

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
  time = Date.parse('2026-10-28T00:00:00Z');
});

describe('durable Tasks worker lease and fencing, staging only', () => {
  it('permits one atomic claimant from distinct SQLite connections and durable completion', () => {
    const { state, workerA, workerB } = fixture();
    const task = state.create('owner-A', 'easyeda_bom_generate', { projectId: 'fixture' });
    const lease = workerA.acquire('owner-A', task.id, 'worker-A');
    expect(lease?.token).toMatch(/^[0-9a-f-]{36}$/i);
    expect(workerB.acquire('owner-A', task.id, 'worker-B')).toBeUndefined();
    expect(workerB.complete('owner-A', { ...lease!, token: 'forged-token' }, content)).toBe(false);
    expect(state.get('owner-A', task.id)?.status).toBe('working');
    expect(workerA.complete('owner-A', lease!, content)).toBe(true);
    expect(workerA.complete('owner-A', lease!, content)).toBe(false);
    expect(workerB.acquire('owner-A', task.id, 'worker-B')).toBeUndefined();
    expect(state.get('owner-A', task.id)).toMatchObject({ status: 'completed', result: content });
  });

  it('rejects expired/fenced workers after takeover, including late completion and release', () => {
    const { state, workerA, workerB } = fixture();
    const task = state.create('owner-A', 'easyeda_bom_generate', {});
    const old = workerA.acquire('owner-A', task.id, 'worker-A', 2000)!;
    expect(workerA.renew('owner-A', old, 2000)).toBe(true);
    time += 2001;
    expect(workerA.renew('owner-A', old)).toBe(false);
    const next = workerB.acquire('owner-A', task.id, 'worker-B', 3000)!;
    expect(next.token).not.toBe(old.token);
    expect(workerA.complete('owner-A', old, content)).toBe(false);
    expect(workerA.release(old)).toBe(false);
    expect(workerA.renew('owner-A', old)).toBe(false);
    expect(workerB.renew('owner-A', next)).toBe(true);
    expect(workerB.complete('owner-A', next, content)).toBe(true);
    expect(state.get('owner-A', task.id)?.result).toEqual(content);
  });

  it('checks original principal and cancellation at every lease and commit step', () => {
    const { state, workerA, workerB } = fixture();
    const task = state.create('owner-A', 'easyeda_bom_generate', {});
    expect(workerA.acquire('owner-B', task.id, 'worker-A')).toBeUndefined();
    const lease = workerA.acquire('owner-A', task.id, 'worker-A')!;
    expect(workerB.renew('owner-B', lease)).toBe(false);
    expect(workerB.complete('owner-B', lease, content)).toBe(false);
    expect(state.requestCancel('owner-A', task.id)).toBe(true);
    expect(workerA.renew('owner-A', lease)).toBe(false);
    expect(workerA.complete('owner-A', lease, content)).toBe(false);
    expect(state.markCancelled('owner-A', task.id)).toBe(true);
    expect(workerB.acquire('owner-A', task.id, 'worker-B')).toBeUndefined();
    expect(state.get('owner-A', task.id)?.status).toBe('cancelled');
  });

  it('fails orphaned expired leases after worker death, and never replays work automatically', () => {
    const { state, workerA, workerB } = fixture();
    const task = state.create('owner-A', 'easyeda_pcb_components', {});
    const lease = workerA.acquire('owner-A', task.id, 'worker-A', 1200)!;
    time += 1201;
    expect(workerB.failExpired()).toBe(1);
    expect(workerB.failExpired()).toBe(0);
    expect(state.get('owner-A', task.id)).toMatchObject({
      status: 'failed',
      error: 'Task worker lease expired; the task was not resumed.',
    });
    expect(workerA.complete('owner-A', lease, content)).toBe(false);
    expect(workerB.acquire('owner-A', task.id, 'worker-B')).toBeUndefined();
  });

  it('preserves an accepted cancellation when an abandoned lease expires', () => {
    const { state, workerA, workerB } = fixture();
    const task = state.create('owner-A', 'easyeda_bom_generate', {});
    const lease = workerA.acquire('owner-A', task.id, 'worker-A', 1000)!;
    expect(state.requestCancel('owner-A', task.id)).toBe(true);
    time += 1001;
    expect(workerB.failExpired()).toBe(0);
    expect(state.get('owner-A', task.id)).toMatchObject({ status: 'cancelled' });
    expect(workerA.complete('owner-A', lease, content)).toBe(false);
  });

  it('does not prematurely mark a healthy renewed worker as expired', () => {
    const { state, workerA, workerB } = fixture();
    const task = state.create('owner-A', 'easyeda_bom_generate', {});
    const lease = workerA.acquire('owner-A', task.id, 'worker-A', 3000)!;
    time += 2000;
    expect(workerA.renew('owner-A', lease, 3000)).toBe(true);
    time += 1500;
    expect(workerB.failExpired()).toBe(0);
    expect(workerB.acquire('owner-A', task.id, 'worker-B')).toBeUndefined();
    expect(workerA.complete('owner-A', lease, content)).toBe(true);
  });

  it('rejects invalid lease identities, durations and results with no state corruption', () => {
    const { state, workerA } = fixture();
    const task = state.create('owner-A', 'easyeda_bom_generate', {});
    expect(() => workerA.acquire(' owner ', task.id, 'worker-A')).toThrow('Invalid owner');
    expect(() => workerA.acquire('owner-A', task.id, '')).toThrow('Invalid worker');
    expect(() => workerA.acquire('owner-A', task.id, 'worker-A', 100)).toThrow('duration');
    const lease = workerA.acquire('owner-A', task.id, 'worker-A')!;
    expect(() => workerA.complete('owner-A', lease, 'not a CallToolResult')).toThrow(
      'structured MCP tool result',
    );
    expect(() =>
      workerA.complete('owner-A', lease, { content: ['x'.repeat(1024 * 1024)] }),
    ).toThrow('too large');
    expect(state.get('owner-A', task.id)?.status).toBe('working');
    expect(workerA.release(lease)).toBe(true);
    expect(workerA.release(lease)).toBe(false);
  });
});
