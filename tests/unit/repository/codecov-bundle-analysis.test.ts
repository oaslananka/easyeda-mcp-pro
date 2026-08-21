import { describe, expect, it, vi } from 'vitest';

import {
  readBundleUploadMetadata,
  runBundleAnalysis,
} from '../../../scripts/upload-codecov-bundle-analysis.mjs';

const baseEnv = (): NodeJS.ProcessEnv => ({
  CODECOV_TOKEN: 'test-token',
  CODECOV_BUNDLE_SLUG: 'oaslananka/easyeda-mcp-pro',
  CODECOV_BUNDLE_SHA: 'a'.repeat(40),
  CODECOV_BUNDLE_BRANCH: 'fix/534-codecov-bundle-gha-workaround',
  CODECOV_BUNDLE_PR: '535',
  GITHUB_ACTIONS: 'true',
});

describe('Codecov bundle analysis upload wrapper', () => {
  it('validates and normalizes trusted GitHub metadata', () => {
    expect(readBundleUploadMetadata(baseEnv())).toEqual({
      token: 'test-token',
      slug: 'oaslananka/easyeda-mcp-pro',
      sha: 'a'.repeat(40),
      branch: 'fix/534-codecov-bundle-gha-workaround',
      pr: '535',
    });

    const env = baseEnv();
    delete env.CODECOV_BUNDLE_PR;
    expect(readBundleUploadMetadata(env).pr).toBeUndefined();
  });

  it.each([
    ['missing token', { CODECOV_TOKEN: '' }],
    ['invalid slug', { CODECOV_BUNDLE_SLUG: 'easyeda-mcp-pro' }],
    ['invalid sha', { CODECOV_BUNDLE_SHA: 'abc123' }],
    ['missing branch', { CODECOV_BUNDLE_BRANCH: '' }],
    ['invalid pr', { CODECOV_BUNDLE_PR: '0' }],
    ['non-numeric pr', { CODECOV_BUNDLE_PR: 'pull-535' }],
  ])('rejects %s before invoking Codecov', (_name, override) => {
    expect(() => readBundleUploadMetadata({ ...baseEnv(), ...override })).toThrow();
  });

  it('uses the local provider path while preserving exact upload metadata', async () => {
    const env = baseEnv();
    const seenDuringUpload: Array<string | undefined> = [];
    const uploader = vi.fn(async (..._args: unknown[]) => {
      seenDuringUpload.push(env.GITHUB_ACTIONS);
      return '{}';
    });

    await runBundleAnalysis({ env, uploader });

    expect(seenDuringUpload).toEqual([undefined]);
    expect(env.GITHUB_ACTIONS).toBe('true');
    expect(uploader).toHaveBeenCalledTimes(1);
    expect(uploader).toHaveBeenCalledWith(
      ['easyeda-bridge-extension/dist'],
      expect.objectContaining({
        uploadToken: 'test-token',
        bundleName: 'easyeda-bridge-extension',
        enableBundleAnalysis: true,
        uploadOverrides: {
          slug: 'oaslananka/easyeda-mcp-pro',
          sha: 'a'.repeat(40),
          branch: 'fix/534-codecov-bundle-gha-workaround',
          pr: '535',
        },
      }),
      expect.objectContaining({ ignorePatterns: ['*.map', '*.json'] }),
    );
  });

  it('restores GITHUB_ACTIONS when the upstream uploader fails', async () => {
    const env = baseEnv();
    const uploader = vi.fn(async () => {
      expect(env.GITHUB_ACTIONS).toBeUndefined();
      throw new Error('upstream 404');
    });

    await expect(runBundleAnalysis({ env, uploader })).rejects.toThrow('upstream 404');
    expect(env.GITHUB_ACTIONS).toBe('true');
  });

  it('leaves GITHUB_ACTIONS absent when it was absent before the upload', async () => {
    const env = baseEnv();
    delete env.GITHUB_ACTIONS;
    const uploader = vi.fn(async () => '{}');

    await runBundleAnalysis({ env, uploader });

    expect('GITHUB_ACTIONS' in env).toBe(false);
  });
});
