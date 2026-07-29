import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { verifyChecksumManifest } from '../easyeda-bridge-extension/scripts/checksums.mjs';
import { collectExtensionMetadataErrors } from './extension-metadata-policy.mjs';

export const PACKAGE_BUILD_MANIFEST_PATH = 'dist/package-build-manifest.json';
export const REQUIRED_PACKAGE_FILE_ENTRIES = [
  'dist',
  'easyeda-bridge-extension.eext',
  'easyeda-bridge-extension.checksums.json',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'config/runtime-policy.json',
  'scripts/check-runtime.mjs',
];

const FORBIDDEN_PACKED_PREFIXES = ['package/dist/router/'];

const REQUIRED_PACKED_FILES = [
  'package/package.json',
  'package/dist/index.js',
  'package/easyeda-bridge-extension.eext',
  'package/easyeda-bridge-extension.checksums.json',
  'package/README.md',
  'package/LICENSE',
  'package/THIRD_PARTY_NOTICES.md',
  'package/config/runtime-policy.json',
  'package/scripts/check-runtime.mjs',
];

const GENERATED_PACKAGE_ARTIFACTS = [
  'dist',
  'easyeda-bridge-extension/dist',
  'easyeda-bridge-extension.eext',
  'easyeda-bridge-extension.checksums.json',
];

const PACKAGE_SOURCE_ENTRIES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'server.json',
  'tsconfig.json',
  'tsconfig.build.json',
  '.claude-plugin/plugin.json',
  'config/runtime-policy.json',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'src',
  'scripts',
  'easyeda-bridge-extension/package.json',
  'easyeda-bridge-extension/extension.json',
  'easyeda-bridge-extension/tsconfig.json',
  'easyeda-bridge-extension/README.md',
  'easyeda-bridge-extension/CHANGELOG.md',
  'easyeda-bridge-extension/src',
  'easyeda-bridge-extension/scripts',
  'easyeda-bridge-extension/images',
  'easyeda-bridge-extension/locales',
];

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
  const absolute = resolve(root, entry);
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

