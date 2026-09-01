import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BridgeListenerOwnership,
  BridgeOwnershipConflictError,
} from '../../../src/bridge/listener-ownership.js';

const createdDirectories = new Set<string>();

function createDataDirectory(prefix = 'easyeda-listener-ownership-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  createdDirectories.add(directory);
  return directory;
}

function lockDirectory(dataDirectory: string): string {
  return join(dataDirectory, 'bridge-listener.lock');
}

function ownerFile(dataDirectory: string): string {
  return join(lockDirectory(dataDirectory), 'owner.json');
}

function backdate(path: string): void {
  const old = new Date(Date.now() - 10_000);
  utimesSync(path, old, old);
}

type OwnershipInternals = {
  ownerFile: string;
  tryAcquireFreshLock: () => boolean;
  readCurrentSnapshotForReclaim: () => unknown;
  isStillStale: (
    current: { owner?: { token: string; pid: number }; mtimeMs: number; safeToReclaim: boolean },
    expectedToken: string | undefined,
    expectedMtimeMs: number,
  ) => boolean;
  assertMovedOwnerUnchanged: (quarantine: string, expectedToken: string | undefined) => void;
};

function internals(ownership: BridgeListenerOwnership): OwnershipInternals {
  return ownership as unknown as OwnershipInternals;
}

