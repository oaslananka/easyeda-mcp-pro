#!/usr/bin/env node

import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: process.env,
    encoding: 'utf8',
    shell: options.shell ?? false,
    stdio: options.stdio ?? 'pipe',
  });
  if (result.status !== 0) {
    const stdout = result.stdout?.trim();
    const stderr = result.stderr?.trim();
    throw new Error(
      [
        `${command} ${args.join(' ')} failed with exit ${result.status ?? 'unknown'}.`,
        stdout ? `stdout:\n${stdout}` : '',
        stderr ? `stderr:\n${stderr}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  return result;
}

const repoRoot = resolve(import.meta.dirname, '../..');
const workspace = await mkdtemp(join(tmpdir(), 'easyeda-packed-doctor-'));
const packDirectory = join(workspace, 'pack');
const installPrefix = join(workspace, 'prefix');

try {
  await mkdir(packDirectory, { recursive: true });
  run('npm', ['pack', '--pack-destination', packDirectory], { cwd: repoRoot });

  const archives = (await readdir(packDirectory)).filter((name) => name.endsWith('.tgz'));
  if (archives.length !== 1) {
    throw new Error(`Expected exactly one packed tarball, found ${archives.length}.`);
  }
  const archive = join(packDirectory, archives[0]);

  run('npm', ['install', '--global', '--prefix', installPrefix, archive], { cwd: workspace });

  const binPath =
    process.platform === 'win32'
      ? join(installPrefix, 'easyeda-mcp-pro.cmd')
      : join(installPrefix, 'bin', 'easyeda-mcp-pro');
  const doctor = run(binPath, ['--doctor'], {
    cwd: workspace,
    shell: process.platform === 'win32',
  });

  console.log(`Packed install doctor passed: ${basename(archive)} on ${process.platform}.`);
  if (doctor.stdout?.trim()) console.log(doctor.stdout.trim());
} finally {
  await rm(workspace, { recursive: true, force: true });
}
