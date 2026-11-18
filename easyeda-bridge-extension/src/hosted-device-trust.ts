/**
 * Optional trusted-device reconnection for the official Hosted Cloud only.
 *
 * EasyEDA extension configuration is profile-scoped, NOT a hardware keychain.
 * Never enable this store without the owner's explicit device-trust choice.
 * The bearer can resume a paired device for <24 hours; it cannot select a
 * project, grant MCP OAuth scopes, or bypass EasyEDA native write approval.
 */
export const HOSTED_DEVICE_TRUST_KEY = 'easyedaMcpProHostedDeviceTrustV1';
export const HOSTED_DEVICE_TRUST_MAX_AGE_MS = 23 * 60 * 60 * 1000;

export interface HostedDeviceTrustStorage {
  getExtensionUserConfig(key: string): unknown;
  setExtensionUserConfig(key: string, value: unknown): Promise<boolean>;
  deleteExtensionUserConfig?(key: string): Promise<boolean>;
}

interface StoredHostedDeviceTrust {
  version: 1;
  credential: string;
  expiresAt: number;
}

const CREDENTIAL_PATTERN = /^ers_[a-f0-9]{64}$/;

function validRecord(value: unknown, now: number): value is StoredHostedDeviceTrust {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<StoredHostedDeviceTrust>;
  return (
    item.version === 1 &&
    typeof item.credential === 'string' &&
    CREDENTIAL_PATTERN.test(item.credential) &&
    typeof item.expiresAt === 'number' &&
    Number.isSafeInteger(item.expiresAt) &&
    item.expiresAt > now &&
    item.expiresAt <= now + HOSTED_DEVICE_TRUST_MAX_AGE_MS
  );
}

export class HostedDeviceTrust {
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly getStorage: () => HostedDeviceTrustStorage | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Read only on extension activation, before opening a Cloud session.
   * Malformed / expired values never become authentication material.
   */
  read(): string | undefined {
    try {
      const data = this.getStorage()?.getExtensionUserConfig(HOSTED_DEVICE_TRUST_KEY);
      if (validRecord(data, this.now())) return data.credential;
      if (data !== undefined) void this.forget();
    } catch {
      // Native storage failures are not authorization; Local mode remains available.
    }
    return undefined;
  }

  /**
   * Serialized with forget() so a delayed persistence reply cannot resurrect
   * a device the user disconnected. Never log the bearer or storage payload.
   */
  remember(credential: string, freshOwnerConsent = false): Promise<boolean> {
    if (!CREDENTIAL_PATTERN.test(credential)) return Promise.resolve(false);
    return this.enqueue(async () => {
      const storage = this.getStorage();
      if (!storage?.setExtensionUserConfig) return false;
      const now = this.now();
      // Server token rotation is not permission to extend the native 23-hour
      // remember decision. Only a fresh, explicit owner choice restarts the clock.
      const current = storage.getExtensionUserConfig(HOSTED_DEVICE_TRUST_KEY);
      if (!freshOwnerConsent && !validRecord(current, now)) return false;
      const record: StoredHostedDeviceTrust = {
        version: 1,
        credential,
        expiresAt: freshOwnerConsent
          ? now + HOSTED_DEVICE_TRUST_MAX_AGE_MS
          : (current as StoredHostedDeviceTrust).expiresAt,
      };
      return (await storage.setExtensionUserConfig(HOSTED_DEVICE_TRUST_KEY, record)) === true;
    });
  }

  forget(): Promise<boolean> {
    return this.enqueue(async () => {
      const storage = this.getStorage();
      if (!storage) return false;
      if (typeof storage.deleteExtensionUserConfig === 'function') {
        try {
          if ((await storage.deleteExtensionUserConfig(HOSTED_DEVICE_TRUST_KEY)) === true)
            return true;
        } catch {
          // Some EasyEDA runtimes expose delete but reject its invocation.
        }
      }
      // Set an invalid sentinel if this build lacks native delete.
      return typeof storage.setExtensionUserConfig === 'function'
        ? (await storage.setExtensionUserConfig(HOSTED_DEVICE_TRUST_KEY, null)) === true
        : false;
    });
  }

  private enqueue(action: () => Promise<boolean>): Promise<boolean> {
    const result = this.operation.then(action).then(
      (succeeded) => succeeded === true,
      () => false, // fail closed without secret-bearing log events
    );
    this.operation = result.then(() => undefined);
    return result;
  }

  /** Allow tests to verify asynchronous EasyEDA native storage writes. */
  async settled(): Promise<void> {
    await this.operation;
  }
}
