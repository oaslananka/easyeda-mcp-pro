#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const PRERELEASE_VERSION = /^(\d+\.\d+\.\d+)-[0-9A-Za-z][0-9A-Za-z.-]*$/;
const RELEASE_AS = /^Release-As:\s*(\d+\.\d+\.\d+)\s*$/m;

export function evaluateReleasePleaseEligibility(version, commitMessage) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('package version must be a non-empty string');
  }
  if (STABLE_VERSION.test(version)) {
    return { run: true, reason: 'stable-version', currentVersion: version };
  }

  const prerelease = PRERELEASE_VERSION.exec(version);
  if (!prerelease?.[1]) {
    throw new Error(`unsupported package version for Release Please eligibility: ${version}`);
  }

  const marker = RELEASE_AS.exec(String(commitMessage ?? ''));
  if (!marker?.[1]) {
    return {
      run: false,
      reason: 'prerelease-awaiting-explicit-promotion',
      currentVersion: version,
      expectedStableVersion: prerelease[1],
    };
  }
  if (marker[1] !== prerelease[1]) {
    throw new Error(
      `Release-As ${marker[1]} does not match prerelease base ${prerelease[1]} for ${version}`,
    );
  }

  return {
    run: true,
    reason: 'explicit-prerelease-promotion',
    currentVersion: version,
    targetVersion: marker[1],
  };
}

function readCommitMessage() {
  const result = spawnSync('git', ['-C', repoRoot, 'log', '-1', '--format=%B'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`could not read HEAD commit message: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function appendGithubFile(path, content) {
  if (path) appendFileSync(path, content, 'utf8');
}

function main() {
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
  const result = evaluateReleasePleaseEligibility(packageJson.version, readCommitMessage());
  const run = result.run ? 'true' : 'false';

  appendGithubFile(process.env.GITHUB_OUTPUT, `run_release_please=${run}\n`);
  appendGithubFile(
    process.env.GITHUB_STEP_SUMMARY,
    `### Stable Release Please eligibility\n\n- package version: \`${result.currentVersion}\`\n- decision: \`${run}\`\n- reason: \`${result.reason}\`\n${result.targetVersion ? `- target version: \`${result.targetVersion}\`\n` : ''}`,
  );

  console.log(
    `Release Please eligibility: run=${run}; version=${result.currentVersion}; reason=${result.reason}`,
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
