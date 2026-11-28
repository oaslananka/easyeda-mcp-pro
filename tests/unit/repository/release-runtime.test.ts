import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const resolver = resolve(import.meta.dirname, '../../../scripts/resolve-release-runtime.mjs');
const roots: string[] = [];

async function fixture(node = '24.22.3', pnpm = '11.28.11') {
  const root = await mkdtemp(join(tmpdir(), 'release-runtime-'));
  roots.push(root);
  await mkdir(join(root, 'config'));
  await writeFile(
    join(root, 'config/runtime-policy.json'),
    JSON.stringify({
      schemaVersion: 2,
      node: { supportedMajor: 24, pinnedVersion: node },
      pnpm: { pinnedVersion: pnpm },
    }),
  );
  await writeFile(join(root, '.node-version'), node + '\n');
  await writeFile(join(root, '.nvmrc'), node + '\n');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ packageManager: 'pnpm@' + pnpm, engines: { node: '>=24 <25', pnpm } }),
  );
  return root;
}

function run(root: string) {
  return spawnSync(process.execPath, [resolver, root], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: join(root, 'output') },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('immutable release runtime resolution', () => {
  it.each(['11.28.11', '11.29.0'])('uses the release checkout exact pnpm %s', async (pnpm) => {
    const root = await fixture('24.22.3', pnpm);
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(join(root, 'output'), 'utf8')).toBe(
      'node_version=24.22.3\npnpm_version=' + pnpm + '\n',
    );
  });

  it.each(['latest', '11.29', '11.29.0-rc.1', '11.29.0\nother=bad', '011.29.0'])(
    'rejects non-exact or unsafe pin %s without emitting outputs',
    async (pnpm) => {
      const root = await fixture('24.22.3', pnpm);
      const result = run(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Invalid exact release runtime');
      await expect(readFile(join(root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each(['.nvmrc', '.node-version', 'package.json', 'config/runtime-policy.json'])(
    'fails closed on missing or inconsistent release metadata: %s',
    async (file) => {
      const root = await fixture();
      await writeFile(join(root, file), '{}\n');
      const result = run(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Invalid exact release runtime');
      await expect(readFile(join(root, 'output'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
});
