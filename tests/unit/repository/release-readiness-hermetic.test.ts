import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectCompatibilityFreshness,
  loadCompatibilityEvidence,
  resolveGitBinary,
} from '../../../scripts/release-readiness.mjs';

const repoRoot = resolve(import.meta.dirname, '../../..');
const temporaryRoots: string[] = [];

const gitBinary = resolveGitBinary();
if (!gitBinary) throw new Error('Git is required for release-readiness fixture tests');

// This suite creates and commits a complete Git fixture before running the
// readiness gate. Hosted macOS runners can exceed Vitest's 5s default.
const GIT_FIXTURE_TEST_TIMEOUT_MS = 15_000;

function git(root: string, args: string[]) {
  const result = spawnSync(gitBinary, ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`fixture Git command failed: git ${args.join(' ')}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createGitFixture() {
  const root = await mkdtemp(join(tmpdir(), 'release-readiness-git-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'src/tools'), { recursive: true });
  await writeFile(join(root, 'src/tools/example.ts'), 'export const value = 1;\n');
  git(root, ['init']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Release Readiness Fixture']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture: add sensitive source']);
  const evidenceCommit = git(root, ['rev-parse', 'HEAD']);

  await writeJson(join(root, 'config/easyeda-compatibility.json'), {
    schemaVersion: 1,
    releaseGate: {
      sensitivePaths: ['src/tools'],
      requiredFreshLiveRecords: 1,
    },
    records: [
      {
        id: 'fixture-live-record',
        server: { commit: evidenceCommit },
      },
    ],
  });
  git(root, ['add', 'config/easyeda-compatibility.json']);
  git(root, ['commit', '-m', 'fixture: bind compatibility evidence']);
  const currentHead = git(root, ['rev-parse', 'HEAD']);
  return { root, evidenceCommit, currentHead };
}

async function createPassingCommand(directory: string, name: string) {
  await mkdir(directory, { recursive: true });
  if (process.platform === 'win32') {
    await writeFile(join(directory, `${name}.cmd`), '@echo off\r\nexit /b 0\r\n', 'utf8');
    return;
  }
  const path = join(directory, name);
  await writeFile(path, '#!/bin/sh\nprintf "fake command output\n"\n', 'utf8');
  await chmod(path, 0o755);
}

async function createNoGitSnapshot() {
  const root = await mkdtemp(join(tmpdir(), 'release-readiness-snapshot-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'config'), { recursive: true });
  await copyFile(
    join(repoRoot, 'scripts/check-release-readiness.mjs'),
    join(root, 'scripts/check-release-readiness.mjs'),
  );
  await copyFile(
    join(repoRoot, 'scripts/release-readiness.mjs'),
    join(root, 'scripts/release-readiness.mjs'),
  );
  await writeJson(join(root, 'config/easyeda-compatibility.json'), {
    schemaVersion: 1,
    releaseGate: {
      sensitivePaths: ['src/tools'],
      requiredFreshLiveRecords: 1,
    },
    records: [
      {
        id: 'snapshot-record',
        server: { commit: '1'.repeat(40) },
      },
    ],
  });
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('hermetic release readiness', () => {
  it(
    'reports current evidence from a self-contained Git fixture',
    async () => {
      const fixture = await createGitFixture();

      const report = await inspectCompatibilityFreshness({
        root: fixture.root,
        gitBinary,
      });

      expect(report).toMatchObject({
        schemaVersion: 1,
        status: 'current',
        reason: 'Required live compatibility evidence is current.',
        targetRef: 'HEAD',
        headCommit: fixture.currentHead,
        requiredFreshLiveRecords: 1,
        freshRecords: 1,
        sensitivePaths: ['src/tools'],
      });
      expect(report.records).toEqual([
        expect.objectContaining({
          id: 'fixture-live-record',
          evidenceCommit: fixture.evidenceCommit,
          status: 'current',
          changedFiles: [],
        }),
      ]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS,
  );

  it('reports stale evidence after a committed sensitive change', async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, 'src/tools/example.ts'), 'export const value = 2;\n');
    git(fixture.root, ['add', 'src/tools/example.ts']);
    git(fixture.root, ['commit', '-m', 'fixture: change sensitive source']);

    const report = await inspectCompatibilityFreshness({ root: fixture.root, gitBinary });

    expect(report.status).toBe('stale');
    expect(report.reason).toBe('Compatibility-sensitive files changed after live evidence.');
    expect(report.records[0]).toMatchObject({
      status: 'stale',
      changedFiles: ['src/tools/example.ts'],
    });
  });

  it('includes dirty sensitive files only when checking HEAD', async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, 'src/tools/example.ts'), 'export const value = 3;\n');

    const headReport = await inspectCompatibilityFreshness({ root: fixture.root, gitBinary });
    const explicitReport = await inspectCompatibilityFreshness({
      root: fixture.root,
      targetRef: fixture.currentHead,
      gitBinary,
    });

    expect(headReport.status).toBe('stale');
    expect(headReport.records[0]?.changedFiles).toEqual(['src/tools/example.ts']);
    expect(explicitReport.status).toBe('current');
    expect(explicitReport.headCommit).toBe(fixture.currentHead);
  });

  it('evaluates an explicit target ref instead of ambient HEAD', async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, 'src/tools/example.ts'), 'export const value = 4;\n');
    git(fixture.root, ['add', 'src/tools/example.ts']);
    git(fixture.root, ['commit', '-m', 'fixture: later sensitive change']);

    const report = await inspectCompatibilityFreshness({
      root: fixture.root,
      targetRef: fixture.currentHead,
      gitBinary,
    });

    expect(report.status).toBe('current');
    expect(report.headCommit).toBe(fixture.currentHead);
    expect(report.records[0]?.changedFiles).toEqual([]);
  });

  it('returns an explicit unavailable report when Git metadata is absent', async () => {
    const root = await createNoGitSnapshot();

    const report = await inspectCompatibilityFreshness({ root, gitBinary });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: 'unavailable',
      reason:
        'Git metadata is unavailable. Run this check from a complete Git checkout before publishing.',
      targetRef: 'HEAD',
      headCommit: null,
      requiredFreshLiveRecords: 1,
      freshRecords: 0,
      sensitivePaths: ['src/tools'],
    });
    expect(report.records).toEqual([
      expect.objectContaining({
        id: 'snapshot-record',
        status: 'unavailable',
        changedFiles: [],
      }),
    ]);
  });

  it('returns unavailable for missing, invalid JSON, or structurally malformed evidence', async () => {
    const missingRoot = await mkdtemp(join(tmpdir(), 'release-readiness-missing-'));
    const malformedRoot = await mkdtemp(join(tmpdir(), 'release-readiness-malformed-'));
    const invalidRoot = await mkdtemp(join(tmpdir(), 'release-readiness-invalid-'));
    temporaryRoots.push(missingRoot, malformedRoot, invalidRoot);
    await mkdir(join(malformedRoot, 'config'), { recursive: true });
    await writeFile(join(malformedRoot, 'config/easyeda-compatibility.json'), '{broken json\n');
    await writeJson(join(invalidRoot, 'config/easyeda-compatibility.json'), {
      releaseGate: { sensitivePaths: ['src/tools'], requiredFreshLiveRecords: 1 },
      records: [{ id: 'invalid-record', server: { commit: 'abc123' } }],
    });

    await expect(loadCompatibilityEvidence({ root: missingRoot })).resolves.toMatchObject({
      ok: false,
      reason: 'Compatibility evidence is missing.',
    });
    await expect(loadCompatibilityEvidence({ root: malformedRoot })).resolves.toMatchObject({
      ok: false,
      reason: 'Compatibility evidence is not valid JSON.',
    });
    await expect(loadCompatibilityEvidence({ root: invalidRoot })).resolves.toMatchObject({
      ok: false,
      reason: 'Compatibility evidence record invalid-record must reference a full Git commit.',
    });
    await expect(
      inspectCompatibilityFreshness({ root: malformedRoot, gitBinary }),
    ).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'Compatibility evidence is not valid JSON.',
      headCommit: null,
      records: [],
    });
  });

  it('fails closed when the Git executable is unavailable', async () => {
    const fixture = await createGitFixture();

    const report = await inspectCompatibilityFreshness({
      root: fixture.root,
      gitBinary: join(fixture.root, 'missing-git-binary'),
    });

    expect(report).toMatchObject({
      status: 'unavailable',
      reason:
        'Git metadata is unavailable. Run this check from a complete Git checkout before publishing.',
      headCommit: null,
    });
    expect(JSON.stringify(report)).not.toContain(fixture.root);
  });

  it('rejects option-like target refs before invoking Git', async () => {
    const fixture = await createGitFixture();

    const report = await inspectCompatibilityFreshness({
      root: fixture.root,
      targetRef: '--upload-pack=/tmp/not-allowed',
      gitBinary,
    });

    expect(report).toMatchObject({
      status: 'unavailable',
      reason: 'The requested target ref is invalid.',
      targetRef: '<invalid>',
      headCommit: null,
    });
  });

  it.skipIf(process.platform === 'win32')(
    'keeps stdout as one JSON document during the full machine-readable gate',
    async () => {
      const fixture = await createGitFixture();
      const scriptsDirectory = join(fixture.root, 'scripts');
      await mkdir(scriptsDirectory, { recursive: true });
      await copyFile(
        join(repoRoot, 'scripts/check-release-readiness.mjs'),
        join(scriptsDirectory, 'check-release-readiness.mjs'),
      );
      await copyFile(
        join(repoRoot, 'scripts/release-readiness.mjs'),
        join(scriptsDirectory, 'release-readiness.mjs'),
      );
      const commandDirectory = join(fixture.root, 'fake-bin');
      await createPassingCommand(commandDirectory, 'pnpm');
      await createPassingCommand(commandDirectory, 'npm');

      const result = spawnSync(
        process.execPath,
        [join(scriptsDirectory, 'check-release-readiness.mjs'), '--json'],
        {
          cwd: fixture.root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${commandDirectory}${delimiter}${process.env.PATH ?? ''}`,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'current' });
      expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(1);
      expect(result.stderr).toContain('fake command output');
    },
  );

  it('always emits parseable unavailable JSON and a nonzero exit code in a no-Git snapshot', async () => {
    const root = await createNoGitSnapshot();
    const script = join(root, 'scripts/check-release-readiness.mjs');

    const jsonResult = spawnSync(process.execPath, [script, '--compatibility-only', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    const report = JSON.parse(jsonResult.stdout) as {
      status: string;
      reason: string;
      headCommit: string | null;
    };

    expect(jsonResult.status).toBe(1);
    expect(jsonResult.stderr).toBe('');
    expect(report).toMatchObject({
      status: 'unavailable',
      reason:
        'Git metadata is unavailable. Run this check from a complete Git checkout before publishing.',
      headCommit: null,
    });

    const humanResult = spawnSync(process.execPath, [script, '--compatibility-only'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(humanResult.status).toBe(1);
    expect(humanResult.stderr).toContain('EasyEDA compatibility evidence is unavailable for HEAD.');
    expect(humanResult.stderr).toContain('Run this check from a complete Git checkout');
    expect(humanResult.stderr).not.toContain(root);
  });

  it('keeps the publication workflow fail closed for unavailable evidence', async () => {
    const workflow = await readFile(
      join(repoRoot, '.github/workflows/publish-release.yml'),
      'utf8',
    );
    const script = await readFile(join(repoRoot, 'scripts/check-release-readiness.mjs'), 'utf8');

    expect(workflow).toContain(
      'node scripts/check-release-readiness.mjs --compatibility-only --target-ref="${TARGET_REF}"',
    );
    expect(script).toContain('let exitCode = 1;');
    expect(script).toContain("if (report.status === 'current')");
    expect(workflow.indexOf('Verify commit-bound EasyEDA compatibility evidence')).toBeLessThan(
      workflow.indexOf('Create commit-bound GitHub Release'),
    );
  });
});
