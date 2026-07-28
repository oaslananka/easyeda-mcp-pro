#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const NODE_IMAGE_RE = /^node@sha256:[0-9a-f]{64}$/;
const DOCUMENTATION_FILES = [
  'README.md',
  'CONTRIBUTING.md',
  'docs/INSTALLATION.md',
  'docs/guide/getting-started.md',
  'docs/guide/troubleshooting.md',
  'docs/TROUBLESHOOTING.md',
  'docs/COMPATIBILITY.md',
];

function normalizeText(value) {
  return value.replace(/\r\n/g, '\n');
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function optionValue(argv, name) {
  const direct = argv.find((argument) => argument.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function readRequired(root, path, errors) {
  try {
    return normalizeText(await readFile(resolve(root, path), 'utf8'));
  } catch {
    errors.push(`${path}: required runtime pin surface is missing or unreadable.`);
    return '';
  }
}

function expectEqual(errors, label, actual, expected) {
  if (actual !== expected) {
    errors.push(`${label}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}.`);
  }
}

function expectContains(errors, path, text, expected) {
  if (!text.includes(expected)) {
    errors.push(`${path}: expected to contain ${JSON.stringify(expected)}.`);
  }
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

async function listWorkflowFiles(root) {
  const workflowRoot = resolve(root, '.github/workflows');
  let entries;
  try {
    entries = await readdir(workflowRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => `.github/workflows/${entry.name}`)
    .sort();
}

function stepBlock(lines, usesIndex) {
  let stepIndex = usesIndex;
  while (stepIndex >= 0 && !/^(\s*)-\s/.test(lines[stepIndex])) stepIndex -= 1;
  if (stepIndex < 0) return lines.slice(usesIndex, usesIndex + 1);
  const indent = /^(\s*)-\s/.exec(lines[stepIndex])?.[1].length ?? 0;
  let endIndex = stepIndex + 1;
  while (endIndex < lines.length) {
    const nextStep = /^(\s*)-\s/.exec(lines[endIndex]);
    if (nextStep && nextStep[1].length <= indent) break;
    endIndex += 1;
  }
  return lines.slice(stepIndex, endIndex);
}

function inspectWorkflow(path, text, policy, errors) {
  const lines = text.split('\n');
  let literalNodePins = 0;
  for (const line of lines) {
    const match = /^\s*node-version:\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const value = unquote(match[1]);
    if (value === '${{ matrix.node-version }}') continue;
    literalNodePins += 1;
    expectEqual(errors, `${path} node-version`, value, policy.node.pinnedVersion);
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (!/uses:\s*pnpm\/action-setup@/.test(lines[index])) continue;
    const block = stepBlock(lines, index).join('\n');
    const versionMatch = /^\s*version:\s*(.+?)\s*$/m.exec(block);
    if (!versionMatch) {
      errors.push(
        `${path}: every pnpm/action-setup step must pin version ${policy.pnpm.pinnedVersion}.`,
      );
      continue;
    }
    expectEqual(
      errors,
      `${path} pnpm/action-setup version`,
      unquote(versionMatch[1]),
      policy.pnpm.pinnedVersion,
    );
  }

  if (/actions\/setup-node@/.test(text) && literalNodePins === 0) {
    errors.push(`${path}: setup-node must expose at least one literal pinned Node.js version.`);
  }
}

function validatePolicy(policy, errors) {
  if (policy?.schemaVersion !== 2) {
    errors.push('config/runtime-policy.json schemaVersion: expected 2.');
  }
  if (!Number.isInteger(policy?.node?.supportedMajor) || policy.node.supportedMajor < 1) {
    errors.push('config/runtime-policy.json node.supportedMajor must be a positive integer.');
  }
  if (!SEMVER_RE.test(policy?.node?.pinnedVersion ?? '')) {
    errors.push('config/runtime-policy.json node.pinnedVersion must be an exact semver version.');
  }
  if (!SEMVER_RE.test(policy?.pnpm?.pinnedVersion ?? '')) {
    errors.push('config/runtime-policy.json pnpm.pinnedVersion must be an exact semver version.');
  }
  if (!NODE_IMAGE_RE.test(policy?.docker?.nodeAlpineImage ?? '')) {
    errors.push(
      'config/runtime-policy.json docker.nodeAlpineImage must be a digest-pinned official Node image.',
    );
  }
  const nodeMajor = Number(String(policy?.node?.pinnedVersion ?? '').split('.')[0]);
  if (Number.isInteger(policy?.node?.supportedMajor) && nodeMajor !== policy.node.supportedMajor) {
    errors.push(
      'config/runtime-policy.json node.pinnedVersion major must match node.supportedMajor.',
    );
  }
}

export async function inspectRuntimePinParity(root = defaultRepoRoot) {
  const errors = [];
  const policyText = await readRequired(root, 'config/runtime-policy.json', errors);
  let policy;
  try {
    policy = JSON.parse(policyText);
  } catch {
    errors.push('config/runtime-policy.json: expected valid JSON.');
    return { ok: false, errors, policy: null };
  }
  validatePolicy(policy, errors);
  if (errors.length > 0) return { ok: false, errors, policy };

  const nodeVersion = policy.node.pinnedVersion;
  const pnpmVersion = policy.pnpm.pinnedVersion;
  const nodeEngine = `>=${policy.node.supportedMajor} <${policy.node.supportedMajor + 1}`;

  expectEqual(
    errors,
    '.node-version',
    (await readRequired(root, '.node-version', errors)).trim(),
    nodeVersion,
  );
  expectEqual(errors, '.nvmrc', (await readRequired(root, '.nvmrc', errors)).trim(), nodeVersion);

  const npmrc = await readRequired(root, '.npmrc', errors);
  expectContains(errors, '.npmrc', npmrc, 'engine-strict=true');
  expectContains(errors, '.npmrc', npmrc, 'manage-package-manager-versions=false');

  const packageText = await readRequired(root, 'package.json', errors);
  let packageJson = {};
  try {
    packageJson = JSON.parse(packageText);
  } catch {
    errors.push('package.json: expected valid JSON.');
  }
  expectEqual(
    errors,
    'package.json packageManager',
    packageJson.packageManager,
    `pnpm@${pnpmVersion}`,
  );
  expectEqual(errors, 'package.json engines.node', packageJson.engines?.node, nodeEngine);
  expectEqual(errors, 'package.json engines.pnpm', packageJson.engines?.pnpm, pnpmVersion);
  const runtimeSource = await readRequired(root, 'src/runtime/policy.ts', errors);
  expectContains(
    errors,
    'src/runtime/policy.ts',
    runtimeSource,
    `SUPPORTED_NODE_MAJOR = ${policy.node.supportedMajor}`,
  );
  expectContains(
    errors,
    'src/runtime/policy.ts',
    runtimeSource,
    `PINNED_NODE_VERSION = '${nodeVersion}'`,
  );
  expectContains(
    errors,
    'src/runtime/policy.ts',
    runtimeSource,
    `PINNED_PNPM_VERSION = '${pnpmVersion}'`,
  );

  const dockerfile = await readRequired(root, 'Dockerfile', errors);
  const escapedNodeVersion = nodeVersion.replaceAll('.', '\\.');
  const escapedImage = policy.docker.nodeAlpineImage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  expectEqual(
    errors,
    'Dockerfile Node version comments',
    countMatches(dockerfile, new RegExp(`# node:${escapedNodeVersion}-alpine`, 'g')),
    2,
  );
  expectEqual(
    errors,
    'Dockerfile Node image digest',
    countMatches(dockerfile, new RegExp(`^FROM ${escapedImage}(?: AS .+)?$`, 'gm')),
    2,
  );
  expectContains(
    errors,
    'Dockerfile',
    dockerfile,
    `corepack prepare pnpm@${pnpmVersion} --activate`,
  );

  const workflows = await listWorkflowFiles(root);
  if (workflows.length === 0) {
    errors.push('.github/workflows: expected at least one workflow file.');
  }
  for (const path of workflows) {
    inspectWorkflow(path, await readRequired(root, path, errors), policy, errors);
  }

  for (const path of DOCUMENTATION_FILES) {
    const text = await readRequired(root, path, errors);
    expectContains(errors, path, text, nodeVersion);
    expectContains(errors, path, text, pnpmVersion);
  }
  const contributing = await readRequired(root, 'CONTRIBUTING.md', errors);
  expectContains(errors, 'CONTRIBUTING.md', contributing, '### Atomic runtime upgrades');
  expectContains(errors, 'CONTRIBUTING.md', contributing, 'node scripts/check-runtime-pins.mjs');

  return { ok: errors.length === 0, errors, policy };
}

async function main(argv = process.argv.slice(2)) {
  const root = resolve(optionValue(argv, '--root') ?? defaultRepoRoot);
  const result = await inspectRuntimePinParity(root);
  if (!result.ok) {
    console.error('Runtime pin parity check failed:');
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Runtime pin parity check passed: Node.js ${result.policy.node.pinnedVersion}; pnpm ${result.policy.pnpm.pinnedVersion}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export { DOCUMENTATION_FILES };
