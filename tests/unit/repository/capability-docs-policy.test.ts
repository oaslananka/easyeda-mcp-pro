import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function runCheck() {
  return spawnSync(
    process.execPath,
    [
      resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs'),
      'scripts/update-capability-counts.mts',
      '--check',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
}

describe('capability documentation policy', () => {
  it('keeps public profile counts generated from the live registry', () => {
    const result = runCheck();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('Capability documentation is current');
  }, 15_000);

  it('escapes union types inside generated Markdown parameter tables', () => {
    const toolsDoc = readFileSync(resolve(repoRoot, 'docs/reference/tools.md'), 'utf8');
    const section =
      toolsDoc.split('## `easyeda_pcb_modify_component`')[1]?.split('\n## `')[0] ?? '';

    expect(section).toContain("`'preview'` \\| `'apply'`");
    expect(section).toContain("`'top'` \\| `'bottom' (optional)`");
  });

  it('does not retain superseded tool-count claims', () => {
    const publicDocs = [
      readFileSync(resolve(repoRoot, 'README.md'), 'utf8'),
      readFileSync(resolve(repoRoot, 'docs/security-architecture.md'), 'utf8'),
    ].join('\n');

    for (const stale of [
      'up to 60',
      'up to 77',
      'core` is the default and exposes 47',
      '48 tools',
      '54 tools',
      '63 tools',
      '67 tools',
    ]) {
      expect(publicDocs).not.toContain(stale);
    }
  });
});
