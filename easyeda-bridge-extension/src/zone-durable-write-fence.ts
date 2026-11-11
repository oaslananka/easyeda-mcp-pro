/**
 * A monotonic, storage-backed safety latch for the native Pour candidate.
 *
 * Storage must survive editor/extension reconstruction. The latch is reserved
 * BEFORE entering native mutation; it is intentionally never auto-cleared by
 * a same-session save, rollback or timeout. No public apply is wired to this.
 */
import type { ZoneFenceLock } from './zone-fence-lock.js';

export interface ZoneFenceStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
}

export interface NativeZoneWriteFence {
  reserve(focus: string): Promise<boolean>;
}

export const NATIVE_ZONE_FENCE_KEY = 'easyeda-mcp-pro.zone-create.pending.v1';

interface PendingZoneFence {
  status: 'reconciliation-required';
  focus: string;
  version: 1;
}

function parsePending(raw: string | null): PendingZoneFence | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null) return undefined;
    const candidate = value as Partial<PendingZoneFence>;
    if (
      candidate.version !== 1 ||
      candidate.status !== 'reconciliation-required' ||
      typeof candidate.focus !== 'string' ||
      candidate.focus.trim().length === 0
    )
      return undefined;
    return candidate as PendingZoneFence;
  } catch {
    return undefined;
  }
}

export function createPersistentZoneWriteFence(storage: ZoneFenceStorage, lock: ZoneFenceLock) {
  async function inspect(): Promise<{ blocked: boolean; focus?: string }> {
    try {
      const stored = await storage.getItem(NATIVE_ZONE_FENCE_KEY);
      if (stored === null) return { blocked: false };
      const parsed = parsePending(stored);
      return parsed ? { blocked: true, focus: parsed.focus } : { blocked: true };
    } catch {
      return { blocked: true };
    }
  }

  async function reserve(focus: string): Promise<boolean> {
    if (typeof focus !== 'string' || !focus.trim() || focus.length > 1024) return false;
    try {
      // Exactly one same-origin contender can examine and create the marker.
      return await lock.exclusive(async () => {
        if ((await storage.getItem(NATIVE_ZONE_FENCE_KEY)) !== null) return false;
        const marker = JSON.stringify({ status: 'reconciliation-required', focus, version: 1 });
        await storage.setItem(NATIVE_ZONE_FENCE_KEY, marker);
        return (await storage.getItem(NATIVE_ZONE_FENCE_KEY)) === marker;
      });
    } catch {
      return false;
    }
  }

  return { reserve, inspect };
}
