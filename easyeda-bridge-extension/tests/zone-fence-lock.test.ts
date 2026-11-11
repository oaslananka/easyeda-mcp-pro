import { describe, expect, it, vi } from 'vitest';
import { createBrowserZoneFenceLock, NATIVE_ZONE_LOCK_KEY } from '../src/zone-fence-lock.js';

describe('fail-closed origin-scoped exclusive zone reservation', () => {
  it('refuses to run any callback without a working Web Locks API', async () => {
    const action = vi.fn(async () => true);
    await expect(createBrowserZoneFenceLock(undefined).exclusive(action)).resolves.toBe(false);
    expect(action).not.toHaveBeenCalled();
  });

  it('uses an exclusive, nonwaiting named Web Lock and releases after callback', async () => {
    const action = vi.fn(async () => true);
    const request = vi.fn(
      async (
        _name: string,
        _options: { mode: string; ifAvailable: boolean },
        callback: (lock: { name: string }) => Promise<boolean>,
      ) => callback({ name: NATIVE_ZONE_LOCK_KEY }),
    );
    const result = await createBrowserZoneFenceLock({ request }).exclusive(action);
    expect(result).toBe(true);
    expect(request).toHaveBeenCalledWith(
      NATIVE_ZONE_LOCK_KEY,
      { mode: 'exclusive', ifAvailable: true },
      expect.any(Function),
    );
    expect(action).toHaveBeenCalledOnce();
  });

  it('does not run if the lock is occupied or the lock manager rejects', async () => {
    const action = vi.fn(async () => true);
    const denied = vi.fn(
      async (
        _name: string,
        _options: { mode: string; ifAvailable: boolean },
        callback: (lock: null) => Promise<boolean>,
      ) => callback(null),
    );
    await expect(createBrowserZoneFenceLock({ request: denied }).exclusive(action)).resolves.toBe(
      false,
    );
    const rejected = vi.fn(async () => {
      throw Error('not allowed');
    });
    await expect(createBrowserZoneFenceLock({ request: rejected }).exclusive(action)).resolves.toBe(
      false,
    );
    expect(action).not.toHaveBeenCalled();
  });
});
