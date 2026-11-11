import { describe, expect, it, vi } from 'vitest';
import { createEasyedaZoneStorage, inspectNativeZoneSafety } from '../src/zone-native-storage.js';
import { encodeZoneWriteReservation } from '../src/zone-recovery-evidence.js';
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

const expected = {
  net: 'GND',
  layer: 2,
  polygonSignature: JSON.stringify(['R', 1400, -1200, 120, 80, 0, 0]),
  fillMethod: 'solid',
  preserveSilos: true,
  pourName: 'STORAGE_TEST_NO_PCB_WRITE',
  pourPriority: 1,
  lineWidth: 0.2,
  locked: false,
};
const v2Marker = () => {
  const encoded = encodeZoneWriteReservation({
    focus: JSON.stringify(['project-1', 'pcb-1']),
    before: { sources: new Map(), derived: new Map() },
    expected,
  });
  if (!encoded) throw Error('Test marker invalid');
  return encoded;
};

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

  it('reports a malformed pending marker as non-recoverable without disclosing its contents', async () => {
    const f = fixture();
    const marker = 'test-private-malformed-marker-contents';
    f.cells.set(NATIVE_ZONE_FENCE_KEY, marker);
    const status = await inspectNativeZoneSafety(f.readFirstPath);
    expect(status).toMatchObject({
      storage: 'readable',
      pendingFence: 'present',
      recoveryState: 'invalid-marker',
      recoveryReleaseAuthorized: false,
      coldReopenVerified: false,
      publicApplyEnabled: false,
    });
    expect(JSON.stringify(status)).not.toContain(marker);
    expect(f.setExtensionUserConfig).not.toHaveBeenCalled();
  });

  it('asks for a focused PCB before inspecting a valid pending marker', async () => {
    const f = fixture();
    f.cells.set(NATIVE_ZONE_FENCE_KEY, v2Marker());
    const status = await inspectNativeZoneSafety(f.readFirstPath);
    expect(status).toMatchObject({
      storage: 'readable',
      pendingFence: 'present',
      recoveryState: 'requires-focused-pcb',
      recoveryReleaseAuthorized: false,
    });
    expect(f.setExtensionUserConfig).not.toHaveBeenCalled();
  });

  it('reports matching PCB focus as awaiting separate inventory recovery, never as success', async () => {
    const f = fixture();
    f.cells.set(NATIVE_ZONE_FENCE_KEY, v2Marker());
    const getAll = vi.fn(async () => []);
    const reader = <T>(paths: readonly string[]): T | undefined => {
      switch (paths[0]) {
        case 'sys_Storage':
          return f.storage as T;
        case 'DMT_Project':
          return { getCurrentProjectInfo: async () => ({ uuid: 'project-1' }) } as T;
        case 'DMT_SelectControl':
          return {
            getCurrentDocumentInfo: async () => ({
              uuid: 'pcb-1',
              parentProjectUuid: 'project-1',
              documentType: 3,
            }),
          } as T;
        case 'PCB_PrimitivePour':
        case 'PCB_PrimitivePoured':
          return { getAll } as T;
        default:
          return undefined;
      }
    };
    const status = await inspectNativeZoneSafety(reader);
    expect(status).toMatchObject({
      pendingFence: 'present',
      recoveryState: 'awaiting-independent-recovery',
      recoveryReleaseAuthorized: false,
      coldReopenVerified: false,
      publicApplyEnabled: false,
    });
    expect(getAll).not.toHaveBeenCalled();
    expect(f.setExtensionUserConfig).not.toHaveBeenCalled();
  });

  it('rejects a different active PCB without scanning native copper or releasing the fence', async () => {
    const f = fixture();
    f.cells.set(NATIVE_ZONE_FENCE_KEY, v2Marker());
    const getAll = vi.fn(async () => []);
    const reader = <T>(paths: readonly string[]): T | undefined => {
      if (paths[0] === 'sys_Storage') return f.storage as T;
      if (paths[0] === 'DMT_Project')
        return { getCurrentProjectInfo: async () => ({ uuid: 'project-1' }) } as T;
      if (paths[0] === 'DMT_SelectControl')
        return {
          getCurrentDocumentInfo: async () => ({
            uuid: 'another-pcb',
            parentProjectUuid: 'project-1',
            documentType: 3,
          }),
        } as T;
      if (paths[0] === 'PCB_PrimitivePour') return { getAll } as T;
      return undefined;
    };
    expect(await inspectNativeZoneSafety(reader)).toMatchObject({
      storage: 'readable',
      pendingFence: 'present',
      recoveryState: 'focus-mismatch',
      recoveryReleaseAuthorized: false,
      coldReopenVerified: false,
      publicApplyEnabled: false,
    });
    expect(getAll).not.toHaveBeenCalled();
    expect(f.setExtensionUserConfig).not.toHaveBeenCalled();
  });

  it('retains a present marker when the focus API fails', async () => {
    const f = fixture();
    f.cells.set(NATIVE_ZONE_FENCE_KEY, v2Marker());
    const reader = <T>(paths: readonly string[]): T | undefined => {
      if (paths[0] === 'sys_Storage') return f.storage as T;
      if (paths[0] === 'DMT_Project')
        return {
          getCurrentProjectInfo: async () => {
            throw Error('native focus getter failed');
          },
        } as T;
      if (paths[0] === 'DMT_SelectControl')
        return {
          getCurrentDocumentInfo: async () => ({
            uuid: 'pcb-1',
            parentProjectUuid: 'project-1',
            documentType: 3,
          }),
        } as T;
      if (paths[0] === 'PCB_PrimitivePour')
        return {
          getAll: async () => {
            throw Error('native getter failed');
          },
        } as T;
      return undefined;
    };
    expect(await inspectNativeZoneSafety(reader)).toMatchObject({
      storage: 'readable',
      pendingFence: 'present',
      recoveryState: 'unresolved',
      recoveryReleaseAuthorized: false,
    });
    expect(f.setExtensionUserConfig).not.toHaveBeenCalled();
  });

  it('does not fall back to browser localStorage or arbitrary global write methods', async () => {
    const reader = vi.fn(<T>(): T | undefined => undefined);
    const provider = createEasyedaZoneStorage(reader);
    await expect(provider.setItem(NATIVE_ZONE_FENCE_KEY, 'nope')).rejects.toThrow();
    expect(reader).toHaveBeenCalled();
  });
});
