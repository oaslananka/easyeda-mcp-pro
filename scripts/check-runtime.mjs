#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(readFileSync(resolve(repoRoot, 'config/runtime-policy.json'), 'utf8'));

export function normalizeVersion(value) {
  const match = String(value ?? '')
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export function evaluateNodeVersion(value) {
  const normalized = normalizeVersion(value);
  const major = normalized ? Number(normalized.split('.')[0]) : Number.NaN;
  return {
    version: normalized,
    supported: Number.isInteger(major) && major === policy.node.supportedMajor,
    required: `${policy.node.supportedMajor}.x`,
    pinned: policy.node.pinnedVersion,
  };
}

export function evaluatePnpmVersion(value) {
  const normalized = normalizeVersion(value);
  return {
    version: normalized,
    supported: normalized === policy.pnpm.pinnedVersion,
    required: policy.pnpm.pinnedVersion,
  };
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function detectPnpmVersion() {
  const override = optionValue('--pnpm-version');
  if (override !== undefined) return override;

  const userAgent = process.env.npm_config_user_agent ?? '';
  const match = userAgent.match(/(?:^|\s)pnpm\/([^\s]+)/);
  if (match?.[1]) return match[1];

  try {
    return execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, EASYEDA_MCP_RUNTIME_CHECK_ACTIVE: '1' },
    }).trim();
  } catch {
    return null;
  }
}

export function validateRuntime({ nodeVersion, pnpmVersion, requirePnpm }) {
  const errors = [];
  const node = evaluateNodeVersion(nodeVersion);
  if (!node.supported) {
    errors.push(
      `Unsupported Node.js ${nodeVersion || '(missing)'}. easyeda-mcp-pro repository automation requires Node.js ${node.required}; use the pinned ${node.pinned}.`,
    );
  }

  const pnpm = evaluatePnpmVersion(pnpmVersion);
  if (requirePnpm && !pnpm.supported) {
    errors.push(
      pnpm.version
        ? `Unsupported pnpm ${pnpm.version}. This repository requires pnpm ${pnpm.required}.`
        : `pnpm was not found. This repository requires pnpm ${pnpm.required}.`,
    );
  }
  return { ok: errors.length === 0, errors, node, pnpm };
}

function main() {
  const nodeVersion = optionValue('--node-version') ?? process.versions.node;
  const requirePnpm =
    process.argv.includes('--require-pnpm') && !process.argv.includes('--node-only');
  const pnpmVersion = requirePnpm ? detectPnpmVersion() : null;
  const result = validateRuntime({ nodeVersion, pnpmVersion, requirePnpm });

  if (!result.ok) {
    for (const error of result.errors) console.error(`Runtime preflight failed: ${error}`);
    console.error(`Recovery: install Node.js ${policy.node.pinnedVersion}, then run:`);
    console.error('  corepack enable');
    console.error(`  corepack prepare pnpm@${policy.pnpm.pinnedVersion} --activate`);
    process.exitCode = 1;
    return;
  }

  const pnpmSummary = requirePnpm ? `; pnpm ${result.pnpm.version}` : '';
  console.log(`Runtime preflight passed: Node.js ${result.node.version}${pnpmSummary}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
