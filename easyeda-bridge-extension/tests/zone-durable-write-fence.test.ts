import { describe, expect, it, vi } from 'vitest';
import { createPersistentZoneWriteFence } from '../src/zone-durable-write-fence.js';

function storage() {
  const cells = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => cells.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      cells.set(key, value);
    }),
    cells,
  };
}

describe('native zone quarantine surviving candidate adapter reconstruction', () => {
  it('reserves synchronously once and blocks different/new adapter instances without expiring', () => {
    const backing = storage();
    const first = createPersistentZoneWriteFence(backing);
    expect(first.reserve('project-A:pcb-1')).toBe(true);
    expect(first.inspect()).toMatchObject({ blocked: true, focus: 'project-A:pcb-1' });
    const reopened = createPersistentZoneWriteFence(backing);
    expect(reopened.reserve('project-A:pcb-1')).toBe(false);
    expect(reopened.reserve('project-B:pcb-2')).toBe(false);
    expect(backing.setItem).toHaveBeenCalledTimes(1);
  });

  it('fails closed on malformed, empty or unsupported journal rather than silently resetting', () => {
    const backing = storage();
    backing.cells.set('easyeda-mcp-pro.zone-create.pending.v1', '{}');
    expect(createPersistentZoneWriteFence(backing).reserve('project:pcb')).toBe(false);
    expect(backing.setItem).not.toHaveBeenCalled();
  });

  it('reports a malformed or corrupt marker as blocked instead of offering recovery', () => {
    const backing = storage();
    const fence = createPersistentZoneWriteFence(backing);
    expect(fence.inspect()).toEqual({ blocked: false });
    backing.cells.set('easyeda-mcp-pro.zone-create.pending.v1', '{}');
    expect(fence.inspect()).toEqual({ blocked: true });
    backing.cells.set('easyeda-mcp-pro.zone-create.pending.v1', '{bad-json');
    expect(createPersistentZoneWriteFence(backing).inspect()).toEqual({ blocked: true });
    expect(backing.setItem).not.toHaveBeenCalled();
  });

  it('reports denied read access as a blocked quarantine without mutating storage', () => {
    const broken = {
      getItem: () => {
        throw Error('permission denied');
      },
      setItem: vi.fn(),
    };
    expect(createPersistentZoneWriteFence(broken).inspect()).toEqual({ blocked: true });
    expect(broken.setItem).not.toHaveBeenCalled();
  });

  it('rejects storage access errors, quota failures, and storage that ignores writes', () => {
    const readDenied = {
      getItem: () => {
        throw Error('storage denied');
      },
      setItem: vi.fn(),
    };
    expect(createPersistentZoneWriteFence(readDenied).reserve('project:pcb')).toBe(false);
    expect(readDenied.setItem).not.toHaveBeenCalled();

    const writeDenied = {
      getItem: () => null,
      setItem: () => {
        throw Error('quota');
      },
    };
    expect(createPersistentZoneWriteFence(writeDenied).reserve('project:pcb')).toBe(false);

    const ignoredWrite = { getItem: () => null, setItem: vi.fn() };
    expect(createPersistentZoneWriteFence(ignoredWrite).reserve('project:pcb')).toBe(false);
    expect(ignoredWrite.setItem).toHaveBeenCalledOnce();
  });

  it('rejects invalid focus before attempting any storage write', () => {
    const backing = storage();
    const fence = createPersistentZoneWriteFence(backing);
    expect(fence.reserve('')).toBe(false);
    expect(fence.reserve(' '.repeat(20))).toBe(false);
    expect(fence.reserve('x'.repeat(1025))).toBe(false);
    expect(backing.setItem).not.toHaveBeenCalled();
  });
});
