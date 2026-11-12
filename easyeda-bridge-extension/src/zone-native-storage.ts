import type { ApiRuntime } from './api-runtime.js';
import { NATIVE_ZONE_FENCE_KEY, type ZoneFenceStorage } from './zone-durable-write-fence.js';
import {
  decodeZonePendingEvidence,
  hasContradictoryZoneRecoveryBaseline,
} from './zone-recovery-evidence.js';

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

interface FocusedProject {
  uuid?: unknown;
}

interface FocusedDocument {
  uuid?: unknown;
  parentProjectUuid?: unknown;
  documentType?: unknown;
}

/** Zero-mutation focus check, intentionally independent of the full copper inventory. */
async function pendingZoneFocus(readFirstPath: NativeReader): Promise<string | undefined> {
  const projectApi = readFirstPath<{
    getCurrentProjectInfo?: () => Promise<FocusedProject | null>;
  }>(['DMT_Project', 'dmt_Project']);
  const documentApi = readFirstPath<{
    getCurrentDocumentInfo?: () => Promise<FocusedDocument | null>;
  }>(['DMT_SelectControl', 'dmt_SelectControl']);
  if (
    typeof projectApi?.getCurrentProjectInfo !== 'function' ||
    typeof documentApi?.getCurrentDocumentInfo !== 'function'
  )
    return undefined;
  const project = await projectApi.getCurrentProjectInfo();
  const document = await documentApi.getCurrentDocumentInfo();
  if (
    typeof project?.uuid !== 'string' ||
    !project.uuid ||
    typeof document?.uuid !== 'string' ||
    !document.uuid ||
    document.documentType !== 3 ||
    document.parentProjectUuid !== project.uuid
  )
    return undefined;
  return JSON.stringify([project.uuid, document.uuid]);
}

/**
 * Safe, privacy-preserving status telemetry: no native writes, no raw marker,
 * project identity or source ID disclosures, and NEVER any release authority.
 * A match is only a same-session focus check, NOT filled-copper recovery or
 * cold-reopen proof. A missing focused PCB is explicitly actionable.
 */
export async function inspectNativeZoneSafety(readFirstPath: NativeReader) {
  const notReady = {
    storage: 'unavailable' as const,
    pendingFence: 'unknown' as const,
    coordinator: 'unavailable' as const,
    coldReopenVerified: false as const,
    publicApplyEnabled: false as const,
  };
  let stored: string | null;
  try {
    stored = await createEasyedaZoneStorage(readFirstPath).getItem(NATIVE_ZONE_FENCE_KEY);
  } catch {
    return notReady;
  }
  const readable = {
    ...notReady,
    storage: 'readable' as const,
    pendingFence: stored === null ? ('absent' as const) : ('present' as const),
  };
  if (stored === null) return readable;

  const candidate = decodeZonePendingEvidence(stored);
  if (!candidate || hasContradictoryZoneRecoveryBaseline(candidate)) {
    return {
      ...readable,
      recoveryState: 'invalid-marker' as const,
      recoveryReleaseAuthorized: false as const,
    };
  }
  let recoveryState:
    'requires-focused-pcb' | 'focus-mismatch' | 'awaiting-independent-recovery' | 'unresolved';
  try {
    const focus = await pendingZoneFocus(readFirstPath);
    if (!focus) {
      recoveryState = 'requires-focused-pcb';
    } else if (candidate.focus !== focus) {
      recoveryState = 'focus-mismatch';
    } else {
      // Do not perform a potentially expensive full copper scan on each
      // health poll. Independent cold-reopen inventory is a separate gate.
      recoveryState = 'awaiting-independent-recovery';
    }
  } catch {
    recoveryState = 'unresolved';
  }
  return {
    ...readable,
    recoveryState,
    recoveryReleaseAuthorized: false as const,
  };
}