afterEach(() => {
  for (const directory of createdDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  createdDirectories.clear();
});

describe('BridgeListenerOwnership', () => {
  it('treats update and release as no-ops before ownership is acquired', () => {
    const dataDirectory = createDataDirectory();
    const ownership = new BridgeListenerOwnership(dataDirectory, '127.0.0.1');

    expect(() => ownership.updatePort(49620)).not.toThrow();
    expect(() => ownership.release()).not.toThrow();
    expect(() => statSync(lockDirectory(dataDirectory))).toThrow();
  });

  it('fails closed when the ownership path is not a directory', () => {
    const dataDirectory = createDataDirectory();
    const lockPath = lockDirectory(dataDirectory);
    writeFileSync(lockPath, 'not-a-directory');
    const ownership = new BridgeListenerOwnership(dataDirectory, '127.0.0.1');

    expect(() => ownership.acquire()).toThrow(/no valid owner metadata/i);
    expect(readFileSync(lockPath, 'utf8')).toBe('not-a-directory');
  });

  it('fails closed when owner metadata is not a regular file', () => {
    const dataDirectory = createDataDirectory();
    mkdirSync(ownerFile(dataDirectory), { recursive: true });
    const ownership = new BridgeListenerOwnership(dataDirectory, '127.0.0.1');

    expect(() => ownership.acquire()).toThrow(/no valid owner metadata/i);
    expect(statSync(ownerFile(dataDirectory)).isDirectory()).toBe(true);
  });

  it('reclaims an old lock whose owner file disappeared during initialization', () => {
    const dataDirectory = createDataDirectory();
    const lockPath = lockDirectory(dataDirectory);
    mkdirSync(lockPath);
    backdate(lockPath);
    const ownership = new BridgeListenerOwnership(dataDirectory, '127.0.0.1');

    ownership.acquire();

    expect(JSON.parse(readFileSync(ownerFile(dataDirectory), 'utf8'))).toMatchObject({
      pid: process.pid,
      host: '127.0.0.1',
    });
    ownership.release();
  });

  it('reclaims old structurally invalid owner metadata only after the grace period', () => {
    const dataDirectory = createDataDirectory();
    const lockPath = lockDirectory(dataDirectory);
    mkdirSync(lockPath);
    writeFileSync(
      ownerFile(dataDirectory),
      JSON.stringify({
        schemaVersion: 1,
        token: 'invalid-owner',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        host: '127.0.0.1',
        port: 0,
      }),
    );
    backdate(lockPath);
    const ownership = new BridgeListenerOwnership(dataDirectory, '127.0.0.1');

    ownership.acquire();

    expect(JSON.parse(readFileSync(ownerFile(dataDirectory), 'utf8'))).toMatchObject({
      pid: process.pid,
    });
    ownership.release();
  });

  it('reports a live owner even when its port has not been recorded yet', () => {
    const dataDirectory = createDataDirectory();
    mkdirSync(lockDirectory(dataDirectory));
    writeFileSync(
      ownerFile(dataDirectory),
      JSON.stringify({
        schemaVersion: 1,
        token: 'live-owner-without-port',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        host: '127.0.0.1',
      }),
    );
    const ownership = new BridgeListenerOwnership(dataDirectory, '127.0.0.1');

    try {
      ownership.acquire();
      throw new Error('expected ownership conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeOwnershipConflictError);
      expect((error as BridgeOwnershipConflictError).conflict).toMatchObject({
        blockedByOtherInstance: true,
        ownerPid: process.pid,
        ownerPort: undefined,
      });
      expect((error as Error).message).not.toMatch(/, port \d+/i);
    }
  });

  it('propagates a non-EEXIST error while creating a fresh lock', () => {
    const root = createDataDirectory();
    const missingDataDirectory = join(root, 'missing-parent', 'data');
    const ownership = new BridgeListenerOwnership(missingDataDirectory, '127.0.0.1');

    expect(() => internals(ownership).tryAcquireFreshLock()).toThrow();
  });

  it('removes a newly-created lock if writing owner metadata fails', () => {
    const dataDirectory = createDataDirectory();
    const ownership = new BridgeListenerOwnership(dataDirectory, '127.0.0.1');
    const internal = internals(ownership);
    internal.ownerFile = dataDirectory;

    expect(() => internal.tryAcquireFreshLock()).toThrow();
    expect(() => statSync(lockDirectory(dataDirectory))).toThrow();
  });

  it('returns no reclaim snapshot after another process already removed the lock', () => {
    const dataDirectory = createDataDirectory();
    const ownership = new BridgeListenerOwnership(dataDirectory, '127.0.0.1');

    expect(internals(ownership).readCurrentSnapshotForReclaim()).toBeUndefined();
  });

  it('rejects a stale snapshot when the lock mtime changed before reclaim', () => {
    const dataDirectory = createDataDirectory();
    const ownership = new BridgeListenerOwnership(dataDirectory, '127.0.0.1');

    expect(
      internals(ownership).isStillStale(
        { owner: undefined, mtimeMs: 20, safeToReclaim: true },
        undefined,
        10,
      ),
    ).toBe(false);
  });

  it('returns safely when quarantined owner metadata disappeared', () => {
    const dataDirectory = createDataDirectory();
    const ownership = new BridgeListenerOwnership(dataDirectory, '127.0.0.1');
    const quarantine = join(dataDirectory, 'quarantine-without-owner');
    mkdirSync(quarantine);

    expect(() =>
      internals(ownership).assertMovedOwnerUnchanged(quarantine, 'expected'),
    ).not.toThrow();
    expect(statSync(quarantine).isDirectory()).toBe(true);
  });

  it('restores quarantine before failing when ownership changes during stale reclaim', () => {
    const dataDirectory = createDataDirectory();
    const ownership = new BridgeListenerOwnership(dataDirectory, '127.0.0.1');
    const quarantine = join(dataDirectory, 'bridge-listener.lock.stale-test');
    mkdirSync(quarantine);
    writeFileSync(
      join(quarantine, 'owner.json'),
      JSON.stringify({
        schemaVersion: 1,
        token: 'replacement-owner',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        host: '127.0.0.1',
        port: 49620,
      }),
    );

    expect(() =>
      internals(ownership).assertMovedOwnerUnchanged(quarantine, 'expected-owner'),
    ).toThrow(/ownership changed/i);
    expect(JSON.parse(readFileSync(ownerFile(dataDirectory), 'utf8'))).toMatchObject({
      token: 'replacement-owner',
    });
    expect(() => statSync(quarantine)).toThrow();
  });
});
