#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspectCompatibilityFreshness, loadCompatibilityEvidence } from './release-readiness.mjs';

const SHA256_RE = /^[0-9a-f]{64}$/;

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
  for (const key of ['root', 'target-ref', 'channel']) {
    if (!values[key]) throw new Error(`--${key} is required.`);
  }
  if (!['stable', 'prerelease'].includes(values.channel)) {
    throw new Error('--channel must be stable or prerelease.');
  }
  return values;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Extension checksum manifest must be a JSON object.');
  }
  if (!SHA256_RE.test(manifest.packageSha256 ?? '')) {
    throw new Error('Extension checksum manifest packageSha256 must be a 64-character SHA-256.');
  }
  if (!Number.isInteger(manifest.packageSize) || manifest.packageSize <= 0) {
    throw new Error('Extension checksum manifest packageSize must be a positive integer.');
  }
}

function appendOutput(path, key, value) {
  if (path) appendFileSync(path, `${key}=${value}\n`, 'utf8');
}

async function resolvePrereleaseEvidence({ root, targetRef, version, manifest }) {
  const freshness = await inspectCompatibilityFreshness({ root, targetRef });
  if (freshness.status !== 'current') {
    throw new Error(
      `Prerelease extension identity requires current live EasyEDA evidence; got ${freshness.status}: ${freshness.reason}`,
    );
  }

  const evidence = await loadCompatibilityEvidence({ root });
  if (!evidence.ok) throw new Error(evidence.reason);
  const currentIds = new Set(
    freshness.records.filter((record) => record.status === 'current').map((record) => record.id),
  );
  const candidates = evidence.source.records.filter(
    (record) =>
      currentIds.has(record.id) &&
      record.server?.validationPackageVersion === version &&
      record.extension?.installedPackageVersion === version,
  );
  if (candidates.length === 0) {
    throw new Error(
      `No current live EasyEDA record carries exact prerelease package version ${version}.`,
    );
  }

  const matching = candidates.find(
    (record) =>
      record.extension?.packageSha256 === manifest.packageSha256 &&
      record.extension?.packageSizeBytes === manifest.packageSize,
  );
  if (!matching) {
    const expected = candidates.map((record) => ({
      id: record.id,
      packageSha256: record.extension?.packageSha256 ?? null,
      packageSizeBytes: record.extension?.packageSizeBytes ?? null,
    }));
    throw new Error(
      `Generated prerelease extension identity does not match current live evidence. ` +
        `Generated sha256=${manifest.packageSha256} size=${manifest.packageSize}; ` +
        `current evidence=${JSON.stringify(expected)}.`,
    );
  }
  if (!SHA256_RE.test(matching.extension.packageSha256 ?? '')) {
    throw new Error(
      `Live EasyEDA record ${matching.id} is missing a valid extension package SHA-256.`,
    );
  }
  if (
    !Number.isInteger(matching.extension.packageSizeBytes) ||
    matching.extension.packageSizeBytes <= 0
  ) {
    throw new Error(
      `Live EasyEDA record ${matching.id} is missing a valid extension package size.`,
    );
  }
  return matching.id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root);
  const packageJson = readJson(resolve(root, 'package.json'));
  const manifest = readJson(resolve(root, 'easyeda-bridge-extension.checksums.json'));
  validateManifest(manifest);

  let evidenceRecordId = '';
  if (args.channel === 'prerelease') {
    evidenceRecordId = await resolvePrereleaseEvidence({
      root,
      targetRef: args['target-ref'],
      version: packageJson.version,
      manifest,
    });
  }

  const digest = `sha256:${manifest.packageSha256}`;
  appendOutput(args['github-output'], 'extension_asset_digest', digest);
  appendOutput(args['github-output'], 'extension_asset_size', String(manifest.packageSize));
  appendOutput(args['github-output'], 'extension_evidence_record', evidenceRecordId);

  console.log(
    `Release extension identity verified for ${packageJson.version}: ${digest} (${manifest.packageSize} bytes)` +
      (evidenceRecordId ? ` via ${evidenceRecordId}.` : '.'),
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
