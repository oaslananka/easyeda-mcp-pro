import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildComplexitySnapshot,
  compareComplexitySnapshots,
  measureRepositoryComplexity,
  runComplexityRatchet,
  validateComplexityBaseline,
} from '../../../scripts/check-complexity-ratchet.mjs';

const targets = ['src/**/*.ts', 'easyeda-bridge-extension/src/**/*.ts', 'scripts/**/*.mjs'];

function functionWithIfCount(ifCount: number): string {
  const conditions = Array.from(
    { length: ifCount },
    (_, index) => `  if (value === ${index}) return ${index};`,
  ).join('\n');
  return `export function decide(value) {\n${conditions}\n  return -1;\n}\n`;
}

async function createHermeticComplexityRoot(ifCount: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'easyeda-complexity-ratchet-'));
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'config'), { recursive: true });
  await writeFile(
    join(root, 'eslint.config.mjs'),
    "export default [{ files: ['**/*.js'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } }];\n",
  );
  await writeFile(join(root, 'scripts/sample.js'), functionWithIfCount(ifCount));
  return root;
}

describe('complexity ratchet', () => {
  it('stores only threshold-exceeding complexities as descending per-file vectors', () => {
    const snapshot = buildComplexitySnapshot(
      [
        { file: 'src/a.ts', complexity: 17 },
        { file: 'src/a.ts', complexity: 12 },
        { file: 'src/a.ts', complexity: 20 },
        { file: 'src/b.ts', complexity: 16 },
        { file: 'src/b.ts', complexity: 15 },
      ],
      { threshold: 15, targets },
    );

    expect(snapshot).toEqual({
      schemaVersion: 1,
      metric: 'eslint-complexity-classic',
      threshold: 15,
      targets,
      files: {
        'src/a.ts': [20, 17],
        'src/b.ts': [16],
      },
    });
  });

  it('rejects an increased hotspot and a newly added threshold violation', () => {
    const baseline = buildComplexitySnapshot(
      [
        { file: 'src/a.ts', complexity: 20 },
        { file: 'src/a.ts', complexity: 17 },
      ],
      { threshold: 15, targets },
    );
    const current = buildComplexitySnapshot(
      [
        { file: 'src/a.ts', complexity: 21 },
        { file: 'src/a.ts', complexity: 17 },
        { file: 'src/a.ts', complexity: 16 },
      ],
      { threshold: 15, targets },
    );

    expect(compareComplexitySnapshots(baseline, current)).toEqual({
      regressions: [
        {
          file: 'src/a.ts',
          baseline: [20, 17],
          current: [21, 17, 16],
        },
      ],
      improvements: [],
    });
  });

  it('flags reduced complexity so the committed baseline must ratchet downward', () => {
    const baseline = buildComplexitySnapshot(
      [
        { file: 'src/a.ts', complexity: 20 },
        { file: 'src/a.ts', complexity: 17 },
        { file: 'src/b.ts', complexity: 18 },
      ],
      { threshold: 15, targets },
    );
    const current = buildComplexitySnapshot(
      [
        { file: 'src/a.ts', complexity: 19 },
        { file: 'src/a.ts', complexity: 17 },
      ],
      { threshold: 15, targets },
    );

    expect(compareComplexitySnapshots(baseline, current)).toEqual({
      regressions: [],
      improvements: [
        {
          file: 'src/a.ts',
          baseline: [20, 17],
          current: [19, 17],
        },
        {
          file: 'src/b.ts',
          baseline: [18],
          current: [],
        },
      ],
    });
  });

  it('accepts an unchanged measured state', () => {
    const baseline = buildComplexitySnapshot([{ file: 'src/a.ts', complexity: 18 }], {
      threshold: 15,
      targets,
    });

    expect(compareComplexitySnapshots(baseline, structuredClone(baseline))).toEqual({
      regressions: [],
      improvements: [],
    });
  });

  it('measures ESLint classic complexity in a hermetic repository root', async () => {
    const root = await createHermeticComplexityRoot(2);
    try {
      await expect(
        measureRepositoryComplexity({ root, targets: ['scripts/**/*.js'] }),
      ).resolves.toEqual([{ file: 'scripts/sample.js', complexity: 3 }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes, verifies, rejects regressions, and requires downward baseline updates', async () => {
    const root = await createHermeticComplexityRoot(15);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(runComplexityRatchet(['--root', root, '--write'])).resolves.toBe(0);
      await expect(runComplexityRatchet(['--root', root])).resolves.toBe(0);

      await writeFile(join(root, 'scripts/sample.js'), functionWithIfCount(16));
      error.mockClear();
      await expect(runComplexityRatchet(['--root', root])).resolves.toBe(1);
      expect(error.mock.calls.flat().join('\n')).toContain('regression(s) detected');

      await writeFile(join(root, 'scripts/sample.js'), functionWithIfCount(14));
      error.mockClear();
      await expect(runComplexityRatchet(['--root', root])).resolves.toBe(1);
      expect(error.mock.calls.flat().join('\n')).toContain('baseline can be tightened');
    } finally {
      log.mockRestore();
      error.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns a failure for unknown CLI arguments', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(runComplexityRatchet(['--unknown'])).resolves.toBe(1);
      expect(error).toHaveBeenCalledWith('unknown argument: --unknown');
    } finally {
      error.mockRestore();
    }
  });

  it('is enforced by the repository verification scripts', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['check:complexity']).toBe(
      'node scripts/check-complexity-ratchet.mjs',
    );
    expect(packageJson.scripts['complexity:update']).toBe(
      'node scripts/check-complexity-ratchet.mjs --write',
    );
    expect(packageJson.scripts.verify).toContain('pnpm lint && pnpm check:complexity');
    expect(readFileSync('vitest.config.ts', 'utf8')).toContain(
      "'scripts/check-complexity-ratchet.mjs'",
    );
  });

  it('rejects malformed or unsorted baseline data', () => {
    expect(() =>
      validateComplexityBaseline({
        schemaVersion: 1,
        metric: 'eslint-complexity-classic',
        threshold: 15,
        targets,
        files: { 'src/a.ts': [17, 20] },
      }),
    ).toThrow(/descending/);
  });
});
