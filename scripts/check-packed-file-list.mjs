import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPackedFilePaths, verifyPackedFileList } from './package-artifacts.mjs';

function nodeGlobalModulePath(packageName, ...segments) {
  const binDirectory = dirname(process.execPath);
  const modulesDirectory =
    process.platform === 'win32'
      ? join(binDirectory, 'node_modules')
      : join(dirname(binDirectory), 'lib', 'node_modules');
  return join(modulesDirectory, packageName, ...segments);
}

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = resolve(process.env.PACKAGE_POLICY_ROOT || repoRoot);
const npmCli = nodeGlobalModulePath('npm', 'bin', 'npm-cli.js');
const npmArgs = ['pack', '--dry-run', '--json', '--ignore-scripts'];
const result = spawnSync(process.execPath, [npmCli, ...npmArgs], {
  cwd: root,
  encoding: 'utf8',
  shell: false,
});

if (result.status !== 0) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error)
    console.error(`[package:check-pack-list] spawn failed: ${result.error.message}`);
  process.exit(result.status ?? 1);
}

let packResult;
try {
  packResult = JSON.parse(result.stdout);
} catch (error) {
  console.error(
    `[package:check-pack-list] unable to parse npm pack JSON: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

const files = extractPackedFilePaths(packResult);
const verification = verifyPackedFileList(files);
if (!verification.ok) {
  console.error(`[package:check-pack-list] FAILED — ${verification.errors.length} error(s)`);
  for (const error of verification.errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`[package:check-pack-list] PASSED — ${files.length} packed files inspected`);
