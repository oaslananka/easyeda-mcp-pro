import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'scripts/release-soak-policy.mjs')).href;

async function loadPolicy() {
  return import(moduleUrl) as Promise<{
    evaluateStableSoak: (input: {
      targetVersion: string;
      previousStableVersion: string | null;
      candidateVersion?: string | null;
      candidatePublishedAt?: string | null;
      baselineCommitAt?: string | null;
      now: string;
    }) => {
      eligible: boolean;
      requiredHours: number;
      eligibleAt: string;
    };
    selectLatestReleaseCandidate: (tags: string[], targetVersion: string) => string | null;
    selectCandidatePublicationRun: (
      runs: Array<{
        event: string;
        conclusion: string | null;
        head_sha: string;
        updated_at: string;
        publication_job_conclusion?: string | null;
      }>,
      candidateCommit: string,
    ) => { updated_at: string } | null;
    filterPostCandidateRuntimeChanges: (
      changes: Array<{ path: string; candidateSource?: string; targetSource?: string }>,
    ) => string[];
    filterReleaseCandidateRequiredChanges: (
      changes: Array<{ path: string; candidateSource?: string; targetSource?: string }>,
      sensitiveRoots: string[],
    ) => string[];
    validatePatchCandidateRequirement: (input: {
      releaseKind: string;
      candidateTag: string | null;
      sensitiveChanges: string[];
    }) => boolean;
    validateEmergencySoakOverride: (input: {
      enabled: boolean;
      mode: string;
      eventName: string;
      releaseKind: string;
      evidenceUrl: string;
    }) => boolean;
  }>;
}

