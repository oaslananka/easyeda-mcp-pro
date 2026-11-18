import { describe, expect, it, vi } from 'vitest';
import {
  HOSTED_DEVICE_TRUST_KEY,
  HOSTED_DEVICE_TRUST_MAX_AGE_MS,
  HostedDeviceTrust,
} from '../src/hosted-device-trust.js';

const TOKEN = 'ers_' + 'a'.repeat(64);

function makeStorage() {
  const records = new Map<string, unknown>();
  const storage = {
    getExtensionUserConfig: vi.fn((key: string) => records.get(key)),
    setExtensionUserConfig: vi.fn(async (key: string, value: unknown) => {
      records.set(key, value);
      return true;
    }),
    deleteExtensionUserConfig: vi.fn(async (key: string) => {
      records.delete(key);
      return true;
    }),
  };
  return { records, storage };
}

describe('explicit trusted Hosted Cloud device recovery', () => {
  it('retains one valid 23-hour, revocable credential across extension instances', async () => {
    const { records, storage } = makeStorage();
    const first = new HostedDeviceTrust(
      () => storage,
      () => 1_000_000,
    );
    expect(first.read()).toBeUndefined(); // No opt-in, no connection.
    expect(await first.remember(TOKEN, true)).toBe(true);
    const saved = records.get(HOSTED_DEVICE_TRUST_KEY);
    expect(saved).toMatchObject({
      version: 1,
      credential: TOKEN,
      expiresAt: 1_000_000 + HOSTED_DEVICE_TRUST_MAX_AGE_MS,
    });
    const restarted = new HostedDeviceTrust(
      () => storage,
      () => 1_000_002,
    );
    expect(restarted.read()).toBe(TOKEN);
    expect(await restarted.forget()).toBe(true);
    expect(records.has(HOSTED_DEVICE_TRUST_KEY)).toBe(false);
    expect(restarted.read()).toBeUndefined();
  });

  it('rejects malformed, expired and excessively long records before any network call', async () => {
    const { records, storage } = makeStorage();
    const now = 700_000_000;
    for (const invalid of [
      { version: 1, credential: 'EDA-AAAABBBB', expiresAt: now + 100 },
      { version: 1, credential: TOKEN, expiresAt: now - 1 },
      { version: 1, credential: TOKEN, expiresAt: now + HOSTED_DEVICE_TRUST_MAX_AGE_MS + 1 },
      { version: 2, credential: TOKEN, expiresAt: now + 100 },
      { version: 1, credential: TOKEN, expiresAt: Number.NaN },
      TOKEN,
    ]) {
      records.set(HOSTED_DEVICE_TRUST_KEY, invalid);
      const store = new HostedDeviceTrust(
        () => storage,
        () => now,
      );
      expect(store.read()).toBeUndefined();
      await store.settled();
      expect(records.has(HOSTED_DEVICE_TRUST_KEY)).toBe(false);
    }
  });

  it('rotates credentials without extending the original explicit 23-hour deadline', async () => {
    const { records, storage } = makeStorage();
    let now = 1_000_000;
    const trusted = new HostedDeviceTrust(
      () => storage,
      () => now,
    );
    expect(await trusted.remember(TOKEN, true)).toBe(true);
    const deadline = (records.get(HOSTED_DEVICE_TRUST_KEY) as { expiresAt: number }).expiresAt;
    now += 12 * 60 * 60 * 1000;
    expect(await trusted.remember('ers_' + 'b'.repeat(64), false)).toBe(true);
    expect(records.get(HOSTED_DEVICE_TRUST_KEY)).toMatchObject({
      credential: 'ers_' + 'b'.repeat(64),
      expiresAt: deadline,
    });
    now = deadline;
    expect(await trusted.remember('ers_' + 'c'.repeat(64), false)).toBe(false);
    expect(trusted.read()).toBeUndefined();
    await trusted.settled();
    expect(records.has(HOSTED_DEVICE_TRUST_KEY)).toBe(false);
    // Only another explicit user trust decision may start a new window.
    expect(await trusted.remember('ers_' + 'd'.repeat(64), true)).toBe(true);
    expect(records.get(HOSTED_DEVICE_TRUST_KEY)).toMatchObject({
      credential: 'ers_' + 'd'.repeat(64),
      expiresAt: now + HOSTED_DEVICE_TRUST_MAX_AGE_MS,
    });
  });

  it('never persists a one-time pairing code or malformed bearer', async () => {
    const { storage } = makeStorage();
    const trusted = new HostedDeviceTrust(() => storage);
    expect(await trusted.remember('EDA-12345678')).toBe(false);
    expect(await trusted.remember('ers_' + 'Z'.repeat(64))).toBe(false);
    expect(storage.setExtensionUserConfig).not.toHaveBeenCalled();
  });

  it('falls back to an invalid sentinel if the native delete API is unavailable', async () => {
    const { records, storage } = makeStorage();
    const limited = {
      getExtensionUserConfig: storage.getExtensionUserConfig,
      setExtensionUserConfig: storage.setExtensionUserConfig,
    };
    const trusted = new HostedDeviceTrust(() => limited);
    expect(await trusted.remember(TOKEN, true)).toBe(true);
    expect(await trusted.forget()).toBe(true);
    expect(records.get(HOSTED_DEVICE_TRUST_KEY)).toBeNull();
    expect(trusted.read()).toBeUndefined();
  });

  it('retries clearing with invalid sentinel when native deletion rejects', async () => {
    const { records, storage } = makeStorage();
    storage.deleteExtensionUserConfig.mockRejectedValueOnce(Error('native unavailable'));
    const trusted = new HostedDeviceTrust(() => storage);
    expect(await trusted.remember(TOKEN, true)).toBe(true);
    expect(await trusted.forget()).toBe(true);
    expect(records.get(HOSTED_DEVICE_TRUST_KEY)).toBeNull();
  });

  it('reports unusable storage without treating it as trusted authorization', async () => {
    const trusted = new HostedDeviceTrust(() => undefined);
    expect(trusted.read()).toBeUndefined();
    expect(await trusted.remember(TOKEN, true)).toBe(false);
    expect(await trusted.forget()).toBe(false);
  });

  it('serializes delayed save and subsequent disconnect so old credentials cannot reappear', async () => {
    const { records, storage } = makeStorage();
    let releaseSave: (() => void) | undefined;
    storage.setExtensionUserConfig.mockImplementationOnce(async (key, value) => {
      await new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      records.set(key, value);
      return true;
    });
    const trusted = new HostedDeviceTrust(() => storage);
    const save = trusted.remember(TOKEN, true);
    const forget = trusted.forget();
    await Promise.resolve();
    releaseSave?.();
    expect(await save).toBe(true);
    expect(await forget).toBe(true);
    expect(records.has(HOSTED_DEVICE_TRUST_KEY)).toBe(false);
  });
});
