import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const requireLocal = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const vitestPackage = requireLocal.resolve('vitest/package.json');
const vitePackage = createRequire(vitestPackage).resolve('vite/package.json');
const forkPath = createRequire(vitePackage).resolve('picomatch');
const matcher = requireLocal(forkPath) as {
  makeRe(pattern: string, options?: Record<string, unknown>): RegExp;
  isMatch(input: string, pattern: string, options?: Record<string, unknown>): boolean;
};

describe('first-party picomatch fork for CVE-2026-112366', () => {
  it('loads the provenance-pinned first-party fork for Vite, Vitest, and tinyglobby', () => {
    const forkPackagePath = resolve(dirname(forkPath), 'package.json');
    const forkPackage = JSON.parse(readFileSync(forkPackagePath, 'utf8')) as {
      name: string;
      version: string;
      license: string;
      'x-upstream': string;
      'x-security-advisory': string;
    };
    expect(forkPackage).toMatchObject({
      name: '@oaslananka/picomatch',
      version: '4.0.7-oaslananka.1',
      license: 'MIT',
      'x-upstream': 'micromatch/picomatch@4.0.7',
      'x-security-advisory': 'GHSA-fc5q-39xc-vjpf / CVE-2026-112366',
    });

    const vitestPackage = requireLocal.resolve('vitest/package.json');
    const vitestPicomatch = createRequire(vitestPackage).resolve('picomatch');
    const vitePicomatch = createRequire(vitePackage).resolve('picomatch');
    const tinyglobbyPackage = createRequire(vitePackage).resolve('tinyglobby/package.json');
    const tinyglobbyPicomatch = createRequire(tinyglobbyPackage).resolve('picomatch');
    expect(vitestPicomatch).toBe(forkPath);
    expect(vitePicomatch).toBe(forkPath);
    expect(tinyglobbyPicomatch).toBe(forkPath);

    const source = readFileSync(resolve(dirname(forkPath), 'lib/parse.js'), 'utf8');
    expect(source).toContain('const hasWildcard = tokens.slice(token.tokensIndex + 2)');
    expect(source).toContain('analysis.collapse === true');
    // Hash LF-normalized upstream-derived parser code, including the reviewed patch.
    // Do not silently swap fork source while keeping the same scoped package identity.
    const sourceSha256 = createHash('sha256').update(source.replaceAll('\r\n', '\n')).digest('hex');
    expect(sourceSha256).toBe('fe3f64c8d898df5d1f73fec276b2d76a78a9db1562dfde6b21e76f2e575ad445');
    const lockfile = readFileSync(resolve(repoRoot, 'pnpm-lock.yaml'), 'utf8');
    expect(lockfile).toContain('picomatch: file:vendor/picomatch');
    expect(lockfile).toContain("'@oaslananka/picomatch@file:vendor/picomatch'");
    expect(lockfile).not.toMatch(/^ {2}picomatch@4\.0\.7:/m);
    expect(readFileSync(resolve(repoRoot, 'vendor/picomatch/FORK_NOTES.md'), 'utf8')).toContain(
      'GHSA-fc5q-39xc-vjpf',
    );
  });

  it('preserves escaped bracket matching and bounds long unmatched bracket inputs', () => {
    const utilsPath = resolve(dirname(forkPath), 'lib/utils.js');
    const utils = requireLocal(utilsPath) as { removeBackslashes(input: string): string };
    const alphabet = ['[', ']', '\\', 'a', '/', '\n', '\r'];
    const cases: [string, string][] = [['', utils.removeBackslashes('')]];
    let words = [''];
    for (let length = 1; length <= 5; length += 1) {
      words = words.flatMap((word) => alphabet.map((character) => word + character));
      for (const input of words) cases.push([input, utils.removeBackslashes(input)]);
    }
    expect(cases).toHaveLength(19608);
    expect(createHash('sha256').update(JSON.stringify(cases)).digest('hex')).toBe(
      'd68a03eb295d26234322c34db8ba46d5ee07084acee5aa454e9c20961c94f9f0',
    );

    const script = [
      'const unescape = require(' + JSON.stringify(utilsPath) + ').removeBackslashes;',
      'const input = "[".repeat(150000) + String.fromCharCode(92) + "z";',
      'if (unescape(input) !== "[".repeat(150000) + "z") process.exit(2);',
    ].join('\n');
    const result = spawnSync(process.execPath, ['-e', script], {
      timeout: 2500,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
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
      'const p = require(' + JSON.stringify(forkPath) + ');',
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
