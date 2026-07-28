import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const eslint = new ESLint({ cwd: repoRoot, errorOnUnmatchedPattern: true });
// Type-aware ESLint must initialize the repository TypeScript program for this fixture.
// Concurrent full-suite execution is measurably slower than an isolated run.
const TYPE_AWARE_LINT_TEST_TIMEOUT_MS = 30_000;

async function lintTemporaryFile(relativePath: string, source: string) {
  const absolutePath = join(repoRoot, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, source, 'utf8');
  try {
    const results = await eslint.lintFiles([absolutePath]);
    return results.flatMap((result) => result.messages);
  } finally {
    await rm(absolutePath, { force: true });
  }
}

function fixtureName(surface: string, extension: string): string {
  return `lint-policy-${surface}-${process.pid}-${Math.random().toString(36).slice(2)}.${extension}`;
}

describe('repository lint surface policy', () => {
  it('runs separate server, extension, script, and tool-metadata lint targets', async () => {
    const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const config = await readFile(join(repoRoot, 'eslint.config.js'), 'utf8');

    expect(packageJson.scripts).toMatchObject({
      lint: 'pnpm lint:server && pnpm lint:extension && pnpm lint:scripts && pnpm lint:tools',
      'lint:server': 'eslint src tests vitest.config.ts --max-warnings 0',
      'lint:extension':
        'eslint easyeda-bridge-extension/src easyeda-bridge-extension/tests easyeda-bridge-extension/scripts --max-warnings 0',
      'lint:scripts': 'eslint scripts eslint.config.js --max-warnings 0',
      'lint:tools': 'tsx scripts/lint-tool-metadata.mts',
    });
    expect(packageJson.scripts.verify).toContain('pnpm lint');
    expect(packageJson.scripts.verify).not.toContain('pnpm lint:tools');

    expect(config).not.toContain("'scripts/'");
    expect(config).not.toContain("'easyeda-bridge-extension/'");
    expect(config).not.toContain("'**/*.js'");
    expect(config).toContain("'@typescript-eslint/no-floating-promises'");
    expect(config).toContain("importNames: ['exec', 'execSync']");
    expect(config).toContain("'no-path-concat': 'error'");
    expect(config).toContain('selector: "NewExpression[callee.name=\'AsyncFunction\']"');
  });

  it(
    'rejects floating promises in TypeScript repository automation',
    async () => {
      const relativePath = join('scripts', fixtureName('floating-promise', 'mts'));
      const messages = await lintTemporaryFile(
        relativePath,
        [
          'export async function run(): Promise<void> {\n',
          '  Promise.resolve();\n',
          '}\n',
          'void run();\n',
        ].join(''),
      );

      expect(messages.map((message) => message.ruleId)).toContain(
        '@typescript-eslint/no-floating-promises',
      );
    },
    TYPE_AWARE_LINT_TEST_TIMEOUT_MS,
  );

  it('rejects shell-string child process APIs in JavaScript automation', async () => {
    const relativePath = join('scripts', fixtureName('shell-process', 'mjs'));
    const messages = await lintTemporaryFile(
      relativePath,
      [
        'import { exec',
        "Sync } from 'node:child_",
        "process';\n",
        'exec',
        "Sync('echo unsafe');\n",
      ].join(''),
    );

    expect(messages.map((message) => message.ruleId)).toContain('no-restricted-imports');
  }, 20_000);

  it('rejects path concatenation in JavaScript automation', async () => {
    const relativePath = join('scripts', fixtureName('path-concat', 'cjs'));
    const messages = await lintTemporaryFile(
      relativePath,
      "const artifactPath = __dirname + '/artifact.json';\nconsole.log(artifactPath);\n",
    );

    expect(messages.map((message) => message.ruleId)).toContain('no-path-concat');
  }, 20_000);

  it('rejects unreviewed dynamic execution in the bridge extension', async () => {
    const relativePath = join(
      'easyeda-bridge-extension',
      'src',
      fixtureName('dynamic-execution', 'ts'),
    );
    const messages = await lintTemporaryFile(
      relativePath,
      [
        'const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as FunctionConstructor;\n',
        'export const run = new Async',
        "Function('return 1');\n",
      ].join(''),
    );

    expect(messages.map((message) => message.ruleId)).toContain('no-restricted-syntax');
  }, 20_000);
});
