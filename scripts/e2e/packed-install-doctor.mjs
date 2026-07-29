#!/usr/bin/env node

import { access, mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: process.env,
    encoding: 'utf8',
    shell: false,
    stdio: options.stdio ?? 'pipe',
  });
  if (result.status !== 0) {
    const stdout = result.stdout?.trim();
    const stderr = result.stderr?.trim();
    const spawnError = result.error?.message;
    throw new Error(
      [
        `${command} ${args.join(' ')} failed with exit ${result.status ?? 'unknown'}.`,
        stdout ? `stdout:\n${stdout}` : '',
        stderr ? `stderr:\n${stderr}` : '',
        spawnError ? `spawn error: ${spawnError}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  return result;
}

function runNpm(args, options = {}) {
  if (process.platform !== 'win32') return run('npm', args, options);
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return run(process.execPath, [npmCli, ...args], options);
}

const repoRoot = resolve(import.meta.dirname, '../..');
const workspace = await mkdtemp(join(tmpdir(), 'easyeda-packed-doctor-'));
const packDirectory = join(workspace, 'pack');
const installPrefix = join(workspace, 'prefix');

try {
  await mkdir(packDirectory, { recursive: true });
  runNpm(['pack', '--pack-destination', packDirectory], { cwd: repoRoot });

  const archives = (await readdir(packDirectory)).filter((name) => name.endsWith('.tgz'));
  if (archives.length !== 1) {
    throw new Error(`Expected exactly one packed tarball, found ${archives.length}.`);
  }
  const archive = join(packDirectory, archives[0]);

  runNpm(['install', '--global', '--prefix', installPrefix, archive], { cwd: workspace });

  const binPath =
    process.platform === 'win32'
      ? join(installPrefix, 'easyeda-mcp-pro.cmd')
      : join(installPrefix, 'bin', 'easyeda-mcp-pro');
  const installedEntry =
    process.platform === 'win32'
      ? join(installPrefix, 'node_modules', 'easyeda-mcp-pro', 'dist', 'index.js')
      : join(installPrefix, 'lib', 'node_modules', 'easyeda-mcp-pro', 'dist', 'index.js');
  await access(binPath);
  await access(installedEntry);
  const doctor = run(process.execPath, [installedEntry, '--doctor'], { cwd: workspace });

  console.log(`Packed install doctor passed: ${basename(archive)} on ${process.platform}.`);
  if (doctor.stdout?.trim()) console.log(doctor.stdout.trim());
} finally {
  await rm(workspace, { recursive: true, force: true });
}
