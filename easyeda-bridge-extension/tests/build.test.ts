import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Regression test for a real bug: the second esbuild call in build.mjs used
// to pass a `define` object literal that REPLACED (rather than merged onto)
// commonOptions.define, silently dropping __MCP_DEV_HOTSWAP__ so hot-swap
// support was always compiled out regardless of MCP_DEV_HOTSWAP. Verified
// live: a dev build reported hotSwapCompiled:false in the running extension.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildScript = join(root, 'scripts', 'build.mjs');

function buildInto(outDir: string, env: Record<string, string>): string {
  execFileSync('node', [buildScript], {
    cwd: root,
    env: { ...process.env, MCP_BUILD_OUT_DIR: outDir, ...env },
    stdio: 'pipe',
  });
  return readFileSync(join(outDir, 'index.js'), 'utf8');
}

describe('build.mjs hot-swap define', () => {
  const outDirs: string[] = [];

  afterEach(() => {
    for (const dir of outDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('compiles HOTSWAP_COMPILED to the literal true when MCP_DEV_HOTSWAP=true', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ext-build-dev-'));
    outDirs.push(outDir);
    const bundle = buildInto(outDir, { MCP_DEV_HOTSWAP: 'true' });
    expect(bundle).toMatch(/HOTSWAP_COMPILED\s*=\s*true;/);
    expect(bundle).not.toContain('__MCP_DEV_HOTSWAP__');
  });

  it('compiles HOTSWAP_COMPILED to the literal false when MCP_DEV_HOTSWAP is unset', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ext-build-prod-'));
    outDirs.push(outDir);
    const bundle = buildInto(outDir, { MCP_DEV_HOTSWAP: '' });
    expect(bundle).toMatch(/HOTSWAP_COMPILED\s*=\s*false;/);
    expect(bundle).not.toContain('__MCP_DEV_HOTSWAP__');
  });
});
