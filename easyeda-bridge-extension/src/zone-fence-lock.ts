/**
 * Origin-scoped, non-waiting Web Lock needed to serialize native fence
 * read+write+readback across concurrent extension/tab instances.
 * No Web Locks capability => no native zone creation (fail closed).
 */
export const NATIVE_ZONE_LOCK_KEY = 'easyeda-mcp-pro.native-zone-reservation.v1';

export interface ZoneFenceLock {
  exclusive(action: () => Promise<boolean>): Promise<boolean>;
}

type ExclusiveRequest = (
  name: string,
  options: { mode: 'exclusive'; ifAvailable: true },
  callback: (lock: { name: string } | null) => Promise<boolean>,
) => Promise<boolean>;

export function createBrowserZoneFenceLock(manager: unknown): ZoneFenceLock {
  async function exclusive(action: () => Promise<boolean>): Promise<boolean> {
    if (!manager || typeof manager !== 'object' || !('request' in manager)) return false;
    const request = (manager as { request: unknown }).request;
    if (typeof request !== 'function') return false;
    try {
      return await (request as ExclusiveRequest).call(
        manager,
        NATIVE_ZONE_LOCK_KEY,
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => (lock ? action() : false),
      );
    } catch {
      return false;
    }
  }
  return { exclusive };
}
