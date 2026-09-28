import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const tempRoots: string[] = [];
const scriptPath = join(process.cwd(), 'scripts/prepare-sonar-coverage.mjs');

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'easyeda-sonar-lcov-'));
  tempRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Sonar LCOV preparation', () => {
  it('prefixes extension-relative LCOV source paths exactly once', () => {
    const root = makeRoot();
    const input = join(root, 'input.info');
    const output = join(root, 'reports', 'extension.info');
    writeFileSync(input, 'TN:\nSF:src/api-runtime.ts\nDA:1,1\nend_of_record\n');

    const result = spawnSync(
      process.execPath,
      [scriptPath, input, output, 'easyeda-bridge-extension/'],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain(
      'SF:easyeda-bridge-extension/src/api-runtime.ts',
    );
  });

  it('does not duplicate an existing prefix', () => {
    const root = makeRoot();
    const input = join(root, 'input.info');
    const output = join(root, 'output.info');
    writeFileSync(input, 'SF:easyeda-bridge-extension/src/api-runtime.ts\n');

    const result = spawnSync(
      process.execPath,
      [scriptPath, input, output, 'easyeda-bridge-extension/'],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(output, 'utf8').trim()).toBe(
      'SF:easyeda-bridge-extension/src/api-runtime.ts',
    );
  });

  it('fails closed on absolute LCOV source paths', () => {
    const root = makeRoot();
    const input = join(root, 'input.info');
    const output = join(root, 'output.info');
    writeFileSync(input, 'SF:/tmp/api-runtime.ts\n');

    const result = spawnSync(
      process.execPath,
      [scriptPath, input, output, 'easyeda-bridge-extension/'],
      { encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('LCOV source path must be repository-relative');
  });
});
