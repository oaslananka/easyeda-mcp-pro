#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { verifyPublishedReleaseObservation } from '../src/release/published-release-verifier.ts';

const TAG_PREFIX = 'easyeda-mcp-pro-v';
const STABLE_TAG = /^easyeda-mcp-pro-v(\d+)\.(\d+)\.(\d+)$/;
const PRERELEASE_TAG = /^easyeda-mcp-pro-v(\d+)\.(\d+)\.(\d+)-rc\.([1-9]\d*)$/;
const PROVENANCE_PREDICATE = 'https://slsa.dev/provenance/v1';

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    values[key] = value;
    index += 1;
  }
  for (const key of ['repository', 'tag', 'channel', 'commit', 'report-json']) {
    if (!values[key]) throw new Error(`--${key} is required.`);
  }
  if (!['stable', 'prerelease'].includes(values.channel)) {
    throw new Error('--channel must be stable or prerelease.');
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repository)) {
    throw new Error('--repository must use owner/name format.');
  }
  if (!/^[0-9a-f]{40}$/i.test(values.commit)) {
    throw new Error('--commit must be a full 40-character Git SHA.');
  }
  return values;
}

function tagDetails(tag, channel) {
  const match = channel === 'stable' ? tag.match(STABLE_TAG) : tag.match(PRERELEASE_TAG);
  if (!match) throw new Error(`Tag ${tag} does not match ${channel} channel format.`);
  const version = tag.slice(TAG_PREFIX.length);
  return {
    version,
    majorMinor: `${match[1]}.${match[2]}`,
  };
}

function runJson(command, args) {
  const output = execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  return JSON.parse(output);
}

function runText(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  }).trim();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}.`);
  return await response.json();
}

async function collectLiveRaw({ repository, tag, version, packageName, mcpName }) {
  const [owner, repositoryName] = repository.split('/');
  const npmPackage = runJson('npm', [
    'view',
    `${packageName}@${version}`,
    'version',
    'dist',
    '--json',
  ]);
  const npmDistTags = runJson('npm', ['view', packageName, 'dist-tags', '--json']);
  const githubRelease = runJson('gh', [
    'release',
    'view',
    tag,
    '--repo',
    repository,
    '--json',
    'tagName,targetCommitish,isDraft,isPrerelease,assets',
  ]);
  const releaseApi = runJson('gh', ['api', `repos/${repository}/releases/tags/${tag}`]);
  const digestByName = new Map(
    (releaseApi.assets ?? []).map((asset) => [asset.name, asset.digest]),
  );
  githubRelease.assets = (githubRelease.assets ?? []).map((asset) => ({
    ...asset,
    digest: digestByName.get(asset.name),
  }));
  const gitTagCommit = runText('git', ['rev-parse', `${tag}^{commit}`]);
  const ghcrVersions = runJson('gh', [
    'api',
    `/users/${owner}/packages/container/${repositoryName}/versions?per_page=100`,
  ]);
  const ghcrImage = runJson('docker', [
    'buildx',
    'imagetools',
    'inspect',
    `ghcr.io/${repository}:${version}`,
    '--format',
    '{{json .Image}}',
  ]);
  const registryUrl = new URL('https://registry.modelcontextprotocol.io/v0.1/servers');
  registryUrl.searchParams.set('search', mcpName);
  registryUrl.searchParams.set('version', version);
  const mcpRegistry = await fetchJson(registryUrl);
  return {
    npmPackage,
    npmDistTags,
    githubRelease,
    gitTagCommit,
    ghcrVersions,
    ghcrImage,
    mcpRegistry,
  };
}

function normalizeObservation(raw, expectation) {
  const exactGhcrVersion = (raw.ghcrVersions ?? []).find((item) =>
    item?.metadata?.container?.tags?.includes(expectation.version),
  );
  const registryEntry = (raw.mcpRegistry?.servers ?? []).find(
    (item) =>
      item?.server?.name === expectation.mcpName && item?.server?.version === expectation.version,
  );
  const registryMeta = registryEntry?._meta?.['io.modelcontextprotocol.registry/official'];
  const provenancePredicate = raw.npmPackage?.dist?.attestations?.provenance?.predicateType;

  return {
    npm: {
      version: raw.npmPackage?.version,
      distTags: raw.npmDistTags ?? {},
      provenance:
        provenancePredicate === PROVENANCE_PREDICATE
          ? 'passed'
          : provenancePredicate
            ? 'failed'
            : 'unverified',
      workflowContextProof: process.env.RELEASE_VERIFY_WORKFLOW_PROVENANCE === 'true',
    },
    github: {
      tag: raw.githubRelease?.tagName,
      tagCommitSha: raw.gitTagCommit,
      isDraft: raw.githubRelease?.isDraft,
      isPrerelease: raw.githubRelease?.isPrerelease,
      assets: (raw.githubRelease?.assets ?? []).map((asset) => ({
        name: asset.name,
        digest: asset.digest,
      })),
    },
    ghcr: {
      digest: exactGhcrVersion?.name,
      tags: exactGhcrVersion?.metadata?.container?.tags ?? [],
      revision: raw.ghcrImage?.config?.Labels?.['org.opencontainers.image.revision'],
    },
    mcpRegistry: registryEntry
      ? {
          version: registryEntry.server.version,
          isLatest: registryEntry.isLatest ?? registryMeta?.isLatest,
        }
      : null,
  };
}

function buildExpectation(args, packageJson) {
  const details = tagDetails(args.tag, args.channel);
  return {
    repository: args.repository,
    packageName: packageJson.name,
    mcpName: packageJson.mcpName,
    version: details.version,
    tag: args.tag,
    channel: args.channel,
    npmDistTag: args.channel === 'stable' ? 'latest' : 'next',
    commitSha: args.commit.toLowerCase(),
    requiredAssets: [
      'easyeda-bridge-extension.eext',
      'sbom.json',
      `${args.tag}.provenance.sigstore.json`,
      `${args.tag}.intoto.jsonl`,
    ],
    requiredGhcrTags:
      args.channel === 'stable'
        ? [details.version, details.majorMinor, 'latest']
        : [details.version, 'next'],
  };
}

function markdownSummary(report) {
  const rows = report.checks
    .map(
      (check) =>
        `| \`${check.id}\` | ${check.status === 'passed' ? 'passed' : 'failed'} | ${check.message ?? ''} |`,
    )
    .join('\n');
  return [
    '# Published release verification',
    '',
    `Status: **${report.ok ? 'passed' : 'failed'}**`,
    '',
    `- Tag: \`${report.expectation?.tag ?? '<unresolved>'}\``,
    `- Commit: \`${report.expectation?.commitSha ?? '<unresolved>'}\``,
    '',
    '| Check | Status | Detail |',
    '| --- | --- | --- |',
    rows,
    report.error ? `\nError: ${report.error}` : '',
    '',
  ].join('\n');
}

