import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  removeGeneratedPackageArtifacts,
  verifyPackageArtifacts,
  writePackageBuildManifest,
} from './package-artifacts.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function requireSuccess(result) {
  if (result.status === 0) return;
  if (result.error) console.error(`[package:prepare] spawn failed: ${result.error.message}`);
  process.exit(result.status ?? 1);
}

function runExecutable(command, args) {
  requireSuccess(
    spawnSync(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: false,
    }),
  );
}

function runPnpmScript(script) {
  if (process.platform !== 'win32') {
    runExecutable('pnpm', [script]);
    return;
  }
  requireSuccess(
    spawnSync('cmd.exe', ['/d', '/s', '/c', 'pnpm.cmd', script], {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: false,
    }),
  );
}

runExecutable(process.execPath, ['scripts/check-metadata.mjs']);

const current = await verifyPackageArtifacts({ root: repoRoot });
if (current.ok) {
  console.log('[package:prepare] existing package artifacts are fresh; rebuild skipped');
  runExecutable(process.execPath, ['scripts/check-packed-file-list.mjs']);
  process.exit(0);
}

console.log('[package:prepare] rebuilding package artifacts because validation failed:');
for (const error of current.errors.slice(0, 20)) console.log(`  - ${error}`);
if (current.errors.length > 20) console.log(`  - ... ${current.errors.length - 20} more error(s)`);

await removeGeneratedPackageArtifacts({ root: repoRoot });
runPnpmScript('build');
runPnpmScript('build:extension');
await writePackageBuildManifest({ root: repoRoot });
runExecutable(process.execPath, ['scripts/check-package-artifacts.mjs']);
runExecutable(process.execPath, ['scripts/check-packed-file-list.mjs']);
