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
    expect(publisher).toContain('source_commit:');
    expect(publisher).toContain('MANUAL_SOURCE_COMMIT: ${{ inputs.source_commit }}');
    expect(publisher).toContain('git cat-file -e "${TARGET_REF}^{commit}"');
    expect(publisher).toContain('TAG_COMMIT="$(git rev-parse "${RELEASE_TAG}^{commit}")"');
    expect(publisher).toContain('TARGET_COMMIT="$(git rev-parse "${TARGET_REF}^{commit}")"');
    expect(publisher).toContain('cancel-in-progress: false');
    expect(publisher).toContain('group: publish-${{ needs.plan.outputs.release_tag }}');
    expect(publisher).toContain('Verify commit-bound EasyEDA compatibility evidence');
    expect(publisher).toContain('Verify Quality Gates');
    expect(publisher).toContain('Create commit-bound GitHub Release');
    expect(publisher).toContain('TARGET_COMMIT="$(git rev-parse "${TARGET_REF}^{commit}")"');
    expect(publisher).toContain('gh release create "$RELEASE_TAG"');
    expect(publisher).toContain('--target "$TARGET_COMMIT"');
    expect(publisher).not.toContain('skip-github-pull-request: true');
    expect(publisher.indexOf('Verify Quality Gates')).toBeLessThan(
      publisher.indexOf('Create commit-bound GitHub Release'),
    );
    expect(publisher).toContain('npm publish --provenance --tag "$NPM_DIST_TAG"');
    expect(publisher).not.toContain('NODE_AUTH_TOKEN="$NPM_TOKEN" npm publish');
    expect(publisher).toContain('NODE_AUTH_TOKEN="$NPM_TOKEN" npm dist-tag add');
    expect(publisher).toContain('name: Verify published release');
    expect(publisher).toContain('pnpm release:verify-published');
    expect(publisher).toContain('--report-json reports/published-release.json');
    expect(publisher).toContain('--summary-file reports/published-release-summary.md');
    expect(publisher).toContain('for attempt in $(seq 1 12)');
    expect(publisher).toContain('sleep 10');
    expect(publisher).toContain(
      'cat reports/published-release-summary.md >> "$GITHUB_STEP_SUMMARY"',
    );
    expect(publisher.indexOf('Build and push Docker image')).toBeLessThan(
      publisher.indexOf('Verify published release'),
    );
    expect(publisher).toContain('name: Upload published release verification');
    expect(publisher).toContain('published-release-${{ env.RELEASE_TAG }}');
    expect(publisher).toContain('path: reports/published-release.json');
    expect(publisher).toContain('if-no-files-found: warn');
    expect(publisher).toContain('if: ${{ always() }}');
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
    expect(manager).toContain('token: ${{ secrets.RELEASE_PLEASE_TOKEN }}');
    expect(manager).not.toContain('token: ${{ secrets.GITHUB_TOKEN }}');
    expect(publisher).not.toContain(
      'googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7',
    );
    expect(publisher).not.toContain('token: ${{ secrets.RELEASE_PLEASE_TOKEN }}');
    expect(publisher).toContain('GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN }}');
    expect(publisher).not.toContain('token: ${{ secrets.GITHUB_TOKEN }}');
    expect(manager.match(/RELEASE_PLEASE_TOKEN/g)).toHaveLength(1);
    expect(publisher.match(/RELEASE_PLEASE_TOKEN/g)).toHaveLength(2);
    expect(publisher).toContain('id-token: write');
    expect(publisher).toContain('attestations: write');
    expect(publisher).toContain('packages: write');
  });

  it('documents pre-tag gating, split workflows, and main-based recovery', () => {
    const process = readText('docs/RELEASE_PROCESS.md');
    const runbook = readText('docs/release-ci-runbook.md');
    const recovery = readText('docs/SOLO_MAINTAINER_RECOVERY.md');

    expect(process).toContain('Release Please PR');
    expect(process).toContain('Publish Release');
    expect(process).toContain('before the immutable tag and GitHub Release are created');
    expect(process).toContain('npm Trusted Publishing');
    expect(process).toContain('RELEASE_PLEASE_TOKEN');
    expect(runbook).toContain('gh workflow run publish-release.yml --ref main');
    expect(runbook).toContain('-f source_commit=69892876b5cf2ddcc1de1b590c0ce35c61a36698');
    expect(runbook).not.toContain('gh workflow run release-please.yml');
    expect(recovery).toContain('gh workflow run publish-release.yml --ref main');
    expect(recovery).toContain('NPM_TOKEN is retained only for dist-tag repair');
  });

  it('documents OIDC-only publication, final verification, and live rollback evidence', () => {
    const openssf = readText('docs/OPENSSF_BEST_PRACTICES.md');
    const verification = readText('docs/RELEASE_VERIFICATION.md');
    const process = readText('docs/RELEASE_PROCESS.md');
    const runbook = readText('docs/release-ci-runbook.md');
    const recovery = readText('docs/SOLO_MAINTAINER_RECOVERY.md');
    const combined = [openssf, verification, process, runbook, recovery].join('\n');

    expect(combined).toContain('new npm versions use Trusted Publishing without `NPM_TOKEN`');
    expect(combined).toContain('`NPM_TOKEN` is restricted to existing-version dist-tag recovery');
    expect(combined).toContain('Verify published release');
    expect(combined).toContain('published-release.json');
    expect(combined).toContain('create/modify/delete rollback');
    expect(combined).toContain('TestMcp / Schematic1 / P1');
    expect(openssf).toContain('`signed_releases`                 | Met');
    expect(openssf).toContain(
      'provenance and GitHub Artifact Attestations satisfy the project signed-release posture',
    );
    expect(openssf).toContain('bus factor remains one');
    expect(runbook).toContain('EASYEDA_LIVE_WRITE_TESTS=true');
    expect(runbook).toContain('EASYEDA_EXPECTED_PROJECT=TestMcp');
    expect(runbook).toContain('EASYEDA_EXPECTED_SCHEMATIC=Schematic1');
    expect(runbook).toContain('EASYEDA_EXPECTED_PAGE=P1');
    expect(runbook).toContain(
      'EASYEDA_TRANSACTION_SMOKE_REPORT_PATH=/tmp/easyeda-transaction-smoke.json',
    );
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
