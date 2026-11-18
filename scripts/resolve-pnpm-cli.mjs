import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Resolve the pnpm CLI used by the current invocation. Portable Node installs
 * do not necessarily ship Corepack alongside node.exe.
 */
export function resolvePnpmCli({
  nodeExecutable = process.execPath,
  pnpmExecPath = process.env.npm_execpath,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  if (
    typeof pnpmExecPath === 'string' &&
    /(?:^|[/\\])(?:pnpm\.(?:mjs|cjs)|pnpm\.js)$/i.test(pnpmExecPath) &&
    exists(pnpmExecPath)
  ) {
    return pnpmExecPath;
  }

  const bin = dirname(nodeExecutable);
  const nodeModules =
    platform === 'win32' ? join(bin, 'node_modules') : join(dirname(bin), 'lib', 'node_modules');
  const corepackCli = join(nodeModules, 'corepack', 'dist', 'pnpm.js');
  if (exists(corepackCli)) return corepackCli;

  throw new Error(
    'Cannot find the pnpm CLI for package preparation. Run this command through the repository-pinned pnpm installation.',
  );
}
