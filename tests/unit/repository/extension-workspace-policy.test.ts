import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const PRIVATE_EXTENSION_VERSION = '0.0.0-private';

function readJson(path: string) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8')) as Record<string, any>;
}

function readText(path: string) {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('private extension workspace policy', () => {
  it('uses an unmistakable private sentinel instead of an independent product version', () => {
    const extensionPackage = readJson('easyeda-bridge-extension/package.json');

    expect(extensionPackage.private).toBe(true);
    expect(extensionPackage.version).toBe(PRIVATE_EXTENSION_VERSION);
  });

  it('does not install the unused EasyEDA API declaration package in either workspace', () => {
    const rootPackage = readJson('package.json');
    const extensionPackage = readJson('easyeda-bridge-extension/package.json');
    const lockfile = readText('pnpm-lock.yaml');

    expect(rootPackage.dependencies?.['@jlceda/pro-api-types']).toBeUndefined();
    expect(rootPackage.devDependencies?.['@jlceda/pro-api-types']).toBeUndefined();
    expect(extensionPackage.dependencies?.['@jlceda/pro-api-types']).toBeUndefined();
    expect(extensionPackage.devDependencies?.['@jlceda/pro-api-types']).toBeUndefined();
    expect(lockfile).not.toContain('@jlceda/pro-api-types');
  });

  it('keeps every remaining extension development dependency tied to a real consumer', () => {
    const extensionPackage = readJson('easyeda-bridge-extension/package.json');
    const archiveScript = readText('easyeda-bridge-extension/scripts/archive.mjs');
    const buildScript = readText('easyeda-bridge-extension/scripts/build.mjs');

    expect(Object.keys(extensionPackage.devDependencies ?? {}).sort()).toEqual([
      'archiver',
      'esbuild',
      'typescript',
      'vitest',
    ]);
    expect(archiveScript).toContain("from 'archiver'");
    expect(buildScript).toContain("from 'esbuild'");
    expect(extensionPackage.scripts.typecheck).toContain('tsc --noEmit');
    expect(extensionPackage.scripts.test).toContain('vitest run');
  });

  it('keeps release automation scoped to product-version surfaces, not the private package', () => {
    const releaseConfig = readJson('release-please-config.json');
    const extraFiles = releaseConfig.packages['.']['extra-files'] as Array<
      string | { path: string; jsonpath?: string }
    >;
    const entries = extraFiles.map((entry) =>
      typeof entry === 'string' ? entry : `${entry.path}:${entry.jsonpath ?? ''}`,
    );

    expect(entries).toEqual(
      expect.arrayContaining([
        'easyeda-bridge-extension/extension.json',
        'easyeda-bridge-extension/src/index.ts:',
        'src/config/version.ts:',
        '.claude-plugin/plugin.json:$.version',
        'server.json:$.version',
        'server.json:$.packages[0].version',
      ]),
    );
    expect(entries.some((entry) => entry.startsWith('easyeda-bridge-extension/package.json'))).toBe(
      false,
    );
    expect(readText('scripts/sync-versions.mjs')).not.toContain(
      'easyeda-bridge-extension/package.json',
    );
  });

  it('passes the executable metadata checker for the current repository state', async () => {
    await expect(import('../../../scripts/check-metadata.mjs')).resolves.toBeDefined();
  });
});
