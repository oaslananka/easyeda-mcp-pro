import { describe, expect, it } from 'vitest';
import {
  evaluatePatch,
  parseAddedLines,
  parseLcov,
} from '../../../scripts/check-patch-coverage.mjs';

const server = ['SF:src/tasks/task-runner.ts', 'DA:1,2', 'DA:2,0', 'DA:3,1', 'end_of_record'].join(
  '\n',
);
const extension = ['SF:src/connection-policy.ts', 'DA:1,1', 'DA:2,0', 'end_of_record'].join('\n');

const diff = (path: string, lines: string[]): string =>
  [
    'diff --git a/' + path + ' b/' + path,
    '--- a/' + path,
    '+++ b/' + path,
    '@@ -0,0 +1,' + lines.length + ' @@',
    ...lines.map((line) => '+' + line),
  ].join('\n');

describe('deterministic changed-line coverage gate', () => {
  it('passes a documentation-only change without checking external providers', () => {
    expect(evaluatePatch('', server, extension)).toMatchObject({
      files: 0,
      total: 0,
      percent: 100,
    });
  });

  it('counts executable lines but ignores lines absent from LCOV', () => {
    const patch = diff('src/tasks/task-runner.ts', ['executable', 'type-only']);
    const report = server.replace('DA:2,0\n', '');
    expect(evaluatePatch(patch, report, extension)).toMatchObject({
      covered: 1,
      total: 1,
      files: 1,
    });
  });

  it('fails on a single uncovered new executable server line despite passing overall tests', () => {
    expect(() =>
      evaluatePatch(diff('src/tasks/task-runner.ts', ['covered', 'uncovered']), server, extension),
    ).toThrow('Changed-line coverage 1/2');
  });

  it('detects uncovered extension-only changed lines', () => {
    expect(() =>
      evaluatePatch(
        diff('easyeda-bridge-extension/src/connection-policy.ts', ['covered', 'uncovered']),
        server,
        extension,
      ),
    ).toThrow('Changed-line coverage 1/2');
  });

  it('fails closed when a newly changed runtime file has no LCOV entry', () => {
    expect(() =>
      evaluatePatch(diff('src/tasks/untested-new.ts', ['new code']), server, extension),
    ).toThrow('Changed source is missing');
  });

  it('does not count removals or intentionally excluded entrypoints', () => {
    expect(
      evaluatePatch(
        'diff --git a/src/obsolete.ts b/src/obsolete.ts\n--- a/src/obsolete.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n',
        server,
        extension,
      ).files,
    ).toBe(0);
    expect(evaluatePatch(diff('src/index.ts', ['entrypoint']), server, extension).files).toBe(0);
  });

  it('counts additions whose source text begins with ++ or mimics a diff file header', () => {
    const patch = diff('src/tasks/task-runner.ts', ['++counter', '++ b/looks-like-header']);
    expect(parseAddedLines(patch).get('src/tasks/task-runner.ts')).toEqual(new Set([1, 2]));
    expect(() => evaluatePatch(patch, server, extension)).toThrow('Changed-line coverage 1/2');
  });

  it('counts all changed lines across multiple hunks', () => {
    const patch =
      'diff --git a/src/tasks/task-runner.ts b/src/tasks/task-runner.ts\n' +
      '--- a/src/tasks/task-runner.ts\n+++ b/src/tasks/task-runner.ts\n' +
      '@@ -1 +1 @@\n+covered\n@@ -3 +3 @@\n+covered\n';
    expect([...parseAddedLines(patch).values()][0]).toEqual(new Set([1, 3]));
    expect(evaluatePatch(patch, server, extension)).toMatchObject({ covered: 2, total: 2 });
  });

  it('supports absolute LCOV paths and rejects malformed coverage', () => {
    expect(
      parseLcov('SF:/repo/src/task.ts\nDA:3,1\nend_of_record').get('src/task.ts')?.get(3),
    ).toBe(1);
    expect(() => parseLcov('SF:src/task.ts\nend_of_record')).toThrow('no executable');
  });

  it('rejects ambiguous diff filenames and malformed hunks instead of silently passing', () => {
    expect(() => parseAddedLines('diff --git a/a b/b\n+++ "b/source with spaces.ts"\n')).toThrow(
      'Cannot parse',
    );
    expect(() =>
      parseAddedLines('diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ incorrect @@'),
    ).toThrow('Cannot parse');
  });
});
