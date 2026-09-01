import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const LOCK_SCHEMA_VERSION = 1;
const LOCK_DIRECTORY_NAME = 'bridge-listener.lock';
const OWNER_FILE_NAME = 'owner.json';
const INITIALIZATION_GRACE_MS = 5_000;
const MAX_ACQUIRE_ATTEMPTS = 4;

interface BridgeListenerOwnerRecord {
  schemaVersion: 1;
  token: string;
  pid: number;
  startedAt: string;
  host: string;
  port?: number;
}

export interface BridgeOwnershipConflict {
  blockedByOtherInstance: true;
  ownerPid: number;
  ownerPort?: number;
  ownerHost?: string;
  message: string;
}

export class BridgeOwnershipConflictError extends Error {
  constructor(public readonly conflict: BridgeOwnershipConflict) {
    super(conflict.message);
    this.name = 'BridgeOwnershipConflictError';
  }
}

interface LockSnapshot {
  owner?: BridgeListenerOwnerRecord;
  mtimeMs: number;
  safeToReclaim: boolean;
}

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === 'EPERM';
  }
}

function isValidPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535;
}

function parseOwnerRecord(raw: string): BridgeListenerOwnerRecord | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.schemaVersion !== LOCK_SCHEMA_VERSION ||
      typeof value.token !== 'string' ||
      value.token.length === 0 ||
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      typeof value.startedAt !== 'string' ||
      typeof value.host !== 'string' ||
      (value.port !== undefined && !isValidPort(value.port))
    ) {
      return undefined;
    }

    return {
      schemaVersion: LOCK_SCHEMA_VERSION,
      token: value.token,
      pid: Number(value.pid),
      startedAt: value.startedAt,
      host: value.host,
      port: value.port === undefined ? undefined : Number(value.port),
    };
  } catch {
    return undefined;
  }
}

export class BridgeListenerOwnership {
  private readonly token = randomUUID();
  private readonly lockDirectory: string;
  private readonly ownerFile: string;
  private readonly startedAt = new Date().toISOString();
  private held = false;
  private port: number | undefined;

  constructor(
    private readonly dataDirectory: string,
    private readonly host: string,
  ) {
    this.lockDirectory = join(dataDirectory, LOCK_DIRECTORY_NAME);
    this.ownerFile = join(this.lockDirectory, OWNER_FILE_NAME);
  }

  acquire(): void {
    mkdirSync(this.dataDirectory, { recursive: true, mode: 0o700 });

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      try {
        mkdirSync(this.lockDirectory, { mode: 0o700 });
        this.held = true;
        try {
          this.writeOwnerRecord();
        } catch (error) {
          this.held = false;
          rmSync(this.lockDirectory, { recursive: true, force: true });
          throw error;
        }
        return;
      } catch (error) {
        if (errnoCode(error) !== 'EEXIST') throw error;
      }

      const snapshot = this.readLockSnapshot();
      if (snapshot.owner && isProcessAlive(snapshot.owner.pid)) {
        throw new BridgeOwnershipConflictError(this.buildConflict(snapshot.owner));
      }

      const staleOwnerToken = snapshot.owner?.token;
      const oldEnough = Date.now() - snapshot.mtimeMs >= INITIALIZATION_GRACE_MS;
      if (!snapshot.owner && (!snapshot.safeToReclaim || !oldEnough)) {
        throw new Error(
          `Local EasyEDA bridge ownership lock at "${this.lockDirectory}" is present but has no valid owner metadata. ` +
            'Retry shortly; if it persists, remove the stale bridge-listener.lock directory after confirming no easyeda-mcp-pro process is running.',
        );
      }

      if (!this.reclaimStaleLock(staleOwnerToken, snapshot.mtimeMs)) continue;
    }

