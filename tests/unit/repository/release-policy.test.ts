import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

const readText = (path: string): string => {
  const absolutePath = resolve(repoRoot, path);
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : '';
};

describe('release channel policy', () => {
  it('documents stable, prerelease, soak, validation, rollback, and deprecation rules', () => {
    const policy = readText('docs/RELEASE_POLICY.md');

    expect(policy).toContain('easyeda-mcp-pro-vX.Y.Z');
    expect(policy).toContain('easyeda-mcp-pro-vX.Y.Z-rc.N');
    expect(policy).toContain('npm dist-tag `latest`');
    expect(policy).toContain('npm dist-tag `next`');
    expect(policy).toContain('24-hour');
    expect(policy).toContain('72-hour');
    expect(policy).toContain('7-day');
    expect(policy).toContain('Live EasyEDA Pro validation is mandatory');
    expect(policy).toContain('Emergency patch');
    expect(policy).toContain('Rollback and yanking');
    expect(policy).toContain('Deprecation and breaking changes');
    expect(policy).toContain('MCP Registry');
    expect(policy).toContain('GHCR');
  });

  it('separates release PR maintenance from fail-closed publication', () => {
    const manager = readText('.github/workflows/release-please.yml');
    const publisher = readText('.github/workflows/publish-release.yml');
    const config = JSON.parse(readText('release-please-config.json')) as {
      packages?: Record<string, { prerelease?: boolean }>;
    };

    expect(config.packages?.['.']?.prerelease).toBe(false);
    expect(manager).toContain('skip-github-release: true');
    expect(manager).not.toContain('workflow_dispatch:');
    expect(manager).not.toContain('npm publish');
    expect(manager).not.toContain('mcp-publisher');
    expect(manager).not.toContain('packages: write');
    expect(manager).not.toContain('attestations: write');

    expect(publisher).toContain('workflow_dispatch:');
    expect(publisher).toContain('run: node scripts/release-channel-policy.mjs');
    expect(publisher.indexOf('Read publication metadata')).toBeLessThan(
      publisher.indexOf('- name: Resolve publication plan'),
    );
    expect(publisher).toContain('HEAD_SHA: ${{ github.sha }}');
    expect(publisher).toContain('cancel-in-progress: false');
    expect(publisher).toContain('group: publish-${{ needs.plan.outputs.release_tag }}');
    expect(publisher).toContain('Verify commit-bound EasyEDA compatibility evidence');
    expect(publisher).toContain('Verify Quality Gates');
    expect(publisher).toContain('Create stable GitHub Release');
    expect(publisher).toContain('skip-github-pull-request: true');
    expect(publisher.indexOf('Verify Quality Gates')).toBeLessThan(
      publisher.indexOf('Create stable GitHub Release'),
    );
    expect(publisher).toContain('npm publish --provenance --tag "$NPM_DIST_TAG"');
    expect(publisher).toContain('npm dist-tag add');
    expect(publisher).toContain('./mcp-publisher publish');
    expect(publisher).toContain('type=raw,value=next');
    expect(publisher).toContain('type=raw,value=latest');
    expect(publisher).not.toContain('continue-on-error: true');
  });

  it('pins the current release toolchain and grants write permissions only to publication', () => {
    const manager = readText('.github/workflows/release-please.yml');
    const publisher = readText('.github/workflows/publish-release.yml');

    expect(manager).toContain('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
    expect(manager).toContain(
      'googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7',
    );
    expect(publisher).toContain('pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271');
    expect(publisher).toContain('actions/setup-node@820762786026740c76f36085b0efc47a31fe5020');
    expect(publisher).toContain('docker/login-action@abd2ef45e78c5afb21d64d4ca52ee8550d9572c7');
    expect(manager).toContain('contents: write');
    expect(manager).toContain('pull-requests: write');
    expect(publisher).toContain('id-token: write');
    expect(publisher).toContain('attestations: write');
    expect(publisher).toContain('packages: write');
  });

  it('links the public policy from contributor, process, verification, and docs navigation', () => {
    expect(readText('CONTRIBUTING.md')).toContain('[Release Policy](docs/RELEASE_POLICY.md)');
    expect(readText('docs/RELEASE_PROCESS.md')).toContain('[Release Policy](RELEASE_POLICY.md)');
    expect(readText('docs/RELEASE_VERIFICATION.md')).toContain(
      '[Release Policy](RELEASE_POLICY.md)',
    );
    expect(readText('docs/.vitepress/config.ts')).toContain("link: '/RELEASE_POLICY'");
    expect(readText('docs/supply-chain-verification.md')).toContain(
      '[Release Policy](RELEASE_POLICY.md)',
    );
    expect(readText('README.md')).toContain('[Release Policy](docs/RELEASE_POLICY.md)');
  });
});
