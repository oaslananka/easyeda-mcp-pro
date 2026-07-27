#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectCompatibilityFreshness } from './release-readiness.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const qualityCommands = [
  { display: 'pnpm security:audit', command: 'pnpm', args: ['security:audit'] },
  { display: 'pnpm verify', command: 'pnpm', args: ['verify'] },
  { display: 'pnpm test:coverage', command: 'pnpm', args: ['test:coverage'] },
  { display: 'pnpm verify:extension', command: 'pnpm', args: ['verify:extension'] },
  { display: 'npm pack --dry-run', command: 'npm', args: ['pack', '--dry-run'] },
];

function parseArguments(argv) {
  const jsonOutput = argv.includes('--json');
  const compatibilityOnly = argv.includes('--compatibility-only');
  const targetArgument = argv.find((argument) => argument.startsWith('--target-ref='));
  return {
    jsonOutput,
    compatibilityOnly,
    targetRef: targetArgument?.slice('--target-ref='.length) || 'HEAD',
  };
}

function runQualityCommands({ machineReadable = false } = {}) {
  const log = machineReadable ? console.error : console.log;
  const stdio = machineReadable ? ['inherit', 2, 2] : 'inherit';
  for (const step of qualityCommands) {
    log(`\n==> ${step.display}`);
    const result = spawnSync(step.command, step.args, { cwd: repoRoot, stdio });
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

function printHumanReport(report) {
  if (report.status === 'current') {
    console.log(
      `EasyEDA compatibility evidence is current for ${report.headCommit} (${report.freshRecords}/${report.requiredFreshLiveRecords} required live records).`,
    );
    return;
  }

  const target = report.headCommit ?? report.targetRef;
  console.error(
    `EasyEDA compatibility evidence is ${report.status} for ${target}. ${report.reason}`,
  );
  for (const record of report.records) {
    console.error(`- ${record.id}: ${record.status} — ${record.reason}`);
    for (const file of record.changedFiles.slice(0, 30)) console.error(`  - ${file}`);
    if (record.changedFiles.length > 30) {
      console.error(`  - ... ${record.changedFiles.length - 30} more file(s)`);
    }
  }
}

function unexpectedUnavailableReport(targetRef) {
  return {
    schemaVersion: 1,
    status: 'unavailable',
    reason: 'Release readiness could not be evaluated.',
    targetRef,
    headCommit: null,
    requiredFreshLiveRecords: 1,
    freshRecords: 0,
    sensitivePaths: [],
    records: [],
  };
}

export async function runReleaseReadinessCli(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  let report;
  try {
    report = await inspectCompatibilityFreshness({
      root: repoRoot,
      targetRef: options.targetRef,
    });
  } catch {
    report = unexpectedUnavailableReport(options.targetRef);
  }

  if (!options.jsonOutput) printHumanReport(report);

  let exitCode = 1;
  if (report.status === 'current') {
    exitCode = options.compatibilityOnly
      ? 0
      : runQualityCommands({ machineReadable: options.jsonOutput });
  }

  if (options.jsonOutput) process.stdout.write(`${JSON.stringify(report)}\n`);
  return exitCode;
}

process.exitCode = await runReleaseReadinessCli();
