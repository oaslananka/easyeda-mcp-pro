import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const requireLocal = createRequire(import.meta.url);
const matcher = requireLocal('../../../vendor/picomatch') as {
  makeRe(pattern: string): RegExp;
  isMatch(input: string, pattern: string): boolean;
};
const vendorPackage = resolve(__dirname, '../../../vendor/picomatch');

describe('locally hardened picomatch for CVE-2026-112366', () => {
  it('retains original package provenance and the actual parser guard', () => {
    const pkg = JSON.parse(readFileSync(resolve(vendorPackage, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    expect(pkg).toMatchObject({ name: 'picomatch', version: '4.0.7' });
    expect(readFileSync(resolve(vendorPackage, 'lib/parse.js'), 'utf8')).toContain(
      'hasUnsafeLeadingQuantifier',
    );
  });

  it('ensures Vite and Vitest resolve the hardened local dependency', () => {
    const vitestPackage = requireLocal.resolve('vitest/package.json');
    const vitePackage = createRequire(vitestPackage).resolve('vite/package.json');
    const resolvedMatcher = createRequire(vitePackage).resolve('picomatch');
    const installed = requireLocal(resolvedMatcher) as typeof matcher;
    expect(installed.makeRe('+(*)z').source).toBe(matcher.makeRe('+(*)z').source);

    const lockfile = readFileSync(resolve(vendorPackage, '../../pnpm-lock.yaml'), 'utf8');
    expect(lockfile).toContain('picomatch@file:vendor/picomatch');
    expect(lockfile).not.toContain('picomatch@4.0.7:');
  });

  it('literalizes unsafe repeated extglobs rather than generating nested repetition', () => {
    for (const pattern of ['+(*a)z', '*(*a)z', '+(*?)z', '+(*)z', '+(*?)!']) {
      const expression = matcher.makeRe(pattern).source;
      expect(expression).toContain('\\(');
      expect(expression).not.toMatch(/\(\?:\[\^\/\]\*\?.*\)\+/);
    }
  });

  it('completes known hostile inputs under a bounded child-process deadline', () => {
    const script = [
      `const p = require(${JSON.stringify(vendorPackage)});`,
      `for (const pattern of ['+(*a)z','+(*?)z','+(*)z','+(*?)!']) {`,
      ` if (p.isMatch('a'.repeat(30), pattern)) process.exit(2);`,
      `}`,
    ].join('\n');
    const child = spawnSync(process.execPath, ['-e', script], {
      timeout: 2500,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
  });

  it('continues to match common source and ordinary extglob patterns', () => {
    expect(matcher.isMatch('src/index.ts', '**/*.ts')).toBe(true);
    expect(matcher.isMatch('README.md', '**/*.ts')).toBe(false);
    expect(matcher.isMatch('abc', '+(a*)')).toBe(true);
    expect(matcher.isMatch('foo.test.ts', '*.@(test|spec).ts')).toBe(true);
  });
});
