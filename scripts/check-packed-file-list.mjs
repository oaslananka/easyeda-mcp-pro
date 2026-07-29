import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPackedFileList } from './package-artifacts.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = resolve(process.env.PACKAGE_POLICY_ROOT || repoRoot);
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npmArgs = ['pack', '--dry-run', '--json', '--ignore-scripts'];
const spawnOptions = {
  cwd: root,
  encoding: 'utf8',
  shell: false,
};
const result =
  process.platform === 'win32'
    ? spawnSync(process.execPath, [npmCli, ...npmArgs], spawnOptions)
    : spawnSync('npm', npmArgs, spawnOptions);

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

const files = Array.isArray(packResult?.[0]?.files)
  ? packResult[0].files.map((entry) => entry.path)
  : [];
const verification = verifyPackedFileList(files);
if (!verification.ok) {
  console.error(`[package:check-pack-list] FAILED — ${verification.errors.length} error(s)`);
  for (const error of verification.errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`[package:check-pack-list] PASSED — ${files.length} packed files inspected`);
