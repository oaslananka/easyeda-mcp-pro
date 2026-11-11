import type { ApiRuntime } from './api-runtime.js';
import { NATIVE_ZONE_FENCE_KEY, type ZoneFenceStorage } from './zone-durable-write-fence.js';

type NativeReader = ApiRuntime['readFirstPath'];

interface EasyedaExtensionStorage {
  getExtensionUserConfig?: (key: string) => unknown;
  setExtensionUserConfig?: (key: string, value: string) => Promise<boolean>;
}

/**
 * EasyEDA Pro extension-only persistent configuration APIs.
 * Do not use browser localStorage from the restricted extension main thread.
 * The get method is synchronous; native set must resolve exactly true.
 */
export function createEasyedaZoneStorage(readFirstPath: NativeReader): ZoneFenceStorage {
  function requiredStorage(): Required<EasyedaExtensionStorage> {
    const storage = readFirstPath<EasyedaExtensionStorage>(['sys_Storage', 'SYS_Storage']);
    if (
      !storage ||
      typeof storage.getExtensionUserConfig !== 'function' ||
      typeof storage.setExtensionUserConfig !== 'function'
    ) {
      throw new Error('Native extension storage capability is unavailable.');
    }
    return storage as Required<EasyedaExtensionStorage>;
  }

  return {
    async getItem(key) {
      const storage = requiredStorage();
      const value = storage.getExtensionUserConfig(key);
      if (value === undefined) return null;
      // This API must be synchronous. A thenable result is a mismatched runtime,
      // not a known persisted marker or proof of an empty store.
      if (value !== null && typeof value === 'object' && 'then' in value)
        throw new Error('Native extension storage getter returned an asynchronous result.');
      // Unsupported values are nonempty/invalid markers, NEVER absent evidence.
      return typeof value === 'string' ? value : 'invalid-native-zone-marker';
    },
    async setItem(key, value) {
      const storage = requiredStorage();
      const result = await storage.setExtensionUserConfig(key, value);
      if (result !== true) throw new Error('Native extension storage did not confirm persistence.');
    },
  };
}

/** Safe status telemetry. No native writes, no marker disclosure or recovery authority. */
export function inspectNativeZoneSafety(readFirstPath: NativeReader) {
  const notReady = {
    storage: 'unavailable' as const,
    pendingFence: 'unknown' as const,
    coordinator: 'unavailable' as const,
    coldReopenVerified: false as const,
    publicApplyEnabled: false as const,
  };
  // The isolated native API can throw synchronously or reject asynchronously.
  // Catch the entire chain; never turn a failed probe into readiness evidence.
  return Promise.resolve()
    .then(() => createEasyedaZoneStorage(readFirstPath).getItem(NATIVE_ZONE_FENCE_KEY))
    .then((stored) => ({
      ...notReady,
      storage: 'readable' as const,
      pendingFence: stored === null ? ('absent' as const) : ('present' as const),
    }))
    .catch(() => notReady);
}
