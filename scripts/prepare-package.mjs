import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  removeGeneratedPackageArtifacts,
  verifyPackageArtifacts,
  writePackageBuildManifest,
} from './package-artifacts.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
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
run('pnpm', ['build']);
run('pnpm', ['build:extension']);
await writePackageBuildManifest({ root: repoRoot });
run(process.execPath, ['scripts/check-package-artifacts.mjs']);
run(process.execPath, ['scripts/check-packed-file-list.mjs']);
