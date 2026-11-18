import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const requireLocal = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const vitestPackage = requireLocal.resolve('vitest/package.json');
const vitePackage = createRequire(vitestPackage).resolve('vite/package.json');
const patchedPath = createRequire(vitePackage).resolve('picomatch');
const matcher = requireLocal(patchedPath) as {
  makeRe(pattern: string, options?: Record<string, unknown>): RegExp;
  isMatch(input: string, pattern: string, options?: Record<string, unknown>): boolean;
};

describe('patched picomatch for CVE-2026-112366', () => {
  it('loads the hash-pinned patch for the actual Vite/Vitest transitive dependency', () => {
    expect(patchedPath).toContain('picomatch@4.0.7_patch_hash');
    const source = readFileSync(resolve(dirname(patchedPath), 'lib/parse.js'), 'utf8');
    expect(source).toContain('const hasWildcard = tokens.slice(token.tokensIndex + 2)');
    expect(source).toContain('analysis.collapse === true');
    expect(readFileSync(resolve(repoRoot, 'pnpm-workspace.yaml'), 'utf8')).toContain(
      'picomatch@4.0.7: patches/picomatch@4.0.7.patch',
    );
    expect(readFileSync(resolve(repoRoot, 'patches/README.md'), 'utf8')).toContain(
      'micromatch/picomatch/pull/262',
    );
  });

  it('collapses simple repeated single-star branches without changing matching semantics', () => {
    const patterns = [
      '+(*)',
      '*(*)',
      '+(*a)',
      '*(*a)',
      '+(a*)',
      '*(a*)',
      '+(a*b)',
      '*(a*b)',
      'x+(*a)y',
    ];
    const inputs = [
      '',
      'a',
      'aa',
      'ab',
      'aba',
      'abab',
      'abcabc',
      'foo.js',
      '.env',
      'a/a',
      'xaby',
      'xay',
      '/',
      'bb',
    ];
    const optionSets: Record<string, unknown>[] = [
      {},
      { dot: true },
      { windows: true },
      { bash: true },
    ];

    for (const pattern of patterns) {
      expect(matcher.makeRe(pattern).source).not.toMatch(/\)\+/);
      expect(matcher.makeRe(pattern).source).not.toMatch(/\)\*/);
      for (const options of optionSets) {
        for (const input of inputs) {
          expect(matcher.isMatch(input, pattern, options)).toBe(
            matcher.isMatch(input, pattern, { ...options, maxExtglobRecursion: false }),
          );
        }
      }
    }
  });

  it('preserves narrow trailing-star alternatives and literalizes unsupported wildcard forms', () => {
    const patterns = ['+(a*|b)', '*(a*|b)', '+(a*|b|c)', '*(a*|b|c)', '+(A*|b)'];
    const inputs = ['', 'a', 'b', 'c', 'aa', 'ab', 'ba', 'bb', 'ax', 'bax', 'abc', 'a/b'];
    const optionSets: Record<string, unknown>[] = [
      {},
      { dot: true },
      { windows: true },
      { bash: true },
      { nocase: true },
      { flags: 'i' },
    ];

    for (const pattern of patterns) {
      for (const options of optionSets) {
        for (const input of inputs) {
          expect(matcher.isMatch(input, pattern, options)).toBe(
            matcher.isMatch(input, pattern, { ...options, maxExtglobRecursion: false }),
          );
        }
      }
    }

    for (const pattern of ['+(*?)z', '+(a?*)']) {
      expect(matcher.makeRe(pattern).source).toContain('\\+\\(');
      expect(matcher.isMatch(pattern, pattern)).toBe(true);
    }
  });

  it('bounds known and adjacent repeated-wildcard cases in a child process', () => {
    const cases = [
      ['+(*a)', 'a'.repeat(30) + '!'],
      ['+(a*)', 'a'.repeat(30) + '/'],
      ['+(a*b)', 'a'.repeat(30) + '!'],
      ['+(a*|b)', 'a'.repeat(30) + '/'],
      ['+(*?)z', 'a'.repeat(30) + '!'],
      ['+(a?*)', 'a'.repeat(30) + '/'],
      ['+(*)z', 'a'.repeat(30) + '!'],
    ];
    const script = [
      'const p = require(' + JSON.stringify(patchedPath) + ');',
      'const cases = ' + JSON.stringify(cases) + ';',
      'for (const [glob, input] of cases) {',
      '  if (p.isMatch(input, glob)) process.exit(2);',
      '}',
    ].join('\n');
    const result = spawnSync(process.execPath, ['-e', script], {
      timeout: 2500,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it('retains the explicit opt-out and capture-mode literal fallback', () => {
    const capture = matcher.makeRe('+(*a)', { capture: true });
    expect(capture.source).toContain('\\+\\(');
    expect(capture.test('+(*a)')).toBe(true);
    expect(capture.test('aaa')).toBe(false);

    expect(matcher.makeRe('+(*a)', { maxExtglobRecursion: false }).source).toMatch(/\)\+/);
  });

  it('preserves ordinary project globs', () => {
    expect(matcher.isMatch('src/index.ts', '**/*.ts')).toBe(true);
    expect(matcher.isMatch('README.md', '**/*.ts')).toBe(false);
    expect(matcher.isMatch('abc', '+(a*)')).toBe(true);
    expect(matcher.isMatch('abab', '+(a*b)')).toBe(true);
    expect(matcher.isMatch('foo.test.ts', '*.@(test|spec).ts')).toBe(true);
  });
});
