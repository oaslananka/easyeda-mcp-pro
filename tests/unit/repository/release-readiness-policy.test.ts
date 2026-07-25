import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');

describe('release readiness policy', () => {
  it('binds live EasyEDA evidence to a full commit and sensitive path policy', () => {
    const source = JSON.parse(read('config/easyeda-compatibility.json')) as {
      releaseGate?: { sensitivePaths?: string[]; requiredFreshLiveRecords?: number };
      records: Array<{ server: { commit: string } }>;
    };

    expect(source.releaseGate?.requiredFreshLiveRecords).toBe(1);
    expect(source.releaseGate?.sensitivePaths).toEqual(
      expect.arrayContaining([
        'easyeda-bridge-extension/src',
        'src/bridge',
        'src/remote',
        'src/server/transports',
        'src/tools',
      ]),
    );
    for (const record of source.records) expect(record.server.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reports compatibility freshness deterministically for the checked-out head', () => {
    const result = spawnSync(
      process.execPath,
      [resolve(repoRoot, 'scripts/check-release-readiness.mjs'), '--compatibility-only', '--json'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    const report = JSON.parse(result.stdout) as {
      status: 'current' | 'stale' | 'unavailable';
      headCommit: string;
      records: Array<{ status: string; changedFiles: string[] }>;
    };

    expect(report.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(report.records.length).toBeGreaterThan(0);
    expect(result.status).toBe(report.status === 'current' ? 0 : 1);
    for (const record of report.records) {
      if (record.status === 'current') expect(record.changedFiles).toEqual([]);
      if (record.status === 'stale') expect(record.changedFiles.length).toBeGreaterThan(0);
    }
  });

  it('runs the compatibility gate before release publication and exposes a full local command', () => {
    const workflow = read('.github/workflows/publish-release.yml');
    const packageJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const script = read('scripts/check-release-readiness.mjs');

    expect(workflow).toContain('check-release-readiness.mjs --compatibility-only');
    expect(workflow).toContain('--target-ref="${TARGET_REF}"');
    expect(workflow.indexOf('Verify commit-bound EasyEDA compatibility evidence')).toBeLessThan(
      workflow.indexOf('Create stable GitHub Release'),
    );
    expect(packageJson.scripts['release:readiness']).toContain('check-release-readiness.mjs');
    expect(packageJson.scripts['release:readiness:compatibility']).toContain(
      '--compatibility-only',
    );
    for (const command of [
      'pnpm security:audit',
      'pnpm verify',
      'pnpm test:coverage',
      'pnpm verify:extension',
      'npm pack --dry-run',
    ]) {
      expect(script).toContain(command);
    }
  });
});
