import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHA256_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
const SAFE_FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const POLICY_PATH = 'config/mcp-publisher-integrity.json';
const ALLOWED_ARCHIVE_MEMBERS = new Set(['LICENSE', 'README.md', 'mcp-publisher']);

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertBasename(value, label) {
  assertString(value, label);
  if (basename(value) !== value || !SAFE_FILE_NAME_RE.test(value)) {
    throw new TypeError(`${label} must be a safe plain file name`);
  }
}

export function validateMcpPublisherPolicy(policy) {
  assertObject(policy, 'mcp-publisher integrity policy');
  if (policy.schemaVersion !== 1) {
    throw new TypeError('schemaVersion must be 1');
  }
  if (policy.repository !== 'modelcontextprotocol/registry') {
    throw new TypeError('repository must be modelcontextprotocol/registry');
  }
  if (typeof policy.version !== 'string' || !VERSION_RE.test(policy.version)) {
    throw new TypeError('version must be a v-prefixed semantic version');
  }

  assertObject(policy.checksumManifest, 'checksumManifest');
  assertBasename(policy.checksumManifest.asset, 'checksumManifest.asset');
  assertSha256(policy.checksumManifest.sha256, 'checksumManifest.sha256');
  assertBasename(policy.checksumManifest.sigstoreBundle, 'checksumManifest.sigstoreBundle');
  assertSha256(
    policy.checksumManifest.sigstoreBundleSha256,
    'checksumManifest.sigstoreBundleSha256',
  );

  assertObject(policy.assets, 'assets');
  for (const [key, asset] of Object.entries(policy.assets)) {
    if (!/^linux-(amd64|arm64)$/.test(key)) {
      throw new TypeError(`unsupported policy asset key: ${key}`);
    }
    assertObject(asset, `assets.${key}`);
    assertBasename(asset.asset, `assets.${key}.asset`);
    const expectedAssetName = `mcp-publisher_${key.replace('-', '_')}.tar.gz`;
    if (asset.asset !== expectedAssetName) {
      throw new TypeError(`assets.${key}.asset must be ${expectedAssetName}`);
    }
    assertSha256(asset.sha256, `assets.${key}.sha256`);
    if (asset.binary !== 'mcp-publisher') {
      throw new TypeError(`assets.${key}.binary must be mcp-publisher`);
    }
  }

  return policy;
}

export async function loadMcpPublisherPolicy({ root = repoRoot, policyPath } = {}) {
  const absolutePath = resolve(policyPath ?? join(root, POLICY_PATH));
  const policy = JSON.parse(await readFile(absolutePath, 'utf8'));
  return validateMcpPublisherPolicy(policy);
}

export function normalizeMcpPublisherPlatform({ os, arch }) {
  assertString(os, 'operating system');
  assertString(arch, 'architecture');

  if (os.toLowerCase() !== 'linux') {
    throw new TypeError(`unsupported mcp-publisher operating system: ${os}`);
  }

  const normalizedArch = arch.toLowerCase();
  let resolvedArch;
  if (['x86_64', 'x64', 'amd64'].includes(normalizedArch)) {
    resolvedArch = 'amd64';
  } else if (['aarch64', 'arm64'].includes(normalizedArch)) {
    resolvedArch = 'arm64';
  } else {
    throw new TypeError(`unsupported mcp-publisher architecture: ${arch}`);
  }

  return { os: 'linux', arch: resolvedArch, key: `linux-${resolvedArch}` };
}

export function resolveMcpPublisherAsset(policy, platform) {
  validateMcpPublisherPolicy(policy);
  const normalized = normalizeMcpPublisherPlatform(platform);
  const asset = policy.assets[normalized.key];
  if (!asset) {
    throw new Error(`no pinned mcp-publisher asset for ${normalized.key}`);
  }

  const baseUrl = `https://github.com/${policy.repository}/releases/download/${policy.version}`;
  return {
    ...normalized,
    version: policy.version,
    repository: policy.repository,
    asset: asset.asset,
    assetSha256: asset.sha256,
    binary: asset.binary,
    checksumsAsset: policy.checksumManifest.asset,
    checksumsSha256: policy.checksumManifest.sha256,
    archiveUrl: `${baseUrl}/${asset.asset}`,
    checksumsUrl: `${baseUrl}/${policy.checksumManifest.asset}`,
  };
}

