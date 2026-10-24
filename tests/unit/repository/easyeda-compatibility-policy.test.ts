import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const read = (path: string): string =>
  readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');

interface CompatibilitySource {
  schemaVersion: number;
  lastReviewed: string;
  reviewPolicyDays: number;
  releaseGate: { requiredFreshLiveRecords: number; sensitivePaths: string[] };
  records: Array<{
    id: string;
    status: string;
    validatedAt: string;
    reviewBy: string;
    environment: {
      operatingSystem: string;
      architecture: string;
      kernel: string;
      nodeVersion: string;
    };
    easyedaPro: {
      version: string;
      electronVersion: string;
      chromiumVersion: string;
      chromiumVersionProvenance?: string;
    };
    server: {
      validationPackageVersion: string;
      releaseContainingFixes: string;
      commit: string;
      compatibilitySnapshot?: {
        algorithm: string;
        paths: Record<string, string>;
      };
    };
    extension: {
      installedPackageVersion: string;
      loaderReportedVersion: string;
      bridgeContractVersion: string;
      methodRegistryHash: string;
      activeDispatcher: string;
      hotSwapCompiled: boolean;
      hotSwapEnabled: boolean;
      packageSha256?: string;
      packageSizeBytes?: number;
    };
    capabilities: Array<{
      id: string;
      evidenceLevel: string;
      status: string;
      evidence: string[];
      limitation?: string;
    }>;
    knownLimitations: string[];
  }>;
}