describe('stable release soak policy', () => {
  it('blocks a major stable promotion until seven days after the final RC publication run', async () => {
    const { evaluateStableSoak } = await loadPolicy();

    expect(
      evaluateStableSoak({
        targetVersion: '1.0.0',
        previousStableVersion: '0.35.4',
        candidateVersion: '1.0.0-rc.6',
        candidatePublishedAt: '2026-08-22T00:55:34.000Z',
        now: '2026-08-26T00:00:00.000Z',
      }),
    ).toEqual({
      eligible: false,
      requiredHours: 168,
      eligibleAt: '2026-08-29T00:55:34.000Z',
    });
  });

  it('allows the same major promotion at the exact seven-day boundary', async () => {
    const { evaluateStableSoak } = await loadPolicy();

    expect(
      evaluateStableSoak({
        targetVersion: '1.0.0',
        previousStableVersion: '0.35.4',
        candidateVersion: '1.0.0-rc.6',
        candidatePublishedAt: '2026-08-22T00:55:34.000Z',
        now: '2026-08-29T00:55:34.000Z',
      }).eligible,
    ).toBe(true);
  });

  it('requires an RC for major/minor releases and 72 hours for a patch that has an RC', async () => {
    const { evaluateStableSoak } = await loadPolicy();

    expect(() =>
      evaluateStableSoak({
        targetVersion: '2.0.0',
        previousStableVersion: '1.9.9',
        now: '2026-08-30T00:00:00.000Z',
      }),
    ).toThrow('requires a numbered release candidate');

    expect(
      evaluateStableSoak({
        targetVersion: '1.2.4',
        previousStableVersion: '1.2.3',
        candidateVersion: '1.2.4-rc.1',
        candidatePublishedAt: '2026-08-20T00:00:00.000Z',
        now: '2026-08-22T23:59:59.000Z',
      }),
    ).toMatchObject({ eligible: false, requiredHours: 72 });
  });

  it('uses a conservative 24-hour main baseline for a patch without an RC', async () => {
    const { evaluateStableSoak } = await loadPolicy();

    expect(
      evaluateStableSoak({
        targetVersion: '1.2.4',
        previousStableVersion: '1.2.3',
        baselineCommitAt: '2026-08-25T12:00:00.000Z',
        now: '2026-08-26T11:59:59.000Z',
      }),
    ).toEqual({
      eligible: false,
      requiredHours: 24,
      eligibleAt: '2026-08-26T12:00:00.000Z',
    });
  });

  it('allows only release-managed version edits after the final candidate', async () => {
    const { filterPostCandidateRuntimeChanges } = await loadPolicy();
    const candidatePackage = JSON.stringify({
      name: 'easyeda-mcp-pro',
      version: '1.0.0-rc.6',
      dependencies: { zod: '1' },
    });
    const stablePackage = JSON.stringify({
      name: 'easyeda-mcp-pro',
      version: '1.0.0',
      dependencies: { zod: '1' },
    });
    const changedDependencyPackage = JSON.stringify({
      name: 'easyeda-mcp-pro',
      version: '1.0.0',
      dependencies: { zod: '2' },
    });

    expect(
      filterPostCandidateRuntimeChanges([
        { path: 'package.json', candidateSource: candidatePackage, targetSource: stablePackage },
        {
          path: 'src/config/version.ts',
          candidateSource:
            "export const SERVER_VERSION = '1.0.0-rc.6'; // x-release-please-version\n",
          targetSource: "export const SERVER_VERSION = '1.0.0'; // x-release-please-version\n",
        },
        { path: 'docs/RELEASE_PROCESS.md' },
        { path: 'scripts/release-readiness.mjs' },
      ]),
    ).toEqual([]);

    expect(
      filterPostCandidateRuntimeChanges([
        {
          path: 'package.json',
          candidateSource: candidatePackage,
          targetSource: changedDependencyPackage,
        },
        { path: 'src/server/transports/http.ts', candidateSource: 'old', targetSource: 'new' },
      ]),
    ).toEqual(['package.json', 'src/server/transports/http.ts']);
  });

  it('requires an RC for compatibility, auth, save/export, transaction, or setup-sensitive patches', async () => {
    const { filterReleaseCandidateRequiredChanges, validatePatchCandidateRequirement } =
      await loadPolicy();
    const candidatePackage = JSON.stringify({ name: 'easyeda-mcp-pro', version: '1.2.3' });
    const stablePackage = JSON.stringify({ name: 'easyeda-mcp-pro', version: '1.2.4' });
    const changes = [
      { path: 'package.json', candidateSource: candidatePackage, targetSource: stablePackage },
      { path: 'src/server/transports/http.ts', candidateSource: 'old', targetSource: 'new' },
      { path: 'src/config/env.ts', candidateSource: 'old', targetSource: 'new' },
      { path: 'src/cli/auto-setup.ts', candidateSource: 'old', targetSource: 'new' },
      { path: 'src/export-manifest/index.ts', candidateSource: 'old', targetSource: 'new' },
      { path: 'docs/RELEASE_PROCESS.md', candidateSource: 'old', targetSource: 'new' },
    ];
    const sensitiveRoots = [
      'src/server/transports',
      'src/config',
      'src/cli',
      'src/export-manifest',
    ];

    const sensitiveChanges = filterReleaseCandidateRequiredChanges(changes, sensitiveRoots);
    expect(sensitiveChanges).toEqual([
      'src/cli/auto-setup.ts',
      'src/config/env.ts',
      'src/export-manifest/index.ts',
      'src/server/transports/http.ts',
    ]);
    expect(() =>
      validatePatchCandidateRequirement({
        releaseKind: 'patch',
        candidateTag: null,
        sensitiveChanges,
      }),
    ).toThrow('requires a numbered release candidate');
    expect(
      validatePatchCandidateRequirement({
        releaseKind: 'patch',
        candidateTag: null,
        sensitiveChanges: [],
      }),
    ).toBe(true);
    expect(
      validatePatchCandidateRequirement({
        releaseKind: 'patch',
        candidateTag: 'easyeda-mcp-pro-v1.2.4-rc.1',
        sensitiveChanges,
      }),
    ).toBe(false);
  });

  it('allows an auditable soak override only for a manually dispatched emergency patch', async () => {
    const { validateEmergencySoakOverride } = await loadPolicy();

    expect(
      validateEmergencySoakOverride({
        enabled: true,
        mode: 'publish',
        eventName: 'workflow_dispatch',
        releaseKind: 'patch',
        evidenceUrl: 'https://github.com/oaslananka/easyeda-mcp-pro/issues/999',
      }),
    ).toBe(true);

    expect(() =>
      validateEmergencySoakOverride({
        enabled: true,
        mode: 'publish',
        eventName: 'push',
        releaseKind: 'patch',
        evidenceUrl: 'https://github.com/oaslananka/easyeda-mcp-pro/issues/999',
      }),
    ).toThrow('manual workflow dispatch');
    expect(() =>
      validateEmergencySoakOverride({
        enabled: true,
        mode: 'publish',
        eventName: 'workflow_dispatch',
        releaseKind: 'major',
        evidenceUrl: 'https://github.com/oaslananka/easyeda-mcp-pro/issues/999',
      }),
    ).toThrow('patch releases');
    expect(() =>
      validateEmergencySoakOverride({
        enabled: true,
        mode: 'publish',
        eventName: 'workflow_dispatch',
        releaseKind: 'patch',
        evidenceUrl: '',
      }),
    ).toThrow('public evidence URL');
  });

  it('selects the highest numbered RC and only a successful workflow-dispatch run for its exact commit', async () => {
    const { selectLatestReleaseCandidate, selectCandidatePublicationRun } = await loadPolicy();
    expect(
      selectLatestReleaseCandidate(
        [
          'easyeda-mcp-pro-v1.0.0-rc.2',
          'easyeda-mcp-pro-v1.0.0-rc.10',
          'easyeda-mcp-pro-v1.0.0-rc.9',
          'easyeda-mcp-pro-v1.0.1-rc.1',
        ],
        '1.0.0',
      ),
    ).toBe('easyeda-mcp-pro-v1.0.0-rc.10');

    expect(
      selectCandidatePublicationRun(
        [
          {
            event: 'workflow_dispatch',
            conclusion: 'success',
            head_sha: 'a'.repeat(40),
            updated_at: '2026-08-22T00:49:00.000Z',
            publication_job_conclusion: 'skipped',
          },
          {
            event: 'push',
            conclusion: 'success',
            head_sha: 'a'.repeat(40),
            updated_at: '2026-08-22T00:50:00.000Z',
            publication_job_conclusion: 'success',
          },
          {
            event: 'workflow_dispatch',
            conclusion: 'failure',
            head_sha: 'a'.repeat(40),
            updated_at: '2026-08-22T00:52:00.000Z',
            publication_job_conclusion: 'failure',
          },
          {
            event: 'workflow_dispatch',
            conclusion: 'success',
            head_sha: 'a'.repeat(40),
            updated_at: '2026-08-22T00:55:34.000Z',
            publication_job_conclusion: 'success',
          },
        ],
        'a'.repeat(40),
      ),
    ).toMatchObject({ updated_at: '2026-08-22T00:55:34.000Z' });
  });
});
