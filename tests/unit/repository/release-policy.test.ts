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

  it('keeps Release Please stable-only and routes manual prereleases to isolated tags', () => {
    const workflow = readText('.github/workflows/release-please.yml');
    const config = JSON.parse(readText('release-please-config.json')) as {
      packages?: Record<string, { prerelease?: boolean }>;
    };

    expect(config.packages?.['.']?.prerelease).toBe(false);
    expect(workflow).toContain('release_channel:');
    expect(workflow).toContain('- stable');
    expect(workflow).toContain('- prerelease');
    expect(workflow).toContain('evidence_url:');
    expect(workflow).toContain("if: github.event_name == 'push'");
    expect(workflow).toContain('run: node scripts/release-channel-policy.mjs');
    expect(workflow).toContain('easyeda-mcp-pro-vX.Y.Z-rc.N');
    expect(workflow).toContain('RELEASE_CHANNEL');
    expect(workflow).toContain('NPM_DIST_TAG');
    expect(workflow).toContain('npm publish --provenance --tag "$NPM_DIST_TAG"');
    expect(workflow).toContain(
      "if: ${{ env.RELEASE_RUN == 'true' && env.RELEASE_CHANNEL == 'stable' }}",
    );
    expect(workflow).toContain('isPrerelease');
    expect(workflow).toContain(
      "enable=${{ needs.release-please.outputs.release_channel == 'stable' }}",
    );
    expect(workflow).toContain(
      "enable=${{ needs.release-please.outputs.release_channel == 'prerelease' }}",
    );
    expect(workflow).toContain('type=raw,value=next');
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
