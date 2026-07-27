import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const script = resolve(repoRoot, 'scripts/verify-published-release.mjs');
const commit = 'a'.repeat(40);

function stableFixture() {
  return {
    sourcePackageVersion: '0.35.4',
    npmPackage: {
      version: '0.35.4',
      dist: {
        attestations: {
          provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
        },
      },
    },
    npmDistTags: { latest: '0.35.4' },
    githubRelease: {
      tagName: 'easyeda-mcp-pro-v0.35.4',
      targetCommitish: commit,
      isDraft: false,
      isPrerelease: false,
      assets: [
        { name: 'easyeda-bridge-extension.eext', digest: 'sha256:extension' },
        { name: 'sbom.json', digest: 'sha256:sbom' },
      ],
    },
    gitTagCommit: commit,
    ghcrImage: {
      config: { Labels: { 'org.opencontainers.image.revision': commit } },
    },
    ghcrVersions: [
      {
        name: 'sha256:image',
        metadata: { container: { tags: ['0.35.4', '0.35', 'latest'] } },
      },
    ],
    mcpRegistry: {
      servers: [
        {
          server: { name: 'io.github.oaslananka/easyeda-mcp-pro', version: '0.35.4' },
          isLatest: true,
        },
      ],
    },
  };
}

function runCli(
  fixture: object,
  overrides: { tag?: string; channel?: string; commit?: string } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'easyeda-release-verify-'));
  const fixturePath = join(directory, 'fixture.json');
  const reportPath = join(directory, 'report.json');
  const summaryPath = join(directory, 'summary.md');
  writeFileSync(fixturePath, `${JSON.stringify(fixture)}\n`);

  const result = spawnSync(
    process.execPath,
    [
      script,
      '--repository',
      'oaslananka/easyeda-mcp-pro',
      '--tag',
      overrides.tag ?? 'easyeda-mcp-pro-v0.35.4',
      '--channel',
      overrides.channel ?? 'stable',
      '--commit',
      overrides.commit ?? commit,
      '--report-json',
      reportPath,
      '--summary-file',
      summaryPath,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, RELEASE_VERIFY_FIXTURE_PATH: fixturePath },
      encoding: 'utf8',
    },
  );

  return {
    ...result,
    report: JSON.parse(readFileSync(reportPath, 'utf8')) as {
      ok: boolean;
      checks: Array<{ id: string; status: string }>;
      failures: Array<{ id: string }>;
    },
    summary: readFileSync(summaryPath, 'utf8'),
  };
}

describe('published release verification CLI', () => {
  it('writes deterministic passing JSON and Markdown for a stable release', () => {
    const result = runCli(stableFixture());

    expect(result.status).toBe(0);
    expect(result.report.ok).toBe(true);
    expect(result.report.checks).toHaveLength(10);
    expect(result.summary).toContain('# Published release verification');
    expect(result.summary).toContain('Status: **passed**');
    expect(result.stdout).not.toContain('token');
  });

  it('returns exit code one and aggregates mismatches', () => {
    const fixture = stableFixture();
    fixture.npmPackage.version = '0.35.3';
    fixture.npmDistTags.latest = '0.35.3';
    fixture.githubRelease.targetCommitish = 'b'.repeat(40);
    fixture.gitTagCommit = 'b'.repeat(40);
    fixture.ghcrVersions[0]!.metadata.container.tags = ['0.35.4'];
    fixture.mcpRegistry.servers = [];

    const result = runCli(fixture);

    expect(result.status).toBe(1);
    expect(result.report.ok).toBe(false);
    expect(result.report.failures.map((failure) => failure.id)).toEqual([
      'npm-version',
      'npm-dist-tag',
      'github-tag-commit',
      'ghcr-tags',
      'mcp-registry',
    ]);
  });

  it('fails when the published image revision does not match the release commit', () => {
    const fixture = stableFixture();
    fixture.ghcrImage.config.Labels['org.opencontainers.image.revision'] = 'b'.repeat(40);

    const result = runCli(fixture);

    expect(result.status).toBe(1);
    expect(result.report.failures.map((failure) => failure.id)).toContain('ghcr-revision');
  });

  it('rejects tag and package version disagreement before registry comparison', () => {
    const result = runCli(stableFixture(), { tag: 'easyeda-mcp-pro-v0.35.5' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match package version');
  });

  it('verifies prerelease channel tags and MCP Registry exclusion', () => {
    const fixture = stableFixture();
    fixture.npmPackage.version = '0.35.4-rc.1';
    fixture.sourcePackageVersion = '0.35.4-rc.1';
    fixture.npmDistTags = { next: '0.35.4-rc.1' };
    fixture.githubRelease.tagName = 'easyeda-mcp-pro-v0.35.4-rc.1';
    fixture.githubRelease.isPrerelease = true;
    fixture.ghcrVersions[0]!.metadata.container.tags = ['0.35.4-rc.1', 'next'];
    fixture.mcpRegistry.servers = [];

    const result = runCli(fixture, {
      tag: 'easyeda-mcp-pro-v0.35.4-rc.1',
      channel: 'prerelease',
    });

    expect(result.status).toBe(0);
    expect(result.report.ok).toBe(true);
  });
});
