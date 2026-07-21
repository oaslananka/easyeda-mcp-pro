import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';

const tempRoots: string[] = [];
const scriptPath = join(process.cwd(), 'scripts/check-extension-size-budget.mjs');

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'easyeda-size-budget-'));
  tempRoots.push(root);
  return root;
};

const runChecker = (root: string, configPath: string) =>
  spawnSync(process.execPath, [scriptPath, '--root', root, '--config', configPath], {
    encoding: 'utf8',
  });

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('extension size budget CLI', () => {
  it('passes artifacts at or below their byte budget', () => {
    const root = makeRoot();
    const artifact = join(root, 'artifact.bin');
    const config = join(root, 'budget.json');
    writeFileSync(artifact, Buffer.alloc(10));
    writeFileSync(config, JSON.stringify({ 'artifact.bin': 10 }));

    const result = runChecker(root, config);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK: artifact.bin');
    expect(result.stdout).toContain('10 / 10 bytes');
  });

  it('fails when an artifact exceeds its byte budget', () => {
    const root = makeRoot();
    const artifact = join(root, 'artifact.bin');
    const config = join(root, 'budget.json');
    writeFileSync(artifact, Buffer.alloc(11));
    writeFileSync(config, JSON.stringify({ 'artifact.bin': 10 }));

    const result = runChecker(root, config);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('artifact.bin exceeds budget');
    expect(result.stderr).toContain('11 > 10 bytes');
  });

  it('fails when a configured artifact is missing', () => {
    const root = makeRoot();
    const configDir = join(root, 'config');
    mkdirSync(configDir);
    const config = join(configDir, 'budget.json');
    writeFileSync(config, JSON.stringify({ 'missing.bin': 10 }));

    const result = runChecker(root, config);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing artifact: missing.bin');
  });
});
