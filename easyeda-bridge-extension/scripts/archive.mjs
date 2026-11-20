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

export function prepareExtensionPackageContent(name, data) {
  // Keep the editable source manifest readable but avoid publishing its whitespace.
  // The EasyEDA loader consumes JSON, not the source file's formatting.
  if (name === 'extension.json') {
    return Buffer.from(JSON.stringify(JSON.parse(data.toString('utf8'))), 'utf8');
  }

  // Windows autocrlf must not change package bytes or their release checksums.
  if (name === 'README.md' || name === 'CHANGELOG.md') {
    return Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  }

  return data;
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
    const name = normalizePath(relative(root, path));
    const data = await readFile(path);
    const packagedData = prepareExtensionPackageContent(name, data);
    archive.append(packagedData, {
      name,
      date,
      mode: 0o644,
    });
  }

  await archive.finalize();
  await completed;
  return archive.pointer();
}
