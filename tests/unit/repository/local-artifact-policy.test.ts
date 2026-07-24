import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');

describe('local repository artifact policy', () => {
  it('excludes project-local pnpm stores from Git and repository-wide formatting', () => {
    for (const path of ['.gitignore', '.prettierignore']) {
      const entries = read(path)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      expect(entries).toContain('.pnpm-store/');
    }
  });

  it('documents supported external and repository-local pnpm store behavior', () => {
    const contributing = read('CONTRIBUTING.md');
    expect(contributing).toContain('### pnpm store and cache expectations');
    expect(contributing).toContain('pnpm config set store-dir .pnpm-store');
    expect(contributing).toContain(
      'The repository-local store is ignored by Git, Prettier, and hygiene scans',
    );
    expect(contributing).toContain('CI keeps the pnpm store outside the checkout');
  });
});
