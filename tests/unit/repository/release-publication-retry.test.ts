import { describe, expect, it, vi } from 'vitest';
import {
  decideReleaseCreation,
  decodeNpmView,
  waitForNpmVisibility,
  waitForPublishedNpm,
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

describe('complete npm publication visibility', () => {
  it('keeps polling beyond the former 20-attempt cutoff', async () => {
    let count = 0;
    const delay = vi.fn().mockResolvedValue(undefined);
    await expect(waitForNpmVisibility({ probe: () => ++count === 21, delay })).resolves.toBe(21);
    expect(delay).toHaveBeenCalledTimes(20);
    expect(delay).toHaveBeenCalledWith(30000);
  });
  const manifest = { name: 'easyeda-mcp-pro', version: '1.18.2' };
  const env = { NPM_DIST_TAG: 'latest', RELEASE_COMMIT_SHA: sha };
  const tarball = 'https://registry.npmjs.org/easyeda-mcp-pro/-/easyeda-mcp-pro-1.18.2.tgz';
  const metadata = {
    version: manifest.version,
    gitHead: sha,
    'dist.tarball': tarball,
    'dist.integrity': 'sha512-' + 'A'.repeat(86) + '==',
  };
  const ok = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const missing = { status: 1, stdout: '', stderr: 'npm error code E404' };
  function fixture() {
    const runNpm = vi.fn((args: string[]) =>
      args.includes('dist-tags.latest') ? ok(manifest.version) : ok(metadata),
    );
    const headTarball = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    return {
      manifest,
      runNpm,
      headTarball,
      delay: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
    };
  }

  it('covers the measured propagation delay within a single finite budget', async () => {
    const f = fixture();
    let probes = 0;
    f.runNpm.mockImplementation((args) => {
      if (args.includes('dist-tags.latest')) return ok(probes < 19 ? '1.18.1' : '1.18.2');
      probes++;
      return probes < 16 ? missing : ok(metadata);
    });
    f.headTarball.mockResolvedValueOnce(
      new Response(null, {
        status: 404,
        headers: { age: '159', 'cache-control': 'public, max-age=300' },
      }),
    );
    await expect(waitForPublishedNpm(env, f)).resolves.toBe(20);
    expect(f.delay).toHaveBeenCalledTimes(19);
    expect(f.delay).toHaveBeenCalledWith(30000);
    expect(f.headTarball.mock.calls).toEqual([[tarball], [tarball]]);
    expect(f.runNpm.mock.calls.every(([args]) => args.includes('--prefer-online'))).toBe(true);
    expect(f.log.mock.calls.flat().join(' ')).toContain('tarball');
  });

  it('never treats a cached negative response as a visible tarball', async () => {
    const f = fixture();
    f.headTarball.mockResolvedValue(
      new Response(null, {
        status: 404,
        headers: { age: '159', 'cache-control': 'public, max-age=300' },
      }),
    );
    await expect(waitForPublishedNpm(env, { ...f, attempts: 3 })).rejects.toThrow(
      /tarball.*3 bounded attempts/i,
    );
    expect(f.headTarball.mock.calls).toEqual([[tarball], [tarball], [tarball]]);
    expect(f.delay).toHaveBeenCalledTimes(2);
  });

  it('stops within the same budget even when the pending stage changes', async () => {
    const f = fixture();
    f.runNpm
      .mockReturnValueOnce(missing)
      .mockReturnValueOnce(ok(metadata))
      .mockReturnValueOnce(ok('1.18.1'));
    f.headTarball.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(waitForPublishedNpm(env, { ...f, attempts: 3 })).rejects.toThrow(
      /tarball.*3 bounded attempts/i,
    );
    expect(f.delay).toHaveBeenCalledTimes(2);
    expect(f.headTarball).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...metadata, version: '1.18.1' },
    { ...metadata, gitHead: 'a'.repeat(40) },
    { ...metadata, 'dist.tarball': 'https://untrusted.example/package.tgz' },
    { ...metadata, 'dist.integrity': 'invalid' },
  ])('fails immediately on inconsistent version, source, tarball or integrity', async (invalid) => {
    const f = fixture();
    f.runNpm.mockReturnValue(ok(invalid));
    await expect(waitForPublishedNpm(env, f)).rejects.toThrow(/identity/i);
    expect(f.delay).not.toHaveBeenCalled();
    expect(f.headTarball).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500, 302])(
    'does not retry unexpected tarball status %s',
    async (status) => {
      const f = fixture();
      f.headTarball.mockResolvedValue(new Response(null, { status }));
      await expect(waitForPublishedNpm(env, f)).rejects.toThrow(String(status));
      expect(f.delay).not.toHaveBeenCalled();
    },
  );

  it('propagates an npm authentication error instead of treating it as index delay', async () => {
    const f = fixture();
    f.runNpm.mockReturnValue({ status: 1, stdout: '', stderr: 'npm error code E401' });
    await expect(waitForPublishedNpm(env, f)).rejects.toThrow(/E401/);
    expect(f.delay).not.toHaveBeenCalled();
  });

  it('fails closed on empty successful metadata instead of retrying it', async () => {
    const f = fixture();
    f.runNpm.mockReturnValue(ok(null));
    await expect(waitForPublishedNpm(env, f)).rejects.toThrow('Invalid npm metadata');
    expect(f.delay).not.toHaveBeenCalled();
  });

  it('does not retry dist-tag lookup errors', async () => {
    const f = fixture();
    f.runNpm.mockReturnValueOnce(ok(metadata)).mockReturnValueOnce(missing);
    await expect(waitForPublishedNpm(env, f)).rejects.toThrow('E404');
    expect(f.delay).not.toHaveBeenCalled();
    expect(f.headTarball).not.toHaveBeenCalled();
  });

  it('fails closed for an inconsistent channel before contacting npm', async () => {
    const f = fixture();
    await expect(waitForPublishedNpm({ ...env, NPM_DIST_TAG: 'next' }, f)).rejects.toThrow(
      'Invalid npm publication identity',
    );
    expect(f.runNpm).not.toHaveBeenCalled();
  });

  it('checks the canonical prerelease URL and next tag without changing latest', async () => {
    const f = fixture();
    const version = '1.18.2-rc.1';
    const rcTarball = tarball.replace('1.18.2.tgz', version + '.tgz');
    f.runNpm.mockImplementation((args) =>
      args.includes('dist-tags.next')
        ? ok(version)
        : ok({ ...metadata, version, 'dist.tarball': rcTarball }),
    );
    await expect(
      waitForPublishedNpm(
        { ...env, NPM_DIST_TAG: 'next' },
        { ...f, manifest: { ...manifest, version } },
      ),
    ).resolves.toBe(1);
    expect(f.headTarball).toHaveBeenCalledExactlyOnceWith(rcTarball);
    expect(f.runNpm.mock.calls.every(([args]) => !args.includes('dist-tags.latest'))).toBe(true);
  });

  it('uses a bounded credential-free canonical HEAD with no redirects or cache-busting', async () => {
    const f = fixture();
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(waitForPublishedNpm(env, { ...f, headTarball: undefined })).resolves.toBe(1);
      expect(fetch).toHaveBeenCalledExactlyOnceWith(
        tarball,
        expect.objectContaining({
          method: 'HEAD',
          redirect: 'manual',
          credentials: 'omit',
          headers: { 'Cache-Control': 'no-cache' },
          signal: expect.any(AbortSignal),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns immediately for an already visible matching package', async () => {
    const f = fixture();
    await expect(waitForPublishedNpm(env, f)).resolves.toBe(1);
    expect(f.delay).not.toHaveBeenCalled();
    expect(f.headTarball).toHaveBeenCalledExactlyOnceWith(tarball);
  });
});
