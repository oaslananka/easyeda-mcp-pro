#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EXACT_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;

function exactVersion(value) {
  return typeof value === 'string' && value.trim() === value && EXACT_VERSION.test(value);
}

function readRuntimePolicy(policy) {
  const node = policy?.node?.pinnedVersion;
  const pnpm = policy?.pnpm?.pinnedVersion;
  const major = policy?.node?.supportedMajor;
  if (
    policy?.schemaVersion !== 2 ||
    !exactVersion(node) ||
    !exactVersion(pnpm) ||
    !Number.isSafeInteger(major) ||
    major < 1 ||
    Number(node.split('.')[0]) !== major
  ) {
    throw new Error('Release runtime policy must contain exact version pins.');
  }
  return { node, pnpm, major };
}

function assertRuntimeMetadata(read, { node, pnpm, major }) {
  const pkg = JSON.parse(read('package.json'));
  if (
    read('.node-version').trim() !== node ||
    read('.nvmrc').trim() !== node ||
    pkg?.packageManager !== `pnpm@${pnpm}` ||
    pkg?.engines?.pnpm !== pnpm ||
    pkg?.engines?.node !== `>=${major} <${major + 1}`
  ) {
    throw new Error('Release runtime metadata must match the exact policy.');
  }
}

function resolveReleaseRuntime(root) {
  const read = (file) => readFileSync(resolve(root, file), 'utf8');
  const pins = readRuntimePolicy(JSON.parse(read('config/runtime-policy.json')));
  assertRuntimeMetadata(read, pins);
  return pins;
}

try {
  const root = process.argv[2];
  const output = process.env.GITHUB_OUTPUT;
  if (!root || !output) throw new Error('Release root and GITHUB_OUTPUT are required.');
  const { node, pnpm } = resolveReleaseRuntime(root);
  appendFileSync(output, `node_version=${node}\npnpm_version=${pnpm}\n`);
  console.log(`Resolved immutable release runtime: Node.js ${node}; pnpm ${pnpm}.`);
} catch {
  console.error(
    'Invalid exact release runtime: missing, malformed, or inconsistent runtime metadata.',
  );
  process.exitCode = 1;
}
