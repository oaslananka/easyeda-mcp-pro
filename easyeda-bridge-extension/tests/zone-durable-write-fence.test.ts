import { describe, expect, it, vi } from 'vitest';
import {
  createPersistentZoneWriteFence,
  NATIVE_ZONE_FENCE_KEY,
  type ZoneFenceStorage,
} from '../src/zone-durable-write-fence.js';

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

function lock() {
  let active = false;
  return {
    async exclusive(action: () => Promise<boolean>): Promise<boolean> {
      if (active) return false;
      active = true;
      try {
        return await action();
      } finally {
        active = false;
      }
    },
  };
}
const fence = (store: ZoneFenceStorage, mutex = lock()) =>
  createPersistentZoneWriteFence(store, mutex);

describe('native zone write quarantine with persistent storage and exclusive lock', () => {
  it('persists a reservation and refuses other adapters or PCB requests', async () => {
    const backing = storage();
    expect(await fence(backing).reserve('project-A:pcb-1')).toBe(true);
    expect(await fence(backing).inspect()).toMatchObject({
      blocked: true,
      focus: 'project-A:pcb-1',
    });
    expect(await fence(backing).reserve('project-A:pcb-1')).toBe(false);
    expect(await fence(backing).reserve('project-B:pcb-2')).toBe(false);
    expect(backing.setItem).toHaveBeenCalledExactlyOnceWith(
      NATIVE_ZONE_FENCE_KEY,
      expect.stringContaining('reconciliation-required'),
    );
  });

  it('never treats corrupt, malformed, null or unsupported markers as an empty store', async () => {
    const backing = storage();
    backing.cells.set(NATIVE_ZONE_FENCE_KEY, '{}');
    expect(await fence(backing).reserve('project:pcb')).toBe(false);
    expect(await fence(backing).inspect()).toEqual({ blocked: true });
    backing.cells.set(NATIVE_ZONE_FENCE_KEY, '{broken-json');
    expect(await fence(backing).inspect()).toEqual({ blocked: true });
    backing.cells.set(NATIVE_ZONE_FENCE_KEY, 'null');
    expect(await fence(backing).inspect()).toEqual({ blocked: true });
    expect(backing.setItem).not.toHaveBeenCalled();
  });

  it('returns blocked when storage access is denied, without attempting a write', async () => {
    const setItem = vi.fn();
    const denied = {
      getItem: () => {
        throw Error('denied');
      },
      setItem,
    };
    expect(await fence(denied).inspect()).toEqual({ blocked: true });
    expect(await fence(denied).reserve('project:pcb')).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('fails closed on rejected and ignored asynchronous writes', async () => {
    const denied = {
      getItem: () => null,
      setItem: async () => {
        throw Error('quota');
      },
    };
    expect(await fence(denied).reserve('project:pcb')).toBe(false);
    const ignoredWrite = { getItem: () => null, setItem: vi.fn(async () => {}) };
    expect(await fence(ignoredWrite).reserve('project:pcb')).toBe(false);
    expect(ignoredWrite.setItem).toHaveBeenCalledOnce();
  });

  it('rejects missing, whitespace or oversized PCB focus before storage calls', async () => {
    const backing = storage();
    expect(await fence(backing).reserve('')).toBe(false);
    expect(await fence(backing).reserve(' '.repeat(20))).toBe(false);
    expect(await fence(backing).reserve('x'.repeat(1025))).toBe(false);
    expect(backing.getItem).not.toHaveBeenCalled();
    expect(backing.setItem).not.toHaveBeenCalled();
  });

  it('does not write when no working cross-tab exclusive lock can be obtained', async () => {
    const backing = storage();
    const denied = { exclusive: vi.fn(async () => false) };
    expect(await createPersistentZoneWriteFence(backing, denied).reserve('project:pcb')).toBe(
      false,
    );
    expect(backing.getItem).not.toHaveBeenCalled();
    expect(backing.setItem).not.toHaveBeenCalled();
  });

  it('serializes concurrent requests, reserving the marker at most once', async () => {
    const backing = storage();
    const mutex = lock();
    const first = fence(backing, mutex);
    const second = fence(backing, mutex);
    const [a, b] = await Promise.all([first.reserve('project:A'), second.reserve('project:B')]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(backing.setItem).toHaveBeenCalledOnce();
    expect(await second.inspect()).toMatchObject({ blocked: true });
  });
});
