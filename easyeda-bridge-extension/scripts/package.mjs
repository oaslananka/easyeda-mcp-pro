import { ZipArchive } from 'archiver';
import { createWriteStream } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CHECKSUM_MANIFEST_NAME, writeChecksumManifest } from './checksums.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const root = join(__dirname, '..');
const packagePath = join(root, '..', 'easyeda-bridge-extension.eext');
const manifestPath = join(root, '..', CHECKSUM_MANIFEST_NAME);
const output = createWriteStream(packagePath);
const archive = new ZipArchive({ zlib: { level: 9 } });

archive.pipe(output);
archive.file(join(root, 'extension.json'), { name: 'extension.json' });
archive.file(join(root, 'README.md'), { name: 'README.md' });
archive.file(join(root, 'CHANGELOG.md'), { name: 'CHANGELOG.md' });
archive.directory(join(root, 'dist'), 'dist');
archive.directory(join(root, 'images'), 'images');
archive.directory(join(root, 'locales'), 'locales');

output.on('close', async () => {
  const manifest = await writeChecksumManifest({ root, packagePath, manifestPath });
  console.log(`Package ready: ${archive.pointer()} bytes`);
  console.log('File: easyeda-bridge-extension.eext');
  console.log(`Checksum: ${manifest.packageSha256}`);
  console.log(`Manifest: ${CHECKSUM_MANIFEST_NAME}`);
});
archive.finalize();