async function sha256File(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function describeFile(root, path) {
  const information = await stat(path);
  return {
    path: normalizePath(relative(root, path)),
    size: information.size,
    sha256: await sha256File(path),
  };
}

async function collectSourceFiles(root) {
  const collected = [];
  for (const entry of PACKAGE_SOURCE_ENTRIES) {
    collected.push(...(await collectFiles(root, entry)));
  }
  const manifestAbsolute = resolve(root, PACKAGE_BUILD_MANIFEST_PATH);
  return [...new Set(collected.map((path) => resolve(path)))]
    .filter((path) => path !== manifestAbsolute)
    .sort((left, right) => comparePaths(relative(root, left), relative(root, right)));
}

async function computeSourceSha256(root) {
  const hash = createHash('sha256');
  for (const path of await collectSourceFiles(root)) {
    hash.update(normalizePath(relative(root, path)));
    hash.update('\0');
    hash.update(await readFile(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function collectBuiltArtifacts(root) {
  const files = await collectFiles(root, 'dist');
  const manifestAbsolute = resolve(root, PACKAGE_BUILD_MANIFEST_PATH);
  const artifactFiles = files.filter((path) => resolve(path) !== manifestAbsolute);
  for (const entry of [
    'easyeda-bridge-extension.eext',
    'easyeda-bridge-extension.checksums.json',
  ]) {
    const absolute = resolve(root, entry);
    if (existsSync(absolute)) artifactFiles.push(absolute);
  }
  return [...new Set(artifactFiles.map((path) => resolve(path)))].sort((left, right) =>
    comparePaths(relative(root, left), relative(root, right)),
  );
}

async function readJson(path, errors, display) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    errors.push(
      `unable to read ${display}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

async function requireNonEmptyFile(root, entry, errors) {
  const absolute = resolve(root, entry);
  if (!existsSync(absolute)) {
    errors.push(`missing required artifact: ${entry}`);
    return false;
  }
  const information = await stat(absolute);
  if (!information.isFile() || information.size === 0) {
    errors.push(`required artifact is empty: ${entry}`);
    return false;
  }
  return true;
}

function parseSourceVersion(source) {
  return source.match(/SERVER_VERSION\s*=\s*'([^']+)'/)?.[1];
}

export async function createPackageBuildManifest({ root }) {
  const resolvedRoot = resolve(root);
  const packageJson = JSON.parse(await readFile(join(resolvedRoot, 'package.json'), 'utf8'));
  const artifacts = [];
  for (const path of await collectBuiltArtifacts(resolvedRoot)) {
    artifacts.push(await describeFile(resolvedRoot, path));
  }
  return {
    schemaVersion: 1,
    packageVersion: packageJson.version,
    sourceSha256: await computeSourceSha256(resolvedRoot),
    artifacts,
  };
}

export async function writePackageBuildManifest({ root }) {
  const resolvedRoot = resolve(root);
  const manifest = await createPackageBuildManifest({ root: resolvedRoot });
  const path = resolve(resolvedRoot, PACKAGE_BUILD_MANIFEST_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export async function removeGeneratedPackageArtifacts({ root }) {
  const resolvedRoot = resolve(root);
  await Promise.all(
    GENERATED_PACKAGE_ARTIFACTS.map((entry) =>
      rm(resolve(resolvedRoot, entry), { recursive: true, force: true }),
    ),
  );
}

export function verifyPackedFileList(files) {
  const normalized = new Set(
    files.map((path) => {
      const normalizedPath = normalizePath(path).replace(/^\.\//, '');
      return normalizedPath.startsWith('package/') ? normalizedPath : `package/${normalizedPath}`;
    }),
  );
  const errors = REQUIRED_PACKED_FILES.filter((path) => !normalized.has(path)).map(
    (path) => `npm pack output is missing required file: ${path}`,
  );
  for (const path of [...normalized].sort(comparePaths)) {
    if (FORBIDDEN_PACKED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      errors.push(`npm pack output contains unsupported router artifact: ${path}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function formatUnknownError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function verifyRequiredArtifacts(root, errors) {
  for (const entry of REQUIRED_PACKAGE_FILE_ENTRIES) {
    if (entry === 'dist') continue;
    await requireNonEmptyFile(root, entry, errors);
  }
  await requireNonEmptyFile(root, 'dist/index.js', errors);
}

function verifyPackageDeclaration(packageJson, errors) {
  if (!packageJson) return;
  const bin = packageJson.bin;
  const validBin =
    bin &&
    typeof bin === 'object' &&
    !Array.isArray(bin) &&
    Object.keys(bin).length === 1 &&
    bin['easyeda-mcp-pro'] === 'dist/index.js';
  if (!validBin) {
    errors.push('package.json bin must declare easyeda-mcp-pro -> dist/index.js');
  }

  const files = Array.isArray(packageJson.files) ? packageJson.files : [];
  for (const required of REQUIRED_PACKAGE_FILE_ENTRIES) {
    if (!files.includes(required)) {
      errors.push(`package.json files is missing required entry: ${required}`);
    }
  }
}

async function verifyCliEntry(root, errors) {
  const cliPath = join(root, 'dist/index.js');
  if (!existsSync(cliPath)) return;
  const cli = await readFile(cliPath, 'utf8');
  if (!cli.startsWith('#!/usr/bin/env node')) {
    errors.push('dist/index.js must start with #!/usr/bin/env node');
  }
}

function verifyServerMetadata(packageJson, serverJson, errors) {
  if (!packageJson || !serverJson) return;
  if (serverJson.version !== packageJson.version) {
    errors.push(
      `server.json version ${String(serverJson.version)} does not match package.json ${String(packageJson.version)}`,
    );
  }

  const serverPackage = serverJson.packages?.[0];
  if (serverPackage?.version !== packageJson.version) {
    errors.push(
      `server.json packages[0].version ${String(serverPackage?.version)} does not match package.json ${String(packageJson.version)}`,
    );
  }
  if (serverPackage?.identifier !== packageJson.name) {
    errors.push(
      `server.json packages[0].identifier ${String(serverPackage?.identifier)} does not match package.json name ${String(packageJson.name)}`,
    );
  }
  if (serverJson.name !== packageJson.mcpName) {
    errors.push(
      `server.json name ${String(serverJson.name)} does not match package.json mcpName ${String(packageJson.mcpName)}`,
    );
  }
}

async function verifySourceVersion(root, packageJson, errors) {
  const versionSourcePath = join(root, 'src/config/version.ts');
  if (!existsSync(versionSourcePath)) {
    errors.push('missing required package metadata: src/config/version.ts');
    return;
  }
  if (!packageJson) return;

  const sourceVersion = parseSourceVersion(await readFile(versionSourcePath, 'utf8'));
  if (sourceVersion !== packageJson.version) {
    errors.push(
      `src/config/version.ts SERVER_VERSION ${String(sourceVersion)} does not match package.json ${String(packageJson.version)}`,
    );
  }
}

async function verifyExtensionChecksum(root, errors) {
  const packagePath = join(root, 'easyeda-bridge-extension.eext');
  const manifestPath = join(root, 'easyeda-bridge-extension.checksums.json');
  if (!existsSync(packagePath) || !existsSync(manifestPath)) return;

  try {
    const checksum = await verifyChecksumManifest({
      root: join(root, 'easyeda-bridge-extension'),
      packagePath,
      manifestPath,
    });
    for (const error of checksum.errors) {
      errors.push(`extension checksum: ${error}`);
    }
  } catch (error) {
    errors.push(`unable to verify extension checksum manifest: ${formatUnknownError(error)}`);
  }
}

function createExpectedArtifactMap(buildManifest) {
  if (!Array.isArray(buildManifest.artifacts)) return new Map();
  return new Map(buildManifest.artifacts.map((artifact) => [artifact.path, artifact]));
}

async function verifyArtifactHashes(root, buildManifest, errors) {
  const expectedArtifacts = createExpectedArtifactMap(buildManifest);
  for (const path of await collectBuiltArtifacts(root)) {
    const actual = await describeFile(root, path);
    const expected = expectedArtifacts.get(actual.path);
    if (!expected) {
      errors.push(`package build manifest is missing artifact: ${actual.path}`);
      continue;
    }
    if (expected.size !== actual.size) {
      errors.push(`artifact size mismatch: ${actual.path}`);
    }
    if (expected.sha256 !== actual.sha256) {
      errors.push(`artifact sha256 mismatch: ${actual.path}`);
    }
    expectedArtifacts.delete(actual.path);
  }

  for (const path of expectedArtifacts.keys()) {
    errors.push(`package build manifest artifact is missing on disk: ${path}`);
  }
}

async function verifyBuildManifest(root, packageJson, errors) {
  const buildManifest = await readJson(
    resolve(root, PACKAGE_BUILD_MANIFEST_PATH),
    errors,
    PACKAGE_BUILD_MANIFEST_PATH,
  );
  if (!buildManifest) return;

  if (buildManifest.schemaVersion !== 1) {
    errors.push(
      `unsupported package build manifest schema: ${String(buildManifest.schemaVersion)}`,
    );
  }
  if (packageJson && buildManifest.packageVersion !== packageJson.version) {
    errors.push(
      `package build manifest version ${String(buildManifest.packageVersion)} does not match package.json ${String(packageJson.version)}`,
    );
  }
  if (buildManifest.sourceSha256 !== (await computeSourceSha256(root))) {
    errors.push('package build inputs changed after artifacts were generated');
  }
  await verifyArtifactHashes(root, buildManifest, errors);
}

export async function verifyPackageArtifacts({ root }) {
  const resolvedRoot = resolve(root);
  const errors = [];
  const packageJson = await readJson(join(resolvedRoot, 'package.json'), errors, 'package.json');
  const serverJson = await readJson(join(resolvedRoot, 'server.json'), errors, 'server.json');
  const extensionJson = await readJson(
    join(resolvedRoot, 'easyeda-bridge-extension/extension.json'),
    errors,
    'easyeda-bridge-extension/extension.json',
  );
  const pluginJson = await readJson(
    join(resolvedRoot, '.claude-plugin/plugin.json'),
    errors,
    '.claude-plugin/plugin.json',
  );
  const extensionPackageJson = await readJson(
    join(resolvedRoot, 'easyeda-bridge-extension/package.json'),
    errors,
    'easyeda-bridge-extension/package.json',
  );
  const extensionSourcePath = join(resolvedRoot, 'easyeda-bridge-extension/src/index.ts');
  const extensionSource = existsSync(extensionSourcePath)
    ? await readFile(extensionSourcePath, 'utf8')
    : undefined;

  await verifyRequiredArtifacts(resolvedRoot, errors);
  verifyPackageDeclaration(packageJson, errors);
  await verifyCliEntry(resolvedRoot, errors);
  verifyServerMetadata(packageJson, serverJson, errors);
  if (packageJson) {
    errors.push(
      ...collectExtensionMetadataErrors({
        productVersion: packageJson.version,
        extensionManifest: extensionJson,
        pluginManifest: pluginJson,
        extensionPackage: extensionPackageJson,
        extensionSource,
      }),
    );
  }
  await verifySourceVersion(resolvedRoot, packageJson, errors);
  await verifyExtensionChecksum(resolvedRoot, errors);
  await verifyBuildManifest(resolvedRoot, packageJson, errors);

  return { ok: errors.length === 0, errors };
}
