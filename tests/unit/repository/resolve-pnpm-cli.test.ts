import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolvePnpmCli } from '../../../scripts/resolve-pnpm-cli.mjs';

describe('portable pnpm CLI resolution for package preparation', () => {
  it('uses the running pnpm CLI with a portable Windows Node binary', () => {
    const activeCli = join('C:', 'pnpm', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
    const result = resolvePnpmCli({
      nodeExecutable: join('C:', 'portable', 'node.exe'),
      pnpmExecPath: activeCli,
      platform: 'win32',
      exists: (path: string) => path === activeCli,
    });
    expect(result).toBe(activeCli);
  });

  it('falls back to adjacent Corepack when the launched pnpm path is absent', () => {
    const nodeExecutable = join('opt', 'node', 'bin', 'node');
    const expected = join('opt', 'node', 'lib', 'node_modules', 'corepack', 'dist', 'pnpm.js');
    expect(
      resolvePnpmCli({
        nodeExecutable,
        pnpmExecPath: '/missing/pnpm.mjs',
        platform: 'linux',
        exists: (path: string) => path === expected,
      }),
    ).toBe(expected);
  });

  it('fails clearly when neither installed CLI is available', () => {
    expect(() =>
      resolvePnpmCli({
        nodeExecutable: '/portable/node',
        pnpmExecPath: '/untrusted/not-pnpm.js',
        platform: 'linux',
        exists: () => false,
      }),
    ).toThrow('Cannot find the pnpm CLI');
  });
});
