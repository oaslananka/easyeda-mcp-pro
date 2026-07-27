import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { getReproducibleDate } from './reproducible-time.mjs';

export const CHECKSUM_MANIFEST_NAME = 'easyeda-bridge-extension.checksums.json';

async function sha256File(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function normalizePath(path) {
  return path.split(sep).join('/');
}

function comparePaths(left, right) {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return 0;
}

async function collectFiles(root, entry) {
  const abs = join(root, entry);
  if (!existsSync(abs)) return [];
  const info = await stat(abs);
  if (info.isFile()) return [abs];
  if (!info.isDirectory()) return [];
  const children = await readdir(abs);
  const nested = await Promise.all(children.map((child) => collectFiles(root, join(entry, child))));
  return nested.flat();
}

export async function collectExtensionFiles(root) {
  const files = [];
  for (const entry of ['extension.json', 'dist', 'images', 'locales']) {
    files.push(...(await collectFiles(root, entry)));
  }
  return files.sort((left, right) => comparePaths(relative(root, left), relative(root, right)));
}

export async function createChecksumManifest({ root, packagePath, generatedAt }) {
  const packageInfo = await stat(packagePath);
  const files = [];
  for (const file of await collectExtensionFiles(root)) {
    const info = await stat(file);
    files.push({
      path: normalizePath(relative(root, file)),
      size: info.size,
      sha256: await sha256File(file),
    });
  }
  return {
    schemaVersion: 1,
    generatedAt: generatedAt ?? getReproducibleDate({ root }).toISOString(),
    package: normalizePath(relative(join(root, '..'), packagePath)),
    packageSize: packageInfo.size,
    packageSha256: await sha256File(packagePath),
    files,
  };
}

export async function writeChecksumManifest({ root, packagePath, manifestPath, generatedAt }) {
  const manifest = await createChecksumManifest({ root, packagePath, generatedAt });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export async function verifyChecksumManifest({ root, packagePath, manifestPath }) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const errors = [];
  const packageInfo = await stat(packagePath);
  const packageSha256 = await sha256File(packagePath);
  if (manifest.packageSize !== packageInfo.size) errors.push('package size mismatch');
  if (manifest.packageSha256 !== packageSha256) errors.push('package sha256 mismatch');

  const expectedFiles = new Map(manifest.files.map((entry) => [entry.path, entry]));
  for (const file of await collectExtensionFiles(root)) {
    const rel = normalizePath(relative(root, file));
    const expected = expectedFiles.get(rel);
    if (!expected) {
      errors.push(`missing manifest entry: ${rel}`);
      continue;
    }
    const info = await stat(file);
    const sha256 = await sha256File(file);
    if (expected.size !== info.size) errors.push(`size mismatch: ${rel}`);
    if (expected.sha256 !== sha256) errors.push(`sha256 mismatch: ${rel}`);
    expectedFiles.delete(rel);
  }
  for (const rel of expectedFiles.keys()) {
    errors.push(`manifest file missing on disk: ${rel}`);
  }
  return { ok: errors.length === 0, errors, manifest };
}
