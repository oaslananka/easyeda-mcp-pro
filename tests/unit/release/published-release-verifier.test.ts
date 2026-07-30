import { describe, expect, it } from 'vitest';
import {
  verifyPublishedReleaseObservation,
  type ReleaseVerificationExpectation,
  type ReleaseVerificationObservation,
} from '../../../src/release/published-release-verifier.js';

const expectation: ReleaseVerificationExpectation = {
  repository: 'oaslananka/easyeda-mcp-pro',
  packageName: 'easyeda-mcp-pro',
  mcpName: 'io.github.oaslananka/easyeda-mcp-pro',
  version: '0.35.4',
  tag: 'easyeda-mcp-pro-v0.35.4',
  channel: 'stable',
  npmDistTag: 'latest',
  commitSha: 'a'.repeat(40),
  requiredAssets: [
    'easyeda-bridge-extension.eext',
    'sbom.json',
    'easyeda-mcp-pro-v0.35.4.provenance.sigstore.json',
    'easyeda-mcp-pro-v0.35.4.intoto.jsonl',
  ],
  requiredGhcrTags: ['0.35.4', '0.35', 'latest'],
};

const observation: ReleaseVerificationObservation = {
  npm: {
    version: '0.35.4',
    distTags: { latest: '0.35.4' },
    provenance: 'passed',
  },
  github: {
    tag: 'easyeda-mcp-pro-v0.35.4',
    tagCommitSha: 'a'.repeat(40),
    isDraft: false,
    isPrerelease: false,
    assets: [
      { name: 'easyeda-bridge-extension.eext', digest: 'sha256:extension' },
      { name: 'sbom.json', digest: 'sha256:sbom' },
      {
        name: 'easyeda-mcp-pro-v0.35.4.provenance.sigstore.json',
        digest: 'sha256:provenance',
      },
      {
        name: 'easyeda-mcp-pro-v0.35.4.intoto.jsonl',
        digest: 'sha256:provenance-statement',
      },
    ],
  },
  ghcr: {
    digest: 'sha256:image',
    tags: ['0.35.4', '0.35', 'latest'],
    revision: 'a'.repeat(40),
  },
  mcpRegistry: {
    version: '0.35.4',
    isLatest: true,
  },
};

function cloneObservation(): ReleaseVerificationObservation {
  return structuredClone(observation);
}

