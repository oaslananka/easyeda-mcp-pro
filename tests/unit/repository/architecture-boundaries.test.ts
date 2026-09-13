import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const scriptPath = resolve(repoRoot, 'scripts/check-architecture-boundaries.mjs');
const temporaryDirectories: string[] = [];

const runChecker = (root: string) =>
  spawnSync(process.execPath, [scriptPath, '--root', root], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('architecture dependency boundaries', () => {
  it('rejects foundational modules importing orchestration modules', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'architecture-boundaries-'));
    temporaryDirectories.push(root);
    mkdirSync(resolve(root, '.github'), { recursive: true });
    mkdirSync(resolve(root, 'src/config'), { recursive: true });
    mkdirSync(resolve(root, 'src/tools'), { recursive: true });
    writeFileSync(
      resolve(root, '.github/architecture-boundaries.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        sourceRoot: 'src',
        rules: [{ name: 'test-boundary', from: ['config'], disallow: ['tools'] }],
      })}\n`,
    );
    writeFileSync(resolve(root, 'src/config/env.ts'), "import '../tools/types.js';\n");
    writeFileSync(resolve(root, 'src/tools/types.ts'), 'export const tool = true;\n');

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Architecture boundary violation');
    expect(result.stderr).toContain('src/config/env.ts');
    expect(result.stderr).toContain('config may not depend on tools');
  });

  it('keeps the live repository inside the committed architecture boundaries', () => {
    const result = runChecker(repoRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Architecture boundaries passed');
  });

  it('wires the architecture checker into fast verification and the required quality gate', () => {
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const workflow = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    const architecture = readFileSync(resolve(repoRoot, 'docs/security-architecture.md'), 'utf8');

    expect(packageJson.scripts['check:architecture']).toBe(
      'node scripts/check-architecture-boundaries.mjs',
    );
    expect(packageJson.scripts['verify:fast']).toContain('pnpm check:architecture');
    expect(workflow).toContain('Run pnpm check:architecture');
    expect(architecture).toContain('`.github/architecture-boundaries.json`');
    expect(architecture).toContain('`pnpm check:architecture`');
  });
});
