import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const validator = resolve(repoRoot, 'scripts/validate-ci-reports.mjs');
const temporaryDirectories: string[] = [];

function fixtureFiles(coverage: string, junit: string) {
  const root = mkdtempSync(resolve(tmpdir(), 'easyeda-ci-reports-'));
  temporaryDirectories.push(root);
  const coveragePath = resolve(root, 'lcov.info');
  const junitPath = resolve(root, 'junit.xml');
  writeFileSync(coveragePath, coverage, 'utf8');
  writeFileSync(junitPath, junit, 'utf8');
  return { coveragePath, junitPath };
}

function runValidator(coveragePath: string, junitPath: string) {
  return spawnSync(
    process.execPath,
    [validator, '--coverage', coveragePath, '--junit', junitPath],
    { cwd: repoRoot, encoding: 'utf8' },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('CI report validation', () => {
  it('accepts non-empty LCOV and JUnit reports with expected structure', () => {
    const fixture = fixtureFiles(
      'TN:\nSF:/workspace/src/index.ts\nDA:1,1\nend_of_record\n',
      '<?xml version="1.0"?><testsuites tests="1"><testsuite tests="1"><testcase name="passes"/></testsuite></testsuites>\n',
    );

    const result = runValidator(fixture.coveragePath, fixture.junitPath);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('CI reports validated');
  });

  it('fails closed with an actionable error when coverage is missing', () => {
    const fixture = fixtureFiles(
      '',
      '<testsuites><testsuite><testcase name="passes"/></testsuite></testsuites>\n',
    );
    rmSync(fixture.coveragePath);

    const result = runValidator(fixture.coveragePath, fixture.junitPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('coverage report is missing or empty');
    expect(result.stderr).toContain(fixture.coveragePath);
  });

  it('fails closed when LCOV is present but malformed', () => {
    const fixture = fixtureFiles(
      'this is not lcov\n',
      '<testsuites><testsuite><testcase name="passes"/></testsuite></testsuites>\n',
    );

    const result = runValidator(fixture.coveragePath, fixture.junitPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('coverage report is malformed');
  });

  it('fails closed when JUnit is present but malformed', () => {
    const fixture = fixtureFiles(
      'SF:/workspace/src/index.ts\nDA:1,1\nend_of_record\n',
      '<not-junit/>\n',
    );

    const result = runValidator(fixture.coveragePath, fixture.junitPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('JUnit report is malformed');
  });
});
