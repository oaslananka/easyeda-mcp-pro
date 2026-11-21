import { snapshotForHash, stableHash } from '../transactions/stable.js';
import type { PrimitiveSnapshotResult, TransactionBridgeCaller } from '../transactions/easyeda.js';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as RecordValue;
}

interface PrivateGroundHostAdapter {
  sessionId: string;
  path: string;
  projectId: string;
  pageId: string;
  markerId: string;
  listSessions(): Promise<unknown>;
  invoke(method: string, params: RecordValue): Promise<unknown>;
}

function hasGroundDevice(value: unknown): boolean {
  const symbol = record(value);
  return (
    symbol.name === 'Ground-GND' &&
    symbol.uuid === 'af20086a8911a85a' &&
    symbol.libraryUuid === '0819f05c4eef4c71ace90d822a990e87'
  );
}

// IDs in the native schematic snapshot are project-local library copies.
const GROUND_LIBRARY = '0819f05c4eef4c71ace90d822a990e87';
const GROUND_SOURCE_DEVICE = '2e4e71fea06848c9a86eef0ed6338204';
const GROUND_SOURCE_SYMBOL = '1c18ed5a06f64a07bdb5b0cf525b3d9e';

/**
 * The trusted private worker must obtain the project-local device/symbol
 * provenance from the native project device export and independently resolve
 * the exact source device. The project-local UUID alone is not a system UUID.
 */
function hasGroundCreationDevice(value: unknown): boolean {
  const evidence = record(value);
  const device = record(evidence.systemDevice);
  const symbol = record(device.association);
  return (
    evidence.projectDeviceUuid === 'af20086a8911a85a' &&
    evidence.projectSymbolUuid === '17c558f9e954b079' &&
    evidence.deviceSource === GROUND_SOURCE_DEVICE + '|' + GROUND_LIBRARY &&
    evidence.symbolSource === GROUND_SOURCE_SYMBOL + '|' + GROUND_LIBRARY &&
    device.name === 'Ground-GND' &&
    device.uuid === GROUND_SOURCE_DEVICE &&
    device.libraryUuid === GROUND_LIBRARY &&
    symbol.type === 18 &&
    symbol.uuid === GROUND_SOURCE_SYMBOL &&
    symbol.libraryUuid === GROUND_LIBRARY
  );
}

function hasGroundIdentity(snapshot: PrimitiveSnapshotResult, id: string): boolean {
  const property = record(snapshot.property);
  return (
    snapshot.schemaVersion === 'schematic-primitive-snapshot/v1' &&
    snapshot.primitiveId === id &&
    snapshot.primitiveKind === 'netflag' &&
    snapshot.componentType === 'netflag' &&
    property.identification === 'Ground' &&
    property.net === 'GND' &&
    hasGroundDevice(property.nativeSymbol) &&
    Number.isSafeInteger(property.x) &&
    Number.isSafeInteger(property.y) &&
    property.rotation === 0 &&
    property.mirror === false
  );
}

function hasGroundScope(
  snapshot: PrimitiveSnapshotResult,
  host: PrivateGroundHostAdapter,
): boolean {
  const scope = record(snapshot.nativeContext);
  return (
    scope.projectId === host.projectId &&
    scope.documentId === host.pageId &&
    scope.editorVersion === '4.1.105'
  );
}

function hasGroundWitness(snapshot: PrimitiveSnapshotResult, id: string): boolean {
  const witness = record(snapshot.nativeIsolation);
  return (
    witness.kind === 'verified-disconnected-ground/v2' &&
    witness.markerId === id &&
    witness.componentCount === 2 &&
    witness.wireCount === 0 &&
    witness.pagePinCount === 0 &&
    witness.embeddedPinCount === 1 &&
    Number.isSafeInteger(witness.attributeCount) &&
    Number(witness.attributeCount) >= 9 &&
    Number(witness.attributeCount) <= 256 &&
    typeof witness.attributeFingerprint === 'string' &&
    /^[0-9a-f]{64}$/.test(witness.attributeFingerprint)
  );
}

type Phase = 'unbound' | 'ready' | 'deleted' | 'restored' | 'poisoned';

/**
 * Internal bridge for a single host-owned, isolated file worker.
 * Construct ONLY after the launcher has isolated the native endpoint, display
 * and working copy from ordinary editor sessions. Session-list checks alone
 * are not an operating-system writer fence. Ordinary GUI/relay backends never
 * construct this class. No client-provided descriptor confers this capability.
 */
export class PrivateNativeGroundSession implements TransactionBridgeCaller {
  private phase: Phase = 'unbound';
  private before: PrimitiveSnapshotResult | undefined;
  private restoredId: string | undefined;
  private busy = false;

  constructor(private readonly host: PrivateGroundHostAdapter) {}

