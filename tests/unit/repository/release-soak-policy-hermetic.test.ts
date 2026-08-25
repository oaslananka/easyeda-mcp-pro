import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'scripts/release-soak-policy.mjs')).href;
const roots: string[] = [];

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'release-soak-policy-'));
  roots.push(root);
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'release-soak@example.invalid']);
  git(root, ['config', 'user.name', 'Release Soak Fixture']);
  await mkdir(join(root, 'config'), { recursive: true });
  await mkdir(join(root, 'src/config'), { recursive: true });
  await mkdir(join(root, 'src/server/transports'), { recursive: true });
  await writeJson(join(root, 'config/easyeda-compatibility.json'), {
    releaseGate: {
      sensitivePaths: ['src/config', 'src/server/transports'],
    },
  });
  await writeJson(join(root, 'package.json'), {
    name: 'easyeda-mcp-pro',
    version: '1.2.3',
  });
  await writeFile(join(root, 'src/config/env.ts'), "export const auth = 'stable';\n");
  await writeFile(join(root, 'src/server/transports/http.ts'), "export const http = 'stable';\n");
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture: stable 1.2.3']);
  git(root, ['tag', 'easyeda-mcp-pro-v1.2.3']);
  return root;
}

async function loadPolicy() {
  return import(moduleUrl) as Promise<{
    verifyStableSoak: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  }>;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('stable release soak policy orchestration', () => {
  it('rejects a sensitive RC-free patch before the pull request can merge', async () => {
    const root = await createFixture();
    const baseRef = git(root, ['rev-parse', 'HEAD']);
    await writeJson(join(root, 'package.json'), { name: 'easyeda-mcp-pro', version: '1.2.4' });
    await writeFile(join(root, 'src/config/env.ts'), "export const auth = 'changed';\n");
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'fix: change auth behavior']);
    const { verifyStableSoak } = await loadPolicy();

    await expect(
      verifyStableSoak({
        root,
        mode: 'pull_request',
        baseRef,
        targetRef: 'HEAD',
        now: '2026-08-26T00:00:00.000Z',
      }),
    ).rejects.toThrow('requires a numbered release candidate');
  });

  it('does not start the soak clock from a workflow run whose publish job was skipped', async () => {
    const root = await createFixture();
    await writeJson(join(root, 'package.json'), {
      name: 'easyeda-mcp-pro',
      version: '1.2.4-rc.1',
    });
    git(root, ['add', 'package.json']);
    git(root, ['commit', '-m', 'chore: candidate 1.2.4-rc.1']);
    const candidateCommit = git(root, ['rev-parse', 'HEAD']);
    git(root, ['tag', 'easyeda-mcp-pro-v1.2.4-rc.1']);
    await writeJson(join(root, 'package.json'), { name: 'easyeda-mcp-pro', version: '1.2.4' });
    git(root, ['add', 'package.json']);
    git(root, ['commit', '-m', 'chore: stable version promotion']);
    const requests: string[] = [];
    const { verifyStableSoak } = await loadPolicy();
    const fetchImpl = async (input: URL | string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const url = String(input);
      requests.push(url);
      if (url.includes('/actions/workflows/publish-release.yml/runs')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            workflow_runs: [
              {
                id: 77,
                event: 'workflow_dispatch',
                conclusion: 'success',
                head_sha: candidateCommit,
                updated_at: '2026-08-20T00:00:00.000Z',
              },
            ],
          }),
        };
      }
      if (url.includes('/actions/runs/77/jobs')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jobs: [{ name: 'Gate and publish immutable release', conclusion: 'skipped' }],
          }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    await expect(
      verifyStableSoak({
        root,
        mode: 'publish',
        releaseChannel: 'stable',
        releaseTag: 'easyeda-mcp-pro-v1.2.4',
        targetRef: 'HEAD',
        repository: 'oaslananka/easyeda-mcp-pro',
        now: '2026-08-24T00:00:00.000Z',
        fetchImpl,
      }),
    ).rejects.toThrow('No successful Publish Release workflow-dispatch run');
    expect(requests.some((url) => url.includes('/actions/runs/77/jobs'))).toBe(true);
  });

  it('does not let an emergency override bypass post-candidate runtime drift', async () => {
    const root = await createFixture();
    await writeJson(join(root, 'package.json'), {
      name: 'easyeda-mcp-pro',
      version: '1.2.4-rc.1',
    });
    git(root, ['add', 'package.json']);
    git(root, ['commit', '-m', 'chore: candidate 1.2.4-rc.1']);
    git(root, ['tag', 'easyeda-mcp-pro-v1.2.4-rc.1']);
    await writeJson(join(root, 'package.json'), { name: 'easyeda-mcp-pro', version: '1.2.4' });
    await writeFile(
      join(root, 'src/server/transports/http.ts'),
      "export const http = 'changed';\n",
    );
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'chore: promote with runtime drift']);
    const { verifyStableSoak } = await loadPolicy();

    await expect(
      verifyStableSoak({
        root,
        mode: 'publish',
        releaseChannel: 'stable',
        releaseTag: 'easyeda-mcp-pro-v1.2.4',
        targetRef: 'HEAD',
        repository: 'oaslananka/easyeda-mcp-pro',
        eventName: 'workflow_dispatch',
        evidenceUrl: 'https://github.com/oaslananka/easyeda-mcp-pro/issues/999',
        emergencySoakOverride: true,
        fetchImpl: () => {
          throw new Error('publication API must not be reached after runtime drift');
        },
      }),
    ).rejects.toThrow(
      'Runtime changes after easyeda-mcp-pro-v1.2.4-rc.1 require a new release candidate',
    );
  });

  it('allows an RC-free non-sensitive emergency patch to waive only the time gate', async () => {
    const root = await createFixture();
    await writeJson(join(root, 'package.json'), { name: 'easyeda-mcp-pro', version: '1.2.4' });
    await writeFile(join(root, 'README.md'), 'release note only\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'fix: emergency documentation-only patch']);
    const { verifyStableSoak } = await loadPolicy();

    await expect(
      verifyStableSoak({
        root,
        mode: 'publish',
        releaseChannel: 'stable',
        releaseTag: 'easyeda-mcp-pro-v1.2.4',
        targetRef: 'HEAD',
        eventName: 'workflow_dispatch',
        evidenceUrl: 'https://github.com/oaslananka/easyeda-mcp-pro/issues/999',
        emergencySoakOverride: true,
        now: '2026-08-26T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      applicable: true,
      emergencyOverride: true,
      eligible: true,
      requiredHours: 0,
    });
  });
});
