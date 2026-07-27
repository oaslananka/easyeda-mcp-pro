import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectLocalScriptTargets,
  discoverPackageManifests,
  verifyRepositoryPackageScriptTargets,
} from '../../../scripts/package-script-targets.mjs';

const repoRoot = resolve(import.meta.dirname, '../../..');
const temporaryRoots: string[] = [];

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createFixture() {
  const root = join(tmpdir(), `package-script-targets-${Date.now()}-${Math.random()}`);
  temporaryRoots.push(root);
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'workspace/scripts'), { recursive: true });
  await writeFile(join(root, 'scripts/root.mjs'), 'console.log("root");\n');
  await writeFile(join(root, 'scripts/quoted file.mjs'), 'console.log("quoted");\n');
  await writeFile(join(root, 'src/index.ts'), 'export {};\n');
  await writeFile(join(root, 'workspace/scripts/child.ts'), 'export {};\n');
  await writeJson(join(root, 'package.json'), {
    name: 'root-fixture',
    scripts: {
      root: 'node scripts/root.mjs',
      quoted: 'node "scripts/quoted file.mjs"',
      watch: 'BRIDGE=true tsx watch src/index.ts',
      inline: 'node -e "console.log(1)"',
      generated: 'node dist/index.js',
      packageCommand: 'pnpm --filter child test',
    },
  });
  await writeJson(join(root, 'workspace/package.json'), {
    name: 'child-fixture',
    scripts: {
      child: 'tsx scripts/child.ts',
    },
  });
  await writeJson(join(root, 'node_modules/ignored/package.json'), {
    name: 'ignored',
    scripts: { broken: 'node scripts/missing.mjs' },
  });
  await writeJson(join(root, 'dist/ignored/package.json'), {
    name: 'generated',
    scripts: { broken: 'node scripts/missing.mjs' },
  });
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('package script target policy', () => {
  it('extracts source-controlled targets without executing package scripts', () => {
    expect(
      collectLocalScriptTargets(
        {
          node: 'node scripts/check.mjs --strict',
          tsx: 'MODE=test tsx watch src/index.ts',
          shell: 'bash scripts/check.sh && sh ./scripts/verify.sh',
          python: 'python3 scripts/audit.py',
          powershell: 'powershell -File scripts/check.ps1',
          quoted: 'node "scripts/quoted file.mjs"',
          inline: "node -e \"require('node:fs').readFileSync('scripts/not-a-target.mjs')\"",
          generated: 'node dist/index.js',
          dependency: 'npx package node dist/index.js',
        },
        { packageName: 'fixture' },
      ),
    ).toEqual([
      { packageName: 'fixture', scriptName: 'node', target: 'scripts/check.mjs' },
      { packageName: 'fixture', scriptName: 'tsx', target: 'src/index.ts' },
      { packageName: 'fixture', scriptName: 'shell', target: 'scripts/check.sh' },
      { packageName: 'fixture', scriptName: 'shell', target: './scripts/verify.sh' },
      { packageName: 'fixture', scriptName: 'python', target: 'scripts/audit.py' },
      { packageName: 'fixture', scriptName: 'powershell', target: 'scripts/check.ps1' },
      { packageName: 'fixture', scriptName: 'quoted', target: 'scripts/quoted file.mjs' },
    ]);
  });

  it('discovers repository package manifests while excluding vendor and generated trees', async () => {
    const root = await createFixture();

    await expect(discoverPackageManifests({ root })).resolves.toEqual([
      join(root, 'package.json'),
      join(root, 'workspace/package.json'),
    ]);
  });

  it('accepts existing local targets in root and workspace package scripts', async () => {
    const root = await createFixture();

    await expect(verifyRepositoryPackageScriptTargets({ root })).resolves.toEqual({
      ok: true,
      checkedPackages: 2,
      checkedTargets: 4,
      errors: [],
    });
  });

  it('reports package name, script name, and missing target without executing it', async () => {
    const root = await createFixture();
    const packagePath = join(root, 'workspace/package.json');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      name: string;
      scripts: Record<string, string>;
    };
    packageJson.scripts.broken = 'tsx scripts/does-not-exist.ts';
    await writeJson(packagePath, packageJson);

    await expect(verifyRepositoryPackageScriptTargets({ root })).resolves.toEqual({
      ok: false,
      checkedPackages: 2,
      checkedTargets: 5,
      errors: [
        'child-fixture script "broken" references missing local target: workspace/scripts/does-not-exist.ts',
      ],
    });
  });

  it('rejects local script targets that escape the repository root', async () => {
    const root = await createFixture();
    const packagePath = join(root, 'workspace/package.json');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      scripts: Record<string, string>;
    };
    packageJson.scripts.escape = 'node ../../outside.mjs';
    await writeJson(packagePath, packageJson);

    const result = await verifyRepositoryPackageScriptTargets({ root });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'child-fixture script "escape" references a local target outside the repository: ../../outside.mjs',
    );
  });

  it('keeps the live repository free of missing package script targets', async () => {
    await expect(verifyRepositoryPackageScriptTargets({ root: repoRoot })).resolves.toMatchObject({
      ok: true,
      checkedPackages: 2,
      errors: [],
    });
  });

  it('removes the obsolete generator and wires the checker into protected verification', async () => {
    const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const workflow = await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    const repositoryText = await readFile(
      join(repoRoot, 'docs/superpowers/plans/2026-07-28-package-script-target-policy.md'),
      'utf8',
    );

    expect(packageJson.scripts['generate:methods']).toBeUndefined();
    expect(packageJson.scripts['check:package-scripts']).toBe(
      'node scripts/check-package-script-targets.mjs',
    );
    expect(packageJson.scripts.verify).toContain('pnpm check:package-scripts');
    expect(workflow).toContain('pnpm verify');
    expect(repositoryText).not.toContain('scripts/generate-method-registry.ts');
  });
});
