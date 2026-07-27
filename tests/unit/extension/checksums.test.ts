import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectExtensionFiles,
  createChecksumManifest,
  verifyChecksumManifest,
  writeChecksumManifest,
} from '../../../easyeda-bridge-extension/scripts/checksums.mjs';

async function createFixture() {
  const root = join(tmpdir(), `easyeda-extension-${Date.now()}-${Math.random()}`);
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(join(root, 'images'), { recursive: true });
  await mkdir(join(root, 'locales'), { recursive: true });
  await writeFile(join(root, 'extension.json'), '{"entry":"dist/index"}\n', 'utf8');
  await writeFile(join(root, 'dist', 'index.js'), 'console.log("bridge");\n', 'utf8');
  await writeFile(join(root, 'images', 'logo.png'), 'png\n', 'utf8');
  await writeFile(join(root, 'locales', 'en.json'), '{}\n', 'utf8');
  const packagePath = join(root, '..', 'easyeda-bridge-extension.eext');
  const manifestPath = join(root, '..', 'easyeda-bridge-extension.checksums.json');
  await writeFile(packagePath, 'zip-bytes\n', 'utf8');
  return { root, packagePath, manifestPath };
}

describe('extension checksum manifest', () => {
  it('collects deterministic package file entries', async () => {
    const fixture = await createFixture();

    await expect(collectExtensionFiles(fixture.root)).resolves.toEqual([
      join(fixture.root, 'dist', 'index.js'),
      join(fixture.root, 'extension.json'),
      join(fixture.root, 'images', 'logo.png'),
      join(fixture.root, 'locales', 'en.json'),
    ]);
  });

  it('creates and verifies a checksum manifest', async () => {
    const fixture = await createFixture();
    const generatedAt = '2023-11-14T22:13:20.000Z';
    const manifest = await createChecksumManifest({ ...fixture, generatedAt });

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.generatedAt).toBe(generatedAt);
    expect(manifest.packageSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.files.map((file) => file.path)).toContain('dist/index.js');

    await writeChecksumManifest(fixture);
    await expect(verifyChecksumManifest(fixture)).resolves.toMatchObject({ ok: true, errors: [] });
  });

  it('detects tampered files', async () => {
    const fixture = await createFixture();
    await writeChecksumManifest(fixture);
    await writeFile(join(fixture.root, 'dist', 'index.js'), 'tampered\n', 'utf8');

    const result = await verifyChecksumManifest(fixture);

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('dist/index.js'))).toBe(true);
  });
});
