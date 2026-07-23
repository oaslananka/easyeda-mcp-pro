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
    expect(resolveReleaseChannel({ eventName: 'push', releaseCreated: 'false' })).toEqual({
      releaseRun: false,
      releaseTag: '',
      releaseChannel: '',
      npmDistTag: '',
    });
  });

  it('maps a Release Please tag only to the stable channel', () => {
    expect(
      resolveReleaseChannel({
        eventName: 'push',
        releaseCreated: 'true',
        generatedTag: 'easyeda-mcp-pro-v1.2.3',
      }),
    ).toEqual({
      releaseRun: true,
      releaseTag: 'easyeda-mcp-pro-v1.2.3',
      releaseChannel: 'stable',
      npmDistTag: 'latest',
    });

    expect(() =>
      resolveReleaseChannel({
        eventName: 'push',
        releaseCreated: 'true',
        generatedTag: 'easyeda-mcp-pro-v1.2.3-rc.1',
      }),
    ).toThrow('Release Please is stable-only');
  });

  it('maps a numbered manual candidate to the isolated prerelease channel', () => {
    expect(
      resolveReleaseChannel({
        eventName: 'workflow_dispatch',
        manualTag: 'easyeda-mcp-pro-v1.2.3-rc.4',
        manualChannel: 'prerelease',
        evidenceUrl: 'https://github.com/oaslananka/easyeda-mcp-pro/issues/342',
      }),
    ).toEqual({
      releaseRun: true,
      releaseTag: 'easyeda-mcp-pro-v1.2.3-rc.4',
      releaseChannel: 'prerelease',
      npmDistTag: 'next',
    });
  });

  it('writes channel-safe GitHub Actions outputs for stable and prerelease runs', () => {
    const stable = makeOutputFiles();
    runCli({
      EVENT_NAME: 'push',
      RELEASE_CREATED: 'true',
      GENERATED_TAG: 'easyeda-mcp-pro-v1.2.3',
      GITHUB_ENV: stable.env,
      GITHUB_OUTPUT: stable.output,
      GITHUB_STEP_SUMMARY: stable.summary,
    });
    expect(readFileSync(stable.env, 'utf8')).toContain('NPM_DIST_TAG=latest');
    expect(readFileSync(stable.output, 'utf8')).toContain('release_channel=stable');
    expect(readFileSync(stable.summary, 'utf8')).toBe('');

    const prerelease = makeOutputFiles();
    runCli({
      EVENT_NAME: 'workflow_dispatch',
      MANUAL_TAG: 'easyeda-mcp-pro-v1.2.3-rc.5',
      MANUAL_CHANNEL: 'prerelease',
      EVIDENCE_URL: 'https://github.com/oaslananka/easyeda-mcp-pro/pull/375',
      GITHUB_ENV: prerelease.env,
      GITHUB_OUTPUT: prerelease.output,
      GITHUB_STEP_SUMMARY: prerelease.summary,
    });
    expect(readFileSync(prerelease.env, 'utf8')).toContain('NPM_DIST_TAG=next');
    expect(readFileSync(prerelease.output, 'utf8')).toContain('release_channel=prerelease');
    expect(readFileSync(prerelease.summary, 'utf8')).toContain(
      'Evidence: https://github.com/oaslananka/easyeda-mcp-pro/pull/375',
    );
  });

  it('writes a disabled result and rejects missing GitHub Actions output paths', () => {
    expect(() => runCli({})).toThrow('Unsupported release event: <empty>');

    const ordinary = makeOutputFiles();
    runCli({
      EVENT_NAME: 'push',
      GITHUB_ENV: ordinary.env,
      GITHUB_OUTPUT: ordinary.output,
      GITHUB_STEP_SUMMARY: ordinary.summary,
    });
    expect(readFileSync(ordinary.env, 'utf8')).toContain('RELEASE_RUN=false');
    expect(readFileSync(ordinary.output, 'utf8')).toContain('release_run=false');
    expect(() => runCli({ EVENT_NAME: 'push' })).toThrow(
      'GitHub Actions output path is unavailable',
    );
  });

  it('exits closed when the executable bootstrap receives invalid evidence', () => {
    const paths = makeOutputFiles();
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EVENT_NAME: 'workflow_dispatch',
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

  it('rejects invalid evidence, tag forms, and channel mismatches', () => {
    expect(() => resolveReleaseChannel({ eventName: '' })).toThrow(
      'Unsupported release event: <empty>',
    );

    expect(() =>
      resolveReleaseChannel({
        eventName: 'workflow_dispatch',
        manualTag: 'easyeda-mcp-pro-v1.2.3-rc.1',
        manualChannel: 'prerelease',
        evidenceUrl: 'https://example.com/private-evidence',
      }),
    ).toThrow('public easyeda-mcp-pro issue or PR evidence URL');

    expect(() =>
      resolveReleaseChannel({
        eventName: 'workflow_dispatch',
        manualTag: 'easyeda-mcp-pro-v1.2.3-beta.1',
        manualChannel: 'prerelease',
        evidenceUrl: 'https://github.com/oaslananka/easyeda-mcp-pro/pull/375',
      }),
    ).toThrow('Invalid tag');

    expect(() =>
      resolveReleaseChannel({
        eventName: 'workflow_dispatch',
        manualTag: 'easyeda-mcp-pro-v1.2.3',
        manualChannel: 'prerelease',
        evidenceUrl: 'https://github.com/oaslananka/easyeda-mcp-pro/issues/342',
      }),
    ).toThrow('does not match');

    expect(() =>
      resolveReleaseChannel({
        eventName: 'workflow_dispatch',
        manualTag: 'easyeda-mcp-pro-v1.2.3',
        evidenceUrl: 'https://github.com/oaslananka/easyeda-mcp-pro/issues/342',
      }),
    ).toThrow('Requested channel <empty>');
  });
});