    throw new Error('Unable to acquire local EasyEDA bridge listener ownership after retries.');
  }

  updatePort(port: number): void {
    if (!this.held) return;
    this.port = port;
    this.writeOwnerRecord();
  }

  release(): void {
    if (!this.held) return;

    let snapshot: LockSnapshot;
    try {
      snapshot = this.readLockSnapshot();
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') {
        this.held = false;
        return;
      }
      throw error;
    }
    if (snapshot.owner?.token !== this.token) {
      this.held = false;
      return;
    }

    rmSync(this.lockDirectory, { recursive: true, force: true });
    this.held = false;
  }

  private writeOwnerRecord(): void {
    const record: BridgeListenerOwnerRecord = {
      schemaVersion: LOCK_SCHEMA_VERSION,
      token: this.token,
      pid: process.pid,
      startedAt: this.startedAt,
      host: this.host,
      port: this.port,
    };
    const temporaryFile = join(this.lockDirectory, `.owner-${this.token}.tmp`);
    writeFileSync(temporaryFile, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'w',
    });
    renameSync(temporaryFile, this.ownerFile);
  }

  private readLockSnapshot(): LockSnapshot {
    const lockStat = lstatSync(this.lockDirectory);
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
      return { mtimeMs: lockStat.mtimeMs, safeToReclaim: false };
    }

    try {
      const ownerStat = lstatSync(this.ownerFile);
      if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) {
        return { mtimeMs: lockStat.mtimeMs, safeToReclaim: false };
      }
      return {
        owner: parseOwnerRecord(readFileSync(this.ownerFile, 'utf8')),
        mtimeMs: lockStat.mtimeMs,
        safeToReclaim: true,
      };
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') {
        return { mtimeMs: lockStat.mtimeMs, safeToReclaim: true };
      }
      throw error;
    }
  }

  private reclaimStaleLock(expectedToken: string | undefined, expectedMtimeMs: number): boolean {
    const current = this.readCurrentSnapshotForReclaim();
    if (!current || !this.isStillStale(current, expectedToken, expectedMtimeMs)) return false;

    const quarantine = `${this.lockDirectory}.stale-${process.pid}-${randomUUID()}`;
    try {
      renameSync(this.lockDirectory, quarantine);
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return false;
      throw error;
    }

    this.assertMovedOwnerUnchanged(quarantine, expectedToken);
    rmSync(quarantine, { recursive: true, force: true });
    return true;
  }

  private readCurrentSnapshotForReclaim(): LockSnapshot | undefined {
    try {
      return this.readLockSnapshot();
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  }

  private isStillStale(
    current: LockSnapshot,
    expectedToken: string | undefined,
    expectedMtimeMs: number,
  ): boolean {
    if (current.mtimeMs !== expectedMtimeMs) return false;
    if (expectedToken === undefined) return current.owner === undefined && current.safeToReclaim;
    return current.owner?.token === expectedToken && !isProcessAlive(current.owner.pid);
  }

  private assertMovedOwnerUnchanged(quarantine: string, expectedToken: string | undefined): void {
    if (expectedToken === undefined) return;

    let movedOwner: BridgeListenerOwnerRecord | undefined;
    try {
      movedOwner = parseOwnerRecord(readFileSync(join(quarantine, OWNER_FILE_NAME), 'utf8'));
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return;
      throw error;
    }
    if (movedOwner?.token === expectedToken) return;

    this.restoreQuarantine(quarantine);
    throw new Error('Bridge ownership changed while reclaiming a stale listener lock.');
  }

  private restoreQuarantine(quarantine: string): void {
    try {
      statSync(this.lockDirectory);
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') {
        renameSync(quarantine, this.lockDirectory);
        return;
      }
      throw error;
    }
  }

  private buildConflict(owner: BridgeListenerOwnerRecord): BridgeOwnershipConflict {
    const portText = owner.port === undefined ? '' : `, port ${owner.port}`;
    return {
      blockedByOtherInstance: true,
      ownerPid: owner.pid,
      ownerPort: owner.port,
      ownerHost: owner.host,
      message:
        `Local EasyEDA bridge listener is owned by another easyeda-mcp-pro process (PID ${owner.pid}${portText}). ` +
        `Close the other MCP client or terminate PID ${owner.pid}, then restart this MCP client.`,
    };
  }
}
