import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSupportedNodeRuntime } from '../../../src/runtime/policy.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const read = (path: string): string => {
  const absolute = resolve(repoRoot, path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8').replace(/\r\n/g, '\n') : '';
};

interface RuntimePolicy {
  schemaVersion: number;
  node: { supportedMajor: number; pinnedVersion: string };
  pnpm: { pinnedVersion: string };
}

describe('repository runtime policy', () => {
  it('pins one Node 24 and pnpm runtime across repository metadata', () => {
    const policy = JSON.parse(read('config/runtime-policy.json')) as RuntimePolicy;
    const packageJson = JSON.parse(read('package.json')) as {
      packageManager?: string;
      engines?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(policy).toEqual({
      schemaVersion: 1,
      node: { supportedMajor: 24, pinnedVersion: '24.18.0' },
      pnpm: { pinnedVersion: '11.5.1' },
    });
    expect(read('.nvmrc').trim()).toBe(policy.node.pinnedVersion);
    expect(read('.node-version').trim()).toBe(policy.node.pinnedVersion);
    expect(packageJson.packageManager).toBe(`pnpm@${policy.pnpm.pinnedVersion}`);
    expect(packageJson.engines).toMatchObject({ node: '>=24 <25', pnpm: '11.5.1' });
    expect(read('.npmrc')).toContain('engine-strict=true');
    expect(read('.npmrc')).toContain('manage-package-manager-versions=false');
    expect(packageJson.scripts?.['runtime:check']).toBe(
      'node scripts/check-runtime.mjs --require-pnpm',
    );
    expect(packageJson.scripts?.prebuild).toContain('pnpm runtime:check');
    expect(packageJson.scripts?.preverify).toBe('pnpm runtime:check');
    expect(packageJson.scripts?.pretest).toBe('pnpm runtime:check');
    expect(packageJson.scripts?.['pretest:extension']).toBe('pnpm runtime:check');
    for (const automation of [
      'dev',
      'dev:extension',
      'dev:hotloop',
      'setup:local',
      'test:watch',
      'test:coverage',
      'test:coverage:ci',
      'test:extension:ci',
    ]) {
      expect(packageJson.scripts?.[`pre${automation}`]).toBe('pnpm runtime:check');
    }
    const runtimeSource = read('src/runtime/policy.ts');
    expect(runtimeSource).toContain(`SUPPORTED_NODE_MAJOR = ${policy.node.supportedMajor}`);
    expect(runtimeSource).toContain(`PINNED_NODE_VERSION = '${policy.node.pinnedVersion}'`);
    expect(runtimeSource).toContain(`PINNED_PNPM_VERSION = '${policy.pnpm.pinnedVersion}'`);
    expect(existsSync(resolve(repoRoot, 'scripts/check-runtime.mjs'))).toBe(true);
    const publishedFiles = JSON.parse(read('package.json')).files as string[];
    expect(publishedFiles).toContain('config/runtime-policy.json');
    expect(publishedFiles).toContain('scripts/check-runtime.mjs');
  });

  it('guards server startup against unsupported Node majors', () => {
    expect(() => assertSupportedNodeRuntime('24.18.0')).not.toThrow();
    expect(() => assertSupportedNodeRuntime('26.0.0')).toThrow(
      'easyeda-mcp-pro requires Node.js 24.x',
    );
    expect(() => assertSupportedNodeRuntime('not-a-version')).toThrow(
      'Install the pinned 24.18.0 runtime',
    );
  });

  it('fails closed for unsupported Node and pnpm versions with actionable output', () => {
    const script = resolve(repoRoot, 'scripts/check-runtime.mjs');
    const run = (args: string[]) =>
      execFileSync(process.execPath, [script, ...args], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      });

    expect(
      run(['--node-version', '24.18.0', '--pnpm-version', '11.5.1', '--require-pnpm']),
    ).toContain('Runtime preflight passed');
    expect(() => run(['--node-version', '26.0.0', '--node-only'])).toThrow(
      expect.objectContaining({
        status: 1,
        stderr: expect.stringContaining('requires Node.js 24.x'),
      }),
    );
    expect(() =>
      run(['--node-version', '24.18.0', '--pnpm-version', '11.5.2', '--require-pnpm']),
    ).toThrow(
      expect.objectContaining({
        status: 1,
        stderr: expect.stringContaining('requires pnpm 11.5.1'),
      }),
    );
  });

  it('uses the pinned Node version across every GitHub Actions runtime', () => {
    const workflows = [
      '.github/workflows/ci.yml',
      '.github/workflows/dependency-advisory-monitor.yml',
      '.github/workflows/deploy-docs.yml',
      '.github/workflows/golden-benchmark.yml',
      '.github/workflows/release-please.yml',
      '.github/workflows/static-security-analysis.yml',
    ]
      .map(read)
      .join('\n');

    expect(workflows.match(/24\.18\.0/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(workflows).not.toMatch(/node-version:\s*['"]?(?:24|26)['"]?\s*$/m);
    const ciWorkflow = read('.github/workflows/ci.yml');
    expect(ciWorkflow).toContain('name: quality (24)');
    expect(ciWorkflow).toContain("node-version: ['24.18.0']");
    expect(read('.github/workflows/ci.yml')).toContain("node-version: '24.18.0'");
    expect(read('.github/workflows/ci.yml')).not.toContain("node-version: '26'");
    expect(workflows.match(/run: pnpm runtime:check/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
  });

  it('pins the Docker builder and runner to the same Node patch and pnpm version', () => {
    const dockerfile = read('Dockerfile');
    expect(
      dockerfile.match(
        /FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd/g,
      ),
    ).toHaveLength(2);
    expect(dockerfile.match(/# node:24\.18\.0-alpine/g)).toHaveLength(2);
    expect(dockerfile).toContain('corepack prepare pnpm@11.5.1 --activate');
    expect(dockerfile).toContain('RUN node scripts/check-runtime.mjs --require-pnpm');
  });

  it('preflights direct automation entrypoints before starting the server', () => {
    expect(read('start_server.bat')).toContain('node scripts\\check-runtime.mjs --node-only');
    expect(read('run_server.ps1')).toContain('node scripts/check-runtime.mjs --node-only');
    expect(read('Taskfile.yml')).toContain('node scripts/check-runtime.mjs --require-pnpm');
    expect(read('src/index.ts')).toContain('assertSupportedNodeRuntime');
  });

  it('documents the exact recovery commands and removes stale broad ranges', () => {
    const docs = [
      'README.md',
      'docs/INSTALLATION.md',
      'docs/guide/getting-started.md',
      'docs/guide/troubleshooting.md',
      'docs/TROUBLESHOOTING.md',
      'docs/COMPATIBILITY.md',
    ]
      .map(read)
      .join('\n');

    expect(docs).toContain('24.18.0');
    expect(docs).toContain('pnpm@11.5.1');
    expect(docs).toContain('corepack prepare pnpm@11.5.1 --activate');
    expect(docs).not.toContain('>=24 <27');
    expect(docs).not.toContain('>= 24 < 27');
    expect(docs).not.toContain('pnpm >= 11');
  });
});
