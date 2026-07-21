import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CONFIG = 'config/codecov-cli.json';
const MAX_BINARY_BYTES = 20 * 1024 * 1024;

const parseArgs = (argv) => {
  const options = {
    config: DEFAULT_CONFIG,
    output: undefined,
    allowFileUrl: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--allow-file-url') {
      options.allowFileUrl = true;
      continue;
    }
    if (argument !== '--config' && argument !== '--output') {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`missing value for ${argument}`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }

  if (!options.output) {
    throw new Error('--output is required');
  }

  return options;
};

const loadConfig = async (configPath) => {
  const parsed = JSON.parse(await readFile(configPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Codecov CLI config must be a JSON object');
  }

  const { version, asset, url, size, sha256 } = parsed;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('Codecov CLI version must be an exact semantic version');
  }
  if (asset !== 'codecovcli_linux') {
    throw new Error('Codecov CLI asset must be codecovcli_linux');
  }
  if (typeof url !== 'string') {
    throw new TypeError('Codecov CLI URL must be a string');
  }
  if (!Number.isInteger(size) || size <= 0 || size > MAX_BINARY_BYTES) {
    throw new Error(`invalid Codecov CLI byte size: ${String(size)}`);
  }
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Codecov CLI SHA-256 must be 64 lowercase hexadecimal characters');
  }

  return { version, asset, url, size, sha256 };
};

const validateSourceUrl = (config, allowFileUrl) => {
  const sourceUrl = new URL(config.url);
  const expectedPath = `/codecov/codecov-cli/releases/download/v${config.version}/${config.asset}`;
  const isPinnedGithubRelease =
    sourceUrl.protocol === 'https:' &&
    sourceUrl.hostname === 'github.com' &&
    sourceUrl.pathname === expectedPath &&
    sourceUrl.search === '' &&
    sourceUrl.hash === '';
  const isAllowedFixture = allowFileUrl && sourceUrl.protocol === 'file:';

  if (!isPinnedGithubRelease && !isAllowedFixture) {
    throw new Error('Only the pinned Codecov GitHub release URL is allowed');
  }

  return sourceUrl;
};

const download = async (sourceUrl) => {
  if (sourceUrl.protocol === 'file:') {
    return readFile(fileURLToPath(sourceUrl));
  }

  const response = await fetch(sourceUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
    headers: { 'user-agent': 'easyeda-mcp-pro-codecov-installer' },
  });
  if (!response.ok) {
    throw new Error(`Codecov CLI download failed with HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_BINARY_BYTES) {
    throw new Error(`Codecov CLI download is unexpectedly large: ${contentLength} bytes`);
  }

  const payload = Buffer.from(await response.arrayBuffer());
  if (payload.byteLength > MAX_BINARY_BYTES) {
    throw new Error(`Codecov CLI download is unexpectedly large: ${payload.byteLength} bytes`);
  }
  return payload;
};

try {
  const options = parseArgs(process.argv.slice(2));
  const configPath = resolve(options.config);
  const outputPath = resolve(options.output);
  const config = await loadConfig(configPath);
  const sourceUrl = validateSourceUrl(config, options.allowFileUrl);
  const payload = await download(sourceUrl);

  if (payload.byteLength !== config.size) {
    throw new Error(
      `Codecov CLI size mismatch: expected ${config.size}, received ${payload.byteLength}`,
    );
  }

  const digest = createHash('sha256').update(payload).digest('hex');
  if (digest !== config.sha256) {
    throw new Error(`Codecov CLI SHA-256 mismatch: expected ${config.sha256}, received ${digest}`);
  }

  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await rm(temporaryPath, { force: true });
  try {
    await writeFile(temporaryPath, payload, { flag: 'wx', mode: 0o755 });
    await chmod(temporaryPath, 0o755);
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }

  console.log(`Installed Codecov CLI ${config.version} (${digest})`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