describe('EasyEDA compatibility evidence policy', () => {
  it('keeps exact, reviewable runtime evidence in a machine-readable source', () => {
    const sourcePath = 'config/easyeda-compatibility.json';
    expect(existsSync(resolve(repoRoot, sourcePath))).toBe(true);
    const source = JSON.parse(read(sourcePath)) as CompatibilitySource;

    expect(source.schemaVersion).toBe(1);
    expect(source.lastReviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(source.reviewPolicyDays).toBeGreaterThan(0);
    expect(source.releaseGate.requiredFreshLiveRecords).toBe(1);
    expect(source.releaseGate.sensitivePaths.length).toBeGreaterThan(0);
    expect(source.records.length).toBeGreaterThan(0);

    expect(source.records[0]?.extension.packageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(source.records[0]?.extension.packageSizeBytes).toBeGreaterThan(0);

    for (const record of source.records) {
      expect(record.id).toMatch(/^[a-z0-9-]+$/);
      expect(record.status).toBe('live-validated');
      expect(Date.parse(record.validatedAt)).not.toBeNaN();
      expect(Date.parse(record.reviewBy)).toBeGreaterThan(Date.parse(record.validatedAt));
      const reviewWindowDays =
        (Date.parse(`${record.reviewBy}T00:00:00.000Z`) -
          Date.parse(`${record.validatedAt.slice(0, 10)}T00:00:00.000Z`)) /
        (24 * 60 * 60 * 1000);
      expect(reviewWindowDays).toBeLessThanOrEqual(source.reviewPolicyDays);
      // Expired historical records remain valid evidence of past tests;
      // the release-readiness gate decides whether evidence is still fresh.
      expect(record.environment.operatingSystem).not.toMatch(/TBD|unknown/i);
      expect(record.environment.architecture).not.toMatch(/TBD|unknown/i);
      expect(record.environment.kernel).not.toMatch(/TBD|unknown/i);
      expect(record.environment.nodeVersion).toMatch(/^24\./);
      expect(record.easyedaPro.version).toMatch(/^3\.2\.\d+\.[0-9a-f]{8}$/);
      // Vendor Electron/Chromium versions evolve independently of old compatibility records.
      expect(record.easyedaPro.electronVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(record.easyedaPro.chromiumVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(record.server.validationPackageVersion).toMatch(
        /^(?:0\.35\.\d+|\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?)$/,
      );
      expect(record.server.releaseContainingFixes).toBe(record.server.validationPackageVersion);
      expect(record.server.commit).toMatch(/^[0-9a-f]{40}$/);
      if (!/^0\.35\./.test(record.server.validationPackageVersion)) {
        expect(record.server.compatibilitySnapshot?.algorithm).toBe('git-tree-sha1');
        expect(Object.keys(record.server.compatibilitySnapshot?.paths ?? {}).sort()).toEqual(
          [...source.releaseGate.sensitivePaths].sort(),
        );
        for (const tree of Object.values(record.server.compatibilitySnapshot?.paths ?? {})) {
          expect(tree).toMatch(/^[0-9a-f]{40}$/);
        }
      }
      expect(record.extension.installedPackageVersion).toMatch(/^\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?$/);
      expect(record.extension.loaderReportedVersion).toBe(record.server.releaseContainingFixes);
      const rcMatch = /^1\.0\.0-rc\.([1-9]\d*)$/.exec(record.server.releaseContainingFixes);
      expect(record.extension.installedPackageVersion).toBe(
        rcMatch ? `0.99.${rcMatch[1]}` : record.server.releaseContainingFixes,
      );
      expect(record.extension.bridgeContractVersion).toBe('1.0.0');
      expect(record.extension.methodRegistryHash).toMatch(/^[0-9a-f]{16}$/);
      expect(record.extension.activeDispatcher).toBe('baked');
      expect(record.extension.hotSwapCompiled).toBe(false);
      expect(record.extension.hotSwapEnabled).toBe(false);
      if (
        record.extension.packageSha256 !== undefined ||
        record.extension.packageSizeBytes !== undefined
      ) {
        expect(record.extension.packageSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(record.extension.packageSizeBytes).toBeGreaterThan(0);
      }
      expect(record.knownLimitations.length).toBeGreaterThan(0);

      const levels = new Set(record.capabilities.map((capability) => capability.evidenceLevel));
      expect(levels).toContain('live');
      for (const capability of record.capabilities) {
        expect(['live', 'fake-runtime', 'ci']).toContain(capability.evidenceLevel);
        expect(['passed', 'limited', 'blocked']).toContain(capability.status);
        expect(capability.evidence.length).toBeGreaterThan(0);
        for (const link of capability.evidence)
          expect(link).toMatch(/^https:\/\/github\.com\/oaslananka\/easyeda-mcp-pro\//);
      }
    }
  });

  it('generates the public matrix deterministically and blocks stale docs', () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [resolve(repoRoot, 'scripts/generate-easyeda-compatibility.mjs'), '--check'],
        { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' },
      ),
    ).not.toThrow();

    const packageJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['generate:compatibility']).toContain(
      'generate-easyeda-compatibility.mjs',
    );
    expect(packageJson.scripts['check:compatibility']).toContain('--check');
    expect(packageJson.scripts['docs:build']).toContain('check:compatibility');
    const generator = read('scripts/generate-easyeda-compatibility.mjs');
    expect(generator).toContain("left.localeCompare(right, 'en')");
    expect(generator).toContain('sort(comparePaths)');
    expect(generator).not.toMatch(/\.sort\(\)/);
    expect(read('docs/reference/easyeda-compatibility.md')).toContain(
      'recorded compatibility-sensitive snapshot',
    );
  });

  it('generates unique record headings and labels unmeasured Chromium references', () => {
    const source = JSON.parse(read('config/easyeda-compatibility.json')) as CompatibilitySource;
    const documentation = read('docs/reference/easyeda-compatibility.md');
    const headings = documentation.split('\n').filter((line) => line.startsWith('## '));

    for (const record of source.records) {
      const heading = `## ${record.easyedaPro.version} on ${record.environment.operatingSystem} (${record.environment.architecture}) — ${record.id}`;
      expect(headings.filter((line) => line === heading)).toHaveLength(1);
      if (record.easyedaPro.chromiumVersionProvenance) {
        expect(record.easyedaPro.chromiumVersionProvenance).toContain('not independently measured');
        expect(
          documentation
            .split('\n')
            .some(
              (line) =>
                line.startsWith('| Chromium') &&
                line.includes(record.easyedaPro.chromiumVersion) &&
                line.includes(record.easyedaPro.chromiumVersionProvenance ?? ''),
            ),
        ).toBe(true);
      }
    }

    const liveEvidence = JSON.parse(
      read(
        'docs/evidence/easyeda-live/2026-10-24-windows-11-easyeda-3.2.209-v1.5.3-owner-readonly.json',
      ),
    ) as {
      operatingSystem: { pnpm: string; pnpmValidationProvenance: string };
      sourceIdentity: { exactPrHead: string };
    };
    expect(liveEvidence.operatingSystem.pnpm).toBe('11.28.3');
    expect(liveEvidence.operatingSystem.pnpmValidationProvenance).toContain('11.28.0');
    expect(liveEvidence.operatingSystem.pnpmValidationProvenance).toContain(
      'identical .eext SHA-256',
    );
    expect(liveEvidence.sourceIdentity.exactPrHead).toBe(source.records[0]?.server.commit);
  });

  it('does not use unsupported env syntax fences in VitePress documentation', () => {
    for (const path of [
      'docs/SELF_HOSTED_REMOTE_MCP.md',
      'docs/REMOTE_GATEWAY_DESIGN.md',
      'docs/reference/easyeda-compatibility.md',
    ]) {
      expect(read(path)).not.toMatch(/^```env\s*$/m);
    }
  });
});
