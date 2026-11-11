import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Host-side native copper-zone serialization primitive; NOT a Bridge RPC or
 * public apply permission. Every MCP server/profile of the same OS user must
 * share this native home directory, never a browser-profile-specific HOME.
 *
 * A process crash deliberately leaves the directory reserved: unlike a bridge
 * listener, a possibly completed native PCB mutation cannot be reclaimed by
 * checking whether a PID still exists.
 */
const ZONE_LOCK_DIRECTORY = 'native-zone-writer-v1.lock';
const OWNER_FILE = 'owner.json';

interface NativeZoneLockOwner {
  schemaVersion: 1;
  token: string;
  pid: number;
  createdAt: string;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function isPrivateDirectory(path: string): boolean {
  try {
    const details = lstatSync(path);
    return details.isDirectory() && !details.isSymbolicLink();
  } catch {
    return false;
  }
}

function sameOwner(ownerFile: string, token: string): boolean {
  try {
    const details = lstatSync(ownerFile);
    if (!details.isFile() || details.isSymbolicLink()) return false;
    const parsed = JSON.parse(readFileSync(ownerFile, 'utf8')) as Partial<NativeZoneLockOwner>;
    return parsed.schemaVersion === 1 && parsed.token === token && parsed.pid === process.pid;
  } catch {
    return false;
  }
}

/** Only trusted host-native recovery code may supply the verification callback. */
export class NativeZoneHostLease {
  private held = true;

  constructor(
    private readonly directory: string,
    private readonly token: string,
  ) {}

  /**
   * Never automatically release on disconnect, thrown callback, timeout or
   * process death. A successful native recovery audit must independently
   * verify the persisted source/fill inventory and pending fence first.
   */
  async releaseAfterVerifiedRecovery(verify: () => Promise<boolean>): Promise<boolean> {
    if (!this.held) return false;
    let verified: boolean;
    try {
      verified = (await verify()) === true;
    } catch {
      return false;
    }
    if (!verified || !isPrivateDirectory(this.directory)) return false;

    const ownerFile = join(this.directory, OWNER_FILE);
    if (!sameOwner(ownerFile, this.token)) return false;
    try {
      unlinkSync(ownerFile);
      rmdirSync(this.directory);
      this.held = false;
      return true;
    } catch {
      // An unknown on-disk state must remain blocked until an independent
      // recovery audit. Never recursively delete a possibly replaced lock.
      return false;
    }
  }
}

export class NativeZoneHostWriterCoordinator {
  private readonly directory: string;

  constructor(dataDirectory = join(userInfo().homedir, '.easyeda-mcp-pro')) {
    this.directory = join(dataDirectory, ZONE_LOCK_DIRECTORY);
  }

  /**
   * Atomic mkdir is exclusive between local processes and browser profiles
   * using the same host account. EEXIST, including abandoned locks, blocks.
   * An interrupted initialization leaves a lock that must not be auto-cleared.
   */
  tryAcquire(): NativeZoneHostLease | null {
    const dataDirectory = dirname(this.directory);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    if (!isPrivateDirectory(dataDirectory)) {
      throw new Error('Native zone coordinator directory is not a regular directory.');
    }
    try {
      mkdirSync(this.directory, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return null;
      throw error;
    }

    const token = randomUUID();
    const owner: NativeZoneLockOwner = {
      schemaVersion: 1,
      token,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    // If metadata persistence fails, keep the directory as a hard blocker:
    // no attempt is allowed to infer that a native write did not occur.
    const fd = openSync(join(this.directory, OWNER_FILE), 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(owner));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return new NativeZoneHostLease(this.directory, token);
  }
}