async function writeReport(path, report) {
  const absolutePath = resolve(path);
  await mkdir(dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, absolutePath);
}

async function writeSummary(path, report) {
  if (!path) return;
  const absolutePath = resolve(path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await appendFile(absolutePath, `${markdownSummary(report)}\n`, 'utf8');
}

function errorReport(error, expectation) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ok: false,
    expectation,
    checks: [],
    failures: [],
    error: error instanceof Error ? error.message : String(error),
  };
}

async function main() {
  let args;
  let expectation;
  try {
    args = parseArgs(process.argv.slice(2));
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    if (!packageJson.name || !packageJson.mcpName) {
      throw new Error('package.json must define name and mcpName.');
    }
    expectation = buildExpectation(args, packageJson);
    const fixturePath = process.env.RELEASE_VERIFY_FIXTURE_PATH;
    const raw = fixturePath
      ? JSON.parse(await readFile(resolve(fixturePath), 'utf8'))
      : await collectLiveRaw({
          ...args,
          version: expectation.version,
          packageName: expectation.packageName,
          mcpName: expectation.mcpName,
        });

    const sourcePackageVersion = fixturePath ? raw.sourcePackageVersion : packageJson.version;
    if (sourcePackageVersion !== expectation.version) {
      throw new Error(
        `Tag version ${expectation.version} does not match package version ${sourcePackageVersion ?? '<missing>'}.`,
      );
    }

    const observation = normalizeObservation(raw, expectation);
    const comparison = verifyPublishedReleaseObservation(expectation, observation);
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      expectation,
      observation,
      ...comparison,
    };
    await writeReport(args['report-json'], report);
    await writeSummary(args['summary-file'], report);
    console.log(
      `Published release verification ${report.ok ? 'passed' : 'failed'} for ${args.tag}.`,
    );
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    const report = errorReport(error, expectation);
    if (args?.['report-json']) await writeReport(args['report-json'], report);
    if (args?.['summary-file']) await writeSummary(args['summary-file'], report);
    console.error(report.error);
    process.exitCode = 1;
  }
}

await main();
