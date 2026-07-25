import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveReleaseChannel, runCli } from '../../../scripts/release-channel-policy.mjs';

const scriptPath = resolve(process.cwd(), 'scripts/release-channel-policy.mjs');

function makeOutputFiles() {
  const root = mkdtempSync(resolve(tmpdir(), 'easyeda-release-policy-'));
  const paths = {
    env: resolve(root, 'github-env'),
    output: resolve(root, 'github-output'),
    summary: resolve(root, 'github-summary'),
  };
  for (const path of Object.values(paths)) writeFileSync(path, '', 'utf8');
  return paths;
}

describe('release channel resolver', () => {
  it('does nothing on an ordinary main push', () => {
    expect(
      resolveReleaseChannel({
        eventName: 'push',
        refName: 'main',
        commitSubject: 'docs: clarify recovery',
        packageVersion: '0.35.3',
        manifestVersion: '0.35.3',
      }),
    ).toEqual({
      releaseRun: false,
      releaseTag: '',
      releaseChannel: '',
      npmDistTag: '',
      targetRef: '',
      createGithubRelease: false,
      evidenceUrl: '',
    });
  });

  it('plans a first automatic stable publication before the tag exists', () => {
    expect(
      resolveReleaseChannel({
        eventName: 'push',
        refName: 'main',
        commitSubject: 'chore(main): release easyeda-mcp-pro 1.2.3 (#500)',
        headSha: '0123456789abcdef0123456789abcdef01234567',
        packageVersion: '1.2.3',
        manifestVersion: '1.2.3',
        tagExists: false,
      }),
    ).toEqual({
      releaseRun: true,
      releaseTag: 'easyeda-mcp-pro-v1.2.3',
      releaseChannel: 'stable',
      npmDistTag: 'latest',
      targetRef: '0123456789abcdef0123456789abcdef01234567',
      createGithubRelease: true,
      evidenceUrl: '',
    });
  });

  it('plans an idempotent automatic recovery when the stable tag already exists', () => {
    expect(
      resolveReleaseChannel({
        eventName: 'push',
        refName: 'main',
        commitSubject: 'chore(main): release easyeda-mcp-pro 1.2.3 (#500)',
        headSha: '0123456789abcdef0123456789abcdef01234567',
        packageVersion: '1.2.3',
        manifestVersion: '1.2.3',
        tagExists: true,
      }),
    ).toMatchObject({
      releaseRun: true,
      releaseTag: 'easyeda-mcp-pro-v1.2.3',
      targetRef: 'easyeda-mcp-pro-v1.2.3',
      createGithubRelease: false,
    });
  });

  it('rejects automatic release metadata drift and non-main release commits', () => {
    expect(() =>
      resolveReleaseChannel({
        eventName: 'push',
        refName: 'main',
        commitSubject: 'chore(main): release easyeda-mcp-pro 1.2.3 (#500)',
        headSha: '0123456789abcdef0123456789abcdef01234567',
        packageVersion: '1.2.4',
        manifestVersion: '1.2.3',
      }),
    ).toThrow('release metadata drift');
    expect(() =>
      resolveReleaseChannel({
        eventName: 'push',
        refName: 'feature/not-main',
        commitSubject: 'chore(main): release easyeda-mcp-pro 1.2.3 (#500)',
        headSha: '0123456789abcdef0123456789abcdef01234567',
        packageVersion: '1.2.3',
        manifestVersion: '1.2.3',
      }),
    ).toThrow('Automatic publication requires main');
  });

  it('maps manual stable recovery and numbered candidates to isolated channels', () => {
    expect(
      resolveReleaseChannel({
        eventName: 'workflow_dispatch',
        refName: 'main',
        manualTag: 'easyeda-mcp-pro-v1.2.3',
        manualChannel: 'stable',
        evidenceUrl: 'https://github.com/oaslananka/easyeda-mcp-pro/issues/407',
      }),
    ).toMatchObject({
      releaseRun: true,
      releaseChannel: 'stable',
      npmDistTag: 'latest',
      targetRef: 'easyeda-mcp-pro-v1.2.3',
      createGithubRelease: false,
    });
    expect(
      resolveReleaseChannel({
        eventName: 'workflow_dispatch',
        refName: 'main',
        manualTag: 'easyeda-mcp-pro-v1.2.3-rc.4',
        manualChannel: 'prerelease',
        evidenceUrl: 'https://github.com/oaslananka/easyeda-mcp-pro/pull/408',
      }),
    ).toMatchObject({
      releaseRun: true,
      releaseChannel: 'prerelease',
      npmDistTag: 'next',
      targetRef: 'easyeda-mcp-pro-v1.2.3-rc.4',
      createGithubRelease: false,
    });
  });

  it('rejects invalid manual branch, evidence, tag forms, and channel mismatches', () => {
    expect(() =>
      resolveReleaseChannel({
        eventName: 'workflow_dispatch',
        refName: 'easyeda-mcp-pro-v1.2.3',
        manualTag: 'easyeda-mcp-pro-v1.2.3',
        manualChannel: 'stable',
        evidenceUrl: 'https://github.com/oaslananka/easyeda-mcp-pro/issues/407',
      }),
    ).toThrow('Manual publication must be dispatched from main');
    expect(() =>
      resolveReleaseChannel({
        eventName: 'workflow_dispatch',
        refName: 'main',
        manualTag: 'easyeda-mcp-pro-v1.2.3-rc.1',
        manualChannel: 'prerelease',
        evidenceUrl: 'https://example.invalid/private',
      }),
    ).toThrow('public easyeda-mcp-pro issue or PR evidence URL');
    expect(() =>
      resolveReleaseChannel({
        eventName: 'workflow_dispatch',
        refName: 'main',
        manualTag: 'easyeda-mcp-pro-v1.2.3-beta.1',
        manualChannel: 'prerelease',
        evidenceUrl: 'https://github.com/oaslananka/easyeda-mcp-pro/pull/408',
      }),
    ).toThrow('Invalid tag');
    expect(() =>
      resolveReleaseChannel({
        eventName: 'workflow_dispatch',
        refName: 'main',
        manualTag: 'easyeda-mcp-pro-v1.2.3',
        manualChannel: 'prerelease',
        evidenceUrl: 'https://github.com/oaslananka/easyeda-mcp-pro/issues/407',
      }),
    ).toThrow('does not match');
  });

  it('writes normalized GitHub Actions outputs and manual evidence summary', () => {
    const paths = makeOutputFiles();
    runCli({
      EVENT_NAME: 'workflow_dispatch',
      REF_NAME: 'main',
      MANUAL_TAG: 'easyeda-mcp-pro-v1.2.3-rc.5',
      MANUAL_CHANNEL: 'prerelease',
      EVIDENCE_URL: 'https://github.com/oaslananka/easyeda-mcp-pro/pull/408',
      GITHUB_ENV: paths.env,
      GITHUB_OUTPUT: paths.output,
      GITHUB_STEP_SUMMARY: paths.summary,
    });
    expect(readFileSync(paths.env, 'utf8')).toContain('TARGET_REF=easyeda-mcp-pro-v1.2.3-rc.5');
    expect(readFileSync(paths.output, 'utf8')).toContain('create_github_release=false');
    expect(readFileSync(paths.summary, 'utf8')).toContain(
      'Evidence: https://github.com/oaslananka/easyeda-mcp-pro/pull/408',
    );
  });

  it('exits closed when the executable bootstrap receives invalid evidence', () => {
    const paths = makeOutputFiles();
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EVENT_NAME: 'workflow_dispatch',
        REF_NAME: 'main',
        MANUAL_TAG: 'easyeda-mcp-pro-v1.2.3-rc.1',
        MANUAL_CHANNEL: 'prerelease',
        EVIDENCE_URL: 'https://example.invalid/private',
        GITHUB_ENV: paths.env,
        GITHUB_OUTPUT: paths.output,
        GITHUB_STEP_SUMMARY: paths.summary,
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('public easyeda-mcp-pro issue or PR evidence URL');
  });
});
