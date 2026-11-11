import { describe, expect, it, vi } from 'vitest';
import { createEasyedaZoneStorage } from '../src/zone-native-storage.js';
import { NATIVE_ZONE_FENCE_KEY } from '../src/zone-durable-write-fence.js';

function fixture() {
  const cells = new Map<string, string>();
  const getExtensionUserConfig = vi.fn((key: string): unknown => cells.get(key));
  const setExtensionUserConfig = vi.fn(async (key: string, value: unknown) => {
    cells.set(key, String(value));
    return true;
  });
  const storage = { getExtensionUserConfig, setExtensionUserConfig };
  const readFirstPath = vi.fn(<T>(_paths: readonly string[]): T | undefined => storage as T);
  return { cells, storage, readFirstPath, getExtensionUserConfig, setExtensionUserConfig };
}

describe('EasyEDA Pro SYS_Storage extension-only persistent marker provider', () => {
  it('uses native synchronous getter and awaits a true native asynchronous write', async () => {
    const f = fixture();
    const provider = createEasyedaZoneStorage(f.readFirstPath);
    expect(await provider.getItem(NATIVE_ZONE_FENCE_KEY)).toBeNull();
    await expect(provider.setItem(NATIVE_ZONE_FENCE_KEY, 'marker')).resolves.toBeUndefined();
    expect(f.getExtensionUserConfig).toHaveBeenCalledExactlyOnceWith(NATIVE_ZONE_FENCE_KEY);
    expect(f.setExtensionUserConfig).toHaveBeenCalledExactlyOnceWith(
      NATIVE_ZONE_FENCE_KEY,
      'marker',
    );
    expect(await createEasyedaZoneStorage(f.readFirstPath).getItem(NATIVE_ZONE_FENCE_KEY)).toBe(
      'marker',
    );
  });

  it('never accepts native set returning false, undefined or rejecting', async () => {
    const f = fixture();
    const provider = createEasyedaZoneStorage(f.readFirstPath);
    f.setExtensionUserConfig.mockResolvedValueOnce(false);
    await expect(provider.setItem(NATIVE_ZONE_FENCE_KEY, 'a')).rejects.toThrow();
    f.setExtensionUserConfig.mockResolvedValueOnce(undefined as never);
    await expect(provider.setItem(NATIVE_ZONE_FENCE_KEY, 'b')).rejects.toThrow();
    f.setExtensionUserConfig.mockRejectedValueOnce(Error('permission denied'));
    await expect(provider.setItem(NATIVE_ZONE_FENCE_KEY, 'c')).rejects.toThrow();
  });

  it('fails closed if storage API absent or returns an unexpected nonstring stored marker', async () => {
    const f = fixture();
    f.readFirstPath.mockReturnValueOnce(undefined);
    await expect(
      createEasyedaZoneStorage(f.readFirstPath).getItem(NATIVE_ZONE_FENCE_KEY),
    ).rejects.toThrow();
    f.getExtensionUserConfig.mockReturnValueOnce({ status: 'unknown' });
    expect(
      await createEasyedaZoneStorage(f.readFirstPath).getItem(NATIVE_ZONE_FENCE_KEY),
    ).toBeTruthy(); // A non-string record cannot be mistaken for empty storage.
  });

  it('does not fall back to browser localStorage or arbitrary global write methods', async () => {
    const reader = vi.fn(<T>(): T | undefined => undefined);
    const provider = createEasyedaZoneStorage(reader);
    await expect(provider.setItem(NATIVE_ZONE_FENCE_KEY, 'nope')).rejects.toThrow();
    expect(reader).toHaveBeenCalled();
  });
});
