import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeExtensionArchive } from './archive.mjs';
import { CHECKSUM_MANIFEST_NAME, writeChecksumManifest } from './checksums.mjs';
import { getReproducibleDate } from './reproducible-time.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');
const packagePath = join(root, '..', 'easyeda-bridge-extension.eext');
const manifestPath = join(root, '..', CHECKSUM_MANIFEST_NAME);
const reproducibleDate = getReproducibleDate({ root });

const packageSize = await writeExtensionArchive({
  root,
  packagePath,
  date: reproducibleDate,
});
const manifest = await writeChecksumManifest({
  root,
  packagePath,
  manifestPath,
  generatedAt: reproducibleDate.toISOString(),
});
console.log(`Package ready: ${packageSize} bytes`);
console.log('File: easyeda-bridge-extension.eext');
console.log(`Checksum: ${manifest.packageSha256}`);
console.log(`Manifest: ${CHECKSUM_MANIFEST_NAME}`);
