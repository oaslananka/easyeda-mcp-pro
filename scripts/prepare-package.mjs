import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  removeGeneratedPackageArtifacts,
  verifyPackageArtifacts,
  writePackageBuildManifest,
} from './package-artifacts.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function run(command, args, options = {}) {
  const useWindowsCommandShell = options.windowsCommandShell ?? false;
  const executable = useWindowsCommandShell ? (process.env.ComSpec ?? 'cmd.exe') : command;
  const executableArgs = useWindowsCommandShell ? ['/d', '/s', '/c', command, ...args] : args;
  const result = spawnSync(executable, executableArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) {
    if (result.error) console.error(`[package:prepare] spawn failed: ${result.error.message}`);
    process.exit(result.status ?? 1);
  }
}

run(process.execPath, ['scripts/check-metadata.mjs']);

const current = await verifyPackageArtifacts({ root: repoRoot });
if (current.ok) {
  console.log('[package:prepare] existing package artifacts are fresh; rebuild skipped');
  run(process.execPath, ['scripts/check-packed-file-list.mjs']);
  process.exit(0);
}

console.log('[package:prepare] rebuilding package artifacts because validation failed:');
for (const error of current.errors.slice(0, 20)) console.log(`  - ${error}`);
if (current.errors.length > 20) console.log(`  - ... ${current.errors.length - 20} more error(s)`);

await removeGeneratedPackageArtifacts({ root: repoRoot });
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const windowsCommandShell = process.platform === 'win32';
run(pnpmCommand, ['build'], { windowsCommandShell });
run(pnpmCommand, ['build:extension'], { windowsCommandShell });
await writePackageBuildManifest({ root: repoRoot });
run(process.execPath, ['scripts/check-package-artifacts.mjs']);
run(process.execPath, ['scripts/check-packed-file-list.mjs']);
