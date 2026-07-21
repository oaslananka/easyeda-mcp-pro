import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const installer = resolve(repoRoot, 'scripts/install-codecov-cli.mjs');
const tempRoots: string[] = [];

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'easyeda-codecov-cli-'));
  tempRoots.push(root);
  return root;
};

const runInstaller = (config: string, output: string, allowFileUrl = true) =>
  spawnSync(
    process.execPath,
    [
      installer,
      '--config',
      config,
      '--output',
      output,
      ...(allowFileUrl ? ['--allow-file-url'] : []),
    ],
    { encoding: 'utf8' },
  );

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Codecov CLI installer', () => {
  it('installs an exact-size, SHA-256 verified executable atomically', () => {
    const root = makeRoot();
    const source = join(root, 'codecovcli');
    const output = join(root, 'bin', 'codecovcli');
    const config = join(root, 'codecov-cli.json');
    const payload = Buffer.from('#!/bin/sh\necho 11.3.1\n');
    writeFileSync(source, payload);
    chmodSync(source, 0o755);
    writeFileSync(
      config,
      JSON.stringify({
        version: '11.3.1',
        asset: 'codecovcli_linux',
        url: pathToFileURL(source).href,
        size: payload.byteLength,
        sha256: createHash('sha256').update(payload).digest('hex'),
      }),
    );

    const result = runInstaller(config, output);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Installed Codecov CLI 11.3.1');
    expect(readFileSync(output)).toEqual(payload);
    if (process.platform !== 'win32') {
      expect(statSync(output).mode & 0o111).not.toBe(0);
    }
  });

  it('rejects a source whose digest does not match the pinned config', () => {
    const root = makeRoot();
    const source = join(root, 'codecovcli');
    const output = join(root, 'bin', 'codecovcli');
    const config = join(root, 'codecov-cli.json');
    const payload = Buffer.from('not-the-pinned-binary');
    writeFileSync(source, payload);
    writeFileSync(
      config,
      JSON.stringify({
        version: '11.3.1',
        asset: 'codecovcli_linux',
        url: pathToFileURL(source).href,
        size: payload.byteLength,
        sha256: '0'.repeat(64),
      }),
    );

    const result = runInstaller(config, output);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SHA-256 mismatch');
  });

  it('rejects file URLs unless the explicit test-only flag is provided', () => {
    const root = makeRoot();
    const source = join(root, 'codecovcli');
    const output = join(root, 'bin', 'codecovcli');
    const config = join(root, 'codecov-cli.json');
    const payload = Buffer.from('fixture');
    writeFileSync(source, payload);
    writeFileSync(
      config,
      JSON.stringify({
        version: '11.3.1',
        asset: 'codecovcli_linux',
        url: pathToFileURL(source).href,
        size: payload.byteLength,
        sha256: createHash('sha256').update(payload).digest('hex'),
      }),
    );

    const result = runInstaller(config, output, false);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Only the pinned Codecov GitHub release URL is allowed');
  });
});
