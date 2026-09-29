import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectExtensionPackageFiles,
  writeExtensionArchive,
} from '../../../easyeda-bridge-extension/scripts/archive.mjs';
import { resolveReproducibleEpochSeconds } from '../../../easyeda-bridge-extension/scripts/reproducible-time.mjs';

const temporaryRoots: string[] = [];

async function sha256(path: string) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function createFixture() {
  const root = join(tmpdir(), `easyeda-reproducible-archive-${Date.now()}-${Math.random()}`);
  temporaryRoots.push(root);
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(join(root, 'images'), { recursive: true });
  await writeFile(join(root, 'extension.json'), '{"entry":"dist/index"}\n');
  await writeFile(join(root, 'README.md'), '# Extension\n');
  await writeFile(join(root, 'CHANGELOG.md'), '# Changes\n');
  await writeFile(join(root, 'dist/index.js'), 'console.log("extension");\n');
  await writeFile(join(root, 'images/logo.png'), 'png\n');
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('reproducible extension archive', () => {
  it('collects files in deterministic path order and ignores absent optional locales', async () => {
    const root = await createFixture();

    await expect(collectExtensionPackageFiles(root)).resolves.toEqual([
      join(root, 'CHANGELOG.md'),
      join(root, 'README.md'),
      join(root, 'dist/index.js'),
      join(root, 'extension.json'),
      join(root, 'images/logo.png'),
    ]);
  });

  it('produces identical archives for identical inputs and epoch', async () => {
    const root = await createFixture();
    const outputRoot = join(root, 'archive-output');
    await mkdir(outputRoot, { recursive: true });
    const first = join(outputRoot, 'first.eext');
    const second = join(outputRoot, 'second.eext');
    const date = new Date(1700000000 * 1000);

    await writeExtensionArchive({ root, packagePath: first, date });
    await writeExtensionArchive({ root, packagePath: second, date });

    expect(await sha256(first)).toBe(await sha256(second));
  });

  it('keeps archive bytes stable across different squash-equivalent Git commit timestamps', async () => {
    const root = await createFixture();
    const outputRoot = join(root, 'commit-independent-output');
    await mkdir(outputRoot, { recursive: true });
    const first = join(outputRoot, 'first.eext');
    const second = join(outputRoot, 'second.eext');

    const buildArchive = async (gitCommitEpoch: string, output: string) => {
      const epoch = resolveReproducibleEpochSeconds({
        sourceDateEpoch: undefined,
        gitCommitEpoch,
      });
      const date = new Date(epoch * 1000);
      await writeFile(
        join(root, 'dist/dispatcher.meta.json'),
        `${JSON.stringify({ buildId: 'dtest', builtAt: date.toISOString() }, null, 2)}
`,
      );
      await writeExtensionArchive({ root, packagePath: output, date });
    };

    await buildArchive('1600000000', first);
    await buildArchive('1700000000', second);

    expect(await sha256(first)).toBe(await sha256(second));
  });
});
