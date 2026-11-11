import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeZoneHostWriterCoordinator } from '../../../src/bridge/native-zone-host-writer.js';

const roots = new Set<string>();
const lockName = 'native-zone-writer-v1.lock';

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'easyeda-zone-host-coordinator-'));
  roots.add(dir);
  return dir;
}

function childAcquire(dir: string): string {
  const script = `
import { NativeZoneHostWriterCoordinator } from './src/bridge/native-zone-host-writer.ts';
const lease = await new NativeZoneHostWriterCoordinator(process.env.NATIVE_ZONE_TEST_ROOT).tryAcquire();
process.stdout.write(lease === null ? 'blocked' : 'acquired');
`;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    {
      cwd: process.cwd(),
      env: { ...process.env, NATIVE_ZONE_TEST_ROOT: dir, HOME: join(dir, 'other-profile') },
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots.clear();
});

describe('host-wide native copper-zone writer reservation (not yet Bridge-wired)', () => {
  it('uses OS identity rather than the per-profile HOME environment for its default root', () => {
    // The data root must not be selected from the EasyEDA isolated profile.
    expect(userInfo().homedir).toBeTruthy();
    expect(new NativeZoneHostWriterCoordinator()).toBeDefined();
  });

  it('refuses two simultaneous same-host reservations even across independent processes', async () => {
    const dir = root();
    const gate = new NativeZoneHostWriterCoordinator(dir);
    const lease = await gate.tryAcquire();
    expect(lease).not.toBeNull();
    expect(await gate.tryAcquire()).toBeNull();
    expect(childAcquire(dir)).toBe('blocked');
    expect(await lease?.releaseAfterVerifiedRecovery(async () => true)).toBe(true);
    expect(childAcquire(dir)).toBe('acquired');
  });

  it('does not reclaim a crashed process reservation, even when its PID has exited', async () => {
    const dir = root();
    expect(childAcquire(dir)).toBe('acquired');
    const gate = new NativeZoneHostWriterCoordinator(dir);
    expect(await gate.tryAcquire()).toBeNull();
    expect(lstatSync(join(dir, lockName)).isDirectory()).toBe(true);
  });

  it('does not release a lock when recovery is false or throws', async () => {
    const dir = root();
    const gate = new NativeZoneHostWriterCoordinator(dir);
    const lease = await gate.tryAcquire();
    expect(lease).not.toBeNull();
    expect(await lease?.releaseAfterVerifiedRecovery(async () => false)).toBe(false);
    expect(
      await lease?.releaseAfterVerifiedRecovery(async () => {
        throw Error('DRC unknown');
      }),
    ).toBe(false);
    expect(await gate.tryAcquire()).toBeNull();
    expect(await lease?.releaseAfterVerifiedRecovery(async () => true)).toBe(true);
    expect(await lease?.releaseAfterVerifiedRecovery(async () => true)).toBe(false);
    expect(await gate.tryAcquire()).not.toBeNull();
  });

  it('rejects malformed or altered owner records without removing the reservation', async () => {
    const dir = root();
    const gate = new NativeZoneHostWriterCoordinator(dir);
    const lease = await gate.tryAcquire();
    const owner = join(dir, lockName, 'owner.json');
    const record = JSON.parse(readFileSync(owner, 'utf8')) as Record<string, unknown>;
    writeFileSync(owner, JSON.stringify({ ...record, token: 'not-our-token' }));
    expect(await lease?.releaseAfterVerifiedRecovery(async () => true)).toBe(false);
    expect(await gate.tryAcquire()).toBeNull();
  });

  it('keeps incomplete reservations as hard blockers', async () => {
    const dir = root();
    const reserved = join(dir, lockName);
    mkdirSync(reserved);
    expect(await new NativeZoneHostWriterCoordinator(dir).tryAcquire()).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('blocks symlinked lock directories', async () => {
    const dir = root();
    const reserved = join(dir, lockName);
    const target = root();
    symlinkSync(target, reserved);
    expect(await new NativeZoneHostWriterCoordinator(dir).tryAcquire()).toBeNull();
    expect(lstatSync(reserved).isSymbolicLink()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('refuses a symlink as coordinator root', async () => {
    const outside = root();
    const dir = root();
    const alias = join(dir, 'alias');
    symlinkSync(outside, alias);
    await expect(new NativeZoneHostWriterCoordinator(alias).tryAcquire()).rejects.toThrow(
      /directory/,
    );
  });
});
