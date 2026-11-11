/**
 * A monotonic, storage-backed safety latch for the native Pour candidate.
 *
 * Storage must survive editor/extension reconstruction. The latch is reserved
 * BEFORE entering native mutation; it is intentionally never auto-cleared by
 * a same-session save, rollback or timeout. No public apply is wired to this.
 */
export interface ZoneFenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface NativeZoneWriteFence {
  reserve(focus: string): boolean;
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

export function createPersistentZoneWriteFence(storage: ZoneFenceStorage) {
  function inspect(): { blocked: boolean; focus?: string } {
    try {
      const stored = storage.getItem(NATIVE_ZONE_FENCE_KEY);
      if (stored === null) return { blocked: false };
      const parsed = parsePending(stored);
      return parsed ? { blocked: true, focus: parsed.focus } : { blocked: true };
    } catch {
      return { blocked: true };
    }
  }

  function reserve(focus: string): boolean {
    if (typeof focus !== 'string' || !focus.trim() || focus.length > 1024) return false;
    try {
      // A malformed record is treated as an existing barrier, not an empty store.
      if (storage.getItem(NATIVE_ZONE_FENCE_KEY) !== null) return false;
      const marker = JSON.stringify({ status: 'reconciliation-required', focus, version: 1 });
      storage.setItem(NATIVE_ZONE_FENCE_KEY, marker);
      return storage.getItem(NATIVE_ZONE_FENCE_KEY) === marker;
    } catch {
      // Access denied, quota, missing permissions, or corrupted persistence => no write.
      return false;
    }
  }

  return { reserve, inspect };
}
