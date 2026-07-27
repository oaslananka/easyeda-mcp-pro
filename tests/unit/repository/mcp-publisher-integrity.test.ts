import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadMcpPublisherPolicy,
  normalizeMcpPublisherPlatform,
  resolveMcpPublisherAsset,
  verifyAndInstallMcpPublisher,
  verifyMcpPublisherPayload,
} from '../../../scripts/mcp-publisher-integrity.mjs';

const repoRoot = resolve(import.meta.dirname, '../../..');
const temporaryRoots: string[] = [];
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function createFixture() {
  const root = join(tmpdir(), `mcp-publisher-integrity-${Date.now()}-${Math.random()}`);
  temporaryRoots.push(root);
  await mkdir(root, { recursive: true });

  const assetName = 'mcp-publisher_linux_amd64.tar.gz';
  const archive = Buffer.from('verified publisher archive fixture\n');
  const assetSha256 = sha256(archive);
  const checksums = `${assetSha256}  ${assetName}\n`;
  const policy = {
    schemaVersion: 1,
    repository: 'modelcontextprotocol/registry',
    version: 'v1.7.9',
    checksumManifest: {
      asset: 'registry_1.7.9_checksums.txt',
      sha256: sha256(checksums),
      sigstoreBundle: 'registry_1.7.9_checksums.txt.sigstore.json',
      sigstoreBundleSha256: '2'.repeat(64),
    },
    assets: {
      'linux-amd64': { asset: assetName, sha256: assetSha256, binary: 'mcp-publisher' },
    },
  };

  const archivePath = join(root, assetName);
  const checksumsPath = join(root, policy.checksumManifest.asset);
  const policyPath = join(root, 'mcp-publisher-integrity.json');
  await writeFile(archivePath, archive);
  await writeFile(checksumsPath, checksums);
  await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  return { root, policy, policyPath, archivePath, checksumsPath, assetName };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('MCP publisher integrity policy', () => {
  it('pins the official v1.7.9 checksum evidence and supported Linux assets', async () => {
    const policy = await loadMcpPublisherPolicy({ root: repoRoot });

    expect(policy).toMatchObject({
      schemaVersion: 1,
      repository: 'modelcontextprotocol/registry',
      version: 'v1.7.9',
      checksumManifest: {
        asset: 'registry_1.7.9_checksums.txt',
        sha256: 'e84c4329507f205b111b35a9b30f330945ef5c329648a65260f15d69fcdbf94d',
      },
      assets: {
        'linux-amd64': {
          asset: 'mcp-publisher_linux_amd64.tar.gz',
          sha256: 'ab128162b0616090b47cf245afe0a23f3ef08936fdce19074f5ba0a4469281ac',
        },
        'linux-arm64': {
          asset: 'mcp-publisher_linux_arm64.tar.gz',
          sha256: '04f5199b3deef8e6fc4d6ed98c56a74f799def53edca3fe6d4862ecd4397c172',
        },
      },
    });
  });

  it('normalizes only explicitly supported operating-system and architecture mappings', () => {
    expect(normalizeMcpPublisherPlatform({ os: 'Linux', arch: 'x86_64' })).toEqual({
      os: 'linux',
      arch: 'amd64',
      key: 'linux-amd64',
    });
    expect(normalizeMcpPublisherPlatform({ os: 'linux', arch: 'aarch64' })).toEqual({
      os: 'linux',
      arch: 'arm64',
      key: 'linux-arm64',
    });
    expect(() => normalizeMcpPublisherPlatform({ os: 'Darwin', arch: 'x86_64' })).toThrow(
      'unsupported mcp-publisher operating system: Darwin',
    );
    expect(() => normalizeMcpPublisherPlatform({ os: 'Linux', arch: 'riscv64' })).toThrow(
      'unsupported mcp-publisher architecture: riscv64',
    );
  });

  it('rejects malformed or incomplete repository-owned policy data', async () => {
    const fixture = await createFixture();
    fixture.policy.assets['linux-amd64'].sha256 = 'not-a-digest';
    await writeFile(fixture.policyPath, JSON.stringify(fixture.policy));

    await expect(loadMcpPublisherPolicy({ policyPath: fixture.policyPath })).rejects.toThrow(
      'assets.linux-amd64.sha256 must be a lowercase SHA-256 digest',
    );
  });

  it('rejects file-name injection and asset names that disagree with their platform key', async () => {
    const fixture = await createFixture();
    fixture.policy.checksumManifest.asset = 'checksums.txt\nMALICIOUS=value';
    await writeFile(fixture.policyPath, JSON.stringify(fixture.policy));

    await expect(loadMcpPublisherPolicy({ policyPath: fixture.policyPath })).rejects.toThrow(
      'checksumManifest.asset must be a safe plain file name',
    );

    fixture.policy.checksumManifest.asset = 'registry_1.7.9_checksums.txt';
    fixture.policy.assets['linux-amd64'].asset = 'mcp-publisher_linux_arm64.tar.gz';
    await writeFile(fixture.policyPath, JSON.stringify(fixture.policy));

    await expect(loadMcpPublisherPolicy({ policyPath: fixture.policyPath })).rejects.toThrow(
      'assets.linux-amd64.asset must be mcp-publisher_linux_amd64.tar.gz',
    );
  });

  it('resolves an exact official URL and rejects a missing supported asset entry', async () => {
    const fixture = await createFixture();
    const resolved = resolveMcpPublisherAsset(fixture.policy, { os: 'Linux', arch: 'x86_64' });

    expect(resolved).toMatchObject({
      key: 'linux-amd64',
      asset: fixture.assetName,
      checksumsAsset: 'registry_1.7.9_checksums.txt',
      archiveUrl:
        'https://github.com/modelcontextprotocol/registry/releases/download/v1.7.9/mcp-publisher_linux_amd64.tar.gz',
    });
    expect(() =>
      resolveMcpPublisherAsset(fixture.policy, { os: 'Linux', arch: 'aarch64' }),
    ).toThrow('no pinned mcp-publisher asset for linux-arm64');
  });

  it('fails closed when the downloaded checksum manifest does not match its pinned digest', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.checksumsPath, 'tampered checksum manifest\n');

    await expect(
      verifyMcpPublisherPayload({
        policy: fixture.policy,
        os: 'Linux',
        arch: 'x86_64',
        archivePath: fixture.archivePath,
        checksumsPath: fixture.checksumsPath,
      }),
    ).rejects.toThrow('checksum manifest SHA-256 mismatch');
  });

  it('fails closed when the official manifest entry disagrees with the pinned asset digest', async () => {
    const fixture = await createFixture();
    const differentDigest = '3'.repeat(64);
    const checksums = `${differentDigest}  ${fixture.assetName}\n`;
    fixture.policy.checksumManifest.sha256 = sha256(checksums);
    await writeFile(fixture.checksumsPath, checksums);

    await expect(
      verifyMcpPublisherPayload({
        policy: fixture.policy,
        os: 'Linux',
        arch: 'x86_64',
        archivePath: fixture.archivePath,
        checksumsPath: fixture.checksumsPath,
      }),
    ).rejects.toThrow('official checksum entry does not match the pinned asset digest');
  });

  it('fails closed when the downloaded publisher archive digest is wrong', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.archivePath, 'tampered archive\n');

    await expect(
      verifyMcpPublisherPayload({
        policy: fixture.policy,
        os: 'Linux',
        arch: 'x86_64',
        archivePath: fixture.archivePath,
        checksumsPath: fixture.checksumsPath,
      }),
    ).rejects.toThrow('mcp-publisher archive SHA-256 mismatch');
  });

  it('verifies both trust anchors and returns the resolved publisher asset', async () => {
    const fixture = await createFixture();

    await expect(
      verifyMcpPublisherPayload({
        policy: fixture.policy,
        os: 'Linux',
        arch: 'x86_64',
        archivePath: fixture.archivePath,
        checksumsPath: fixture.checksumsPath,
      }),
    ).resolves.toMatchObject({ key: 'linux-amd64', asset: fixture.assetName });
  });

  it('never invokes extraction when integrity verification fails', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.archivePath, 'tampered archive\n');
    const extractArchive = vi.fn();

    await expect(
      verifyAndInstallMcpPublisher({
        policy: fixture.policy,
        os: 'Linux',
        arch: 'x86_64',
        archivePath: fixture.archivePath,
        checksumsPath: fixture.checksumsPath,
        destination: fixture.root,
        extractArchive,
      }),
    ).rejects.toThrow('mcp-publisher archive SHA-256 mismatch');
    expect(extractArchive).not.toHaveBeenCalled();
  });

  it('invokes extraction only after successful verification', async () => {
    const fixture = await createFixture();
    const extractArchive = vi.fn().mockResolvedValue(join(fixture.root, 'mcp-publisher'));

    await expect(
      verifyAndInstallMcpPublisher({
        policy: fixture.policy,
        os: 'Linux',
        arch: 'x86_64',
        archivePath: fixture.archivePath,
        checksumsPath: fixture.checksumsPath,
        destination: fixture.root,
        extractArchive,
      }),
    ).resolves.toBe(join(fixture.root, 'mcp-publisher'));
    expect(extractArchive).toHaveBeenCalledOnce();
  });

  it('keeps OIDC login unchanged and verifies before extraction in the release workflow', async () => {
    const workflow = await readFile(
      join(repoRoot, '.github/workflows/publish-release.yml'),
      'utf8',
    );
    const runbook = await readFile(join(repoRoot, 'docs/release-ci-runbook.md'), 'utf8');

    expect(workflow).toContain('config/mcp-publisher-integrity.json');
    expect(workflow).toContain('$MCP_PUBLISHER_CHECKSUMS_URL');
    expect(workflow).toContain('node "$RELEASE_VERIFIER_ROOT/scripts/install-mcp-publisher.mjs"');
    expect(workflow).toContain(
      'cp config/mcp-publisher-integrity.json "$RELEASE_VERIFIER_ROOT/config/"',
    );
    expect(workflow).toContain(
      'cp scripts/install-mcp-publisher.mjs "$RELEASE_VERIFIER_ROOT/scripts/"',
    );
    expect(workflow).not.toContain('tar xzf mcp-publisher_*.tar.gz mcp-publisher');
    expect(workflow.indexOf('cp scripts/install-mcp-publisher.mjs')).toBeLessThan(
      workflow.indexOf('Checkout immutable publication source'),
    );
    expect(
      workflow.indexOf('node "$RELEASE_VERIFIER_ROOT/scripts/install-mcp-publisher.mjs" install'),
    ).toBeLessThan(workflow.indexOf('./mcp-publisher login github-oidc'));
    expect(workflow).toContain('./mcp-publisher login github-oidc');
    expect(workflow).toContain('./mcp-publisher publish');
    expect(runbook).toContain('Updating mcp-publisher integrity evidence');
    expect(runbook).toContain('config/mcp-publisher-integrity.json');
    expect(runbook).toContain('GitHub release asset `digest`');
  });
});
