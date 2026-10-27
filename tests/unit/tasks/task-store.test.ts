import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableTaskStore } from '../../../src/tasks/task-store.js';

const directories: string[] = [];
const stores: DurableTaskStore[] = [];
let currentTime = Date.parse('2026-10-28T00:00:00Z');

function open(dbPath?: string) {
  const dir = dbPath ?? mkdtempSync(join(tmpdir(), 'easyeda-mcp-tasks-'));
  if (!dbPath) directories.push(dir);
  const store = new DurableTaskStore(join(dir, 'tasks.sqlite'), () => currentTime);
  stores.push(store);
  return { store, dir };
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
  currentTime = Date.parse('2026-10-28T00:00:00Z');
});

describe('durable task state substrate (not yet wired to MCP)', () => {
  it('retains a completed read-only job across database connections', () => {
    const { store, dir } = open();
    const task = store.create('principal-A', 'easyeda_bom_generate', { projectId: 'fixture' });
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(task.status).toBe('working');
    expect(store.finish('principal-A', task.id, { entries: [] })).toBe(true);
    const second = open(dir).store;
    expect(second.get('principal-A', task.id)).toMatchObject({
      status: 'completed',
      result: { entries: [] },
      ttlMs: 3600000,
    });
  });

  it('never leaks tasks or permits mutation across principals', () => {
    const { store } = open();
    const task = store.create('principal-A', 'easyeda_pcb_components', { projectId: 'P1' });
    expect(store.get('principal-B', task.id)).toBeUndefined();
    expect(store.list('principal-B')).toEqual([]);
    expect(store.finish('principal-B', task.id, { value: 123 })).toBe(false);
    expect(store.requestCancel('principal-B', task.id)).toBe(false);
    expect(store.markCancelled('principal-B', task.id)).toBe(false);
    expect(store.get('principal-A', task.id)?.status).toBe('working');
  });

  it('records cancellation durably without overwriting terminal results', () => {
    const { store, dir } = open();
    const task = store.create('owner', 'easyeda_bom_generate', {});
    expect(store.requestCancel('owner', task.id)).toBe(true);
    expect(store.finish('owner', task.id, {})).toBe(false);
    expect(open(dir).store.get('owner', task.id)?.cancelRequested).toBe(true);
    expect(store.markCancelled('owner', task.id)).toBe(true);
    expect(store.markCancelled('owner', task.id)).toBe(false);
    expect(store.finish('owner', task.id, {})).toBe(false);
    expect(store.get('owner', task.id)?.status).toBe('cancelled');
  });

  it('fails interrupted tasks after restart rather than claiming phantom work', () => {
    const { store, dir } = open();
    const pending = store.create('owner', 'easyeda_bom_generate', {});
    const done = store.create('owner', 'easyeda_pcb_components', {});
    expect(store.finish('owner', done.id, { done: true })).toBe(true);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = open(dir).store;
    expect(reopened.failInterruptedOnRestart()).toBe(1);
    expect(reopened.failInterruptedOnRestart()).toBe(0);
    expect(reopened.get('owner', pending.id)?.status).toBe('failed');
    expect(reopened.get('owner', pending.id)?.error).toContain('not resumed');
    expect(reopened.get('owner', done.id)?.status).toBe('completed');
  });

  it('expires task records and deletes their retained CAD data', () => {
    const { store } = open();
    const task = store.create('owner', 'easyeda_bom_generate', { projectId: 'fixture' }, 60000);
    currentTime += 60001;
    expect(store.get('owner', task.id)).toBeUndefined();
    expect(store.list('owner')).toEqual([]);
    expect(store.finish('owner', task.id, {})).toBe(false);
    expect(store.cleanupExpired()).toBe(1);
    expect(store.cleanupExpired()).toBe(0);
  });

  it('rejects unaudited operations, invalid principals and oversized arguments', () => {
    const { store } = open();
    expect(() => store.create('', 'easyeda_bom_generate', {})).toThrow('validated owner');
    expect(() => store.create(' owner ', 'easyeda_bom_generate', {})).toThrow('validated owner');
    expect(() =>
      store.create('owner', 'easyeda_pcb_add_track' as 'easyeda_bom_generate', {}),
    ).toThrow('allowlist');
    expect(() => store.create('owner', 'easyeda_bom_generate', {}, 10)).toThrow('retention');
    expect(() =>
      store.create('owner', 'easyeda_bom_generate', { large: 'a'.repeat(66000) }),
    ).toThrow('size limit');
    const task = store.create('owner', 'easyeda_bom_generate', {});
    expect(() => store.finish('owner', task.id, { large: 'a'.repeat(1024 * 1024) })).toThrow(
      'size limit',
    );
    expect(store.get('owner', task.id)?.status).toBe('working');
  });

  it('enforces per-owner quotas, bounded listings and durable retention', () => {
    const { store } = open();
    for (let i = 0; i < 100; i++) store.create('owner', 'easyeda_bom_generate', { i });
    expect(store.list('owner', 10)).toHaveLength(10);
    expect(() => store.list('owner', 101)).toThrow('limit');
    expect(() => store.create('owner', 'easyeda_bom_generate', {})).toThrow('quota');
    expect(store.create('another-owner', 'easyeda_bom_generate', {}).status).toBe('working');
    currentTime += 3600001;
    expect(store.create('owner', 'easyeda_bom_generate', {}).status).toBe('working');
  });
});
