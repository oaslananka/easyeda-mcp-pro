import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rmdir, unlink } from 'node:fs/promises';
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

/** Non-authorizing local OS-account lock observation; no owner details leak. */
export type NativeZoneHostReservationState = 'unreserved' | 'reserved' | 'unknown';

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

function isPrivateDirectory(path: string): Promise<boolean> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path is generated from the private fixed OS-account reservation root, not a user/MCP request.
  return lstat(path)
    .then((details) => details.isDirectory() && !details.isSymbolicLink())
    .catch(() => false);
}

function sameOwner(ownerFile: string, token: string): Promise<boolean> {
  // This is deliberately a fully rejection-handled chain: unreadable metadata,
  // malformed JSON, missing owner or a symlink must all retain the write lock.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed owner.json path in private server-owned lock directory.
  return lstat(ownerFile)
    .then((details) => {
      if (!details.isFile() || details.isSymbolicLink()) return false;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Owner metadata path was checked against symlinks.
      return readFile(ownerFile, 'utf8').then((raw) => {
        const parsed = JSON.parse(raw) as Partial<NativeZoneLockOwner>;
        return parsed.schemaVersion === 1 && parsed.token === token && parsed.pid === process.pid;
      });
    })
    .catch(() => false);
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
    if (!verified || !(await isPrivateDirectory(this.directory))) return false;

    const ownerFile = join(this.directory, OWNER_FILE);
    if (!(await sameOwner(ownerFile, this.token))) return false;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Verified owner token and private lock path; no untrusted pathname.
      await unlink(ownerFile);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only the fixed empty native writer lock directory is removed after verified recovery.
      await rmdir(this.directory);
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
   * Read-only host reservation status. A crashed process and a live process
   * are intentionally indistinguishable: neither may be auto-reclaimed.
   * Malformed paths, symlinks, or access failures remain unknown, not free.
   */
  async inspectState(): Promise<NativeZoneHostReservationState> {
    const parent = dirname(this.directory);
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed OS-account coordinator root; never an MCP path.
      const base = await lstat(parent);
      if (!base.isDirectory() || base.isSymbolicLink()) return 'unknown';
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? 'unreserved' : 'unknown';
    }
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed native zone lock path below verified host coordinator root.
      const state = await lstat(this.directory);
      return state.isDirectory() && !state.isSymbolicLink() ? 'reserved' : 'unknown';
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? 'unreserved' : 'unknown';
    }
  }

  /**
   * Atomic mkdir is exclusive between local processes and browser profiles
   * using the same host account. EEXIST, including abandoned locks, blocks.
   * An interrupted initialization leaves a lock that must not be auto-cleared.
   */
  async tryAcquire(): Promise<NativeZoneHostLease | null> {
    const dataDirectory = dirname(this.directory);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- OS userInfo().homedir or trusted test-injected root, never supplied by a client.
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    if (!(await isPrivateDirectory(dataDirectory))) {
      throw new Error('Native zone coordinator directory is not a regular directory.');
    }
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Atomic fixed-name lock below private OS-user directory, no remote input.
      await mkdir(this.directory, { mode: 0o700 });
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed owner.json under an exclusive, fresh 0700 lock directory.
    const handle = await open(join(this.directory, OWNER_FILE), 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(owner));
      await handle.sync();
    } finally {
      await handle.close();
    }
    return new NativeZoneHostLease(this.directory, token);
  }
}
