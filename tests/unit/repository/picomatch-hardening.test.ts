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
  makeRe(pattern: string): RegExp;
  isMatch(input: string, pattern: string): boolean;
};

describe('patched picomatch for CVE-2026-112366', () => {
  it('loads the hash-pinned patch for the actual Vite/Vitest transitive dependency', () => {
    expect(patchedPath).toContain('picomatch@4.0.7_patch_hash');
    expect(readFileSync(resolve(dirname(patchedPath), 'lib/parse.js'), 'utf8')).toContain(
      'hasUnsafeLeadingQuantifier',
    );
    expect(readFileSync(resolve(repoRoot, 'pnpm-workspace.yaml'), 'utf8')).toContain(
      'picomatch@4.0.7: patches/picomatch@4.0.7.patch',
    );
  });

  it('literalizes unsafe repeated extglobs rather than nested regex quantifiers', () => {
    for (const pattern of ['+(*a)z', '*(*a)z', '+(*?)z', '+(*)z', '+(*?)!']) {
      const expression = matcher.makeRe(pattern).source;
      expect(expression).toContain('\\(');
      expect(expression).not.toMatch(/\(\?:\[\^\/\]\*\?.*\)\+/);
    }
  });

  it('terminates known ReDoS cases within a short child-process deadline', () => {
    const script = [
      `const p = require(${JSON.stringify(patchedPath)});`,
      "for (const glob of ['+(*a)z','+(*?)z','+(*)z','+(*?)!']) {",
      "  if (p.isMatch('a'.repeat(30), glob)) process.exit(2);",
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

  it('preserves ordinary glob and literal-prefix extglob matching', () => {
    expect(matcher.isMatch('src/index.ts', '**/*.ts')).toBe(true);
    expect(matcher.isMatch('README.md', '**/*.ts')).toBe(false);
    expect(matcher.isMatch('abc', '+(a*)')).toBe(true);
    expect(matcher.isMatch('foo.test.ts', '*.@(test|spec).ts')).toBe(true);
  });
});
