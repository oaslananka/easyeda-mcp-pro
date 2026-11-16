import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { HostedDeviceResumeStore } from '../../../src/cloud/device-resume.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function openStore(now: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'easyeda-device-resume-'));
  tempDirs.push(dir);
  const path = join(dir, 'hosted.sqlite');
  const db = new DatabaseSync(path);
  return { db, path, store: new HostedDeviceResumeStore(db, now) };
}

describe('HostedDeviceResumeStore', () => {
  it('rotates single-use credentials across database reopen without revealing secrets in the owner UI', () => {
    const clock = { value: Date.parse('2026-11-16T09:00:00.000Z') };
    const one = openStore(() => clock.value);
    const token = one.store.issue('owner-one', 'sess_original', '1.15.6');
    expect(token).toMatch(/^ers_[a-f0-9]{64}$/);
    expect(JSON.stringify(one.store.list('owner-one'))).not.toContain(token);
    one.db.close();

    const reopenedDb = new DatabaseSync(one.path);
    const two = new HostedDeviceResumeStore(reopenedDb, () => clock.value);
    expect(two.list('owner-one')).toMatchObject([{ sessionId: 'sess_original', connected: false }]);
    expect(two.list('other-owner')).toEqual([]);
    expect(two.revoke('other-owner', 'sess_original')).toBe(false);

    const renewed = two.redeem(token, 'sess_after_restart', '1.15.6');
    expect(renewed?.userId).toBe('owner-one');
    expect(renewed?.credential).toMatch(/^ers_[a-f0-9]{64}$/);
    expect(renewed?.credential).not.toBe(token);
    expect(two.redeem(token, 'sess_replay', '1.15.6')).toBeUndefined();
    expect(two.list('owner-one')).toMatchObject([{ sessionId: 'sess_after_restart' }]);

    expect(two.revoke('owner-one', 'sess_after_restart')).toBe(true);
    expect(two.list('owner-one')).toEqual([]);
    expect(two.redeem(renewed!.credential, 'sess_after_revocation', '1.15.6')).toBeUndefined();
    reopenedDb.close();
  });

  it('allows revocation of an offline device before it reconnects after restart', () => {
    const clock = { value: Date.parse('2026-11-16T09:00:00.000Z') };
    const initial = openStore(() => clock.value);
    const credential = initial.store.issue('owner-a', 'sess_old', '1.15.6');
    initial.db.close();
    const reopenedDb = new DatabaseSync(initial.path);
    const reopened = new HostedDeviceResumeStore(reopenedDb, () => clock.value);
    expect(reopened.list('owner-a')).toHaveLength(1);
    expect(reopened.revoke('owner-b', 'sess_old')).toBe(false);
    expect(reopened.revoke('owner-a', 'sess_old')).toBe(true);
    expect(reopened.redeem(credential, 'sess_replay', '1.15.6')).toBeUndefined();
    expect(reopened.list('owner-a')).toEqual([]);
    reopenedDb.close();
  });

  it('expires the association and rejects malformed credentials', () => {
    const clock = { value: Date.parse('2026-11-16T09:00:00.000Z') };
    const { db, store } = openStore(() => clock.value);
    const token = store.issue('owner-one', 'sess_one', '1.15.6');
    expect(store.redeem('ers_insecure', 'sess_invalid', '1.15.6')).toBeUndefined();
    clock.value += 24 * 60 * 60 * 1000 + 1;
    expect(store.redeem(token, 'sess_expired', '1.15.6')).toBeUndefined();
    expect(store.list('owner-one')).toEqual([]);
    db.close();
  });
});
