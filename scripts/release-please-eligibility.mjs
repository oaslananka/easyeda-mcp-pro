import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateReleasePleaseEligibility } from './release-please-eligibility-lib.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
