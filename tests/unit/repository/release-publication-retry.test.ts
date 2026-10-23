import { describe, expect, it, vi } from 'vitest';
import {
  decideReleaseCreation,
  decodeNpmView,
  waitForNpmVisibility,
} from '../../../scripts/release-publication-retry.mjs';

const sha = '133c3fa274da3bb4b5b8ba7ea6ca4c341c7d4d9b';
const tag = 'easyeda-mcp-pro-v1.5.1';
const existingRelease = {
  tagName: tag,
  targetCommitish: sha,
  isDraft: false,
  isPrerelease: false,
};

describe('immutable release creation recovery', () => {
  it('creates a first release only when there is no tag or release', () => {
    expect(decideReleaseCreation({ tag, targetSha: sha, channel: 'stable' })).toBe('create');
  });

  it('does not create an already-published matching release on a failed-job rerun', () => {
    expect(
      decideReleaseCreation({
        tag,
        targetSha: sha,
        channel: 'stable',
        existingTagSha: sha,
        existingRelease,
      }),
    ).toBe('reuse');
  });

  it('can create a missing release only when an existing tag points to the same SHA', () => {
    expect(
      decideReleaseCreation({ tag, targetSha: sha, existingTagSha: sha, channel: 'stable' }),
    ).toBe('create');
  });

  it('fails closed on an existing tag pointing at different source', () => {
    expect(() =>
      decideReleaseCreation({
        tag,
        targetSha: sha,
        channel: 'stable',
        existingTagSha: 'a'.repeat(40),
        existingRelease,
      }),
    ).toThrow('different source commit');
  });

  it('fails closed on unexpected release identity and classifications', () => {
    const base = { tag, targetSha: sha, channel: 'stable', existingTagSha: sha };
    expect(() =>
      decideReleaseCreation({
        ...base,
        existingRelease: { ...existingRelease, targetCommitish: 'b'.repeat(40) },
      }),
    ).toThrow('identity or classification');
    expect(() =>
      decideReleaseCreation({ ...base, existingRelease: { ...existingRelease, isDraft: true } }),
    ).toThrow('identity or classification');
    expect(() =>
      decideReleaseCreation({
        ...base,
        existingRelease: { ...existingRelease, isPrerelease: true },
      }),
    ).toThrow('identity or classification');
    expect(() => decideReleaseCreation({ ...base, existingTagSha: null, existingRelease })).toThrow(
      'no verified tag',
    );
  });
});

describe('bounded npm registry visibility', () => {
  it('accepts scalar and one-entry npm workspace JSON results', () => {
    expect(decodeNpmView('"1.5.1"')).toBe('1.5.1');
    expect(decodeNpmView('["1.5.1"]')).toBe('1.5.1');
    expect(decodeNpmView('')).toBeNull();
    expect(decodeNpmView('   ')).toBeNull();
    expect(() => decodeNpmView('unexpected malformed JSON')).toThrow();
  });

  it('waits for a delayed npm index and stops when visible', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const delay = vi.fn().mockResolvedValue(undefined);
    await expect(
      waitForNpmVisibility({ probe, delay, attempts: 4, intervalMs: 250 }),
    ).resolves.toBe(3);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(250);
  });

  it('fails after a bounded number of permanent 404 probes', async () => {
    const probe = vi.fn().mockResolvedValue(false);
    const delay = vi.fn().mockResolvedValue(undefined);
    await expect(waitForNpmVisibility({ probe, delay, attempts: 3 })).rejects.toThrow(
      '3 bounded attempts',
    );
    expect(probe).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it('does not retry unexpected lookup failures as transient 404', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('npm network authentication error'));
    const delay = vi.fn();
    await expect(waitForNpmVisibility({ probe, delay })).rejects.toThrow('authentication error');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });
});
