import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeChecksumManifest } from '../../../easyeda-bridge-extension/scripts/checksums.mjs';
import {
  PACKAGE_BUILD_MANIFEST_PATH,
  REQUIRED_PACKAGE_FILE_ENTRIES,
  removeGeneratedPackageArtifacts,
  verifyPackageArtifacts,
  verifyPackedFileList,
  writePackageBuildManifest,
} from '../../../scripts/package-artifacts.mjs';

const repoRoot = resolve(import.meta.dirname, '../../..');
const temporaryRoots: string[] = [];

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createFixture() {
  const root = join(tmpdir(), `easyeda-package-policy-${Date.now()}-${Math.random()}`);
  temporaryRoots.push(root);

  for (const directory of [
    'src/config',
    'scripts',
    'easyeda-bridge-extension/src',
    'easyeda-bridge-extension/scripts',
    'easyeda-bridge-extension/images',
    'easyeda-bridge-extension/locales',
  ]) {
    await mkdir(join(root, directory), { recursive: true });
  }

  const version = '1.2.3';
  const packageJson = {
    name: 'easyeda-mcp-pro',
    version,
    mcpName: 'io.github.oaslananka/easyeda-mcp-pro',
    bin: { 'easyeda-mcp-pro': 'dist/index.js' },
    files: [...REQUIRED_PACKAGE_FILE_ENTRIES],
  };
  await writeJson(join(root, 'package.json'), packageJson);
  await writeJson(join(root, 'server.json'), {
    name: packageJson.mcpName,
    version,
    packages: [{ identifier: packageJson.name, version }],
  });
  await writeJson(join(root, '.claude-plugin/plugin.json'), { version });
  await writeJson(join(root, 'easyeda-bridge-extension/extension.json'), {
    version,
    entry: './dist/index',
  });
  await writeFile(
    join(root, 'src/config/version.ts'),
    `export const SERVER_VERSION = '${version}';\n`,
    'utf8',
  );
  await writeFile(join(root, 'src/index.ts'), '#!/usr/bin/env node\nconsole.log("source");\n');
  await writeFile(join(root, 'tsconfig.build.json'), '{}\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await writeFile(join(root, 'README.md'), '# Fixture\n');
  await writeFile(join(root, 'LICENSE'), 'MIT\n');
  await writeFile(join(root, 'THIRD_PARTY_NOTICES.md'), '# Notices\n');
  await writeJson(join(root, 'config/runtime-policy.json'), { node: '24.18.0' });
  await writeFile(join(root, 'scripts/check-runtime.mjs'), 'process.exit(0);\n');
  await writeFile(
    join(root, 'easyeda-bridge-extension/package.json'),
    '{"private":true,"version":"0.0.0-private"}\n',
  );
  await writeFile(join(root, 'easyeda-bridge-extension/tsconfig.json'), '{}\n');
  await writeFile(
    join(root, 'easyeda-bridge-extension/src/index.ts'),
    `const EXTENSION_INFO = { extensionVersion: '${version}' };\nexport const extension = true;\n`,
  );
  await writeFile(
    join(root, 'easyeda-bridge-extension/scripts/build.mjs'),
    'console.log("build");\n',
  );
  await writeFile(join(root, 'easyeda-bridge-extension/README.md'), '# Extension\n');
  await writeFile(join(root, 'easyeda-bridge-extension/CHANGELOG.md'), '# Changes\n');
  await writeFile(join(root, 'easyeda-bridge-extension/images/logo.png'), 'png\n');
  await writeJson(join(root, 'easyeda-bridge-extension/locales/en.json'), {});

  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'dist/index.js'), '#!/usr/bin/env node\nconsole.log("built");\n');
  await writeFile(join(root, 'dist/runtime.js'), 'export const runtime = true;\n');
  await mkdir(join(root, 'easyeda-bridge-extension/dist'), { recursive: true });
  await writeFile(
    join(root, 'easyeda-bridge-extension/dist/index.js'),
    'console.log("extension");\n',
  );
  await writeFile(join(root, 'easyeda-bridge-extension.eext'), 'extension-archive\n');
  await writeChecksumManifest({
    root: join(root, 'easyeda-bridge-extension'),
    packagePath: join(root, 'easyeda-bridge-extension.eext'),
    manifestPath: join(root, 'easyeda-bridge-extension.checksums.json'),
  });
  await writePackageBuildManifest({ root });

  return { root, packageJson };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('package artifact policy', () => {
  it('accepts a complete, fresh, checksummed package fixture', async () => {
    const fixture = await createFixture();

    await expect(verifyPackageArtifacts({ root: fixture.root })).resolves.toMatchObject({
      ok: true,
      errors: [],
    });
  });

  it('rejects a missing built CLI entry point', async () => {
    const fixture = await createFixture();
    await rm(join(fixture.root, 'dist/index.js'));

    const result = await verifyPackageArtifacts({ root: fixture.root });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('missing required artifact: dist/index.js');
  });

  it('rejects a built CLI without the declared shebang', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, 'dist/index.js'), 'console.log("built");\n');
    await writePackageBuildManifest({ root: fixture.root });

    const result = await verifyPackageArtifacts({ root: fixture.root });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('dist/index.js must start with #!/usr/bin/env node');
  });

  it('rejects a bin target that does not point at dist/index.js', async () => {
    const fixture = await createFixture();
    const packagePath = join(fixture.root, 'package.json');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as Record<string, unknown>;
    packageJson.bin = { 'easyeda-mcp-pro': 'dist/other.js' };
    await writeJson(packagePath, packageJson);
    await writePackageBuildManifest({ root: fixture.root });

    const result = await verifyPackageArtifacts({ root: fixture.root });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'package.json bin must declare easyeda-mcp-pro -> dist/index.js',
    );
  });

  it('rejects extension product-version drift and a release-looking private workspace', async () => {
    const fixture = await createFixture();
    await writeJson(join(fixture.root, 'easyeda-bridge-extension/package.json'), {
      private: false,
      version: '1.0.0',
    });
    await writeFile(
      join(fixture.root, 'easyeda-bridge-extension/src/index.ts'),
      "const EXTENSION_INFO = { extensionVersion: '9.9.9' };\n",
    );
    await writePackageBuildManifest({ root: fixture.root });

    const result = await verifyPackageArtifacts({ root: fixture.root });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'easyeda-bridge-extension/src/index.ts EXTENSION_INFO.extensionVersion 9.9.9 does not match package.json 1.2.3',
        'easyeda-bridge-extension/package.json must remain private',
        'easyeda-bridge-extension/package.json version 1.0.0 must be 0.0.0-private',
      ]),
    );
  });

  it('rejects source and registry version drift', async () => {
    const fixture = await createFixture();
    const serverPath = join(fixture.root, 'server.json');
    const serverJson = JSON.parse(await readFile(serverPath, 'utf8')) as {
      version: string;
      packages: Array<{ version: string }>;
    };
    serverJson.version = '9.9.9';
    serverJson.packages[0]!.version = '9.9.9';
    await writeJson(serverPath, serverJson);
    await writePackageBuildManifest({ root: fixture.root });

    const result = await verifyPackageArtifacts({ root: fixture.root });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'server.json version 9.9.9 does not match package.json 1.2.3',
        'server.json packages[0].version 9.9.9 does not match package.json 1.2.3',
      ]),
    );
  });

  it('rejects a package allowlist that omits runtime, checksum, or legal files', async () => {
    const fixture = await createFixture();
    const packagePath = join(fixture.root, 'package.json');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      files: string[];
    };
    packageJson.files = packageJson.files.filter(
      (entry) =>
        entry !== 'dist' &&
        entry !== 'easyeda-bridge-extension.checksums.json' &&
        entry !== 'THIRD_PARTY_NOTICES.md',
    );
    await writeJson(packagePath, packageJson);
    await writePackageBuildManifest({ root: fixture.root });

    const result = await verifyPackageArtifacts({ root: fixture.root });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'package.json files is missing required entry: dist',
        'package.json files is missing required entry: easyeda-bridge-extension.checksums.json',
        'package.json files is missing required entry: THIRD_PARTY_NOTICES.md',
      ]),
    );
  });

  it('rejects server artifacts changed after the build manifest was written', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, 'dist/runtime.js'), 'tampered\n');

    const result = await verifyPackageArtifacts({ root: fixture.root });

    expect(result.ok).toBe(false);
    expect(
      result.errors.some((error) => error.includes('artifact sha256 mismatch: dist/runtime.js')),
    ).toBe(true);
  });

  it('rejects generated artifacts when build inputs changed after the manifest', async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.root, 'src/index.ts'),
      '#!/usr/bin/env node\nconsole.log("changed");\n',
    );

    const result = await verifyPackageArtifacts({ root: fixture.root });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('package build inputs changed after artifacts were generated');
  });

  it('rejects a tampered extension archive through its checksum manifest', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, 'easyeda-bridge-extension.eext'), 'tampered\n');

    const result = await verifyPackageArtifacts({ root: fixture.root });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('extension checksum: package sha256 mismatch');
  });

  it('removes every generated package artifact before a rebuild', async () => {
    const fixture = await createFixture();

    await removeGeneratedPackageArtifacts({ root: fixture.root });

    for (const path of [
      'dist',
      'easyeda-bridge-extension/dist',
      'easyeda-bridge-extension.eext',
      'easyeda-bridge-extension.checksums.json',
    ]) {
      await expect(readFile(join(fixture.root, path))).rejects.toThrow();
    }
  });

  it('requires every runtime and legal artifact in the npm pack file list', () => {
    const complete = [
      'package/dist/index.js',
      'package/easyeda-bridge-extension.eext',
      'package/easyeda-bridge-extension.checksums.json',
      'package/README.md',
      'package/LICENSE',
      'package/THIRD_PARTY_NOTICES.md',
      'package/config/runtime-policy.json',
      'package/scripts/check-runtime.mjs',
      'package/package.json',
    ];

    expect(verifyPackedFileList(complete)).toEqual({ ok: true, errors: [] });
    expect(verifyPackedFileList([...complete, 'package/dist/router/astar.js'])).toEqual({
      ok: false,
      errors: [
        'npm pack output contains unsupported router artifact: package/dist/router/astar.js',
      ],
    });
    expect(
      verifyPackedFileList(complete.filter((path) => !path.endsWith('THIRD_PARTY_NOTICES.md'))),
    ).toEqual({
      ok: false,
      errors: ['npm pack output is missing required file: package/THIRD_PARTY_NOTICES.md'],
    });
  });

  it('wires prepack and CI through the fail-closed package preparation path', async () => {
    const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
      files: string[];
      scripts: Record<string, string>;
    };
    const workflow = await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    const packagePrepare = await readFile(join(repoRoot, 'scripts/prepare-package.mjs'), 'utf8');
    const packedListCheck = await readFile(
      join(repoRoot, 'scripts/check-packed-file-list.mjs'),
      'utf8',
    );
    const releaseWorkflow = await readFile(
      join(repoRoot, '.github/workflows/publish-release.yml'),
      'utf8',
    );

    expect(packageJson.files).toEqual(expect.arrayContaining(REQUIRED_PACKAGE_FILE_ENTRIES));
    expect(packageJson.scripts.prepack).toBe(
      'pnpm runtime:check && node scripts/prepare-package.mjs',
    );
    expect(packageJson.scripts['package:prepare']).toBe('node scripts/prepare-package.mjs');
    expect(packageJson.scripts['package:check']).toBe('node scripts/check-package-artifacts.mjs');
    expect(packageJson.scripts['package:check-pack-list']).toBe(
      'node scripts/check-packed-file-list.mjs',
    );
    expect(packagePrepare).toContain('function runExecutable(command, args)');
    expect(packagePrepare).toContain('spawnSync(command, args');
    expect(packagePrepare).toContain("spawnSync('cmd.exe', ['/d', '/s', '/c', 'pnpm.cmd', script]");
    expect(packagePrepare).toContain("runPnpmScript('build')");
    expect(packagePrepare).toContain("runPnpmScript('build:extension')");
    expect(packagePrepare).not.toContain('process.env.ComSpec');
    expect(packagePrepare).not.toContain('windowsCommandShell');
    expect(packedListCheck).toContain("'node_modules', 'npm', 'bin', 'npm-cli.js'");
    expect(packedListCheck).toContain('spawnSync(process.execPath, [npmCli, ...npmArgs]');
    expect(packedListCheck).not.toContain('process.env.ComSpec');
    expect(packedListCheck).not.toContain("'/d', '/s', '/c'");
    expect(workflow).toContain('pnpm package:prepare');
    expect(workflow).toContain('easyeda-bridge-extension.checksums.json');
    expect(workflow).not.toContain(
      'easyeda-bridge-extension/easyeda-bridge-extension.checksums.json',
    );
    expect(releaseWorkflow).toContain('pnpm package:prepare');
  });

  it('keeps the build manifest outside the source fingerprint and inside dist', () => {
    expect(PACKAGE_BUILD_MANIFEST_PATH).toBe('dist/package-build-manifest.json');
  });
});
