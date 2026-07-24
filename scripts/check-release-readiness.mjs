#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(repoRoot, 'config/easyeda-compatibility.json');
const jsonOutput = process.argv.includes('--json');
const compatibilityOnly = process.argv.includes('--compatibility-only');
const targetRef =
  process.argv
    .find((argument) => argument.startsWith('--target-ref='))
    ?.slice('--target-ref='.length) || 'HEAD';

function resolveGitBinary() {
  const candidates =
    process.platform === 'win32'
      ? [
          resolve(
            process.env.ProgramFiles ?? String.raw`C:\Program Files`,
            'Git',
            'cmd',
            'git.exe',
          ),
          resolve(
            process.env.ProgramFiles ?? String.raw`C:\Program Files`,
            'Git',
            'bin',
            'git.exe',
          ),
        ]
      : ['/usr/bin/git', '/usr/local/bin/git'];
  const binary = candidates.find((candidate) => existsSync(candidate));
  if (!binary)
    throw new Error(`Git executable not found in supported locations: ${candidates.join(', ')}`);
  return binary;
}

const gitBinary = resolveGitBinary();

function git(args, options = {}) {
  return execFileSync(gitBinary, ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : undefined,
  }).trim();
}

function gitStatus(args) {
  return spawnSync(gitBinary, ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function listChangedFiles(base, head, paths) {
  const output = git(['diff', '--name-only', `${base}..${head}`, '--', ...paths], { quiet: true });
  return output ? output.split('\n').filter(Boolean) : [];
}

function listDirtyFiles(paths) {
  const worktree = git(['diff', '--name-only', '--', ...paths], { quiet: true });
  const index = git(['diff', '--cached', '--name-only', '--', ...paths], { quiet: true });
  return [...new Set(`${worktree}\n${index}`.split('\n').filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

export function inspectCompatibilityFreshness() {
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
  const paths = source.releaseGate?.sensitivePaths ?? [];
  const requiredFreshLiveRecords = source.releaseGate?.requiredFreshLiveRecords ?? 1;
  const headCommit = git(['rev-parse', `${targetRef}^{commit}`], { quiet: true });
  const dirtyFiles = targetRef === 'HEAD' ? listDirtyFiles(paths) : [];
  const records = source.records.map((record) => {
    try {
      const evidenceCommit = git(['rev-parse', `${record.server.commit}^{commit}`], {
        quiet: true,
      });
      const ancestor = gitStatus(['merge-base', '--is-ancestor', evidenceCommit, headCommit]);
      if (ancestor.status !== 0) {
        return {
          id: record.id,
          evidenceCommit,
          status: 'unavailable',
          changedFiles: [],
          reason: 'The evidence commit is not an ancestor of the checked-out release candidate.',
        };
      }
      const changedFiles = listChangedFiles(evidenceCommit, headCommit, paths);
      const combined = [...new Set([...changedFiles, ...dirtyFiles])].sort((left, right) =>
        left.localeCompare(right),
      );
      return {
        id: record.id,
        evidenceCommit,
        status: combined.length === 0 ? 'current' : 'stale',
        changedFiles: combined,
        reason:
          combined.length === 0
            ? 'No compatibility-sensitive file changed after the live evidence commit.'
            : 'Compatibility-sensitive files changed after the live evidence commit.',
      };
    } catch (error) {
      return {
        id: record.id,
        evidenceCommit: record.server.commit,
        status: 'unavailable',
        changedFiles: [],
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const freshRecords = records.filter((record) => record.status === 'current').length;
  let status = 'unavailable';
  if (freshRecords >= requiredFreshLiveRecords) status = 'current';
  else if (records.some((record) => record.status === 'stale')) status = 'stale';
  return {
    status,
    targetRef,
    headCommit,
    requiredFreshLiveRecords,
    freshRecords,
    sensitivePaths: paths,
    records,
  };
}

const qualityCommands = [
  { display: 'pnpm security:audit', command: 'pnpm', args: ['security:audit'] },
  { display: 'pnpm verify', command: 'pnpm', args: ['verify'] },
  { display: 'pnpm test:coverage', command: 'pnpm', args: ['test:coverage'] },
  { display: 'pnpm verify:extension', command: 'pnpm', args: ['verify:extension'] },
  { display: 'npm pack --dry-run', command: 'npm', args: ['pack', '--dry-run'] },
];

function runQualityCommands() {
  for (const step of qualityCommands) {
    console.log(`\n==> ${step.display}`);
    const result = spawnSync(step.command, step.args, { cwd: repoRoot, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

const report = inspectCompatibilityFreshness();
if (jsonOutput) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
} else if (report.status === 'current') {
  console.log(
    `EasyEDA compatibility evidence is current for ${report.headCommit} (${report.freshRecords}/${report.requiredFreshLiveRecords} required live records).`,
  );
} else {
  console.error(
    `EasyEDA compatibility evidence is ${report.status} for ${report.headCommit}. A release is blocked until a new live record is bound to the compatibility-sensitive candidate.`,
  );
  for (const record of report.records) {
    console.error(`- ${record.id}: ${record.status} — ${record.reason}`);
    for (const file of record.changedFiles.slice(0, 30)) console.error(`  - ${file}`);
    if (record.changedFiles.length > 30) {
      console.error(`  - ... ${record.changedFiles.length - 30} more file(s)`);
    }
  }
}

if (report.status !== 'current') process.exit(1);
if (!compatibilityOnly) runQualityCommands();
