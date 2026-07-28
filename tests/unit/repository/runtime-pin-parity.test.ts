import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const checker = resolve(repoRoot, 'scripts/check-runtime-pins.mjs');
const temporaryRoots: string[] = [];

async function write(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function writeJson(path: string, value: unknown) {
  await write(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function createCanonicalFixture() {
  const root = await mkdtemp(join(tmpdir(), 'runtime-pin-parity-'));
  temporaryRoots.push(root);
  const nodeVersion = '24.18.0';
  const pnpmVersion = '11.5.1';
  const nodeImage = 'node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd';

  await writeJson(join(root, 'config/runtime-policy.json'), {
    schemaVersion: 2,
    node: {
      supportedMajor: 24,
      pinnedVersion: nodeVersion,
    },
    pnpm: {
      pinnedVersion: pnpmVersion,
    },
    docker: {
      nodeAlpineImage: nodeImage,
    },
  });
  await write(join(root, '.node-version'), `${nodeVersion}\n`);
  await write(join(root, '.nvmrc'), `${nodeVersion}\n`);
  await write(join(root, '.npmrc'), 'engine-strict=true\nmanage-package-manager-versions=false\n');
  await writeJson(join(root, 'package.json'), {
    packageManager: `pnpm@${pnpmVersion}`,
    engines: {
      node: '>=24 <25',
      pnpm: pnpmVersion,
    },
    scripts: {
      verify: 'pnpm test',
    },
  });
  await write(
    join(root, 'src/runtime/policy.ts'),
    `export const SUPPORTED_NODE_MAJOR = 24;\n` +
      `export const PINNED_NODE_VERSION = '${nodeVersion}';\n` +
      `export const PINNED_PNPM_VERSION = '${pnpmVersion}';\n`,
  );
  await write(
    join(root, 'Dockerfile'),
    `# node:${nodeVersion}-alpine\n` +
      `FROM ${nodeImage} AS builder\n` +
      `RUN corepack enable && corepack prepare pnpm@${pnpmVersion} --activate\n` +
      `# node:${nodeVersion}-alpine\n` +
      `FROM ${nodeImage} AS runner\n`,
  );
  await write(
    join(root, '.github/workflows/ci.yml'),
    `steps:\n` +
      `  - uses: pnpm/action-setup@0123456789012345678901234567890123456789\n` +
      `    with:\n` +
      `      version: '${pnpmVersion}'\n` +
      `  - uses: actions/setup-node@0123456789012345678901234567890123456789\n` +
      `    with:\n` +
      `      node-version: '${nodeVersion}'\n`,
  );

  const documentationFiles = [
    'README.md',
    'CONTRIBUTING.md',
    'docs/INSTALLATION.md',
    'docs/guide/getting-started.md',
    'docs/guide/troubleshooting.md',
    'docs/TROUBLESHOOTING.md',
    'docs/COMPATIBILITY.md',
  ];
  for (const relativePath of documentationFiles) {
    const upgrade =
      relativePath === 'CONTRIBUTING.md'
        ? '\n### Atomic runtime upgrades\n\nRun `node scripts/check-runtime-pins.mjs` in one pull request.\n'
        : '';
    await write(
      join(root, relativePath),
      `Node.js ${nodeVersion}; pnpm ${pnpmVersion}; pnpm@${pnpmVersion}.${upgrade}\n`,
    );
  }

  return root;
}

function runChecker(root: string) {
  return spawnSync(process.execPath, [checker, '--root', root], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('runtime pin parity', () => {
  it('accepts one canonical Node.js and pnpm version across every runtime surface', async () => {
    const root = await createCanonicalFixture();

    const result = runChecker(root);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'Runtime pin parity check passed: Node.js 24.18.0; pnpm 11.5.1.',
    );
  });

  it('accepts the checked-out repository runtime surfaces', () => {
    const result = runChecker(repoRoot);

    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects package-manager metadata drift', async () => {
    const root = await createCanonicalFixture();
    const packagePath = join(root, 'package.json');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as Record<string, unknown>;
    packageJson.packageManager = 'pnpm@11.14.0';
    await writeJson(packagePath, packageJson);

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('package.json packageManager');
  });

  it('rejects a pnpm setup action without the canonical version', async () => {
    const root = await createCanonicalFixture();
    const workflowPath = join(root, '.github/workflows/ci.yml');
    const workflow = await readFile(workflowPath, 'utf8');
    await writeFile(workflowPath, workflow.replace("      version: '11.5.1'\n", ''), 'utf8');

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('every pnpm/action-setup step must pin version 11.5.1');
  });

  it('rejects Node, Docker, and documentation drift with file-specific diagnostics', async () => {
    const root = await createCanonicalFixture();
    await writeFile(join(root, '.nvmrc'), '24.18.1\n', 'utf8');
    const dockerPath = join(root, 'Dockerfile');
    const dockerfile = await readFile(dockerPath, 'utf8');
    await writeFile(
      dockerPath,
      dockerfile.replace('node:24.18.0-alpine', 'node:24.18.1-alpine'),
      'utf8',
    );
    await writeFile(join(root, 'README.md'), 'runtime documentation without exact pins\n', 'utf8');

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.nvmrc');
    expect(result.stderr).toContain('Dockerfile Node version comments');
    expect(result.stderr).toContain('README.md');
  });
});