describe('published release verifier', () => {
  it('passes a complete stable release', () => {
    const report = verifyPublishedReleaseObservation(expectation, cloneObservation());

    expect(report.ok).toBe(true);
    expect(report.checks).toHaveLength(10);
    expect(report.checks.every((check) => check.status === 'passed')).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([
      'npm-version',
      'npm-dist-tag',
      'npm-provenance',
      'github-tag',
      'github-tag-commit',
      'github-classification',
      'github-assets',
      'ghcr-tags',
      'ghcr-revision',
      'mcp-registry',
    ]);
  });

  it('fails when the npm version does not match', () => {
    const current = cloneObservation();
    current.npm.version = '0.35.3';

    const report = verifyPublishedReleaseObservation(expectation, current);

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === 'npm-version')?.status).toBe('failed');
  });

  it('fails when the expected npm dist-tag points elsewhere', () => {
    const current = cloneObservation();
    current.npm.distTags.latest = '0.35.3';

    const report = verifyPublishedReleaseObservation(expectation, current);

    expect(report.checks.find((check) => check.id === 'npm-dist-tag')?.status).toBe('failed');
  });

  it('accepts workflow-context provenance proof when registry proof is unverified', () => {
    const current = cloneObservation();
    current.npm.provenance = 'unverified';
    current.npm.workflowContextProof = true;

    const report = verifyPublishedReleaseObservation(expectation, current);

    expect(report.checks.find((check) => check.id === 'npm-provenance')?.status).toBe('passed');
  });

  it('fails stable publication when provenance is unverified without workflow proof', () => {
    const current = cloneObservation();
    current.npm.provenance = 'unverified';

    const report = verifyPublishedReleaseObservation(expectation, current);

    expect(report.checks.find((check) => check.id === 'npm-provenance')?.status).toBe('failed');
  });

  it('fails when the in-toto provenance statement is missing', () => {
    const current = cloneObservation();
    current.github.assets = current.github.assets.filter(
      (asset) => asset.name !== 'easyeda-mcp-pro-v0.35.4.intoto.jsonl',
    );

    const report = verifyPublishedReleaseObservation(expectation, current);

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === 'github-assets')?.status).toBe('failed');
  });

  it('fails when the portable Sigstore provenance sidecar is missing', () => {
    const current = cloneObservation();
    current.github.assets = current.github.assets.filter(
      (asset) => asset.name !== 'easyeda-mcp-pro-v0.35.4.provenance.sigstore.json',
    );

    const report = verifyPublishedReleaseObservation(expectation, current);

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === 'github-assets')?.status).toBe('failed');
  });

  it('fails for GitHub tag, commit, classification, or asset mismatch', () => {
    const current = cloneObservation();
    current.github.tag = 'easyeda-mcp-pro-v0.35.3';
    current.github.tagCommitSha = 'b'.repeat(40);
    current.github.isDraft = true;
    current.github.isPrerelease = true;
    current.github.assets = [{ name: 'sbom.json', digest: '' }];

    const report = verifyPublishedReleaseObservation(expectation, current);

    for (const id of [
      'github-tag',
      'github-tag-commit',
      'github-classification',
      'github-assets',
    ]) {
      expect(report.checks.find((check) => check.id === id)?.status).toBe('failed');
    }
  });

  it('fails when required GHCR tags are missing from the selected digest', () => {
    const current = cloneObservation();
    current.ghcr.tags = ['0.35.4'];

    const report = verifyPublishedReleaseObservation(expectation, current);

    expect(report.checks.find((check) => check.id === 'ghcr-tags')?.status).toBe('failed');
  });

  it('fails when the GHCR image revision is not the immutable release commit', () => {
    const current = cloneObservation();
    current.ghcr.revision = 'b'.repeat(40);

    const report = verifyPublishedReleaseObservation(expectation, current);

    expect(report.checks.find((check) => check.id === 'ghcr-revision')?.status).toBe('failed');
  });

  it('fails stable MCP Registry version and latest mismatches', () => {
    const current = cloneObservation();
    current.mcpRegistry = { version: '0.35.3', isLatest: false };

    const report = verifyPublishedReleaseObservation(expectation, current);

    expect(report.checks.find((check) => check.id === 'mcp-registry')?.status).toBe('failed');
  });

  it('requires MCP Registry exclusion for prereleases', () => {
    const prereleaseExpectation: ReleaseVerificationExpectation = {
      ...expectation,
      version: '0.35.4-rc.1',
      tag: 'easyeda-mcp-pro-v0.35.4-rc.1',
      channel: 'prerelease',
      npmDistTag: 'next',
      requiredGhcrTags: ['0.35.4-rc.1', 'next'],
    };
    const current = cloneObservation();
    current.npm.version = '0.35.4-rc.1';
    current.npm.distTags = { next: '0.35.4-rc.1' };
    current.github.tag = 'easyeda-mcp-pro-v0.35.4-rc.1';
    current.github.isPrerelease = true;
    current.ghcr.tags = ['0.35.4-rc.1', 'next'];
    current.mcpRegistry = null;

    expect(verifyPublishedReleaseObservation(prereleaseExpectation, current).ok).toBe(true);

    current.mcpRegistry = { version: '0.35.4-rc.1', isLatest: false };
    expect(
      verifyPublishedReleaseObservation(prereleaseExpectation, current).checks.find(
        (check) => check.id === 'mcp-registry',
      )?.status,
    ).toBe('failed');
  });

  it('aggregates multiple independent failures', () => {
    const current = cloneObservation();
    current.npm.version = '0.35.3';
    current.github.tagCommitSha = 'b'.repeat(40);
    current.ghcr.tags = [];
    current.mcpRegistry = null;

    const report = verifyPublishedReleaseObservation(expectation, current);

    expect(report.ok).toBe(false);
    expect(report.failures.map((failure) => failure.id)).toEqual([
      'npm-version',
      'github-tag-commit',
      'ghcr-tags',
      'mcp-registry',
    ]);
  });
});