  get connected(): boolean {
    return this.phase !== 'poisoned';
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy || !this.connected) throw new Error('Private native session unavailable');
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }

  private async assertOwnedSession(): Promise<void> {
    const inventory = await this.host.listSessions();
    if (!Array.isArray(inventory)) throw new Error('Native session inventory unavailable');
    if (
      inventory.some((value) => {
        const row = record(value);
        return typeof row.sessionId !== 'string' || !('path' in row);
      })
    ) {
      throw new Error('Native session inventory malformed');
    }
    const projects = inventory.map(record).filter((row) => row.path !== null);
    const session = projects[0];
    if (
      projects.length !== 1 ||
      !session ||
      session.sessionId !== this.host.sessionId ||
      session.path !== this.host.path ||
      session.status !== 'alive' ||
      session.origin !== 'cli' ||
      session.headless !== true
    ) {
      this.phase = 'poisoned';
      throw new Error('Private native session ownership changed or is ambiguous');
    }
  }

  private async invokeOwned(method: string, params: RecordValue): Promise<unknown> {
    await this.assertOwnedSession();
    const result = await this.host.invoke(method, params);
    await this.assertOwnedSession();
    return result;
  }

  private assertGround(snapshot: PrimitiveSnapshotResult, id: string): void {
    if (
      !hasGroundIdentity(snapshot, id) ||
      !hasGroundScope(snapshot, this.host) ||
      !hasGroundWitness(snapshot, id)
    ) {
      throw new Error('Native Ground is not a verified reconstructable private-session marker');
    }
  }

  private async read(id: string): Promise<PrimitiveSnapshotResult> {
    if (id !== this.host.markerId && id !== this.restoredId) {
      throw new Error('Unbound private Ground primitive identity');
    }
    const snapshot = record(
      await this.invokeOwned('schematic.getPrimitiveSnapshot', {
        primitiveId: id,
        expectedPrimitiveKind: 'netflag',
      }),
    );
    this.assertGround(snapshot, id);
    return snapshot;
  }

  /**
   * An existing marker can be readable from the project while the actual
   * native creation device is unavailable to a fresh offline editor. Require
   * an independent native library lookup instead of reusing its descriptor.
   * This is necessary but not sufficient for successful recreation.
   */
  private async assertCreationDevice(): Promise<void> {
    const device = await this.invokeOwned('privateGround.getRecreationDevice', {});
    if (!hasGroundCreationDevice(device)) {
      throw new Error(
        'Verified native Ground creation device is unavailable in the private worker',
      );
    }
  }

  async preflight(projectId: string, primitiveId: string): Promise<PrimitiveSnapshotResult> {
    return this.exclusive(async () => {
      if (
        projectId !== this.host.projectId ||
        primitiveId !== this.host.markerId ||
        (this.phase !== 'unbound' && this.phase !== 'ready')
      )
        throw new Error('Private Ground preflight scope or phase mismatch');
      const current = await this.read(primitiveId);
      if (this.before && stableHash(current) !== stableHash(this.before)) {
        throw new Error('Private Ground snapshot changed after preflight');
      }
      await this.assertCreationDevice();
      this.before = structuredClone(current);
      this.phase = 'ready';
      return current;
    });
  }

  private async delete(params: RecordValue): Promise<unknown> {
    if (
      this.phase !== 'ready' ||
      !this.before ||
      !Array.isArray(params.primitiveIds) ||
      params.primitiveIds.length !== 1 ||
      params.primitiveIds[0] !== this.host.markerId
    )
      throw new Error('Private Ground delete lacks bound preflight');
    const fresh = await this.read(this.host.markerId);
    if (stableHash(fresh) !== stableHash(this.before)) {
      throw new Error('Private Ground snapshot changed before native mutation');
    }
    await this.assertCreationDevice();
    const before = this.before;
    // Once the native call is attempted, no automatic retry is safe.
    this.phase = 'poisoned';
    const result = record(
      await this.invokeOwned('privateGround.delete', {
        primitiveId: this.host.markerId,
        snapshot: before,
      }),
    );
    if (
      !Array.isArray(result.deleted) ||
      result.deleted.length !== 1 ||
      result.deleted[0] !== this.host.markerId ||
      !Array.isArray(result.notFound) ||
      result.notFound.length !== 0
    )
      throw new Error('Native Ground delete outcome unconfirmed; discard private copy');
    this.phase = 'deleted';
    return result;
  }

  private async recreate(params: RecordValue): Promise<unknown> {
    if (
      this.phase !== 'deleted' ||
      !this.before ||
      stableHash(params.snapshot) !== stableHash(this.before)
    ) {
      throw new Error('Private Ground recreation lacks matching delete evidence');
    }
    const before = this.before;
    this.phase = 'poisoned';
    const result = record(
      await this.invokeOwned('schematic.recreatePrimitiveSnapshot', {
        snapshot: before,
      }),
    );
    if (
      typeof result.primitiveId !== 'string' ||
      !result.primitiveId ||
      result.primitiveId === this.host.markerId
    ) {
      throw new Error('Native Ground recreation outcome unconfirmed');
    }
    this.restoredId = result.primitiveId;
    const snapshot = await this.read(this.restoredId);
    if (
      stableHash(snapshotForHash(snapshot, 'ignore-primitive-id')) !==
      stableHash(snapshotForHash(before, 'ignore-primitive-id'))
    ) {
      throw new Error('Native Ground rollback fingerprint changed; discard private copy');
    }
    this.phase = 'restored';
    return { primitiveId: this.restoredId, snapshot };
  }

  async call<TParams, TResult>(method: string, params?: TParams): Promise<TResult> {
    const input = record(params);
    return this.exclusive(async () => {
      switch (method) {
        case 'schematic.getPrimitiveSnapshot':
          return (await this.read(String(input.primitiveId ?? ''))) as TResult;
        case 'schematic.deletePrimitive':
          return (await this.delete(input)) as TResult;
        case 'schematic.recreatePrimitiveSnapshot':
          return (await this.recreate(input)) as TResult;
        default:
          throw new Error('Method unavailable in the private Ground worker');
      }
    });
  }
}
