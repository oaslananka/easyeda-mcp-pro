import { ZipArchive } from 'archiver';
import { createWriteStream, existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

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
  const absolute = join(root, entry);
  if (!existsSync(absolute)) return [];
  const information = await stat(absolute);
  if (information.isFile()) return [absolute];
  if (!information.isDirectory()) return [];
  const children = await readdir(absolute);
  const nested = await Promise.all(
    children.sort(comparePaths).map((child) => collectFiles(root, join(entry, child))),
  );
  return nested.flat();
}

export async function collectExtensionPackageFiles(root) {
  const files = [];
  for (const entry of [
    'extension.json',
    'README.md',
    'CHANGELOG.md',
    'dist',
    'images',
    'locales',
  ]) {
    files.push(...(await collectFiles(root, entry)));
  }
  return files.sort((left, right) => comparePaths(relative(root, left), relative(root, right)));
}

export async function writeExtensionArchive({ root, packagePath, date }) {
  const output = createWriteStream(packagePath);
  const archive = new ZipArchive({
    zlib: { level: 9 },
    forceLocalTime: false,
  });
  archive.pipe(output);

  const completed = new Promise((resolve, reject) => {
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
  });

  for (const path of await collectExtensionPackageFiles(root)) {
    archive.append(await readFile(path), {
      name: normalizePath(relative(root, path)),
      date,
      mode: 0o644,
    });
  }

  await archive.finalize();
  await completed;
  return archive.pointer();
}