async function sha256File(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function findOfficialChecksum(checksumsText, assetName) {
  const matches = [];
  for (const line of checksumsText.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const match = line.match(/^([0-9a-f]{64})\s+(.+)$/);
    if (!match) continue;
    if (match[2] === assetName) matches.push(match[1]);
  }
  if (matches.length !== 1) {
    throw new Error(`official checksum manifest must contain exactly one entry for ${assetName}`);
  }
  return matches[0];
}

export async function verifyMcpPublisherPayload({ policy, os, arch, archivePath, checksumsPath }) {
  const resolved = resolveMcpPublisherAsset(policy, { os, arch });
  if (basename(archivePath) !== resolved.asset) {
    throw new Error(`archive file name must be ${resolved.asset}`);
  }
  if (basename(checksumsPath) !== resolved.checksumsAsset) {
    throw new Error(`checksum manifest file name must be ${resolved.checksumsAsset}`);
  }

  const checksumsDigest = await sha256File(checksumsPath);
  if (checksumsDigest !== resolved.checksumsSha256) {
    throw new Error(
      `checksum manifest SHA-256 mismatch: expected ${resolved.checksumsSha256}, got ${checksumsDigest}`,
    );
  }

  const officialAssetDigest = findOfficialChecksum(
    await readFile(checksumsPath, 'utf8'),
    resolved.asset,
  );
  if (officialAssetDigest !== resolved.assetSha256) {
    throw new Error('official checksum entry does not match the pinned asset digest');
  }

  const archiveDigest = await sha256File(archivePath);
  if (archiveDigest !== resolved.assetSha256) {
    throw new Error(
      `mcp-publisher archive SHA-256 mismatch: expected ${resolved.assetSha256}, got ${archiveDigest}`,
    );
  }

  return resolved;
}

function listArchiveMembers(archivePath) {
  const result = spawnSync('/usr/bin/tar', ['-tzf', archivePath], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`unable to list mcp-publisher archive: ${result.stderr.trim()}`);
  }
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function verifyArchiveMembers(members, binary) {
  const memberSet = new Set(members);
  for (const member of members) {
    if (member.startsWith('/') || member.split('/').includes('..')) {
      throw new Error(`unsafe mcp-publisher archive member: ${member}`);
    }
    if (!ALLOWED_ARCHIVE_MEMBERS.has(member)) {
      throw new Error(`unexpected mcp-publisher archive member: ${member}`);
    }
  }
  if (!memberSet.has(binary)) {
    throw new Error(`mcp-publisher archive is missing ${binary}`);
  }
}

export async function extractVerifiedMcpPublisher({ archivePath, destination, binary }) {
  const members = listArchiveMembers(archivePath);
  verifyArchiveMembers(members, binary);

  await mkdir(destination, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'mcp-publisher-install-'));
  try {
    const extraction = spawnSync(
      '/usr/bin/tar',
      ['-xzf', archivePath, '-C', temporaryDirectory, binary],
      { encoding: 'utf8' },
    );
    if (extraction.status !== 0) {
      throw new Error(`unable to extract mcp-publisher: ${extraction.stderr.trim()}`);
    }

    const extracted = join(temporaryDirectory, binary);
    const information = await stat(extracted);
    if (!information.isFile() || information.size === 0) {
      throw new Error('extracted mcp-publisher binary is missing or empty');
    }

    const installed = resolve(destination, binary);
    await copyFile(extracted, installed);
    await chmod(installed, 0o755);
    return installed;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function verifyAndInstallMcpPublisher({
  policy,
  os,
  arch,
  archivePath,
  checksumsPath,
  destination,
  extractArchive = extractVerifiedMcpPublisher,
}) {
  const resolved = await verifyMcpPublisherPayload({
    policy,
    os,
    arch,
    archivePath,
    checksumsPath,
  });
  return extractArchive({ archivePath, destination, binary: resolved.binary });
}

export { POLICY_PATH };
