import type { ApiRuntime } from './api-runtime.js';
import type { ZoneFenceStorage } from './zone-durable-write-fence.js';

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
    const storage = readFirstPath<EasyedaExtensionStorage>(['SYS_Storage', 'sys_Storage']);
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
      // An unexpected object (including a Promise) is an existing, corrupt
      // marker, NEVER evidence for a fresh empty durable store.
      return typeof value === 'string' ? value : 'invalid-native-zone-marker';
    },
    async setItem(key, value) {
      const storage = requiredStorage();
      const result = await storage.setExtensionUserConfig(key, value);
      if (result !== true) throw new Error('Native extension storage did not confirm persistence.');
    },
  };
}
