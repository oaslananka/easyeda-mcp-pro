import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const read = (path: string): string =>
  readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');

interface CompatibilitySource {
  schemaVersion: number;
  lastReviewed: string;
  reviewPolicyDays: number;
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
    easyedaPro: { version: string; electronVersion: string; chromiumVersion: string };
    server: { validationPackageVersion: string; releaseContainingFixes: string; commit: string };
    extension: {
      installedPackageVersion: string;
      loaderReportedVersion: string;
      bridgeContractVersion: string;
      methodRegistryHash: string;
      activeDispatcher: string;
      hotSwapCompiled: boolean;
      hotSwapEnabled: boolean;
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
    expect(source.records.length).toBeGreaterThan(0);

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
      expect(Date.parse(`${record.reviewBy}T23:59:59.999Z`)).toBeGreaterThanOrEqual(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()),
      );
      expect(record.environment.operatingSystem).not.toMatch(/TBD|unknown/i);
      expect(record.environment.architecture).not.toMatch(/TBD|unknown/i);
      expect(record.environment.kernel).not.toMatch(/TBD|unknown/i);
      expect(record.environment.nodeVersion).toMatch(/^24\./);
      expect(record.easyedaPro.version).toMatch(/^3\.2\.149\./);
      expect(record.easyedaPro.electronVersion).toMatch(/^36\./);
      expect(record.easyedaPro.chromiumVersion).toMatch(/^136\./);
      expect(record.server.validationPackageVersion).toMatch(/^0\.35\./);
      expect(record.server.releaseContainingFixes).toBe('0.35.1');
      expect(record.server.commit).toMatch(/^[0-9a-f]{7,40}$/);
      expect(record.extension.installedPackageVersion).toBe('0.35.1');
      expect(record.extension.loaderReportedVersion).toBe('0.35.0');
      expect(record.extension.bridgeContractVersion).toBe('1.0.0');
      expect(record.extension.methodRegistryHash).toMatch(/^[0-9a-f]{16}$/);
      expect(record.extension.activeDispatcher).toBe('baked');
      expect(record.extension.hotSwapCompiled).toBe(false);
      expect(record.extension.hotSwapEnabled).toBe(false);
      expect(record.knownLimitations.length).toBeGreaterThan(0);

      const levels = new Set(record.capabilities.map((capability) => capability.evidenceLevel));
      expect(levels).toContain('live');
      expect(levels).toContain('fake-runtime');
      for (const capability of record.capabilities) {
        expect(['live', 'fake-runtime', 'ci']).toContain(capability.evidenceLevel);
        expect(['passed', 'limited', 'blocked']).toContain(capability.status);
        expect(capability.evidence.length).toBeGreaterThan(0);
        for (const link of capability.evidence)
          expect(link).toMatch(/^https:\/\/github\.com\/oaslananka\/easyeda-mcp-pro\//);
      }
    }
  });

  it('generates the public matrix deterministically and blocks stale docs', async () => {
    const generator = (await import(
      pathToFileURL(resolve(repoRoot, 'scripts/generate-easyeda-compatibility.mjs')).href
    )) as {
      renderCompatibilityMarkdown(source: CompatibilitySource): Promise<string>;
    };
    const source = JSON.parse(read('config/easyeda-compatibility.json')) as CompatibilitySource;
    expect(read('docs/reference/easyeda-compatibility.md')).toBe(
      await generator.renderCompatibilityMarkdown(source),
    );

    const packageJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['generate:compatibility']).toContain(
      'generate-easyeda-compatibility.mjs',
    );
    expect(packageJson.scripts['check:compatibility']).toContain('--check');
    expect(packageJson.scripts['docs:build']).toContain('check:compatibility');
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
