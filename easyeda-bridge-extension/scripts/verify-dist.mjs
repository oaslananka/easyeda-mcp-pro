import { existsSync, readFileSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { CHECKSUM_MANIFEST_NAME, verifyChecksumManifest } from './checksums.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');

const required = ['dist/index.js', 'extension.json', 'images/logo.png'];
const marketplaceSourceFiles = ['README.md', 'CHANGELOG.md'];

function readPngDimensions(path) {
  const buffer = readFileSync(path);
  const pngSignature = '89504e470d0a1a0a';
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== pngSignature) {
    throw new Error('not a PNG file');
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function findPhoneLikeContent(text) {
  const matches = [];
  const phoneLikePattern = /(?:\+?\d[\s().:-]*){7,}\d/g;
  for (const match of text.matchAll(phoneLikePattern)) {
    const raw = match[0];
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 7) matches.push(raw.trim());
  }
  return matches;
}

let ok = true;
for (const f of required) {
  const p = join(root, f);
  if (!existsSync(p)) {
    console.error(`MISSING: ${f}`);
    ok = false;
  } else {
    const size = statSync(p).size;
    if (size === 0) {
      console.error(`EMPTY FILE: ${f}`);
      ok = false;
    } else {
      console.log(`OK: ${f} (${size} bytes)`);
    }
  }
}

for (const f of marketplaceSourceFiles) {
  const p = join(root, f);
  if (!existsSync(p)) {
    console.error(`MISSING MARKETPLACE SOURCE FILE: ${f}`);
    ok = false;
  } else {
    const size = statSync(p).size;
    if (size === 0) {
      console.error(`EMPTY MARKETPLACE SOURCE FILE: ${f}`);
      ok = false;
    } else {
      console.log(`OK: marketplace source file ${f} (${size} bytes)`);
      const phoneLikeMatches = findPhoneLikeContent(readFileSync(p, 'utf8'));
      if (phoneLikeMatches.length > 0) {
        console.error(`MARKETPLACE SOURCE FILE HAS PHONE-LIKE CONTENT: ${f}`);
        for (const match of phoneLikeMatches.slice(0, 5)) console.error(`  ${match}`);
        ok = false;
      }
    }
  }
}

const manifestPath = join(root, 'extension.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entry = typeof manifest.entry === 'string' ? manifest.entry : '';
const normalizedEntry = entry.replace(/^\.\//, '');
const entryCandidates = [normalizedEntry, `${normalizedEntry}.js`];
if (!entry || !entryCandidates.some((candidate) => existsSync(join(root, candidate)))) {
  console.error(`INVALID ENTRY: ${entry || '<missing>'}`);
  ok = false;
} else {
  console.log(`OK: manifest entry (${entry})`);
}

const marketplaceRequiredManifestFields = [
  'name',
  'uuid',
  'displayName',
  'description',
  'version',
  'publisher',
  'license',
  'categories',
  'keywords',
  'images',
  'entry',
  'repository',
  'homepage',
  'bugs',
];
for (const field of marketplaceRequiredManifestFields) {
  if (manifest[field] === undefined || manifest[field] === null || manifest[field] === '') {
    console.error(`MISSING MARKETPLACE MANIFEST FIELD: ${field}`);
    ok = false;
  }
}

if (typeof manifest.description !== 'string' || manifest.description.length < 80) {
  console.error('MARKETPLACE DESCRIPTION TOO SHORT: expected at least 80 characters');
  ok = false;
} else {
  console.log(`OK: marketplace description (${manifest.description.length} chars)`);
}

if (!Array.isArray(manifest.keywords) || manifest.keywords.length < 5) {
  console.error('MARKETPLACE KEYWORDS TOO SHORT: expected at least 5 keywords');
  ok = false;
} else {
  console.log(`OK: marketplace keywords (${manifest.keywords.length})`);
}

if (typeof manifest.bugs !== 'string' || !/^https?:\/\//.test(manifest.bugs)) {
  console.error('MARKETPLACE BUGS FIELD INVALID: expected an HTTP(S) URL string');
  ok = false;
} else {
  console.log('OK: marketplace bugs URL string');
}

const logoPath = join(root, 'images', 'logo.png');
try {
  const { width, height } = readPngDimensions(logoPath);
  const probe = `${width}x${height}`;
  if (width < 200 || height < 200) {
    console.error(`MARKETPLACE LOGO TOO SMALL: ${probe}; expected at least 200x200`);
    ok = false;
  } else if (width !== height) {
    console.error(`MARKETPLACE LOGO NOT SQUARE: ${probe}`);
    ok = false;
  } else {
    console.log(`OK: marketplace logo size (${probe})`);
  }
} catch (error) {
  console.error(`FAILED TO INSPECT MARKETPLACE LOGO: ${error}`);
  ok = false;
}

const packagePath = join(root, '..', 'easyeda-bridge-extension.eext');
const checksumPath = join(root, '..', CHECKSUM_MANIFEST_NAME);
if (!existsSync(packagePath)) {
  console.error('MISSING: easyeda-bridge-extension.eext');
  ok = false;
}
if (!existsSync(checksumPath)) {
  console.error(`MISSING: ${CHECKSUM_MANIFEST_NAME}`);
  ok = false;
}
if (existsSync(packagePath) && existsSync(checksumPath)) {
  const result = await verifyChecksumManifest({ root, packagePath, manifestPath: checksumPath });
  if (!result.ok) {
    for (const error of result.errors) console.error(`CHECKSUM: ${error}`);
    ok = false;
  } else {
    console.log(`OK: ${CHECKSUM_MANIFEST_NAME}`);
  }
}

if (existsSync(packagePath)) {
  try {
    const listing = execFileSync('python3', ['-m', 'zipfile', '-l', packagePath], {
      encoding: 'utf8',
    });
    for (const packagedFile of [
      'README.md',
      'CHANGELOG.md',
      'extension.json',
      'dist/index.js',
      'images/logo.png',
    ]) {
      if (!listing.includes(packagedFile)) {
        console.error(`PACKAGE MISSING MARKETPLACE FILE: ${packagedFile}`);
        ok = false;
      } else {
        console.log(`OK: packaged marketplace file ${packagedFile}`);
      }
    }

    const packageContent = execFileSync(
      'python3',
      [
        '-c',
        "import sys, zipfile; z=zipfile.ZipFile(sys.argv[1]); files=['README.md','CHANGELOG.md','extension.json','dist/index.js']; print('\\n'.join(z.read(f).decode('utf-8', 'ignore') for f in files))",
        packagePath,
      ],
      { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 },
    );
    const packagePhoneLikeMatches = findPhoneLikeContent(packageContent);
    if (packagePhoneLikeMatches.length > 0) {
      console.error('PACKAGE HAS PHONE-LIKE CONTENT');
      for (const match of packagePhoneLikeMatches.slice(0, 10)) console.error(`  ${match}`);
      ok = false;
    } else {
      console.log('OK: package has no phone-like content');
    }
  } catch (error) {
    console.error(`FAILED TO INSPECT EXTENSION PACKAGE: ${error}`);
    ok = false;
  }
}

if (!ok) process.exit(1);
console.log('\nDist verification successful ✓');
