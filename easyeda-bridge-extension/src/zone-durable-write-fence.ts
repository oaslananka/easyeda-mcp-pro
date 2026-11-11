/**
 * A monotonic, storage-backed safety latch for the native Pour candidate.
 *
 * Storage must survive editor/extension reconstruction. The latch is reserved
 * BEFORE entering native mutation; it is intentionally never auto-cleared by
 * a same-session save, rollback or timeout. No public apply is wired to this.
 */
import type { ZoneFenceLock } from './zone-fence-lock.js';
import {
  encodeZoneWriteReservation,
  decodeZonePendingEvidence,
  type ZoneWriteReservation,
} from './zone-recovery-evidence.js';

export interface ZoneFenceStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
}

export interface NativeZoneWriteFence {
  reserve(reservation: ZoneWriteReservation): Promise<boolean>;
}

export const NATIVE_ZONE_FENCE_KEY = 'easyeda-mcp-pro.zone-create.pending.v1';

export function createPersistentZoneWriteFence(storage: ZoneFenceStorage, lock: ZoneFenceLock) {
  async function inspect(): Promise<{ blocked: boolean; focus?: string }> {
    try {
      const stored = await storage.getItem(NATIVE_ZONE_FENCE_KEY);
      if (stored === null) return { blocked: false };
      const parsed = decodeZonePendingEvidence(stored);
      return parsed ? { blocked: true, focus: parsed.focus } : { blocked: true };
    } catch {
      return { blocked: true };
    }
  }

  async function reserve(reservation: ZoneWriteReservation): Promise<boolean> {
    const marker = encodeZoneWriteReservation(reservation);
    if (!marker) return false;
    try {
      // Exactly one same-origin contender can examine and create the marker.
      return await lock.exclusive(async () => {
        if ((await storage.getItem(NATIVE_ZONE_FENCE_KEY)) !== null) return false;
        await storage.setItem(NATIVE_ZONE_FENCE_KEY, marker);
        return (await storage.getItem(NATIVE_ZONE_FENCE_KEY)) === marker;
      });
    } catch {
      return false;
    }
  }

  return { reserve, inspect };
}
