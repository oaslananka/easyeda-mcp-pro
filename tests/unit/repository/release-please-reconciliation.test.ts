import { describe, expect, it } from 'vitest';

import {
  parsePendingRelease,
  verifyReleaseIdentity,
} from '../../../scripts/reconcile-release-please-lib.mjs';

const sha = 'a'.repeat(40);
const issue = {
  number: 632,
  title: 'chore(main): release easyeda-mcp-pro 1.1.0',
  pull_request: {},
};
const pull = { number: 632, merged_at: '2026-09-29T17:06:56Z', merge_commit_sha: sha };
const candidate = {
  number: 632,
  version: '1.1.0',
  tag: 'easyeda-mcp-pro-v1.1.0',
  mergeSha: sha,
};
const release = {
  tag_name: candidate.tag,
  target_commitish: sha,
  draft: false,
  prerelease: false,
  assets: [
    'easyeda-bridge-extension.eext',
    'sbom.json',
    candidate.tag + '.provenance.sigstore.json',
    candidate.tag + '.intoto.jsonl',
  ].map((name) => ({ name, size: 1 })),
};

describe('Release Please published identity reconciliation', () => {
  it('recognizes a merged pending stable release PR', () => {
    expect(parsePendingRelease(issue, pull)).toEqual(candidate);
  });

  it('ignores unmerged pending release PRs and issues', () => {
    expect(parsePendingRelease(issue, { ...pull, merged_at: null })).toBeNull();
    expect(parsePendingRelease({ ...issue, pull_request: null }, pull)).toBeNull();
  });

  it('ignores unrelated merged PRs but rejects malformed release identity', () => {
    expect(parsePendingRelease({ ...issue, title: 'some other release' }, pull)).toBeNull();
    expect(() => parsePendingRelease(issue, { ...pull, merge_commit_sha: 'main' })).toThrow();
  });

  it('accepts complete and immutable published identity', () => {
    expect(verifyReleaseIdentity(candidate, release, sha, '1.1.0')).toBe(true);
  });

  it('rejects wrong tag commit and wrong channel', () => {
    expect(() => verifyReleaseIdentity(candidate, release, 'b'.repeat(40), '1.1.0')).toThrow();
    expect(() =>
      verifyReleaseIdentity(candidate, { ...release, prerelease: true }, sha, '1.1.0'),
    ).toThrow();
    expect(() =>
      verifyReleaseIdentity(candidate, { ...release, draft: true }, sha, '1.1.0'),
    ).toThrow();
  });

  it('rejects missing npm publication and mismatched target commit', () => {
    expect(() => verifyReleaseIdentity(candidate, release, sha, '1.0.1')).toThrow();
    expect(() =>
      verifyReleaseIdentity(candidate, { ...release, target_commitish: 'main' }, sha, '1.1.0'),
    ).toThrow();
  });

  it('rejects partial or empty published release assets', () => {
    expect(() =>
      verifyReleaseIdentity(
        candidate,
        { ...release, assets: release.assets.slice(0, 3) },
        sha,
        '1.1.0',
      ),
    ).toThrow();
    expect(() =>
      verifyReleaseIdentity(
        candidate,
        { ...release, assets: [{ name: 'sbom.json', size: 0 }] },
        sha,
        '1.1.0',
      ),
    ).toThrow();
  });
});
