import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');

describe('release readiness policy', () => {
  it('binds live EasyEDA evidence to a full commit and sensitive path policy', () => {
    const source = JSON.parse(read('config/easyeda-compatibility.json')) as {
      releaseGate?: { sensitivePaths?: string[]; requiredFreshLiveRecords?: number };
      records: Array<{
        server: {
          commit: string;
          compatibilitySnapshot?: { algorithm: string; paths: Record<string, string> };
        };
      }>;
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
    const snapshotRecord = source.records.find((record) => record.server.compatibilitySnapshot);
    expect(snapshotRecord?.server.compatibilitySnapshot?.algorithm).toBe('git-tree-sha1');
    expect(Object.keys(snapshotRecord?.server.compatibilitySnapshot?.paths ?? {}).sort()).toEqual(
      [...(source.releaseGate?.sensitivePaths ?? [])].sort(),
    );
  });

  it('runs the compatibility gate before release publication and exposes a full local command', () => {
    const workflow = read('.github/workflows/publish-release.yml');
    const packageJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const script = read('scripts/check-release-readiness.mjs');

    expect(workflow).toContain('check-release-readiness.mjs --compatibility-only');
    expect(workflow).toContain('--target-ref="${TARGET_REF}"');
    expect(workflow.indexOf('Verify commit-bound EasyEDA compatibility evidence')).toBeLessThan(
      workflow.indexOf('Create commit-bound GitHub Release'),
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
